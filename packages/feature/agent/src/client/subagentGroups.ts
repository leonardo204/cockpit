import type { ToolCallInfo } from './types';

/**
 * A DELEGATED RUN IS NOT PART OF THE TURN'S TOOL BATCH.
 *
 * When the model delegates (the Claude Agent SDK's `Task` tool), the subagent
 * runs its own tools — often dozens of them — and every one of those calls used
 * to arrive in the transcript looking exactly like a call the main thread made.
 * They were all swept into the same collapsed "N tool calls" line, so a turn
 * that ran four research agents in parallel showed one anonymous batch of 133
 * calls and four near-identical `system/task_started · agent=general-purpose`
 * pills beside it. Nothing on screen said which agent did what, or that four
 * separate runs had happened at all.
 *
 * This module holds the pure part of the fix: given the turn's tool calls and
 * whatever subagent LIFECYCLE the backend reported, decide which calls belong to
 * which delegated run. It is deliberately free of React and i18n so the decision
 * can be tested directly.
 *
 * IT NEVER GUESSES. A call is attributed to a subagent only because the BACKEND
 * said so — the SDK sets `agent_id` on the pre-execution hook of every tool a
 * subagent runs, and leaves it unset on the main thread. Timing is not evidence:
 * a subagent's calls interleave with the main thread's, so "it happened while an
 * agent was running" would file the wrong work under the wrong name, which is
 * worse than the flat batch this replaces. A call with no attribution stays in
 * the generic batch, always.
 */

/** Where a delegated run has got to. `unknown` is honest, not a bug: after a
 *  page reload the lifecycle events are gone (they are observational and never
 *  persisted) and only the calls remain, so the run's outcome is unrecorded. */
export type SubagentStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'unknown';

/** One run's lifecycle, as the backend reported it over the stream.
 *
 *  NOT ONLY SUBAGENTS. The backend registers a background shell job (`Bash` with
 *  `run_in_background`) as a task on exactly these four edges, with no
 *  `agentType` to tell it apart — `taskType` is what separates them, and
 *  `backgroundJobs.ts` takes those records before this module groups the rest. */
export interface SubagentTask {
  /** The backend's task id — also the agent id its tool calls are tagged with. */
  id: string;
  /** e.g. `general-purpose`. */
  agentType?: string;
  /** The backend's KIND for this run: `local_agent` (a `Task` subagent),
   *  `local_bash` (a background shell job), … Reported on the opening edge only,
   *  so it is kept once learned rather than re-read from a later one. */
  taskType?: string;
  /** The `Task` call that spawned it, when reported. */
  toolCallId?: string;
  status: Exclude<SubagentStatus, 'unknown'>;
  /** When the runtime saw this run START (epoch ms), when it reported a time.
   *  The elapsed clock a background job shows is measured from here. */
  startedAt?: number;
  /** When the runtime saw it END (epoch ms). */
  endedAt?: number;
}

/** The backend's discriminant for a BACKGROUND SHELL JOB — the Claude Agent
 *  SDK's `local_bash` task kind (sdk.d.ts `SDKTaskStartedMessage.task_type`;
 *  the CLI labels it "shell"). Lives here, next to the lifecycle record it
 *  discriminates, so both readers of that record agree on one string. */
export const BACKGROUND_TASK_TYPE = 'local_bash';

/** Whether a lifecycle record describes a background shell job rather than a
 *  delegated subagent. A record with NO kind is not assumed to be either — the
 *  caller joins it to its spawning call instead (see backgroundJobs.ts). */
export function isBackgroundTask(task: Pick<SubagentTask, 'taskType'>): boolean {
  return task.taskType === BACKGROUND_TASK_TYPE;
}

/** One block in the transcript: a subagent, its work, and how it ended. */
export interface SubagentGroup {
  id: string;
  agentType?: string;
  /** The model's own words for the task, taken from the spawning call's input
   *  (the same string the `Task` row already shows). */
  description?: string;
  status: SubagentStatus;
  /** The calls the subagent made, in order. */
  calls: ToolCallInfo[];
  /** The `Task` call that launched it, when it can be identified — folded in
   *  here so it stops sitting in the generic batch as an unrelated row. */
  parentCall?: ToolCallInfo;
}

export interface SubagentPartition {
  /** Calls the MAIN thread made. These keep the existing batch UI unchanged. */
  topLevel: ToolCallInfo[];
  /** One block per delegated run, in the order the runs first appear. */
  groups: SubagentGroup[];
}

