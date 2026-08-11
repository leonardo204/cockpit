// packages/feature/agent/src/server/lib/backgroundJobReport.ts
//
// NABY SPEAKS FIRST WHEN A BACKGROUND JOB ENDS.
//
// THE REPORT THIS EXISTS FOR. "배포하고 끝나면 알려줘." naby started the deploy,
// said "완료되면 알려드릴게요", and the turn ended. Then nothing — forever. The
// only path that ever let naby open its mouth after a turn was the scheduled-task
// manager, and the model cannot create a scheduled task.
//
// WHAT THIS IS. The shell half of `src/runtime/jobs.ts`. The runtime owns the
// child process and hears it exit; it cannot dispatch a turn (it has no sessions
// and no orchestrator), so it hands the ending to a `JobSink`. This module IS
// that sink, and what it does with an ending is start one ordinary turn.
//
// NO NEW TURN MACHINERY, for the same reason `fastGrowthKickoff` invented none:
// `dispatchChat(nabySpec, …)` is the entry point the chat route, the scheduler
// and the Telegram bridge all use, so the memory injection, the gate, the
// check-in sink, the unread badge, the push notification and the Telegram final
// report are all this turn's too, for free. A side door would be a report that
// behaved like nothing else in the app.
//
// THE ORDER MATTERS, AND IT IS COPIED DELIBERATELY. `reserveRun(sessionId)` is
// called SYNCHRONOUSLY before the first await (`startFastGrowthKickoff` explains
// why: a client attaching in the gap is told the session is idle, and then sits
// in front of an empty conversation while a turn it was never told about runs).
// Everything after it is fire-and-forget.
//
// THE PROMPT CARRIES NO OUTPUT. A build log is megabytes; pasting it into the
// prompt would blow the window on the one turn that has to read it. The model is
// given the ID and told to fetch what it needs with `naby_read_job_output`,
// which is also what makes the turn's reasoning visible in the transcript.
//
// IT IS NOT A POLLER. The trigger is the child process's own exit — an interrupt
// the OS delivers once. The one place a timer appears is `retryDelayMs`, and it
// exists for a single race: the user may be mid-conversation in that very session
// when the job lands, and `dispatchChat` refuses a second concurrent run (409).
// That is a BOUNDED retry of one specific dispatch, not a standing sweep: it
// stops at `MAX_DISPATCH_ATTEMPTS`, it only ever runs while a report is owed, and
// no report means no timer exists at all.

import {
  READ_JOB_OUTPUT_TOOL_NAME,
  type JobRecord,
} from '../../../../../../../dist/naby-runtime.mjs';
import { reserveRun, releaseRun } from '../sessionRunHub';

/** The `source` stamped on the run, so the activity log can tell a job report
 *  apart from something the user typed. */
export const JOB_REPORT_SOURCE = 'background-job';

/**
 * How many times the dispatch may be re-tried when the session is busy.
 *
 * The only expected refusal is the one-active-run-per-session guard, and the
 * thing it is waiting for is a turn a human is having right now. Five attempts
 * over ~2.5 minutes covers an ordinary exchange; past that the report is dropped
 * with a log line rather than queued forever, because a report that arrives after
 * the user has moved on is noise, and an unbounded retry is the standing loop
 * this design refuses to become.
 */
export const MAX_DISPATCH_ATTEMPTS = 5;

/** Gap between those attempts. */
export const DISPATCH_RETRY_MS = 30_000;

/** Start a turn. Production supplies `dispatchChat(nabySpec, …)`; a test supplies
 *  its own, so no model, key or network is involved. */
export type JobReportDispatch = (input: {
  sessionId: string;
  prompt: string;
  cwd?: string;
}) => Promise<{ ok: boolean; error?: string; status?: number }>;

export interface JobReportDeps {
  dispatch: JobReportDispatch;
  /** Overridable so a test does not wait 30 seconds to observe the retry. */
  retryDelayMs?: number;
  maxAttempts?: number;
  /** Injected so a test can observe the reservation renewal without the run hub. */
  reserve?: (sessionId: string) => void;
  log?: (msg: string) => void;
}

/** Why a report did not go out. For the log and the tests; the user never sees
 *  it (there is nothing to show them — the app is idle). */
export type JobReportOutcome =
  | { started: true; attempts: number }
  | {
      started: false;
      reason: 'no-session' | 'still-running' | 'busy' | 'refused' | 'threw';
      error?: string;
      attempts: number;
    };

// ---------------------------------------------------------------------------
// The prompt (pure)
// ---------------------------------------------------------------------------

/** Wall-clock duration in the shortest honest form. */
function humanDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * What the follow-up turn is asked to do.
 *
 * ENGLISH, like `DEFAULT_KICKOFF_TEXT`, because this server has no locale — the
 * persona mirrors the user's language when it answers, so an English instruction
 * still produces a Korean report for a Korean user.
 *
 * IT NAMES THE JOB AND NOTHING MORE. No stdout, no tail, no exit banner: the
 * model fetches what it needs, which keeps a 40MB test log out of a context
 * window and puts the fetch in the transcript where the user can see it.
 */
