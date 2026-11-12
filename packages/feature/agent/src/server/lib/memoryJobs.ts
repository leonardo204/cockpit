// packages/feature/agent/src/server/lib/memoryJobs.ts
//
// MEMORY WORK — what each queued job does, and how its model call is made
// (specs/memory-worker.md §1).
//
// The queue's RULES are the runtime's (`memory-work.ts`: coalescing, one job at a
// time, backoff, re-seed). The work itself is unchanged and lives where it always
// did — `runTurnMemoryReview`, `runMemorySummaries`, `runMemoryTidy`
// (memoryReview.ts) and `runReflectionSweep` (reflection.ts). This file is the
// glue between the two: one executor per job kind, and the MODEL PORT every
// executor's calls go through.
//
// THE PORT IS THE ONE DOOR TO A MODEL. Every memory call — the reflection judge,
// the review, the tidy, the summaries — is a `MemoryModelPort.call`. That single
// choke point is what lets the runner keep its three promises without touching
// the work: one call at a time (R2), a rate limit stops every call rather than
// just the one that met it (R5), and "calls today" counts every call (§2).
//
// WHERE A CALL RUNS (R1, R6). The descriptor (`MemoryJobModel`) travels; the
// backend is rebuilt from it. A SUBSCRIPTION call (the Claude Agent SDK) spawns a
// CLI process, so it runs in the memory process, at its lowered priority. A KEY
// call (or the ChatGPT subscription's token source) needs a secret that lives in
// the app process — the Electron main process holds the vault, and the key never
// crosses a process boundary (electron/boot.ts) — so that call is made THERE and
// only its answer travels back. `resolveMemoryCallRoute` is where that is decided,
// and it runs in the app process in both modes.

import {
  ClaudeAgentSdkEngine,
  isClaudeAgentSdkAvailable,
  MEMORY_SUMMARY_BATCH_CAP,
  MEMORY_SUMMARY_MIN_CHARS,
  MEMORY_SUMMARY_MIN_LINE_BREAKS,
  readLearningEnabled,
  runTierPromotion,
  runTierRetention,
  TIDY_BATCH_CAP,
  type MemoryJob,
  type MemoryJobKind,
  type MemoryJobModel,
  type TierStore,
} from '../../../../../../../dist/naby-runtime.mjs';
import {
  engineReviewer,
  readAutoApplySetting,
  resolveSessionReviewBackend,
  runMemorySummaries,
  runMemoryTidy,
  runTurnMemoryReview,
  REVIEW_BATCH_CAP,
  type MemoryReviewer,
  type MemoryReviewStore,
  type ReviewBackend,
} from './memoryReview';
import {
  modelReflectionJudge,
  ReflectionJudgeUnavailableError,
  resolveJudgeBackend,
  runReflectionSweep,
  REFLECTION_JUDGE_TIMEOUT_MS,
  type ReflectionStore,
} from './reflection';

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

export type MemoryPrompt = { system: string; user: string };

/** What a call is FOR, which decides what answers it. */
export type MemoryCallTarget =
  /** The review, tidy and summaries: the queuing turn's own backend (R38). */
  | { kind: 'session'; model: MemoryJobModel }
  /** The reflection judge: the user's provider choice, else the subscription
   *  (continuous-learning §4.4 — `resolveJudgeBackend`'s rule, unchanged). */
  | { kind: 'judge'; providerId?: string };

/** Nothing can answer this target. Not a failure of the call — there was none. */
export class MemoryModelUnavailableError extends Error {
  constructor(message = 'no model can answer this memory call') {
    super(message);
    this.name = 'MemoryModelUnavailableError';
  }
}

export type MemoryCallAnswer = { text: string; label: string };

export type MemoryModelPort = {
  call(target: MemoryCallTarget, prompt: MemoryPrompt, timeoutMs: number): Promise<MemoryCallAnswer>;
};

// ---------------------------------------------------------------------------
// Where a call runs (app-process side)
// ---------------------------------------------------------------------------