/** The phases a task event can report. `progress` is a mid-flight heartbeat: it
 *  must not close a block, only confirm it is still open. */
export type SubagentTaskPhase = 'started' | 'progress' | 'ended';

export interface SubagentTaskEvent {
  id: string;
  phase: SubagentTaskPhase;
  agentType?: string;
  /** The backend's kind (`local_agent` / `local_bash` / …), on the opening edge. */
  taskType?: string;
  toolCallId?: string;
  status?: 'completed' | 'failed' | 'stopped';
  /** When the RUNTIME saw this edge (epoch ms), as it reported it. Never a
   *  client clock: the viewer replays a run's whole event buffer on reconnect,
   *  and stamping arrival would restart every elapsed count from zero. */
  at?: number;
}

/**
 * Fold one lifecycle event into the list of runs a message knows about.
 *
 * Pure and IDEMPOTENT: the viewer replays the whole turn on every reconnect
 * snapshot, so applying the same event twice must not duplicate a block or
 * reopen a finished one. Returns the SAME array when nothing changed, so a
 * memoized renderer is not woken by a no-op.
 */
export function applySubagentTaskEvent(
  tasks: SubagentTask[] | undefined,
  ev: SubagentTaskEvent
): SubagentTask[] {
  const list = tasks ?? [];
  const status: SubagentTask['status'] =
    ev.phase === 'ended' ? (ev.status ?? 'completed') : 'running';
  const idx = list.findIndex((t) => t.id === ev.id);
  if (idx === -1) {
    return [
      ...list,
      {
        id: ev.id,
        status,
        ...(ev.agentType ? { agentType: ev.agentType } : {}),
        ...(ev.taskType ? { taskType: ev.taskType } : {}),
        ...(ev.toolCallId ? { toolCallId: ev.toolCallId } : {}),
        // A run first SEEN on a later edge (its opening one was capped, or the
        // viewer subscribed mid-run) still gets a start time — the earliest
        // moment anything is known about it. An ending edge sets both, so a
        // block that only ever saw the end reports a zero-length run rather
        // than a run that started at an invented time.
        ...(ev.at !== undefined ? { startedAt: ev.at } : {}),
        ...(ev.at !== undefined && ev.phase === 'ended' ? { endedAt: ev.at } : {}),
      },
    ];
  }
  const prev = list[idx]!;
  // A late `progress` must never resurrect a run that already ended — the SDK
  // says ordering between its level signals and its edges is unspecified, so a
  // finished block that flips back to "running" is a real possibility, and a
  // spinner that never stops is exactly the failure mode this is here to avoid.
  const nextStatus = prev.status !== 'running' && ev.phase !== 'ended' ? prev.status : status;
  const next: SubagentTask = {
    ...prev,
    status: nextStatus,
    ...(ev.agentType ? { agentType: ev.agentType } : {}),
    ...(ev.taskType ? { taskType: ev.taskType } : {}),
    ...(ev.toolCallId ? { toolCallId: ev.toolCallId } : {}),
    // The start time is set ONCE and never moved: the later edges of a run
    // (progress heartbeats, the ending) each carry their own observation time,
    // and taking the newest would make a job that has run for ten minutes read
    // as if it had just begun. The END time, by the same logic, is the time of
    // the edge that ENDED it.
    ...(prev.startedAt === undefined && ev.at !== undefined ? { startedAt: ev.at } : {}),
    ...(ev.at !== undefined && ev.phase === 'ended' && prev.endedAt === undefined
      ? { endedAt: ev.at }
      : {}),
  };
  if (
    next.status === prev.status &&
    next.agentType === prev.agentType &&
    next.taskType === prev.taskType &&
    next.toolCallId === prev.toolCallId &&
    next.startedAt === prev.startedAt &&
    next.endedAt === prev.endedAt
  ) {
    return list;
  }
  const out = [...list];
  out[idx] = next;
  return out;
}

/** The spawning call's description, when it has one worth showing. */
function descriptionOf(call: ToolCallInfo | undefined): string | undefined {
  const raw = call?.input?.description;
  if (typeof raw !== 'string') return undefined;
  const text = raw.replace(/\s+/g, ' ').trim();
  return text ? text : undefined;
}

