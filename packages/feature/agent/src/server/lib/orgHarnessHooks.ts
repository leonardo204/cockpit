// packages/feature/agent/src/server/lib/orgHarnessHooks.ts
//
// THE ORG HARNESS HOOKS, WIRED INTO A TURN (org-harness-sync §3.5, M3).
//
// The runtime owns the runner (`org-harness-hooks.ts`): the allowlist, the
// Claude Code-shaped input, the tool-name table, spawning, timeouts, the
// per-project lane and the SessionEnd cap. This file owns only what the runtime
// cannot know:
//
//   * WHEN, in naby terms. SessionStart before a session's first turn in this
//     process (`resume` for one this process did not start, §4.7);
//     UserPromptSubmit before the engine sees the prompt; PreToolUse inside the
//     shell's gate wrapper, which BOTH engines call before every tool;
//     PostToolUse when a tool result streams past (both engines emit one per
//     executed call); Stop when the run ends; PreCompact / SessionStart(compact)
//     through `EngineRunInput.compaction`, which both engines call at their own
//     compaction point; SessionEnd on tab close and app quit.
//   * WHICH SECRETS. The cic token and the metrics token are read here (the cic
//     preset is the shell's registry) and handed to the runtime's env builder.
//   * WHICH `node`. `NABY_APP_EXECUTABLE` (electron/boot.ts sets it to the app
//     binary), else `process.execPath`.
//
// Everything here is a no-op when the org harness is off or has no package, and
// nothing here can fail a turn.

import {
  createOrgHookRunner,
  installOrgHarnessQuitHandler,
  isInsideFolder,
  nabyHomeDir,
  noteOrgSessionStarted,
  orgHarnessOnState,
  orgHarnessRoot,
  orgHookEnv,
  orgSessionStartSource,
  orgTranscriptPath,
  ORG_HARNESS_SETTING,
  readOrgHookConfig,
  takeAllOrgSessions,
  takeOrgSession,
  writeOrgTranscript,
  type CompactionPort,
  type OrgHarnessTurn,
  type OrgHookCall,
  type OrgHookConfig,
  type OrgHookDecision,
  type OrgHookRunner,
  type OrgHookSessionInfo,
  type Store,
  type ToolCall,
} from '../../../../../../../dist/naby-runtime.mjs';
import { existsSync } from 'node:fs';
import { orgHarnessContext, readOrgCicToken } from './orgHarness';

// The runtime's process-level hook state, re-exported from THIS module so a test or
// a spike reaches the same bundle instance the engine uses (a second import path
// can load a second copy of the runtime, with its own state).
export {
  orgHooksIdle,
  recentOrgHookLog,
  resetOrgHookStateForTests,
} from '../../../../../../../dist/naby-runtime.mjs';

/** The executable `node` means for a hook (§3.5 "실행"). */
export function orgHookExecutable(env: Record<string, string | undefined> = process.env): string {
  return env.NABY_APP_EXECUTABLE?.trim() || process.execPath;
}

const configCache = new Map<string, OrgHookConfig>();

/** hooks.json of one package version, read once per folder (a version folder
 *  never changes after it is extracted — M1 renames it into place whole). */
export function orgHookConfigFor(pkgDir: string): OrgHookConfig {
  let c = configCache.get(pkgDir);
  if (!c) {
    c = readOrgHookConfig(pkgDir);
    configCache.set(pkgDir, c);
  }
  return c;
}

function runnerFor(store: Store, pkgDir: string, projectDir: string | undefined): OrgHookRunner {
  const metricsToken = store.getSetting(ORG_HARNESS_SETTING.metricsToken)?.trim() || undefined;
  let cicToken: string | undefined;
  try {
    cicToken = readOrgCicToken(store);
  } catch {
    cicToken = undefined;
  }
  const env = orgHookEnv({
    base: process.env,
    pkgDir,
    ...(projectDir ? { projectDir } : {}),
    ...(cicToken ? { cicToken } : {}),
    ...(metricsToken ? { metricsToken } : {}),
  });
  return createOrgHookRunner({ config: orgHookConfigFor(pkgDir), env, executable: orgHookExecutable() });
}

