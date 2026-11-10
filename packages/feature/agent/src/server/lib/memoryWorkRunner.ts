// packages/feature/agent/src/server/lib/memoryWorkRunner.ts
//
// THE MEMORY QUEUE, RUNNING (specs/memory-worker.md R2/R5/R8, §2).
//
// One runner per process that does memory work: normally the memory process
// (memoryWorkerMain.ts), and the app process itself only when that process could
// not be started (memoryWorker.ts) or a test injected its own reviewer. Either
// way it is the same object doing the same thing, so the fallback is not a second
// implementation that can drift.
//
// What it does, and nothing more:
//
//   * turns "a turn started / ended" into jobs (R9: the sweep is queued at a
//     turn's start, the review at its end) and keeps them coalesced by kind;
//   * runs ONE job at a time, and through the guarded port ONE model call at a
//     time (R2);
//   * on a rate limit, puts the job back with its next window and holds every
//     other model call until that window passes (R5);
//   * keeps the counts the settings row shows (§2) — kinds, sizes, codes, the
//     backend label, calls today. Never a memory's text.
//
// The queue's rules are the runtime's pure functions (memory-work.ts); each job's
// work is its executor (memoryJobs.ts). This file is the loop between them.

import {
  countMemoryJobs,
  deferMemoryJob,
  enqueueMemoryJob,
  isMemoryRateLimitError,
  memoryCallDay,
  memoryJobCallsModel,
  memoryJobNeedsTurnModel,
  memoryWorkState,
  nextMemoryWakeAt,
  pickNextMemoryJob,
  reseedMemoryJobs,
  type MemoryBacklog,
  type MemoryFailureReason,
  type MemoryJob,
  type MemoryJobKind,
  type MemoryJobModel,
  type MemoryWorkStatus,
} from '../../../../../../../dist/naby-runtime.mjs';
import type { MemoryReviewer } from './memoryReview';
import {
  MEMORY_JOB_EXECUTORS,
  MemoryModelUnavailableError,
  memoryJobSize,
  portReviewer,
  readMemoryBacklog,
  type MemoryCallTarget,
  type MemoryJobExecutor,
  type MemoryModelPort,
  type MemoryPrompt,
  type MemoryWorkStore,
} from './memoryJobs';

/** Where "calls today" is kept, so a restarted memory process keeps counting. */
export const MEMORY_WORK_CALLS_KEY = 'memory.work.calls';

/** Raised by the guarded port while a rate limit is in force — the call was not
 *  made. Its message reads as a rate limit so every catch upstream agrees. */
export class MemoryCallHeldError extends Error {
  constructor() {
    super('memory calls are held: rate limit in force');
    this.name = 'MemoryCallHeldError';
  }
}

export type TurnNotice = {
  sessionId: string;
  /** The turn's backend descriptor (R6). Absent on the test seams, where there
   *  is no backend to rebuild. */
  model?: MemoryJobModel;
  /** In-process only: a test's reviewer, used instead of the port for the
   *  review/tidy/summaries this notice queues. */
  reviewer?: MemoryReviewer;
};

export type MemoryWorkRunnerOptions = {
  store: MemoryWorkStore;
  port: MemoryModelPort;
  mode: 'worker' | 'in-process';
  now?: () => number;
  /** Every status change, for the supervisor (worker mode posts it). */
  onStatus?: (status: MemoryWorkStatus) => void;
  /** Test seam: replace one kind's work. */
  executors?: Readonly<Record<string, MemoryJobExecutor>>;
};

export class MemoryWorkRunner {
  private queue: MemoryJob[] = [];
  private running: { job: MemoryJob; startedAt: number; size?: number } | undefined;
  /** The latest descriptor per originating session, so a job runs on the model
   *  its turn ended up using (the router decides mid-turn), read at RUN time —
   *  the same "read at call time" the in-turn reviewer closure had. */
  private readonly sessionModels = new Map<string, MemoryJobModel>();
  /** The latest turn's descriptor: what a re-seeded job runs on (R38). */
  private lastModel: MemoryJobModel | undefined;
  private reviewerOverride: MemoryReviewer | undefined;
  private blockedUntil = 0;
  private rateLimitedThisJob = false;
  /** A call this job made found nothing to answer it — reported as "no model",
   *  not as a failed job, even though the work swallowed the error (R42). */
  private unavailableThisJob = false;
  private callChain: Promise<unknown> = Promise.resolve();
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private idleWaiters: Array<() => void> = [];
  private backlog: MemoryBacklog | undefined;
  private lastDone: MemoryWorkStatus['lastDone'];
  private lastFailure: MemoryWorkStatus['lastFailure'];
  private modelLabel: string | undefined;
  private disposed = false;
  private readonly now: () => number;
  private readonly executors: Readonly<Record<string, MemoryJobExecutor>>;
  /** The port every executor sees: serialized, held on a rate limit, counted. */
  private readonly guardedPort: MemoryModelPort;