export type MemoryCallRoute =
  /** Spawn the Claude Agent SDK — in the memory process when there is one. */
  | { where: 'subscription'; accountId?: string; model?: string; label: string }
  /** Needs a secret this process holds: call it here. */
  | { where: 'here'; backend: ReviewBackend };

/**
 * Decide where a memory call runs. Runs in the APP process — it is the side that
 * can see the vault and the ChatGPT token source. Undefined: nothing can answer
 * (the review waits, R42; the judge throws, continuous-learning §4.9).
 */
export async function resolveMemoryCallRoute(target: MemoryCallTarget): Promise<MemoryCallRoute | undefined> {
  if (target.kind === 'session') {
    const m = target.model;
    if (m.engineId === 'dev-claude') {
      if (!isClaudeAgentSdkAvailable()) return undefined;
      return {
        where: 'subscription',
        ...(m.accountId ? { accountId: m.accountId } : {}),
        ...(m.model ? { model: m.model } : {}),
        label: `claude-agent-sdk (subscription${m.model ? ` ${m.model}` : ''})`,
      };
    }
    const backend = await resolveSessionReviewBackend(m);
    return backend ? { where: 'here', backend } : undefined;
  }
  const judge = await resolveJudgeBackend(target.providerId ? { providerId: target.providerId } : {});
  if (!judge) return undefined;
  // The judge's own subscription fallback names no account, and the background
  // model `resolveJudgeBackend` builds it with.
  if (judge.model.providerId === 'dev-claude') {
    return {
      where: 'subscription',
      ...(judge.model.model ? { model: judge.model.model } : {}),
      label: judge.label,
    };
  }
  return { where: 'here', backend: { engine: () => judge.engine, model: judge.model, label: judge.label } };
}

/** Make a subscription call in THIS process (the memory process, normally). */
export function callSubscription(
  route: Extract<MemoryCallRoute, { where: 'subscription' }>,
  prompt: MemoryPrompt,
  timeoutMs: number,
): Promise<string> {
  return engineReviewer(
    {
      // Toolless: a memory call is answered in one text reply.
      engine: () =>
        new ClaudeAgentSdkEngine({ toolless: true, ...(route.accountId ? { accountId: route.accountId } : {}) }),
      model: { providerId: 'dev-claude', ...(route.model ? { model: route.model } : {}) },
      label: route.label,
    },
    { timeoutMs },
  ).call(prompt);
}

/** Make a call whose backend this process holds. */
export function callHere(backend: ReviewBackend, prompt: MemoryPrompt, timeoutMs: number): Promise<string> {
  return engineReviewer(backend, { timeoutMs }).call(prompt);
}

/** Everything in one process — the in-process fallback, and the test seams. */
export function localMemoryModelPort(): MemoryModelPort {
  return {
    async call(target, prompt, timeoutMs) {
      const route = await resolveMemoryCallRoute(target);
      if (!route) throw new MemoryModelUnavailableError();
      if (route.where === 'subscription') {
        return { text: await callSubscription(route, prompt, timeoutMs), label: route.label };
      }
      return { text: await callHere(route.backend, prompt, timeoutMs), label: route.backend.label };
    },
  };
}

// ---------------------------------------------------------------------------
// The executors
// ---------------------------------------------------------------------------

/** The store a job needs: the review slice plus what the sweep reads. A real
 *  `SqliteStore` is both. */
export type MemoryWorkStore = MemoryReviewStore & ReflectionStore & TierStore;

export type MemoryJobContext = {
  store: MemoryWorkStore;
  job: MemoryJob;
  /** The reviewer for the job's turn model, or undefined when there is none —
   *  the work then waits exactly as it always did without a model (R22, R42). */
  reviewer: MemoryReviewer | undefined;
  /** The port, for the reflection judge (which resolves its own backend). */
  port: MemoryModelPort;
  now: number;
};

