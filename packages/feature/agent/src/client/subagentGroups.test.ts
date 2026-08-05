// The decision that gives a delegated run its own block in the transcript.
// Pure — no DOM, no i18n — so what it does is stated here rather than inferred
// from a screenshot. Run with `npm test`.
import { describe, it, expect } from 'vitest';
import {
  applySubagentTaskEvent,
  groupSubagentCalls,
  type SubagentTask,
} from './subagentGroups';
import type { ToolCallInfo } from './types';

const call = (
  id: string,
  name: string,
  extra: Partial<ToolCallInfo> = {}
): ToolCallInfo => ({ id, name, input: {}, ...extra });

const sub = (id: string, name: string, agentId: string, agentType = 'general-purpose') =>
  call(id, name, { agentId, agentType });

describe('groupSubagentCalls — attribution decides, never timing', () => {
  it('a turn with no delegation is untouched (same array back)', () => {
    const calls = [call('t1', 'Read'), call('t2', 'Bash')];
    const out = groupSubagentCalls(calls, undefined);
    expect(out.groups).toEqual([]);
    // Identity, not just equality: the bubble memoizes on this.
    expect(out.topLevel).toBe(calls);
  });

  it('subagent calls leave the batch; main-thread calls stay in it', () => {
    const out = groupSubagentCalls(
      [call('t1', 'Read'), sub('t2', 'Grep', 'a1'), sub('t3', 'Read', 'a1'), call('t4', 'Bash')],
      undefined
    );
    expect(out.topLevel.map((c) => c.id)).toEqual(['t1', 't4']);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]!.id).toBe('a1');
    expect(out.groups[0]!.agentType).toBe('general-purpose');
    expect(out.groups[0]!.calls.map((c) => c.id)).toEqual(['t2', 't3']);
  });

  it('four concurrent subagents are four blocks, keyed by task id', () => {
    // The screenshot case: four research agents in parallel, all of type
    // general-purpose. Anything keyed on the TYPE would collapse them into one.
    const tasks: SubagentTask[] = ['a1', 'a2', 'a3', 'a4'].map((id) => ({
      id,
      agentType: 'general-purpose',
      status: 'running',
    }));
    const out = groupSubagentCalls(
      [sub('t1', 'Grep', 'a3'), sub('t2', 'Read', 'a1'), sub('t3', 'Read', 'a3')],
      tasks
    );
    expect(out.groups.map((g) => g.id)).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(out.groups.map((g) => g.calls.length)).toEqual([1, 0, 2, 0]);
    expect(out.topLevel).toEqual([]);
  });

  it('the spawning Task call is folded into its block, out of the batch', () => {
    const tasks: SubagentTask[] = [
      { id: 'a1', agentType: 'general-purpose', toolCallId: 'task-1', status: 'completed' },
    ];
    const out = groupSubagentCalls(
      [
        call('task-1', 'Task', { input: { description: 'research  the  API', subagent_type: 'general-purpose' }, result: 'report' }),
        sub('t2', 'Read', 'a1'),
        call('t3', 'Bash'),
      ],
      tasks
    );
    expect(out.topLevel.map((c) => c.id)).toEqual(['t3']);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]!.parentCall?.id).toBe('task-1');
    // Free text is condensed, not reformatted.
    expect(out.groups[0]!.description).toBe('research the API');
  });

  it('an unidentifiable Task call is left in the batch rather than guessed at', () => {
    const out = groupSubagentCalls(
      [call('task-1', 'Task', { input: { description: 'go' } }), sub('t2', 'Read', 'a1')],
      undefined
    );
    expect(out.topLevel.map((c) => c.id)).toEqual(['task-1']);
    expect(out.groups[0]!.parentCall).toBeUndefined();
  });

  it('reload: blocks rebuild from the calls alone, with the parent link persisted', () => {
    // No lifecycle events survive a reload — they are observational and never
    // stored. The calls carry their own attribution, so the block still exists;
    // what it cannot claim is a live status.
    const out = groupSubagentCalls(
      [
        call('task-1', 'Task', { input: { subagent_type: 'code-reviewer' }, result: 'done' }),
        sub('t2', 'Read', 'a1', 'code-reviewer'),
        call('t3', 'Read'),
      ],
      undefined
    );
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]!.calls.map((c) => c.id)).toEqual(['t2']);
    expect(out.groups[0]!.parentCall).toBeUndefined();
    expect(out.groups[0]!.status).toBe('unknown');

    // …and with the parent link the engine persisted, the launcher folds in and
    // its answered result is enough to call the run finished.
    const linked = groupSubagentCalls(
      [
        call('task-1', 'Task', { input: { subagent_type: 'code-reviewer' }, result: 'done' }),
        sub('t2', 'Read', 'a1', 'code-reviewer'),
      ].map((c) => (c.id === 't2' ? { ...c, parentToolCallId: 'task-1' } : c)),
      undefined
    );
    expect(linked.topLevel).toEqual([]);
    expect(linked.groups[0]!.parentCall?.id).toBe('task-1');
    expect(linked.groups[0]!.status).toBe('completed');
    expect(linked.groups[0]!.agentType).toBe('code-reviewer');
  });

  it('a run that only ever reported its lifecycle still gets a block', () => {
    const out = groupSubagentCalls(undefined, [
      { id: 'a1', agentType: 'general-purpose', status: 'running' },
    ]);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]!.status).toBe('running');
    expect(out.groups[0]!.calls).toEqual([]);
  });
});