  constructor(private readonly opts: MemoryWorkRunnerOptions) {
    this.now = opts.now ?? Date.now;
    this.executors = { ...MEMORY_JOB_EXECUTORS, ...(opts.executors ?? {}) };
    this.guardedPort = { call: (target, prompt, timeoutMs) => this.guardedCall(target, prompt, timeoutMs) };
  }

  // -------------------------------------------------------------------------
  // Notices from the app process
  // -------------------------------------------------------------------------

  /** A turn started: queue the reflection sweep (R9), excluding that session. */
  turnStarted(n: TurnNotice): void {
    this.noteModel(n);
    this.enqueue({
      kind: 'reflection',
      sessionId: n.sessionId,
      excludeSessionId: n.sessionId,
      ...(n.model ? { model: n.model } : {}),
      reason: 'turn',
      enqueuedAt: this.now(),
      attempts: 0,
      notBefore: 0,
    });
  }

  /** A turn ended: queue the review of what it wrote (memory-auto-apply R37). */
  turnEnded(n: TurnNotice & { autoApply: boolean }): void {
    this.noteModel(n);
    if (!n.autoApply) {
      this.emit();
      return;
    }
    this.enqueue({
      kind: 'review',
      sessionId: n.sessionId,
      ...(n.model ? { model: n.model } : {}),
      reason: 'turn',
      enqueuedAt: this.now(),
      attempts: 0,
      notBefore: 0,
    });
  }

  /** The turn's model became known (the router chose it mid-turn). */
  turnModel(n: { sessionId: string; model: MemoryJobModel }): void {
    this.noteModel(n);
    // A model arriving can make waiting jobs runnable (R8a: re-seeded work waits
    // for the first turn's model), so look at the queue again — emitting alone
    // relied on a pump that happened to still be pending.
    this.schedule();
  }

  private noteModel(n: { sessionId: string; model?: MemoryJobModel; reviewer?: MemoryReviewer }): void {
    if (n.model) {
      this.sessionModels.set(n.sessionId, n.model);
      this.lastModel = n.model;
    }
    if (n.reviewer) this.reviewerOverride = n.reviewer;
  }

  /** R8: queue what the database says is owed. Called once at process start. */
  reseed(): void {
    this.backlog = readMemoryBacklog(this.opts.store);
    for (const job of reseedMemoryJobs(this.backlog, this.now())) this.queue = enqueueMemoryJob(this.queue, job);
    // memory-tiers: from here on the retention pass runs once per local day
    // (the first job to finish on a new day queues it).
    if (this.backlog.tiers) this.tierDay = memoryCallDay(this.now());
    this.schedule();
  }

  /** The local day the retention pass was last queued for; undefined until a
   *  re-seed armed it (a runner that never re-seeded has no daily pass). */
  private tierDay: string | undefined;

  /** memory-tiers: queue the daily retention pass on a new local day. */
  private armDailyTiers(now: number): void {
    if (this.tierDay === undefined) return;
    const day = memoryCallDay(now);
    if (day === this.tierDay) return;
    this.tierDay = day;
    this.queue = enqueueMemoryJob(this.queue, {
      kind: 'archive',
      reason: 'reseed',
      enqueuedAt: now,
      attempts: 0,
      notBefore: 0,
    });
  }

  enqueue(job: MemoryJob): void {
    if (this.disposed) return;
    this.queue = enqueueMemoryJob(this.queue, job);
    this.schedule();
  }

  // -------------------------------------------------------------------------
  // The loop
  // -------------------------------------------------------------------------

  private schedule(): void {
    this.emit();
    // Off the caller's stack: a notice from a turn returns at once, always.
    setImmediate(() => void this.pump());
  }

  private effectiveModel(job: MemoryJob): MemoryJobModel | undefined {
    return (job.sessionId ? this.sessionModels.get(job.sessionId) : undefined) ?? job.model ?? this.lastModel;
  }

