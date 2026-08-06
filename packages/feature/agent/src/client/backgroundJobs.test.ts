// THE JOB THAT RAN WITH NOBODY WATCHING.
//
// The complaint these tests pin down: naby backgrounded a deploy script, the
// transcript showed the `Bash` row (which returned instantly, because a
// background launch's tool result is only the acknowledgement) plus a sentence
// saying the deploy had started — and then nothing at all. Nothing said the job
// was still running, nothing said how it ended, and the screen read as if the
// work were finished the second it began.
//
// Pure — no DOM, no i18n — so the rules are stated here rather than inferred
// from a screenshot. Run with `npm test`.
import { describe, it, expect } from 'vitest';
import {
  formatJobCommand,
  isBackgroundLaunch,
  jobElapsedSeconds,
  partitionBackgroundJobs,
  MAX_COMMAND_CHARS,
} from './backgroundJobs';
import { applySubagentTaskEvent, groupSubagentCalls, type SubagentTask } from './subagentGroups';
import type { ToolCallInfo } from './types';

const call = (
  id: string,
  name: string,
  input: Record<string, unknown> = {},
  extra: Partial<ToolCallInfo> = {}
): ToolCallInfo => ({ id, name, input, ...extra });

/** The launch as the transcript records it: a `Bash` call with the flag, whose
 *  result is the SDK's launch acknowledgement — never the job's outcome. */
const launch = (id: string, command: string, extra: Partial<ToolCallInfo> = {}) =>
  call(id, 'Bash', { command, run_in_background: true }, extra);

const job = (id: string, over: Partial<SubagentTask> = {}): SubagentTask => ({
  id,
  taskType: 'local_bash',
  status: 'running',
  ...over,
});

describe('isBackgroundLaunch — the flag, not the tool name', () => {
  it('recognises a launch by run_in_background', () => {
    expect(isBackgroundLaunch(launch('t1', 'npm run deploy'))).toBe(true);
  });

  it('an ordinary Bash call is not a background job', () => {
    expect(isBackgroundLaunch(call('t1', 'Bash', { command: 'ls' }))).toBe(false);
    expect(isBackgroundLaunch(call('t2', 'Bash', { command: 'ls', run_in_background: false }))).toBe(
      false
    );
    expect(isBackgroundLaunch(undefined)).toBe(false);
  });
});