export function buildJobReportPrompt(job: JobRecord): string {
  const ended = job.endedAt ?? Date.now();
  const outcome =
    job.status === 'succeeded'
      ? 'finished successfully'
      : job.status === 'failed'
        ? `FAILED${job.exitCode !== undefined ? ` (exit ${job.exitCode})` : ''}`
        : job.status === 'killed'
          ? `was stopped${job.signal ? ` (${job.signal})` : ''}`
          : `ended with an unrecorded outcome (${job.status})`;
  return [
    `[system] The background job ${job.id} you started has ended — it ${outcome}.`,
    '',
    `  command: ${job.command}`,
    `  ran for: ${humanDuration(ended - job.startedAt)}`,
    ...(job.truncated ? ['  note: its output was long and the log was truncated.'] : []),
    ...(job.note ? [`  note: ${job.note}`] : []),
    '',
    `Read the end of its output with ${READ_JOB_OUTPUT_TOOL_NAME}("${job.id}") before you say`,
    'anything about it, then tell the user how it went: what you asked it to do, what',
    'actually happened, and — if it failed — what you would do next. Keep it short, and',
    'do not start new work unless they asked for it. The user did not send this message;',
    'they are being told because you promised to report back.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The dispatch
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Report one finished job into its own session, retrying only the busy-session
 * race. Awaitable for the tests; the sink does not await it.
 *
 * IT DOES NOT RELEASE THE RESERVATION on a failure — `makeJobSink` does, on
 * every path, exactly as `startFastGrowthKickoff` owns the release for
 * `kickoffFastGrowthSession`. One owner means the indicator can neither leak nor
 * be cleared twice.
 *
 * NEVER THROWS: every failure path answers with a reason.
 */
export async function reportFinishedJob(
  deps: JobReportDeps,
  job: JobRecord,
): Promise<JobReportOutcome> {
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const sessionId = job.sessionId;
  const maxAttempts = deps.maxAttempts ?? MAX_DISPATCH_ATTEMPTS;

  // A job started outside a conversation (a spike, a future CLI) has nowhere to
  // report to. It still ran and is still readable with naby_check_job.
  if (!sessionId) {
    return { started: false, reason: 'no-session', attempts: 0 };
  }
  // Defensive: the sink is only called on an ending, but a report about a job
  // that is still going would be a turn that states an outcome nobody has.
  if (job.status === 'running') {
    return { started: false, reason: 'still-running', attempts: 0 };
  }

  const prompt = buildJobReportPrompt(job);
  let attempts = 0;
  let lastError: string | undefined;
  for (;;) {
    attempts += 1;
    try {
      const outcome = await deps.dispatch({
        sessionId,
        prompt,
        ...(job.cwd ? { cwd: job.cwd } : {}),
      });
      if (outcome.ok) {
        log(`[jobs] reporting ${job.id} (${job.status}) into session ${sessionId}`);
        return { started: true, attempts };
      }
      lastError = outcome.status ? `${outcome.error} (${outcome.status})` : (outcome.error ?? 'refused');
      // 409 is the one-run-per-session guard: the user is talking to naby right
      // now. Everything else (no engine configured, a refused preflight) will not
      // improve by being asked again.
      const busy = outcome.status === 409;
      if (!busy) {
        log(`[jobs] report for ${job.id} refused: ${lastError}`);
        return { started: false, reason: 'refused', error: lastError, attempts };
      }
      if (attempts >= maxAttempts) {
        log(
          `[jobs] session ${sessionId} stayed busy for ${attempts} attempts; dropping the report for ${job.id}`,
        );
        return { started: false, reason: 'busy', error: lastError, attempts };
      }
      await sleep(deps.retryDelayMs ?? DISPATCH_RETRY_MS);
      // The reservation is renewed before each retry: it has a TTL, and a report
      // waiting out a long conversation must not let the indicator lapse and then
      // reappear.
      (deps.reserve ?? reserveRun)(sessionId);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      log(`[jobs] report for ${job.id} threw: ${why}`);
      return { started: false, reason: 'threw', error: why, attempts };
    }
  }
}

/**
 * The production dispatch: the ONE orchestrator every other turn goes through.
 *
 * The engine modules are imported HERE, inside the call, exactly as
 * `kickoffDispatch` does it — `/api/naby` is imported by every settings request,
 * and a static import would drag the engine composition root into requests that
 * only ever wanted to read a checkbox.
 */
export async function jobReportDispatch(): Promise<JobReportDispatch> {
  const [{ dispatchChat }, { nabySpec }] = await Promise.all([
    import('../engines/orchestrator'),
    import('../engines/naby'),
  ]);
  return async ({ sessionId, prompt, cwd }) => {
    const outcome = await dispatchChat(nabySpec, {
      source: JOB_REPORT_SOURCE,
      prompt,
      sessionId,
      ...(cwd ? { cwd } : {}),
      engine: 'naby',
    });
    return outcome.ok ? { ok: true } : { ok: false, error: outcome.error, status: outcome.status };
  };
}

/**
 * The sink the engine hands to the runtime's toolset.
 *
 * `onFinished` is SYNCHRONOUS and returns immediately — it is called from a
 * child process's `close` handler, and anything slow there would stall the
 * runtime's own bookkeeping. The reservation is made inside it, before the first
 * await, for the reason in the module header.
 */
export function makeJobSink(opts?: { dispatch?: () => Promise<JobReportDispatch> }): {
  onFinished(job: JobRecord): void;
} {
  return {
    onFinished(job: JobRecord): void {
      if (!job.sessionId) return;
      // Synchronous, before anything async: a client attaching in the gap must be
      // told a turn is coming rather than that the session is idle.
      reserveRun(job.sessionId);
      void (async () => {
        try {
          const dispatch = await (opts?.dispatch ?? jobReportDispatch)();
          const outcome = await reportFinishedJob({ dispatch }, job);
          if (!outcome.started) releaseRun(job.sessionId!);
        } catch (e) {
          releaseRun(job.sessionId!);
          console.warn(
            `[jobs] could not report ${job.id}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      })();
    },
  };
}
