// packages/feature/agent/src/server/lib/memoryWorkerProtocol.ts
//
// The messages between the app process and the memory process
// (specs/memory-worker.md R1). JSON over the fork IPC channel; nothing here can
// carry a function, a store handle or a key.

import type { MemoryJobModel, MemoryWorkStatus } from '../../../../../../../dist/naby-runtime.mjs';
import type { MemoryCallRoute, MemoryCallTarget, MemoryPrompt } from './memoryJobs';

/** App process → memory process. */
export type ToMemoryWorker =
  | { type: 'turn-started'; sessionId: string; model?: MemoryJobModel }
  | { type: 'turn-ended'; sessionId: string; model?: MemoryJobModel; autoApply: boolean }
  | { type: 'turn-model'; sessionId: string; model: MemoryJobModel }
  /** After every (re)start: the latest turn's model, so re-seeded jobs can run
   *  without waiting for the next turn (R8, R38). */
  | { type: 'hello'; lastModel?: { sessionId: string; model: MemoryJobModel } }
  | ({ type: 'call-result'; id: number } & MemoryCallReply);

/** Memory process → app process. */
export type FromMemoryWorker =
  | { type: 'ready'; pid: number }
  | { type: 'status'; status: MemoryWorkStatus }
  /** A model call the memory process cannot make itself — it needs a secret the
   *  app process holds (memoryJobs.ts, "WHERE A CALL RUNS"). */
  | { type: 'call'; id: number; target: MemoryCallTarget; prompt: MemoryPrompt; timeoutMs: number };

/** The app process's answer to a `call`. */
export type MemoryCallReply =
  | { text: string; label: string }
  /** A subscription call: make it yourself, at your own priority. */
  | { local: Extract<MemoryCallRoute, { where: 'subscription' }> }
  | { unavailable: true }
  | { error: string; rateLimited: boolean };

/** Set in the memory process's environment, so its entry can refuse to run as
 *  anything else and the app process can recognise its own child. */
export const MEMORY_WORKER_CHILD_ENV = 'NABY_MEMORY_WORKER_CHILD';

/** `off` (or `in-process`) keeps memory work in the app process — the test
 *  setup sets it, and it is the manual escape hatch. */
export const MEMORY_WORKER_MODE_ENV = 'NABY_MEMORY_WORKER';

/** The built entry's file name, next to the shell's other server bundles. */
export const MEMORY_WORKER_SCRIPT = 'memoryWorker.mjs';