describe('formatJobCommand — one line, whatever was run', () => {
  it('keeps a short command as it is', () => {
    expect(formatJobCommand('npm run deploy -- --prod')).toBe('npm run deploy -- --prod');
  });

  it('collapses a multi-line command to its first line, and says it continued', () => {
    expect(formatJobCommand('set -e\nnpm run build\nnpm run deploy')).toBe('set -e …');
  });

  it('truncates at the display limit rather than pushing the status off the row', () => {
    const out = formatJobCommand('x'.repeat(400))!;
    expect(out.length).toBe(MAX_COMMAND_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });

  it('has nothing to show for a missing or blank command', () => {
    expect(formatJobCommand(undefined)).toBeUndefined();
    expect(formatJobCommand('   \n  ')).toBeUndefined();
  });
});

describe('partitionBackgroundJobs — LIVE, with the backend’s lifecycle', () => {
  it('a turn that backgrounded nothing is untouched (same arrays back)', () => {
    const calls = [call('t1', 'Read'), call('t2', 'Bash', { command: 'ls' })];
    const tasks: SubagentTask[] = [{ id: 'a1', agentType: 'general-purpose', status: 'running' }];
    const out = partitionBackgroundJobs(calls, tasks);
    expect(out.jobs).toEqual([]);
    // Identity, not just equality: the bubble memoizes on these.
    expect(out.calls).toBe(calls);
    expect(out.tasks).toBe(tasks);
  });

  it('the launch leaves the batch and becomes a block that is still running', () => {
    const out = partitionBackgroundJobs(
      [call('t1', 'Read'), launch('t2', 'npm run deploy'), call('t3', 'Read')],
      [job('b1', { toolCallId: 't2', startedAt: 1_000 })]
    );
    expect(out.calls.map((c) => c.id)).toEqual(['t1', 't3']);
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0]).toMatchObject({
      id: 'b1',
      status: 'running',
      command: 'npm run deploy',
      startedAt: 1_000,
    });
    expect(out.jobs[0]!.spawningCall?.id).toBe('t2');
  });

  it('a shell job is NOT a subagent — it never becomes a phantom agent block', () => {
    // Before this split, the job's lifecycle record `ensure()`d a group of its
    // own: an empty block labelled "Subagent" sitting where the deploy started.
    const calls = [launch('t2', 'npm run deploy')];
    const tasks = [job('b1', { toolCallId: 't2' })];
    const out = partitionBackgroundJobs(calls, tasks);
    expect(out.tasks).toEqual([]);
    expect(groupSubagentCalls(out.calls, out.tasks).groups).toEqual([]);
    // And even if a caller forgets to split first, the grouping refuses it.
    expect(groupSubagentCalls(calls, tasks).groups).toEqual([]);
  });

  it('a delegated run and a background job in the same turn stay separate blocks', () => {
    const calls = [
      call('t1', 'Task', { subagent_type: 'general-purpose' }),
      launch('t2', 'npm run deploy'),
      call('t3', 'Grep', {}, { agentId: 'a1', agentType: 'general-purpose' }),
    ];
    const tasks: SubagentTask[] = [
      { id: 'a1', agentType: 'general-purpose', taskType: 'local_agent', status: 'running', toolCallId: 't1' },
      job('b1', { toolCallId: 't2' }),
    ];
    const bg = partitionBackgroundJobs(calls, tasks);
    expect(bg.jobs.map((j) => j.id)).toEqual(['b1']);
    const groups = groupSubagentCalls(bg.calls, bg.tasks).groups;
    expect(groups.map((g) => g.id)).toEqual(['a1']);
    expect(groups[0]!.calls.map((c) => c.id)).toEqual(['t3']);
    expect(groups[0]!.parentCall?.id).toBe('t1');
  });

  it('two concurrent jobs are two blocks, keyed by task id', () => {
    const out = partitionBackgroundJobs(
      [launch('t1', 'npm run deploy'), launch('t2', 'npm run e2e')],
      [job('b1', { toolCallId: 't1' }), job('b2', { toolCallId: 't2', status: 'completed' })]
    );
    expect(out.jobs.map((j) => j.id)).toEqual(['b1', 'b2']);
    expect(out.jobs.map((j) => j.status)).toEqual(['running', 'completed']);
    expect(out.jobs.map((j) => j.command)).toEqual(['npm run deploy', 'npm run e2e']);
    expect(out.calls).toEqual([]);
  });

  it('a job whose opening edge was missed is still claimed, by its launch call', () => {
    // `task_type` only rides the opening edge; if that edge was capped or the
    // viewer subscribed late, the record arrives kindless — and the call it
    // names is the evidence that says what it is.
    const out = partitionBackgroundJobs(
      [launch('t1', 'npm run deploy')],
      [{ id: 'b1', status: 'completed', toolCallId: 't1' }]
    );
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0]!.status).toBe('completed');
    expect(out.tasks).toEqual([]);
  });

  it('an unlabelled task that is not a launch is left to the subagent grouping', () => {
    const out = partitionBackgroundJobs(
      [call('t1', 'Task', { subagent_type: 'general-purpose' })],
      [{ id: 'a1', status: 'running', toolCallId: 't1' }]
    );
    expect(out.jobs).toEqual([]);
    expect(out.tasks.map((t) => t.id)).toEqual(['a1']);
  });

  it('a job launched inside a subagent keeps its call in that block, and still gets one', () => {
    const out = partitionBackgroundJobs(
      [call('t1', 'Bash', { command: 'npm run deploy', run_in_background: true }, { agentId: 'a1' })],
      [job('b1', { toolCallId: 't1' })]
    );
    // The call stays where the reader is looking for it…
    expect(out.calls.map((c) => c.id)).toEqual(['t1']);
    // …and the job is still reported, without an anchor or a borrowed command.
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0]!.spawningCall).toBeUndefined();
    expect(out.jobs[0]!.command).toBeUndefined();
  });

  it('carries the model’s own words when the launch had no command to show', () => {
    const out = partitionBackgroundJobs(
      [call('t1', 'Bash', { run_in_background: true, description: 'Deploy  to\nprod' })],
      undefined
    );
    expect(out.jobs[0]!.description).toBe('Deploy to prod');
  });
});

describe('partitionBackgroundJobs — RELOADED, with no lifecycle at all', () => {
  // The lifecycle is transport and is never persisted. What survives is the call.
  it('the block still appears, from the persisted launch', () => {
    const out = partitionBackgroundJobs(
      [launch('t1', 'npm run deploy', { result: 'Command running in background with ID: b1' })],
      undefined
    );
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0]).toMatchObject({ id: 'call:t1', command: 'npm run deploy' });
    expect(out.calls).toEqual([]);
  });

  it('claims NO outcome — the launch acknowledgement is not a result', () => {
    // The rule that separates this from a `Task` call, where a result does mean
    // the run finished. Here it only means the job started.
    const out = partitionBackgroundJobs(
      [launch('t1', 'npm run deploy', { result: 'Command running in background with ID: b1' })],
      undefined
    );
    expect(out.jobs[0]!.status).toBe('unknown');
    expect(out.jobs[0]!.startedAt).toBeUndefined();
    expect(out.jobs[0]!.endedAt).toBeUndefined();
  });

  it('invents no running state either — an unfinished launch is still unknown', () => {
    const out = partitionBackgroundJobs([launch('t1', 'npm run deploy', { isLoading: true })], []);
    expect(out.jobs[0]!.status).toBe('unknown');
  });
});