export type MemoryJobOutcome = {
  /** Counts for "최근 완료" — numbers only, never content. */
  counts: Record<string, number>;
  /** Kinds this job leaves owed (the sweep's review/tidy/summaries, the
   *  review's summaries). Queued after it with its model. */
  followups?: MemoryJobKind[];
  /** The job could not do its work. */
  failed?: 'no-model' | 'failed';
};

export type MemoryJobExecutor = (ctx: MemoryJobContext) => Promise<MemoryJobOutcome>;

/** A reviewer whose every call goes through the port, on the turn's backend. */
export function portReviewer(port: MemoryModelPort, model: MemoryJobModel): MemoryReviewer {
  const reviewer: MemoryReviewer = {
    label: `${model.engineId} (${model.providerId}${model.model ? ` ${model.model}` : ''})`,
    async call(prompt) {
      const answer = await port.call({ kind: 'session', model }, prompt, MEMORY_CALL_TIMEOUT_MS);
      reviewer.label = answer.label;
      return answer.text;
    },
  };
  return reviewer;
}

/** One review/tidy/summary call (memoryReview.ts `MEMORY_REVIEW_TIMEOUT_MS`). */
const MEMORY_CALL_TIMEOUT_MS = 60_000;

const reviewJob: MemoryJobExecutor = async ({ store, job, reviewer }) => {
  const r = await runTurnMemoryReview(store, reviewer, job.sessionId ? { sessionId: job.sessionId } : {});
  return {
    counts: {
      reviewed: r.reviewed,
      applied: r.applied,
      merged: r.merged,
      refined: r.refined,
      superseded: r.superseded,
      held: r.held,
      waiting: r.waiting,
    },
    // The summaries rode in the same fire-and-forget pass as the review before
    // the queue existed; now they are their own job behind it. With the switch
    // off there are none (R48). memory-tiers: what the review confirmed or
    // merged may now be due for promotion.
    ...(r.skipped === 'auto-apply-off' ? { followups: ['promote'] } : { followups: ['summary', 'promote'] }),
    ...(r.failed ? { failed: reviewer ? 'failed' : 'no-model' } : {}),
  } as MemoryJobOutcome;
};

const summaryJob: MemoryJobExecutor = async ({ store, reviewer }) => {
  if (!readAutoApplySetting(store)) return { counts: { written: 0 } };
  if (!reviewer) return { counts: { written: 0 }, failed: 'no-model' };
  return { counts: { written: await runMemorySummaries(store, reviewer) } };
};

const tidyJob: MemoryJobExecutor = async ({ store, reviewer, now }) => {
  // R15: the tidy pass does not run with learning off — the same gate the sweep
  // applied when the tidy rode at its end.
  if (!safeLearningEnabled(store)) return { counts: { reviewed: 0 } };
  const t = await runMemoryTidy(store, reviewer, { now });
  return {
    counts: {
      reviewed: t.reviewed,
      equivalent: t.equivalent,
      refines: t.refines,
      contradicts: t.contradicts,
    },
    ...(t.skipped === 'no-model' ? { failed: 'no-model' } : t.failed ? { failed: 'failed' } : {}),
  } as MemoryJobOutcome;
};

const reflectionJob: MemoryJobExecutor = async ({ store, job, port }) => {
  // The judge's call goes through the port — so it is counted, serialized and
  // backed off like every other memory call — on the provider the user picked,
  // read inside `modelReflectionJudge` from this very store.
  const judge = modelReflectionJudge(store, async (prompt, providerId) => {
    try {
      return (
        await port.call({ kind: 'judge', ...(providerId ? { providerId } : {}) }, prompt, REFLECTION_JUDGE_TIMEOUT_MS)
      ).text;
    } catch (e) {
      if (e instanceof MemoryModelUnavailableError) throw new ReflectionJudgeUnavailableError(e.message);
      throw e;
    }
  });
  // NO REVIEWER IS HANDED TO THE SWEEP. Its review, tidy and summaries used to
  // ride at its end inside the same call; now they are queued behind it as their
  // own jobs (R2), under the same gate the sweep applied (`autoApply` with
  // learning on).
  const sweep = await runReflectionSweep(store, judge, {
    ...(job.excludeSessionId ? { excludeSessionId: job.excludeSessionId } : {}),
  });
  const owed = safeLearningEnabled(store) && readAutoApplySetting(store);
  return {
    counts: {
      sessions: sweep.sweptSessions,
      proposed: sweep.proposedMemories,
      corrections: sweep.markedEvents,
    },
    ...(owed ? { followups: ['review', 'tidy', 'summary', 'promote'] } : { followups: ['promote'] }),
  };
};

