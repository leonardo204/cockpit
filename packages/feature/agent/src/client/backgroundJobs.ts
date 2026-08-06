import type { ToolCallInfo } from './types';
import { type SubagentTask, isBackgroundTask } from './subagentGroups';

/**
 * A JOB THAT KEEPS RUNNING AFTER THE TOOL CALL RETURNS.
 *
 * THE BUG THIS IS ABOUT. The model backgrounded a deploy script (`Bash` with
 * `run_in_background`). The transcript showed the Bash row — which came back
 * INSTANTLY, because the tool result is only "started, id b-3f21, output going
 * to …" — and a sentence saying the deploy had been started in the background.
 * After that: nothing. No row said a job was still running, none said when it
 * finished, and the only honest reading of the screen was that the work was
 * over. A tool call that returns before its work does is the one shape the
 * transcript's ordinary "call → result" vocabulary cannot express.
 *
 * The backend does report it: a background shell job is registered as a TASK and
 * reports on the same four edges a delegated subagent does (`task_started` /
 * `_progress` / `_updated` / `_notification`), carrying its own id and the id of
 * the call that spawned it. What it does NOT carry is a `subagent_type` — the
 * kind is `task_type: 'local_bash'` — which is exactly why those events used to
 * be either invisible or mislabelled.
 *
 * This module is the pure part: given a turn's tool calls and whatever lifecycle
 * the backend reported, decide which jobs exist, what each one is running, and
 * where in the turn it was launched. No React, no i18n.
 *
 * TWO SOURCES, ONE RULE — NEVER GUESS A STATE.
 *   * LIVE: the lifecycle says the job is running / completed / failed / stopped.
 *   * RELOADED: the lifecycle is transport and is never persisted, so a reopened
 *     transcript has only the calls. A background launch is still recognisable
 *     (the call's own input says `run_in_background`), so the block still appears
 *     with its command — but its status is `unknown` and stays that way. The
 *     spawning call's RESULT proves nothing here: for a background job it is the
 *     launch acknowledgement, not the outcome, so treating "has a result" as
 *     "finished" (which is the right rule for a `Task` call) would state an
 *     outcome nobody recorded.
 *
 * AND THE TURN'S END IS THE END OF WHAT WE KNOW. The runtime drives one turn per
 * `query()` and the backend process winds down when that turn produces its
 * result, so an ending edge can only arrive while the turn is still going. A job
 * that had not reported back by then is therefore not "still running" as far as
 * anything on this screen can tell — it is unrecorded, and it says so. Leaving a
 * spinner and a climbing clock on a finished turn would be the same lie in a new
 * shape: the block would insist a deploy was in flight hours after nothing was
 * listening for it.
 */

/** Where a background job has got to. `unknown` is honest: a reloaded transcript
 *  has no lifecycle, and the launch acknowledgement is not an outcome. */
export type BackgroundJobStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'unknown';

/** One background job: what it runs, how it is going, and where it started. */
export interface BackgroundJob {
  /** The backend's task id when a lifecycle edge was seen; otherwise
   *  `call:<toolCallId>` — on a reloaded transcript the spawning call is the
   *  only identity the job has. Stable either way, and unique per job, so two
   *  concurrent jobs are two blocks. */
  id: string;
  status: BackgroundJobStatus;
  /** The command line, as one display line. Taken from the SPAWNING CALL's own
   *  input — never from the lifecycle event, which deliberately carries no free
   *  text (the runtime's rule: ids and enums cross the seam, project content
   *  does not). */
  command?: string;
  /** The model's own words for the job (the Bash tool's `description`). */
  description?: string;
  /** Epoch ms, from the runtime's own observation of the opening edge. */
  startedAt?: number;
  /** Epoch ms, from the runtime's observation of the ending edge. */
  endedAt?: number;
  /** The call that launched it — folded in here so it stops sitting in the
   *  generic batch looking like an ordinary command that already finished. */
  spawningCall?: ToolCallInfo;
}

export interface BackgroundPartition {
  /** The calls that are still the turn's own — every spawning call folded into a
   *  job above has been removed. */
  calls: ToolCallInfo[];
  /** The lifecycle records that are NOT background jobs, for the subagent
   *  grouping that runs next. */
  tasks: SubagentTask[];
  /** One block per job, in the order the jobs appear in the turn. */
  jobs: BackgroundJob[];
}

/** How much of a command line a block shows before it gets in the way of the
 *  rest of the row. Long enough for a real command (`npm run deploy -- --prod`),
 *  short enough that the status stays readable beside it. */
export const MAX_COMMAND_CHARS = 120;

/**
 * Whether a tool call is a BACKGROUND LAUNCH, by its own input.
 *
 * Keyed on the flag rather than on the tool's NAME: `run_in_background` is what
 * makes the call return before its work does, and it is the same flag whatever
 * the shell tool ends up being called. A missing/false flag is an ordinary call.
 *
 * This is also the only signal a RELOADED transcript has — tool call inputs are
 * persisted, lifecycle events are not.
 */
export function isBackgroundLaunch(call: ToolCallInfo | undefined): boolean {
  return call?.input?.run_in_background === true;
}

/**
 * The command line as ONE line: newlines collapsed, truncated at the display
 * limit. A heredoc or a `&&` chain is often several lines long and would
 * otherwise push the status off the row.
 */
export function formatJobCommand(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const firstLine = raw.split('\n')[0] ?? '';
  const head = firstLine.trim();
  if (!head) return undefined;
  // A command that continued onto another line says so, so the truncation is
  // never mistaken for the whole of what is running.
  const multiline = raw.trim().includes('\n');
  const text = multiline ? `${head} …` : head;
  if (text.length <= MAX_COMMAND_CHARS) return text;
  return `${text.slice(0, MAX_COMMAND_CHARS - 1).trimEnd()}…`;
}

