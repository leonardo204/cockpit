// packages/feature/agent/src/server/lib/memoryWorkerMain.ts
//
// THE MEMORY PROCESS (specs/memory-worker.md R1, R3, R4, R7, R8).
//
// Built to `shell/dist/memoryWorker.mjs` and forked by the supervisor
// (memoryWorker.ts). Its whole life:
//
//   1. lower its own priority (R4) — its CLI children inherit it;
//   2. open ITS OWN connection to the same database the app uses (R1), resolved
//      by the same rule (`nabyDbPath`: NABY_DB_PATH > NABY_HOME > ~/.naby);
//      the store sets the busy timeout on open (R3);
//   3. re-seed the queue from what the database says is owed (R8), say `ready`;
//   4. run the queue: notices in, status out, a `call` out whenever a model call
//      needs a secret only the app process holds (memoryJobs.ts);
//   5. exit when the app process goes away — the IPC channel closing is that.
//
// IT IS NOT A CHAT SESSION (R7). It writes no `sessions` row, no transcript, no
// usage: every call is driven straight through an engine with no tools, exactly
// as the reflection judge and the review always were.

import { mkdirSync } from 'node:fs';
import { setPriority, constants as osConstants } from 'node:os';
import { dirname } from 'node:path';
import { nabyDbPath, SqliteStore } from '../../../../../../../dist/naby-runtime.mjs';
import { callSubscription, MemoryModelUnavailableError, type MemoryModelPort, type MemoryWorkStore } from './memoryJobs';
import { MemoryWorkRunner } from './memoryWorkRunner';
import {
  MEMORY_WORKER_CHILD_ENV,
  type FromMemoryWorker,
  type MemoryCallReply,
  type ToMemoryWorker,
} from './memoryWorkerProtocol';

function send(message: FromMemoryWorker): void {
  // A closed channel fails ASYNCHRONOUSLY (EPIPE through the callback, or as an
  // 'error' event with none) — so both the connected check and the callback are
  // needed; the try only covers the synchronous half. `disconnect` ends us.
  if (!process.connected) return;
  try {
    process.send?.(message, undefined, {}, () => undefined);
  } catch {
    /* the app process is gone */
  }
}

/** How much longer than the call itself the app process may take to answer. */
const CALL_REPLY_GRACE_MS = 15_000;

function ipcPort(): MemoryModelPort {
  let nextId = 1;
  const waiting = new Map<number, (reply: MemoryCallReply) => void>();
  process.on('message', (raw: unknown) => {
    const m = raw as ToMemoryWorker;
    if (m && typeof m === 'object' && m.type === 'call-result') {
      const resolve = waiting.get(m.id);
      if (resolve) {
        waiting.delete(m.id);
        const { type: _type, id: _id, ...reply } = m;
        resolve(reply as MemoryCallReply);
      }
    }
  });
  return {
    async call(target, prompt, timeoutMs) {
      const id = nextId++;
      const reply = await new Promise<MemoryCallReply>((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          resolve({ error: 'the app process did not answer the memory call', rateLimited: false });
        }, timeoutMs + CALL_REPLY_GRACE_MS);
        timer.unref?.();
        waiting.set(id, (r) => {
          clearTimeout(timer);
          resolve(r);
        });
        send({ type: 'call', id, target, prompt, timeoutMs });
      });
      if ('unavailable' in reply) throw new MemoryModelUnavailableError();
      if ('error' in reply) {
        const error = new Error(reply.error) as Error & { status?: number };
        // Carried as a status, not re-parsed from text: the app process already
        // decided, and the runner's check reads either.
        if (reply.rateLimited) error.status = 429;
        throw error;
      }
      if ('local' in reply) {
        // A subscription call: spawned HERE, at this process's lowered priority.
        return { text: await callSubscription(reply.local, prompt, timeoutMs), label: reply.local.label };
      }
      return { text: reply.text, label: reply.label };
    },
  };
}

function main(): void {
  if (!process.send || process.env[MEMORY_WORKER_CHILD_ENV] !== '1') {
    console.error('[memory-worker] not started by the app server — exiting');
    process.exit(2);
  }

  // R4 — best effort, never fatal. A CPU-bound turn outranks memory work.
  try {
    setPriority(0, osConstants.priority?.PRIORITY_BELOW_NORMAL ?? 10);
  } catch {
    /* some platforms refuse; the work still runs */
  }

  const path = nabyDbPath();
  mkdirSync(dirname(path), { recursive: true });
  const store = new SqliteStore({ path }) as unknown as MemoryWorkStore;

  const runner = new MemoryWorkRunner({
    store,
    port: ipcPort(),
    mode: 'worker',
    onStatus: (status) => send({ type: 'status', status }),
  });

  process.on('message', (raw: unknown) => {
    const m = raw as ToMemoryWorker;
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'turn-started':
        runner.turnStarted(m);
        return;
      case 'turn-ended':
        runner.turnEnded(m);
        return;
      case 'turn-model':
        runner.turnModel(m);
        return;
      case 'hello':
        if (m.lastModel) runner.turnModel(m.lastModel);
        return;
      default:
        return;
    }
  });

  // The app process closed the channel (quit, crash, reload): nothing left to
  // serve. Work in flight is owed in the database and re-seeded next start.
  process.on('disconnect', () => {
    runner.dispose();
    try {
      (store as unknown as { close?: () => void }).close?.();
    } catch {
      /* exiting anyway */
    }
    process.exit(0);
  });

  process.on('uncaughtException', (e) => {
    console.error(`[memory-worker] fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    // The supervisor restarts us and the queue re-seeds (R8).
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => {
    console.warn(`[memory-worker] unhandled rejection: ${e instanceof Error ? e.message : String(e)}`);
  });

  runner.reseed();
  send({ type: 'ready', pid: process.pid });
  console.log(`[memory-worker] ready (pid ${process.pid})`);
}

main();