/** memory-tiers §3: promotion short → long → anchored, from observations. No
 *  model. Runs with learning off too — it moves no new knowledge in, it only
 *  re-labels what the user already has (and an anchoring is announced, R6). */
const promoteJob: MemoryJobExecutor = async ({ store, now }) => {
  const r = runTierPromotion(store, now);
  return { counts: { long: r.long, anchored: r.anchored, full: r.full } };
};

/** memory-tiers §4: archive due rows, delete rows past their 30 days (R8–R14).
 *  No model. */
const archiveJob: MemoryJobExecutor = async ({ store, now }) => {
  const r = runTierRetention(store, now);
  return { counts: { archived: r.archived, purged: r.purged } };
};

function safeLearningEnabled(store: MemoryWorkStore): boolean {
  try {
    return readLearningEnabled(store);
  } catch {
    // An unreadable switch means "do not learn" (reflection.ts, the same reading).
    return false;
  }
}

export const MEMORY_JOB_EXECUTORS: Readonly<Record<string, MemoryJobExecutor>> = {
  review: reviewJob,
  summary: summaryJob,
  tidy: tidyJob,
  reflection: reflectionJob,
  promote: promoteJob,
  archive: archiveJob,
};

// ---------------------------------------------------------------------------
// Sizes — "새 기억 3개 검수 중" and the backlog line. Counts only.
// ---------------------------------------------------------------------------

/** The backlog is counted up to this; the screen shows "100+" beyond it. */
export const MEMORY_BACKLOG_COUNT_CAP = 100;

/** How many rows the job about to run will look at. */
export function memoryJobSize(store: MemoryWorkStore, job: MemoryJob): number | undefined {
  try {
    switch (job.kind) {
      case 'review':
        return store.listPendingReviewMemory({
          ...(job.sessionId ? { sessionId: job.sessionId } : {}),
          limit: REVIEW_BATCH_CAP,
        }).length;
      case 'summary':
        return store.listMemoryToSummarize(MEMORY_SUMMARY_BATCH_CAP, MEMORY_SUMMARY_MIN_CHARS, MEMORY_SUMMARY_MIN_LINE_BREAKS)
          .length;
      case 'tidy':
        return store.listUnreviewedMemory(TIDY_BATCH_CAP).length;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/** What the database says is owed (R8) — the re-seed's input and the status line. */
export function readMemoryBacklog(store: MemoryWorkStore): {
  pendingReview: number;
  toSummarize: number;
  unreviewed: number;
  tiers: boolean;
} {
  const count = (read: () => readonly unknown[]): number => {
    try {
      return read().length;
    } catch {
      return 0;
    }
  };
  return {
    pendingReview: count(() => store.listPendingReviewMemory({ limit: MEMORY_BACKLOG_COUNT_CAP })),
    toSummarize: count(() =>
      store.listMemoryToSummarize(MEMORY_BACKLOG_COUNT_CAP, MEMORY_SUMMARY_MIN_CHARS, MEMORY_SUMMARY_MIN_LINE_BREAKS),
    ),
    unreviewed: count(() => store.listUnreviewedMemory(MEMORY_BACKLOG_COUNT_CAP)),
    // memory-tiers: the promotion and retention passes run once at start (and
    // daily after, see the runner) whenever the store can answer them.
    tiers: typeof (store as Partial<TierStore>).listTieredMemory === 'function',
  };
}