  private async pump(): Promise<void> {
    if (this.disposed || this.running) return;
    const now = this.now();
    // With a test's reviewer in hand every job is runnable — the reviewer IS
    // the model. Otherwise a job needing a turn model waits for one.
    const fallback = this.lastModel ?? (this.reviewerOverride ? { engineId: 'injected', providerId: 'injected' } : undefined);
    const pick = pickNextMemoryJob(this.queue, {
      now,
      running: false,
      ...(fallback ? { fallbackModel: fallback } : {}),
      blockedUntil: this.blockedUntil,
    });
    if (!pick) {
      this.armWake(now);
      this.emit();
      this.flushIdle();
      return;
    }
    this.queue = pick.rest;
    const job = pick.job;
    this.running = { job, startedAt: now, size: memoryJobSize(this.opts.store, job) };
    this.rateLimitedThisJob = false;
    this.unavailableThisJob = false;
    this.emit();

    const model = this.effectiveModel(job);
    const reviewer = this.reviewerOverride ?? (model ? portReviewer(this.guardedPort, model) : undefined);
    const executor = this.executors[job.kind];
    let failure: MemoryFailureReason | undefined;
    let outcome: Awaited<ReturnType<MemoryJobExecutor>> | undefined;
    try {
      if (!executor) throw new Error(`no executor for memory job kind ${job.kind}`);
      outcome = await executor({ store: this.opts.store, job, reviewer, port: this.guardedPort, now });
      if (outcome.failed) failure = outcome.failed === 'no-model' || this.unavailableThisJob ? 'no-model' : 'failed';
    } catch (e) {
      if (isMemoryRateLimitError(e)) this.rateLimitedThisJob = true;
      else if (e instanceof MemoryModelUnavailableError) failure = 'no-model';
      else failure = 'failed';
      console.warn(`[memory-work] ${job.kind} failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const done = this.now();
    if (this.rateLimitedThisJob) {
      // R5: back off THIS job on its own schedule, and hold every model call
      // until its window passes. The work it did not finish is still owed in the
      // database, so putting the job back loses nothing.
      const deferred = deferMemoryJob(job, done);
      this.blockedUntil = deferred.notBefore;
      this.queue = enqueueMemoryJob(this.queue, deferred);
      this.lastFailure = { kind: job.kind, at: done, reason: 'rate-limited', retryAt: deferred.notBefore };
      console.warn(`[memory-work] ${job.kind} rate-limited — retry in ${Math.round((deferred.notBefore - done) / 1000)}s`);
    } else {
      if (failure) this.lastFailure = { kind: job.kind, at: done, reason: failure };
      // A tier pass that found nothing to do is not news: it would push the
      // review's "2개 적용" off the status line with "0개 승격" after every turn.
      else if (memoryJobCallsModel(job.kind) || Object.values(outcome?.counts ?? {}).some((n) => n > 0)) {
        this.lastDone = { kind: job.kind, at: done, counts: outcome?.counts ?? {} };
      }
      for (const kind of outcome?.followups ?? []) {
        this.queue = enqueueMemoryJob(this.queue, {
          kind,
          ...(job.sessionId ? { sessionId: job.sessionId } : {}),
          ...(job.model ? { model: job.model } : {}),
          reason: 'followup',
          enqueuedAt: done,
          attempts: 0,
          notBefore: 0,
        });
      }
    }
    this.running = undefined;
    this.armDailyTiers(done);
    this.backlog = readMemoryBacklog(this.opts.store);
    this.emit();
    setImmediate(() => void this.pump());
  }

  private armWake(now: number): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    const at = nextMemoryWakeAt(this.queue, now, this.blockedUntil);
    if (at === undefined) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      void this.pump();
    }, Math.max(0, at - now));
    // A waiting backoff must never keep a process alive on its own.
    this.wakeTimer.unref?.();
  }

  // -------------------------------------------------------------------------
  // The one door to a model
  // -------------------------------------------------------------------------

  private guardedCall(target: MemoryCallTarget, prompt: MemoryPrompt, timeoutMs: number) {
    // Serialized: a call starts only after the previous one settled (R2). The
    // runner already runs one job at a time; this makes it true of CALLS too,
    // whatever an executor does inside.
    const run = async () => {
      if (this.rateLimitedThisJob || this.blockedUntil > this.now()) throw new MemoryCallHeldError();
      this.countCall();
      this.emit();
      try {
        const answer = await this.opts.port.call(target, prompt, timeoutMs);
        this.modelLabel = answer.label;
        return answer;
      } catch (e) {
        // Seen HERE, not in the executor: the review and the summaries swallow
        // their own errors (a failed review simply waits, R42), so without the
        // port noticing, a 429 would read as an ordinary miss and the next job
        // would call straight back into the limit.
        if (isMemoryRateLimitError(e)) this.rateLimitedThisJob = true;
        else if (e instanceof MemoryModelUnavailableError) this.unavailableThisJob = true;
        throw e;
      }
    };
    const next = this.callChain.then(run, run);
    this.callChain = next.catch(() => undefined);
    return next;
  }

  private countCall(): void {
    const day = memoryCallDay(this.now());
    const current = this.readCalls();
    const count = current.day === day ? current.count + 1 : 1;
    try {
      this.opts.store.setSetting(MEMORY_WORK_CALLS_KEY, JSON.stringify({ day, count }));
    } catch {
      // A count that could not be written is a display miss, never a reason to
      // stop the call.
    }
    this.callsCache = { day, count };
  }

  private callsCache: { day: string; count: number } | undefined;

  private readCalls(): { day: string; count: number } {
    if (this.callsCache) return this.callsCache;
    try {
      const raw = this.opts.store.getSetting(MEMORY_WORK_CALLS_KEY);
      const parsed = raw ? (JSON.parse(raw) as { day?: unknown; count?: unknown }) : {};
      if (typeof parsed.day === 'string' && typeof parsed.count === 'number') {
        this.callsCache = { day: parsed.day, count: parsed.count };
        return this.callsCache;
      }
    } catch {
      /* unreadable → zero */
    }
    return { day: '', count: 0 };
  }

  // -------------------------------------------------------------------------
  // Status (§2)
  // -------------------------------------------------------------------------

  status(): MemoryWorkStatus {
    const now = this.now();
    const calls = this.readCalls();
    const nextRetryAt = nextMemoryWakeAt(this.queue, now, this.blockedUntil);
    const state = memoryWorkState(this.queue, this.running !== undefined);
    const noModel =
      !this.lastModel && !this.reviewerOverride && this.queue.some((j) => memoryJobNeedsTurnModel(j.kind) && !j.model);
    return {
      mode: this.opts.mode,
      state,
      ...(this.running
        ? {
            current: {
              kind: this.running.job.kind,
              startedAt: this.running.startedAt,
              ...(this.running.size !== undefined ? { size: this.running.size } : {}),
            },
          }
        : {}),
      queued: countMemoryJobs(this.queue),
      ...(this.backlog ? { backlog: this.backlog } : {}),
      ...(nextRetryAt !== undefined ? { nextRetryAt } : {}),
      ...(state === 'waiting'
        ? nextRetryAt !== undefined
          ? { waitingFor: 'backoff' as const }
          : noModel
            ? { waitingFor: 'turn-model' as const }
            : {}
        : {}),
      ...(this.lastDone ? { lastDone: this.lastDone } : {}),
      ...(this.lastFailure ? { lastFailure: this.lastFailure } : {}),
      ...(this.modelLabel ? { model: this.modelLabel } : {}),
      callsToday: calls.day === memoryCallDay(now) ? calls.count : 0,
    };
  }

  private emit(): void {
    try {
      this.opts.onStatus?.(this.status());
    } catch {
      /* a status listener never breaks the loop */
    }
  }

  /** Resolves once nothing is running and nothing runnable is waiting (tests,
   *  and the in-process `settle`). A job held by a backoff does not count. */
  idle(): Promise<void> {
    if (!this.running && (this.queue.length === 0 || !this.hasRunnableNow())) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private hasRunnableNow(): boolean {
    const fallback = this.lastModel ?? (this.reviewerOverride ? { engineId: 'injected', providerId: 'injected' } : undefined);
    return (
      pickNextMemoryJob(this.queue, {
        now: this.now(),
        running: false,
        ...(fallback ? { fallbackModel: fallback } : {}),
        blockedUntil: this.blockedUntil,
      }) !== undefined
    );
  }

  private flushIdle(): void {
    if (this.running) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  /** Look at the queue again now — a clock moved, or a test advanced one. */
  poke(): void {
    this.schedule();
  }

  /** Kinds waiting, for tests. */
  queuedKinds(): MemoryJobKind[] {
    return this.queue.map((j) => j.kind);
  }

  dispose(): void {
    this.disposed = true;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.flushIdle();
  }
}
