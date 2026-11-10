// packages/feature/agent/src/server/lib/memoryWorker.ts
//
// THE MEMORY PROCESS'S SUPERVISOR (specs/memory-worker.md R1, R8, R9).
//
// Memory work runs beside the user's turns but never in their way. The ways a
// turn could be slowed are three (§1): the app server's event loop (the store is
// synchronous), the database's write lock, and the machine's CPU. This file
// takes the first off the table — the work runs in ANOTHER Node process with its
// own event loop and its own database connection — and starts that process at a
// lowered priority for the third. The app process only posts notices ("a turn
// started", "a turn ended") and reads back a status; each is one IPC message.
//
// HOW THE PROCESS IS STARTED. `child_process.fork` of the built entry
// (`shell/dist/memoryWorker.mjs`). Not `utilityProcess`: this module runs inside
// the Next server in every launch mode — inside Electron's main process for the
// desktop app (`npm run electron:dev`, the packaged app) and in plain Node for
// `node server.mjs` — and must not import `electron` (it would drag it into the
// Next graph, the coupling the credential bridge exists to avoid). `fork` works
// in all three: under Electron, `process.execPath` is the app's own binary and
// `ELECTRON_RUN_AS_NODE=1` makes it a plain Node — the same switch the release
// check runs the binary with (packaging-path-resolution §4).
//
// IT NEVER SILENTLY STOPS. A process that dies is restarted (with a short,
// growing delay), and re-seeds its queue from the database (R8). A process that
// cannot be started at all — no built entry, a fork that dies before it is ready,
// one that keeps crashing — is given up on, logged, and the SAME runner is run
// here instead: exactly today's in-process behaviour, memory keeps working.
//
// ONE SUPERVISOR PER APP PROCESS, ON `globalThis`. The shell's server code is
// bundled twice into the same process — the WebSocket bundle (tsup, where turns
// run) and the Next route bundle (where `/api/memory` reads the status) — so a
// module-level singleton would be two supervisors forking two processes. The
// global key is the seam both copies share, the way the credential bridge is.

import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setPriority, constants as osConstants } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decideMemoryWorkerRestart,
  isMemoryRateLimitError,
  type MemoryJobModel,
  type MemoryWorkStatus,
} from '../../../../../../../dist/naby-runtime.mjs';
import type { MemoryReviewer } from './memoryReview';
import {
  callHere,
  localMemoryModelPort,
  resolveMemoryCallRoute,
  type MemoryCallTarget,
  type MemoryPrompt,
  type MemoryWorkStore,
} from './memoryJobs';
import { MemoryWorkRunner } from './memoryWorkRunner';
import {
  MEMORY_WORKER_CHILD_ENV,
  MEMORY_WORKER_MODE_ENV,
  MEMORY_WORKER_SCRIPT,
  type FromMemoryWorker,
  type MemoryCallReply,
  type ToMemoryWorker,
} from './memoryWorkerProtocol';

// ---------------------------------------------------------------------------
// Where the built entry is
// ---------------------------------------------------------------------------

/**
 * Candidate paths for the memory process's entry, in the order the packaging
 * rule fixes (packaging-path-resolution §2): `NABY_APP_ROOT` (the desktop app's
 * own copy), `COCKPIT_ROOT` (the shell directory, set by both servers), and only
 * then this module's own location — which the Next bundle freezes to the build
 * machine's path, so it is the last resort, for `tsx` and tests. Never
 * `process.cwd()`.
 */