/** The subagent type named in a spawning call's input, e.g. `general-purpose`. */
function agentTypeOf(call: ToolCallInfo | undefined): string | undefined {
  const raw = call?.input?.subagent_type;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

/**
 * Split a message's tool calls into the main thread's batch and one block per
 * delegated run.
 *
 * `tasks` is what the live stream reported; it is absent on a reloaded
 * transcript, where the blocks are rebuilt from the calls' own attribution
 * alone. That is the whole reason attribution is persisted ON the call: the
 * lifecycle is transport, the call is history.
 */
export function groupSubagentCalls(
  toolCalls: ToolCallInfo[] | undefined,
  tasks: SubagentTask[] | undefined
): SubagentPartition {
  const calls = toolCalls ?? [];
  // A BACKGROUND SHELL JOB IS NOT A DELEGATED RUN. It arrives on the same
  // lifecycle edges and would otherwise `ensure()` a group of its own — an empty
  // block labelled "Subagent" sitting where a backgrounded `npm run deploy` was
  // launched. Those records belong to `backgroundJobs.ts`; the caller normally
  // takes them out before calling here, and this repeats the check so no caller
  // can produce a phantom agent by forgetting to.
  const taskList = (tasks ?? []).filter((t) => !isBackgroundTask(t));
  if (calls.every((c) => !c.agentId) && taskList.length === 0) {
    // Nothing was delegated — the overwhelmingly common turn. Hand back the
    // input array itself so the caller's memo sees no change.
    return { topLevel: calls, groups: [] };
  }

  // Ordered accumulation: lifecycle first (a run is announced before it works),
  // then any agent known only from its calls — which is what a reloaded
  // transcript looks like.
  const order: string[] = [];
  const byId = new Map<string, SubagentGroup>();
  const ensure = (id: string): SubagentGroup => {
    const found = byId.get(id);
    if (found) return found;
    const created: SubagentGroup = { id, status: 'unknown', calls: [] };
    byId.set(id, created);
    order.push(id);
    return created;
  };

  for (const task of taskList) {
    const g = ensure(task.id);
    g.status = task.status;
    if (task.agentType) g.agentType = task.agentType;
  }

  // The id of the call that spawned each run, from either source.
  const parentIdByAgent = new Map<string, string>();
  for (const task of taskList) {
    if (task.toolCallId) parentIdByAgent.set(task.id, task.toolCallId);
  }

  const topLevel: ToolCallInfo[] = [];
  for (const call of calls) {
    if (!call.agentId) {
      topLevel.push(call);
      continue;
    }
    const g = ensure(call.agentId);
    g.calls.push(call);
    if (!g.agentType && call.agentType) g.agentType = call.agentType;
    if (call.parentToolCallId && !parentIdByAgent.has(call.agentId)) {
      parentIdByAgent.set(call.agentId, call.parentToolCallId);
    }
  }

  // Fold each spawning `Task` call out of the batch and into its own block. A
  // parent that cannot be identified is left in the batch rather than guessed
  // at: two `Task` calls in one turn are indistinguishable by name alone.
  if (parentIdByAgent.size > 0) {
    const parentOwner = new Map<string, string>();
    for (const [agentId, callId] of parentIdByAgent) parentOwner.set(callId, agentId);
    for (let i = topLevel.length - 1; i >= 0; i -= 1) {
      const call = topLevel[i]!;
      const agentId = parentOwner.get(call.id);
      if (!agentId) continue;
      const g = ensure(agentId);
      g.parentCall = call;
      topLevel.splice(i, 1);
    }
  }

  const groups = order.map((id) => {
    const g = byId.get(id)!;
    const agentType = g.agentType ?? agentTypeOf(g.parentCall);
    const description = descriptionOf(g.parentCall);
    // With no lifecycle to go on (a reloaded transcript), the spawning call's
    // own result is the next best evidence: a `Task` call that came back means
    // the run finished. Without even that, the status stays unknown — the block
    // simply does not claim one.
    const status: SubagentStatus =
      g.status !== 'unknown'
        ? g.status
        : g.parentCall
          ? g.parentCall.result !== undefined
            ? 'completed'
            : g.parentCall.isLoading
              ? 'running'
              : 'unknown'
          : 'unknown';
    return {
      ...g,
      status,
      ...(agentType ? { agentType } : {}),
      ...(description ? { description } : {}),
    };
  });

  return { topLevel, groups };
}