describe('applySubagentTaskEvent — the lifecycle, idempotently', () => {
  it('started opens a running run; the terminal edge closes it', () => {
    const opened = applySubagentTaskEvent(undefined, {
      id: 'a1',
      phase: 'started',
      agentType: 'general-purpose',
      toolCallId: 'task-1',
    });
    expect(opened).toEqual([
      { id: 'a1', status: 'running', agentType: 'general-purpose', toolCallId: 'task-1' },
    ]);
    const closed = applySubagentTaskEvent(opened, { id: 'a1', phase: 'ended', status: 'completed' });
    expect(closed[0]!.status).toBe('completed');
    // The identity it was opened with is not lost by the closing edge.
    expect(closed[0]!.agentType).toBe('general-purpose');
    expect(closed).toHaveLength(1);
  });

  it('replaying the same event changes nothing — same array, so no re-render', () => {
    const once = applySubagentTaskEvent(undefined, { id: 'a1', phase: 'started' });
    const twice = applySubagentTaskEvent(once, { id: 'a1', phase: 'started' });
    expect(twice).toBe(once);
  });

  it('a late progress cannot reopen a finished run', () => {
    // The SDK is explicit that ordering between its level signals and its edges
    // is unspecified. A spinner that never stops is the failure this prevents.
    const ended = applySubagentTaskEvent(
      applySubagentTaskEvent(undefined, { id: 'a1', phase: 'started' }),
      { id: 'a1', phase: 'ended', status: 'failed' }
    );
    const late = applySubagentTaskEvent(ended, { id: 'a1', phase: 'progress' });
    expect(late[0]!.status).toBe('failed');
    expect(late).toBe(ended);
  });

  it('an ended edge with no status is a completion, not an unknown', () => {
    const out = applySubagentTaskEvent(undefined, { id: 'a1', phase: 'ended' });
    expect(out[0]!.status).toBe('completed');
  });

  it('concurrent runs accumulate as separate entries', () => {
    let list = applySubagentTaskEvent(undefined, { id: 'a1', phase: 'started' });
    list = applySubagentTaskEvent(list, { id: 'a2', phase: 'started' });
    list = applySubagentTaskEvent(list, { id: 'a1', phase: 'ended', status: 'completed' });
    expect(list.map((t) => [t.id, t.status])).toEqual([
      ['a1', 'completed'],
      ['a2', 'running'],
    ]);
  });
});