/** The hooks one turn fires. Every method is safe to call when disabled. */
export type OrgTurnHooks = {
  readonly enabled: boolean;
  /** Fire SessionStart if this session has not had one in this process. Returns
   *  the hooks' extra context (empty when nothing fired). */
  sessionStart(isNewSession: boolean): Promise<string[]>;
  userPromptSubmit(prompt: string): Promise<string[]>;
  /** The strongest PreToolUse opinion, or undefined. Awaited by the gate. */
  preToolUse(call: ToolCall): Promise<OrgHookDecision | undefined>;
  /** Fire-and-forget. */
  postToolUse(call: { toolName: string; input: unknown; agentId?: string }, output: { content: string; isError: boolean }): void;
  /** Fire-and-forget, once per run. */
  stop(): void;
  /** For `runTurn({ compaction })`, or undefined when disabled. */
  readonly compaction: CompactionPort | undefined;
};

const DISABLED: OrgTurnHooks = {
  enabled: false,
  sessionStart: async () => [],
  userPromptSubmit: async () => [],
  preToolUse: async () => undefined,
  postToolUse: () => {},
  stop: () => {},
  compaction: undefined,
};

/**
 * Build the turn's hooks over the package folder the turn PINNED (§4.7). The
 * kill switch is re-read on every call (`orgTurn.stillOn()`): off is the safe
 * direction, and a switch flipped mid-turn takes effect at the next hook.
 */