describe('partitionBackgroundJobs — the turn’s end is the end of what we know', () => {
  // The runtime drives one turn per query() and the backend winds down with it,
  // so an ending edge can only arrive while the turn is still going.
  it('a job still marked running when the turn ended is unrecorded, not live', () => {
    const out = partitionBackgroundJobs(
      [launch('t1', 'npm run deploy')],
      [job('b1', { toolCallId: 't1', startedAt: 1_000 })],
      { turnEnded: true }
    );
    expect(out.jobs[0]!.status).toBe('unknown');
    // …and it shows no duration: we know when we stopped hearing about it, not
    // when it stopped. A number here would be read as how long it ran.
    expect(jobElapsedSeconds(out.jobs[0]!, 900_000)).toBeNull();
  });

  it('a job that DID report back keeps its outcome after the turn ends', () => {
    const out = partitionBackgroundJobs(
      [launch('t1', 'npm run deploy')],
      [job('b1', { toolCallId: 't1', status: 'completed', startedAt: 1_000, endedAt: 41_000 })],
      { turnEnded: true }
    );
    expect(out.jobs[0]!.status).toBe('completed');
    expect(jobElapsedSeconds(out.jobs[0]!, 900_000)).toBe(40);
  });

  it('while the turn is still going, a running job is running', () => {
    const out = partitionBackgroundJobs(
      [launch('t1', 'npm run deploy')],
      [job('b1', { toolCallId: 't1', startedAt: 1_000 })],
      { turnEnded: false }
    );
    expect(out.jobs[0]!.status).toBe('running');
    expect(jobElapsedSeconds(out.jobs[0]!, 46_000)).toBe(45);
  });

  it('applies to an anchorless job too (one launched inside a subagent)', () => {
    const out = partitionBackgroundJobs([], [job('b1', { startedAt: 1_000 })], {
      turnEnded: true,
    });
    expect(out.jobs[0]!.status).toBe('unknown');
  });
});

describe('jobElapsedSeconds — how long, honestly', () => {
  it('counts from the start while the job runs', () => {
    expect(jobElapsedSeconds({ id: 'b1', status: 'running', startedAt: 1_000 }, 46_400)).toBe(45);
  });

  it('stops at the end time once it is over', () => {
    expect(
      jobElapsedSeconds({ id: 'b1', status: 'completed', startedAt: 1_000, endedAt: 61_000 }, 900_000)
    ).toBe(60);
  });

  it('has nothing to say without a start time (a reloaded transcript)', () => {
    expect(jobElapsedSeconds({ id: 'call:t1', status: 'unknown' }, 900_000)).toBeNull();
  });
});

describe('applySubagentTaskEvent — a job’s edges, folded', () => {
  it('start then end: one record, its kind and both times kept', () => {
    let tasks = applySubagentTaskEvent(undefined, {
      id: 'b1',
      phase: 'started',
      taskType: 'local_bash',
      toolCallId: 't1',
      at: 1_000,
    });
    tasks = applySubagentTaskEvent(tasks, { id: 'b1', phase: 'progress', at: 30_000 });
    tasks = applySubagentTaskEvent(tasks, {
      id: 'b1',
      phase: 'ended',
      status: 'completed',
      at: 61_000,
    });
    expect(tasks).toEqual([
      {
        id: 'b1',
        status: 'completed',
        taskType: 'local_bash',
        toolCallId: 't1',
        startedAt: 1_000,
        endedAt: 61_000,
      },
    ]);
  });

  it('the start time never moves — a heartbeat does not restart the clock', () => {
    let tasks = applySubagentTaskEvent(undefined, {
      id: 'b1',
      phase: 'started',
      taskType: 'local_bash',
      at: 1_000,
    });
    tasks = applySubagentTaskEvent(tasks, { id: 'b1', phase: 'progress', at: 600_000 });
    expect(tasks[0]!.startedAt).toBe(1_000);
  });

  it('replay (a reconnect snapshot) changes nothing and re-renders nothing', () => {
    const events = [
      { id: 'b1', phase: 'started' as const, taskType: 'local_bash', at: 1_000 },
      { id: 'b1', phase: 'ended' as const, status: 'completed' as const, at: 61_000 },
    ];
    let once = applySubagentTaskEvent(undefined, events[0]!);
    once = applySubagentTaskEvent(once, events[1]!);
    let twice = applySubagentTaskEvent(once, events[0]!);
    twice = applySubagentTaskEvent(twice, events[1]!);
    expect(twice).toBe(once);
  });

  it('a killed job ends stopped rather than spinning forever', () => {
    // The runtime maps the task-state enum's `killed` onto `stopped` before this
    // point; what matters here is that the ending closes the block.
    let tasks = applySubagentTaskEvent(undefined, {
      id: 'b1',
      phase: 'started',
      taskType: 'local_bash',
      at: 1_000,
    });
    tasks = applySubagentTaskEvent(tasks, { id: 'b1', phase: 'ended', status: 'stopped', at: 9_000 });
    expect(tasks[0]!.status).toBe('stopped');
    expect(tasks[0]!.endedAt).toBe(9_000);
  });
});