/** The model's own words for the job, when the spawning call carried some. */
function descriptionOf(call: ToolCallInfo | undefined): string | undefined {
  const raw = call?.input?.description;
  if (typeof raw !== 'string') return undefined;
  const text = raw.replace(/\s+/g, ' ').trim();
  return text ? text : undefined;
}

/**
 * Take the background jobs out of a turn: their lifecycle records, their
 * spawning calls, and the blocks they render as.
 *
 * Runs BEFORE the subagent grouping and hands it what is left, so exactly one
 * block claims each record and each call.
 *
 * WHICH RECORDS ARE JOBS. Those the backend labelled `local_bash`, plus those
 * whose spawning call is itself a background launch — the second case is what
 * covers a run whose opening edge (the only one carrying the kind) was capped or
 * missed. A record with no kind and no such call is left alone: an unlabelled
 * task is not assumed to be a shell job.
 *
 * WHICH CALLS ARE FOLDED IN. Main-thread calls only. A background job launched
 * INSIDE a subagent keeps its call in that subagent's block, where the reader is
 * looking for it; the job still gets its own block, anchored at the end of the
 * turn rather than at a call that is no longer in the batch.
 */
export function partitionBackgroundJobs(
  toolCalls: ToolCallInfo[] | undefined,
  tasks: SubagentTask[] | undefined,
  opts?: {
    /** Whether the turn that launched these jobs has finished. Once it has,
     *  nothing is listening for an ending edge any more (see the module doc), so
     *  a job still marked running is reported as unrecorded rather than live. */
    turnEnded?: boolean;
  }
): BackgroundPartition {
  const calls = toolCalls ?? [];
  const taskList = tasks ?? [];
  const turnEnded = opts?.turnEnded === true;
  /** What the block may claim, given that the turn may be over. */
  const claim = (status: SubagentTask['status']): BackgroundJobStatus =>
    turnEnded && status === 'running' ? 'unknown' : status;

  // Main-thread calls only (see the doc): a subagent's own calls are that
  // block's business.
  const callById = new Map<string, ToolCallInfo>();
  for (const call of calls) if (!call.agentId) callById.set(call.id, call);

  const jobTasks: SubagentTask[] = [];
  const otherTasks: SubagentTask[] = [];
  for (const task of taskList) {
    const claimedByCall =
      task.taskType === undefined &&
      task.agentType === undefined &&
      task.toolCallId !== undefined &&
      isBackgroundLaunch(callById.get(task.toolCallId));
    if (isBackgroundTask(task) || claimedByCall) jobTasks.push(task);
    else otherTasks.push(task);
  }

  if (jobTasks.length === 0 && !calls.some((c) => !c.agentId && isBackgroundLaunch(c))) {
    // The overwhelmingly common turn: nothing was backgrounded. Hand back the
    // input arrays themselves so the caller's memo sees no change.
    return { calls, tasks: taskList, jobs: [] };
  }

  const taskByCallId = new Map<string, SubagentTask>();
  for (const task of jobTasks) {
    if (task.toolCallId && !taskByCallId.has(task.toolCallId)) {
      taskByCallId.set(task.toolCallId, task);
    }
  }

  const jobs: BackgroundJob[] = [];
  const claimedTaskIds = new Set<string>();
  const remainingCalls: ToolCallInfo[] = [];

  // Pass 1, in TURN ORDER: every background launch becomes a block, joined to
  // its lifecycle when there is one.
  for (const call of calls) {
    const task = call.agentId ? undefined : taskByCallId.get(call.id);
    if (!task && !(isBackgroundLaunch(call) && !call.agentId)) {
      remainingCalls.push(call);
      continue;
    }
    if (task) claimedTaskIds.add(task.id);
    const command = formatJobCommand(call.input?.command);
    const description = descriptionOf(call);
    jobs.push({
      id: task ? task.id : `call:${call.id}`,
      // No lifecycle ⇒ no claim. See the module doc: the launch acknowledgement
      // is not an outcome.
      status: task ? claim(task.status) : 'unknown',
      ...(command ? { command } : {}),
      ...(description ? { description } : {}),
      ...(task?.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
      ...(task?.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
      spawningCall: call,
    });
  }

  // Pass 2: jobs the backend reported but whose spawning call is not in this
  // turn's batch (it ran inside a subagent, or the call was never seen). Work
  // that was reported is work that gets a block — it simply has no anchor, and
  // no command to show, because the only place the command exists is that call.
  for (const task of jobTasks) {
    if (claimedTaskIds.has(task.id)) continue;
    jobs.push({
      id: task.id,
      status: claim(task.status),
      ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
      ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
    });
  }

  return { calls: remainingCalls, tasks: otherTasks, jobs };
}

/**
 * How long a job has been going, in whole seconds, at the given moment.
 *
 * `null` when there is nothing honest to show:
 *   * no start time — a reloaded transcript, or a backend that reported none;
 *   * an UNRECORDED outcome with no end time — we know when we stopped hearing
 *     about the job, not when it stopped, and a number here would be read as its
 *     duration. A finished job measures to its END time, so the count stops
 *     where the job stopped instead of running on.
 */
export function jobElapsedSeconds(job: BackgroundJob, now: number): number | null {
  if (job.startedAt === undefined) return null;
  if (job.status === 'unknown' && job.endedAt === undefined) return null;
  const end = job.endedAt ?? now;
  return Math.max(0, Math.floor((end - job.startedAt) / 1000));
}