export function memoryWorkerScriptCandidates(): string[] {
  const out: string[] = [];
  const add = (p: string): void => {
    if (!out.includes(p)) out.push(p);
  };
  const appRoot = process.env.NABY_APP_ROOT;
  if (appRoot) add(join(appRoot, 'shell', 'dist', MEMORY_WORKER_SCRIPT));
  const shellRoot = process.env.COCKPIT_ROOT;
  if (shellRoot) add(join(shellRoot, 'dist', MEMORY_WORKER_SCRIPT));
  let dir: string | undefined;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    dir = undefined;
  }
  // From `shell/dist/` (the tsup bundle) the entry is a sibling; from the source
  // tree it is up at `shell/dist/`.
  for (let i = 0; dir !== undefined && i < 8; i += 1) {
    if (basename(dir) === 'dist') add(join(dir, MEMORY_WORKER_SCRIPT));
    add(join(dir, 'dist', MEMORY_WORKER_SCRIPT));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

export function resolveMemoryWorkerScript(): string | undefined {
  return memoryWorkerScriptCandidates().find((p) => existsSync(p));
}

// ---------------------------------------------------------------------------
// The child, as the supervisor sees it — narrow, so a test can fake it
// ---------------------------------------------------------------------------

export type MemoryWorkerChild = {
  readonly pid?: number;
  send(message: ToMemoryWorker): unknown;
  on(event: 'message', listener: (message: FromMemoryWorker) => void): unknown;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
};

/** Lowest priority the OS calls "below normal" — `nice 10` on macOS/Linux,
 *  BELOW_NORMAL_PRIORITY_CLASS on Windows (R4). */
export const MEMORY_WORKER_PRIORITY = osConstants.priority?.PRIORITY_BELOW_NORMAL ?? 10;

/** Fork the built entry. Under Electron the app's own binary runs as Node. */
export function forkMemoryWorker(script: string): MemoryWorkerChild {
  const child = fork(script, [], {
    env: {
      ...process.env,
      [MEMORY_WORKER_CHILD_ENV]: '1',
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
    // The server's own flags (an inspector port, a loader) are not the worker's.
    execArgv: [],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    serialization: 'json',
  });
  // Belt and braces with the worker lowering itself: on macOS/Linux its CLI
  // children inherit the nice value, on Windows the below-normal class (R4).
  if (child.pid !== undefined) {
    try {
      setPriority(child.pid, MEMORY_WORKER_PRIORITY);
    } catch {
      /* best effort, never fatal */
    }
  }
  // The memory process must never keep a server, a spike or a CLI alive on its
  // own — the app's lifetime is the app's business.
  child.unref();
  (child as unknown as { channel?: { unref?: () => void } }).channel?.unref?.();
  return child as unknown as MemoryWorkerChild;
}

// ---------------------------------------------------------------------------
// The supervisor
// ---------------------------------------------------------------------------

export type MemoryWorkNotice = {
  sessionId: string;
  model?: MemoryJobModel;
  /** The app's store — used only if the work has to run here. */
  store: MemoryWorkStore;
  /** A test's reviewer. Not serializable, so its work always runs here. */
  reviewer?: MemoryReviewer;
  /** The engine's test seams: no backend to rebuild, nothing to fork for. */
  inProcess?: boolean;
};

export type MemoryWorkSupervisorOptions = {
  /** Where the entry is; `null` = there is none. Default: resolved on start. */
  script?: string | null;
  /** Start the child. Default: `forkMemoryWorker`. */
  spawn?: (script: string) => MemoryWorkerChild;
  /** Answer a `call` from the child. Default: resolve the route here, make key
   *  calls here, hand subscription calls back. */
  answerCall?: (target: MemoryCallTarget, prompt: MemoryPrompt, timeoutMs: number) => Promise<MemoryCallReply>;
  /** How long a fresh child has to say `ready`. */
  readyTimeoutMs?: number;
  now?: () => number;
  log?: (line: string) => void;
};

/** Notices buffered while the child is (re)starting. The newest are kept. */
const PENDING_CAP = 50;
const READY_TIMEOUT_MS = 15_000;
/** A child that dies before ever being ready this many times in a row cannot
 *  start here — give up sooner than the crash window would. */
const START_FAILURE_LIMIT = 2;

export class MemoryWorkSupervisor {
  private mode: 'idle' | 'starting' | 'worker' | 'in-process' = 'idle';
  private child: MemoryWorkerChild | undefined;
  private childReady = false;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;
  private crashes: number[] = [];
  private startFailures = 0;
  private restarts = 0;
  private pending: ToMemoryWorker[] = [];
  private lastWorkerStatus: MemoryWorkStatus | undefined;
  private lastCrashAt: number | undefined;
  private lastModel: { sessionId: string; model: MemoryJobModel } | undefined;
  private store: MemoryWorkStore | undefined;
  private localRunner: MemoryWorkRunner | undefined;
  private seamRunner: MemoryWorkRunner | undefined;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: MemoryWorkSupervisorOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => console.log(line));
  }

  // -------------------------------------------------------------------------
  // Notices — each returns at once and never throws
  // -------------------------------------------------------------------------

  turnStarted(n: MemoryWorkNotice): void {
    this.route(n, (r) => r.turnStarted(n), {
      type: 'turn-started',
      sessionId: n.sessionId,
      ...(n.model ? { model: n.model } : {}),
    });
  }

  turnEnded(n: MemoryWorkNotice & { autoApply: boolean }): void {
    this.route(n, (r) => r.turnEnded(n), {
      type: 'turn-ended',
      sessionId: n.sessionId,
      autoApply: n.autoApply,
      ...(n.model ? { model: n.model } : {}),
    });
  }

  turnModel(n: MemoryWorkNotice & { model: MemoryJobModel }): void {
    this.route(n, (r) => r.turnModel(n), { type: 'turn-model', sessionId: n.sessionId, model: n.model });
  }

  private route(n: MemoryWorkNotice, here: (r: MemoryWorkRunner) => void, message: ToMemoryWorker): void {
    try {
      if (n.inProcess || n.reviewer) {
        this.seamRunner ??= new MemoryWorkRunner({ store: n.store, port: localMemoryModelPort(), mode: 'in-process' });
        here(this.seamRunner);
        return;
      }
      if (n.model) this.lastModel = { sessionId: n.sessionId, model: n.model };
      this.ensureStarted(n.store);
      if (this.mode === 'in-process') {
        if (this.localRunner) here(this.localRunner);
        return;
      }
      this.post(message);
    } catch (e) {
      // The turn that sent this must be byte-for-byte unaffected.
      this.log(`[memory-work] notice dropped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private post(message: ToMemoryWorker): void {
    if (this.mode === 'worker' && this.child && this.childReady) {
      try {
        this.child.send(message);
        return;
      } catch {
        /* the channel closed under us — buffer it; the exit handler restarts */
      }
    }
    this.pending.push(message);
    if (this.pending.length > PENDING_CAP) this.pending.splice(0, this.pending.length - PENDING_CAP);
  }

  // -------------------------------------------------------------------------
  // Starting, restarting, giving up
  // -------------------------------------------------------------------------

  /** Start the memory process if nothing is running yet. Idempotent. */
  ensureStarted(store: MemoryWorkStore): void {
    this.store ??= store;
    if (this.mode !== 'idle') return;
    const setting = process.env[MEMORY_WORKER_MODE_ENV]?.trim().toLowerCase();
    if (setting === 'off' || setting === 'in-process' || setting === 'inprocess') {
      this.fallBack(`${MEMORY_WORKER_MODE_ENV}=${setting}`);
      return;
    }
    // Never fork from inside the memory process itself.
    if (process.env[MEMORY_WORKER_CHILD_ENV] === '1') {
      this.fallBack('already inside the memory process');
      return;
    }
    const script = this.opts.script === undefined ? resolveMemoryWorkerScript() : this.opts.script;
    if (!script) {
      this.fallBack(`no built ${MEMORY_WORKER_SCRIPT} (looked in ${memoryWorkerScriptCandidates().join(', ')})`);
      return;
    }
    this.startChild(script);
  }

  private startChild(script: string): void {
    this.mode = 'starting';
    this.childReady = false;
    let child: MemoryWorkerChild;
    try {
      child = (this.opts.spawn ?? forkMemoryWorker)(script);
    } catch (e) {
      this.fallBack(`could not start the memory process: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.child = child;
    this.readyTimer = setTimeout(() => {
      if (this.child === child && !this.childReady) {
        this.log('[memory-work] memory process did not become ready — restarting');
        try {
          child.kill();
        } catch {
          /* exit handler follows either way */
        }
        this.onExit(child, null, 'ready-timeout');
      }
    }, this.opts.readyTimeoutMs ?? READY_TIMEOUT_MS);
    this.readyTimer.unref?.();
    child.on('message', (m) => this.onMessage(child, m));
    child.on('exit', (code, signal) => this.onExit(child, code, signal));
    child.on('error', (e) => {
      this.log(`[memory-work] memory process error: ${e.message}`);
      this.onExit(child, null, 'error');
    });
  }

  private onMessage(child: MemoryWorkerChild, m: FromMemoryWorker): void {
    if (child !== this.child || !m || typeof m !== 'object') return;
    switch (m.type) {
      case 'ready': {
        if (this.readyTimer) clearTimeout(this.readyTimer);
        this.childReady = true;
        this.mode = 'worker';
        this.startFailures = 0;
        this.log(`[memory-work] memory process ready (pid ${m.pid})`);
        try {
          child.send({ type: 'hello', ...(this.lastModel ? { lastModel: this.lastModel } : {}) });
        } catch {
          /* exit handler restarts */
        }
        const pending = this.pending;
        this.pending = [];
        for (const message of pending) this.post(message);
        return;
      }
      case 'status':
        this.lastWorkerStatus = m.status;
        return;
      case 'call':
        void this.answer(child, m);
        return;
      default:
        return;
    }
  }

  private async answer(child: MemoryWorkerChild, m: Extract<FromMemoryWorker, { type: 'call' }>): Promise<void> {
    let reply: MemoryCallReply;
    try {
      reply = await (this.opts.answerCall ?? answerMemoryCall)(m.target, m.prompt, m.timeoutMs);
    } catch (e) {
      reply = { error: e instanceof Error ? e.message : String(e), rateLimited: isMemoryRateLimitError(e) };
    }
    if (child !== this.child) return;
    try {
      child.send({ type: 'call-result', id: m.id, ...reply });
    } catch {
      /* the child is gone; its job is re-seeded on restart */
    }
  }

  private onExit(child: MemoryWorkerChild, code: number | null, signal: string | null): void {
    if (child !== this.child) return;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    const wasReady = this.childReady;
    this.child = undefined;
    this.childReady = false;
    if (this.mode === 'in-process') return;
    const now = this.now();
    this.lastCrashAt = now;
    this.log(`[memory-work] memory process exited (code ${String(code)}, signal ${String(signal)})`);
    if (!wasReady) {
      this.startFailures += 1;
      if (this.startFailures >= START_FAILURE_LIMIT) {
        this.fallBack('the memory process could not be started');
        return;
      }
    }
    const decision = decideMemoryWorkerRestart(this.crashes, now);
    this.crashes = decision.recent;
    if (decision.action === 'fallback') {
      this.fallBack('the memory process keeps crashing');
      return;
    }
    this.mode = 'starting';
    const timer = setTimeout(() => {
      if (this.mode !== 'starting' || this.child) return;
      const script = this.opts.script === undefined ? resolveMemoryWorkerScript() : this.opts.script;
      if (!script) {
        this.fallBack(`no built ${MEMORY_WORKER_SCRIPT}`);
        return;
      }
      this.restarts += 1;
      this.startChild(script);
    }, decision.delayMs);
    timer.unref?.();
  }

  /** Run the work here — the behaviour before the memory process existed. */
  private fallBack(reason: string): void {
    this.log(`[memory-work] running memory work in the app process: ${reason}`);
    this.mode = 'in-process';
    if (this.child) {
      const child = this.child;
      this.child = undefined;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    if (!this.store) return;
    this.localRunner ??= new MemoryWorkRunner({ store: this.store, port: localMemoryModelPort(), mode: 'in-process' });
    this.localRunner.reseed();
    if (this.lastModel) this.localRunner.turnModel(this.lastModel);
    // Replay what the child never received.
    const pending = this.pending;
    this.pending = [];
    for (const m of pending) {
      if (m.type === 'turn-started') this.localRunner.turnStarted(m);
      else if (m.type === 'turn-ended') this.localRunner.turnEnded(m);
      else if (m.type === 'turn-model') this.localRunner.turnModel(m);
    }
  }

  // -------------------------------------------------------------------------
  // Reading it back
  // -------------------------------------------------------------------------

  /** The settings row's status (§2). Starts the memory process if it has not
   *  been — opening Settings after a restart is enough to re-seed (R8). */
  status(store: MemoryWorkStore): MemoryWorkStatus {
    this.ensureStarted(store);
    if (this.mode === 'in-process' && this.localRunner) return this.localRunner.status();
    const base: MemoryWorkStatus = this.lastWorkerStatus ?? { mode: 'worker', state: 'idle', queued: {}, callsToday: 0 };
    return {
      ...base,
      mode: 'worker',
      restarts: this.restarts,
      // While the process is coming back, its last word is stale.
      ...(this.mode === 'starting' && this.lastCrashAt !== undefined
        ? {
            state: 'waiting' as const,
            lastFailure: { kind: base.current?.kind ?? 'worker', at: this.lastCrashAt, reason: 'crashed' as const },
          }
        : {}),
    };
  }

  /** The live memory process's pid, if there is one — for tests and logs. */
  childPid(): number | undefined {
    return this.childReady ? this.child?.pid : undefined;
  }

  /** Which mode the work is in — for tests and logs. */
  currentMode(): 'idle' | 'starting' | 'worker' | 'in-process' {
    return this.mode;
  }

  /** Wait until the in-process work (the fallback and the test seams) is idle. */
  async settle(): Promise<void> {
    await Promise.all([this.seamRunner?.idle(), this.localRunner?.idle()]);
  }

  /** Stop the child and the runners (tests). */
  shutdown(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    const child = this.child;
    this.child = undefined;
    this.mode = 'idle';
    try {
      child?.kill();
    } catch {
      /* gone */
    }
    this.localRunner?.dispose();
    this.seamRunner?.dispose();
  }
}

/**
 * The app process's side of a `call` from the memory process: decide the route
 * here (this process can see the vault and the token source), make a key call
 * here, and hand a subscription call back to be made at the memory process's
 * priority.
 */
export async function answerMemoryCall(
  target: MemoryCallTarget,
  prompt: MemoryPrompt,
  timeoutMs: number,
): Promise<MemoryCallReply> {
  const route = await resolveMemoryCallRoute(target);
  if (!route) return { unavailable: true };
  if (route.where === 'subscription') return { local: route };
  return { text: await callHere(route.backend, prompt, timeoutMs), label: route.backend.label };
}

// ---------------------------------------------------------------------------
// The process-wide handle
// ---------------------------------------------------------------------------

const GLOBAL_KEY = '__nabyMemoryWorkSupervisor';
type SupervisorHost = { [GLOBAL_KEY]?: MemoryWorkSupervisor };

/** The one supervisor in this process (see the file header for why global). */
export function memoryWork(): MemoryWorkSupervisor {
  const host = globalThis as SupervisorHost;
  if (!host[GLOBAL_KEY]) {
    const supervisor = new MemoryWorkSupervisor();
    host[GLOBAL_KEY] = supervisor;
    // The child is unref'd and exits on its own when the channel closes; this
    // is the explicit half for an orderly exit.
    process.once('exit', () => {
      try {
        supervisor.shutdown();
      } catch {
        /* exiting anyway */
      }
    });
  }
  return host[GLOBAL_KEY]!;
}

/** For tests: wait for the in-process memory work to finish. */
export async function settleMemoryWork(): Promise<void> {
  await (globalThis as SupervisorHost)[GLOBAL_KEY]?.settle();
}