export function makeOrgTurnHooks(args: {
  store: Store;
  orgTurn: OrgHarnessTurn;
  sessionId: string;
  projectDir?: string;
  /** This turn's MCP tool names (`<server>__<tool>`), for `mcp__…` spelling. */
  mcpToolNames: ReadonlySet<string>;
}): OrgTurnHooks {
  const pkg = args.orgTurn.pkg;
  if (!args.orgTurn.on || !pkg) return DISABLED;
  let runner: OrgHookRunner;
  try {
    runner = runnerFor(args.store, pkg.dir, args.projectDir);
  } catch (e) {
    console.warn(`[org-hooks] runner unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return DISABLED;
  }
  if (!runner.config.entries.some((e) => e.disposition === 'run')) return DISABLED;
  const home = args.orgTurn.home;
  const transcriptPath = orgTranscriptPath(home, args.sessionId);
  const base = (event: OrgHookCall['event']): OrgHookCall => ({
    event,
    sessionId: args.sessionId,
    transcriptPath,
    ...(args.projectDir ? { cwd: args.projectDir } : {}),
    mcpToolNames: args.mcpToolNames,
  });
  const live = (): boolean => {
    try {
      return args.orgTurn.stillOn();
    } catch {
      return false;
    }
  };
  const writeTranscript = (): void => {
    try {
      writeOrgTranscript({
        home,
        sessionId: args.sessionId,
        messages: args.store.getMessages(args.sessionId),
        ...(args.projectDir ? { cwd: args.projectDir } : {}),
        mcpToolNames: args.mcpToolNames,
      });
    } catch {
      /* the hook still runs; it finds the previous file or none */
    }
  };

  let stopped = false;
  return {
    enabled: true,
    async sessionStart(isNewSession) {
      if (!live()) return [];
      const source = orgSessionStartSource(args.sessionId, isNewSession);
      if (!source) return [];
      noteOrgSessionStarted({
        sessionId: args.sessionId,
        ...(args.projectDir ? { cwd: args.projectDir } : {}),
        pkgDir: pkg.dir,
        startedAt: Date.now(),
      });
      const r = await runner.dispatch({ ...base('SessionStart'), source });
      return r.additionalContext;
    },
    async userPromptSubmit(prompt) {
      if (!live()) return [];
      const r = await runner.dispatch({ ...base('UserPromptSubmit'), prompt });
      return r.additionalContext;
    },
    async preToolUse(call) {
      if (!live()) return undefined;
      const r = await runner.dispatch({
        ...base('PreToolUse'),
        toolName: call.toolName,
        toolInput: call.input,
        ...(call.subagent?.agentId ? { agentId: call.subagent.agentId } : {}),
      });
      return r.decision;
    },
    postToolUse(call, output) {
      if (!live()) return;
      void runner.dispatch({
        ...base('PostToolUse'),
        toolName: call.toolName,
        toolInput: call.input,
        toolResponse: { content: output.content, is_error: output.isError },
        ...(call.agentId ? { agentId: call.agentId } : {}),
      });
    },
    stop() {
      if (stopped || !live()) return;
      stopped = true;
      void runner.dispatch(base('Stop'));
    },
    compaction: {
      async before({ trigger }) {
        if (!live()) return;
        // §3.5: the transcript is rewritten for PreCompact.
        writeTranscript();
        await runner.dispatch({ ...base('PreCompact'), trigger });
      },
      async after() {
        if (!live()) return undefined;
        const r = await runner.dispatch({ ...base('SessionStart'), source: 'compact' });
        return r.additionalContext.length > 0 ? r.additionalContext.join('\n\n') : undefined;
      },
    },
  };
}

/** Join hook context into one system block, or undefined. */
export function orgHookContextBlock(parts: readonly string[]): string | undefined {
  const text = parts.map((p) => p.trim()).filter(Boolean).join('\n\n');
  return text ? `[Org harness hooks]\n${text}` : undefined;
}

// ---------------------------------------------------------------------------
// SessionEnd — tab close and app quit (§1, §3.5)
// ---------------------------------------------------------------------------

/**
 * End one live session: transcript first (synchronously — the caller may delete
 * the session right after), then SessionEnd from the folder the session's turns
 * used (falling back to `current` when that version was cleaned up). Returns the
 * hook run, capped at 5 s by the runtime; undefined when the session never
 * started hooks in this process or the org harness is off.
 */
export function prepareOrgSessionEnd(
  store: Store,
  sessionId: string,
  reason = 'other',
): (() => Promise<void>) | undefined {
  const info = takeOrgSession(sessionId);
  if (!info) return undefined;
  return prepareFromInfo(store, info, reason);
}

function prepareFromInfo(store: Store, info: OrgHookSessionInfo, reason: string): (() => Promise<void>) | undefined {
  let on = false;
  try {
    on = orgHarnessOnState(store, orgHarnessContext(store)).on;
  } catch {
    on = false;
  }
  if (!on) return undefined;
  const home = nabyHomeDir();
  // The folder must still be a package folder under this home (it may have been
  // cleaned up by a later sync; one previous version is kept, §3.1).
  const pkgDir =
    existsSync(info.pkgDir) && isInsideFolder(orgHarnessRoot(home), info.pkgDir) ? info.pkgDir : undefined;
  if (!pkgDir) return undefined;
  let transcriptPath = orgTranscriptPath(home, info.sessionId);
  try {
    transcriptPath =
      writeOrgTranscript({
        home,
        sessionId: info.sessionId,
        messages: store.getMessages(info.sessionId),
        ...(info.cwd ? { cwd: info.cwd } : {}),
      }) ?? transcriptPath;
  } catch {
    /* keep the path */
  }
  let runner: OrgHookRunner;
  try {
    runner = runnerFor(store, pkgDir, info.cwd);
  } catch {
    return undefined;
  }
  return async () => {
    await runner.dispatch({
      event: 'SessionEnd',
      sessionId: info.sessionId,
      transcriptPath,
      ...(info.cwd ? { cwd: info.cwd } : {}),
      reason,
    });
  };
}

/** Tab close: end each closed session that ran hooks here. Never throws, never
 *  waits — the HTTP answer does not depend on hook processes. */
export function endOrgSessionsOnClose(store: Store, sessionIds: readonly string[]): void {
  for (const id of sessionIds) {
    try {
      const run = prepareOrgSessionEnd(store, id, 'other');
      if (run) void run().catch(() => {});
    } catch {
      /* next one */
    }
  }
}

let quitInstalled = false;

/**
 * Register the app-quit SessionEnd with the Electron main process (through a
 * global the runtime names, because the main process cannot see this module's
 * state). Every live session ends together; the runtime caps the wait.
 */
export function ensureOrgHarnessQuitHandler(store: Store): void {
  if (quitInstalled) return;
  quitInstalled = true;
  installOrgHarnessQuitHandler(async () => {
    const runs: Promise<void>[] = [];
    for (const info of takeAllOrgSessions()) {
      try {
        const run = prepareFromInfo(store, info, 'prompt_input_exit');
        if (run) runs.push(run().catch(() => {}));
      } catch {
        /* next */
      }
    }
    await Promise.all(runs);
  });
}

/** Test-only. */
export function resetOrgHarnessHooksForTests(): void {
  configCache.clear();
  quitInstalled = false;
  installOrgHarnessQuitHandler(undefined);
}
