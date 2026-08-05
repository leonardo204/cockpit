import { describe, it, expect } from 'vitest';
import {
  appendTextSegment,
  appendToolCallSegment,
  buildRenderSegments,
  lastTextSegmentId,
  type RenderSegment,
  type TurnSegment,
} from './turnSegments';
import { groupSubagentCalls } from './subagentGroups';
import type { ToolCallInfo } from './types';

/**
 * A TURN IS A SEQUENCE.
 *
 * The complaint these tests pin down: a turn rendered as ONE bubble that kept
 * growing. Text produced after a tool ran was appended to the sentence from
 * before it ran, and every call in the turn was pooled into one batch at the
 * end — so the transcript could no longer say what happened in what order,
 * which is the only thing it exists to say.
 */

const call = (id: string, name = 'Read', extra: Partial<ToolCallInfo> = {}): ToolCallInfo => ({
  id,
  name,
  input: {},
  ...extra,
});

/** The shape of a rendered turn, as a readable string: `text:…`, `tools:a,b`,
 *  `agent:<id>`. Every assertion below reads better as one of these. */
const shape = (segs: RenderSegment[]): string[] =>
  segs.map((s) =>
    s.kind === 'text'
      ? `text:${s.text}`
      : s.kind === 'tools'
        ? `tools:${s.calls.map((c) => c.id).join(',')}`
        : `agent:${s.group.id}`
  );

const build = (segments: TurnSegment[] | undefined, content: string, calls: ToolCallInfo[]) =>
  buildRenderSegments(segments, content, groupSubagentCalls(calls, undefined));

describe('appendTextSegment — where a bubble ends', () => {
  it('grows the open bubble while the model is still talking', () => {
    let segs = appendTextSegment(undefined, 'Hel');
    segs = appendTextSegment(segs, 'lo');
    segs = appendTextSegment(segs, ' world');
    expect(segs).toEqual([{ kind: 'text', id: 's0', text: 'Hello world' }]);
  });

  it('starts a NEW bubble for text that arrives after a tool call', () => {
    // The whole complaint in one assertion. "Now I will fix it" is not a
    // continuation of "let me look" — a file was read in between.
    let segs = appendTextSegment(undefined, 'Let me look.');
    segs = appendToolCallSegment(segs, 'c1');
    segs = appendTextSegment(segs, 'Now I will fix it.');
    expect(segs).toEqual([
      { kind: 'text', id: 's0', text: 'Let me look.' },
      { kind: 'tools', id: 's1', callIds: ['c1'] },
      { kind: 'text', id: 's2', text: 'Now I will fix it.' },
    ]);
  });

  it('drops the newlines a new run of prose opens with, not the ones inside it', () => {
    let segs = appendToolCallSegment(undefined, 'c1');
    segs = appendTextSegment(segs, '\n\nFound it.');
    segs = appendTextSegment(segs, '\nOn line 9.');
    expect(segs[1]).toEqual({ kind: 'text', id: 's1', text: 'Found it.\nOn line 9.' });
  });

  it('adds nothing for an empty (or whitespace-only opening) delta', () => {
    const seeded = appendToolCallSegment(undefined, 'c1');
    expect(appendTextSegment(seeded, '')).toBe(seeded);
    expect(appendTextSegment(seeded, '  \n ')).toBe(seeded);
  });
});

describe('appendToolCallSegment — where a batch ends', () => {
  it('keeps a contiguous run of calls in ONE batch', () => {
    let segs = appendToolCallSegment(undefined, 'c1');
    segs = appendToolCallSegment(segs, 'c2');
    segs = appendToolCallSegment(segs, 'c3');
    expect(segs).toEqual([{ kind: 'tools', id: 's0', callIds: ['c1', 'c2', 'c3'] }]);
  });

  it('opens a new batch after the model has spoken again', () => {
    let segs = appendToolCallSegment(undefined, 'c1');
    segs = appendTextSegment(segs, 'ok');
    segs = appendToolCallSegment(segs, 'c2');
    expect(segs.map((s) => s.id)).toEqual(['s0', 's1', 's2']);
    expect(segs[2]).toEqual({ kind: 'tools', id: 's2', callIds: ['c2'] });
  });

  it('is idempotent across the WHOLE list, so a replay cannot split a batch', () => {
    // The viewer replays an entire turn through the reducer on every reconnect
    // snapshot. A call that comes back a second time must not be re-appended at
    // the end, which would tear one batch into two around whatever was said
    // after it.
    let segs = appendToolCallSegment(undefined, 'c1');
    segs = appendToolCallSegment(segs, 'c2');
    segs = appendTextSegment(segs, 'done');
    const again = appendToolCallSegment(segs, 'c1');
    expect(again).toBe(segs);
  });

  it('assigns ids monotonically, never by position', () => {
    let segs = appendTextSegment(undefined, 'a');
    segs = appendToolCallSegment(segs, 'c1');
    segs = appendTextSegment(segs, 'b');
    segs = appendToolCallSegment(segs, 'c2');
    expect(segs.map((s) => s.id)).toEqual(['s0', 's1', 's2', 's3']);
  });
});

describe('buildRenderSegments — the turn as it is drawn', () => {
  it('interleaves say / act / say in the order it happened', () => {
    let segs = appendTextSegment(undefined, 'Let me look.');
    segs = appendToolCallSegment(segs, 'c1');
    segs = appendToolCallSegment(segs, 'c2');
    segs = appendTextSegment(segs, 'Now I will fix it.');
    segs = appendToolCallSegment(segs, 'c3');
    segs = appendTextSegment(segs, 'Done.');

    expect(
      shape(build(segs, 'Let me look.Now I will fix it.Done.', [call('c1'), call('c2'), call('c3')]))
    ).toEqual([
      'text:Let me look.',
      'tools:c1,c2',
      'text:Now I will fix it.',
      'tools:c3',
      'text:Done.',
    ]);
  });

  it('counts each batch separately — a turn is not one pile of tools', () => {
    let segs = appendTextSegment(undefined, 'a');
    segs = appendToolCallSegment(segs, 'c1');
    segs = appendToolCallSegment(segs, 'c2');
    segs = appendTextSegment(segs, 'b');
    segs = appendToolCallSegment(segs, 'c3');
    const out = build(segs, 'ab', [call('c1'), call('c2'), call('c3')]);
    const batches = out.filter((s) => s.kind === 'tools') as Extract<RenderSegment, { kind: 'tools' }>[];
    expect(batches.map((b) => b.calls.length)).toEqual([2, 1]);
  });

  it('renders an OLD merged transcript as one bubble, without inventing splits', () => {
    // No segments were recorded, so where the model stopped talking is not
    // knowable. Guessing would be worse than the old layout: it would assert an
    // order that may never have happened. The turn comes back exactly as it
    // always did — one bubble, then the batch.
    const out = build(undefined, 'the whole answer', [call('c1'), call('c2')]);
    expect(shape(out)).toEqual(['text:the whole answer', 'tools:c1,c2']);
  });

  it('renders an empty segment list the same way', () => {
    expect(shape(build([], 'answer', [call('c1')]))).toEqual(['text:answer', 'tools:c1']);
  });

  it('draws nothing at all for a turn with neither text nor calls', () => {
    expect(build([], '', [])).toEqual([]);
  });

  it('keeps a tool-only turn as a bare batch (no empty balloon)', () => {
    const segs = appendToolCallSegment(undefined, 'c1');
    expect(shape(build(segs, '', [call('c1')]))).toEqual(['tools:c1']);
  });

  it('skips a call it cannot resolve rather than drawing a blank row', () => {
    // ExitPlanMode is filtered out of the display list upstream (it is shown as
    // a plan card), and a subagent's own calls live in its block. Neither is a
    // row of the main batch.
    let segs = appendToolCallSegment(undefined, 'c1');
    segs = appendToolCallSegment(segs, 'filtered');
    expect(shape(build(segs, '', [call('c1')]))).toEqual(['tools:c1']);
  });

  it('places a call the segments never recorded rather than losing it', () => {
    // Defensive: an incomplete skeleton must not make a call disappear from the
    // transcript entirely.
    const segs = appendToolCallSegment(undefined, 'c1');
    expect(shape(build(segs, '', [call('c1'), call('c2')]))).toEqual(['tools:c1', 'tools:c2']);
  });
});

describe('buildRenderSegments — a delegated run sits where it was launched', () => {
  const delegatedTurn = () => {
    // say → Task(spawns a1) → the agent's own two calls → say → one main call
    const calls = [
      call('task-1', 'Task', { input: { description: 'research the parser', subagent_type: 'general-purpose' }, result: 'report' }),
      call('g1', 'Grep', { agentId: 'a1', agentType: 'general-purpose', parentToolCallId: 'task-1' }),
      call('g2', 'Read', { agentId: 'a1', agentType: 'general-purpose', parentToolCallId: 'task-1' }),
      call('c9', 'Edit'),
    ];
    let segs = appendTextSegment(undefined, 'Delegating.');
    // The Task call and the agent's own work all land before the model speaks
    // again; the main thread's own edit comes after.
    for (const c of calls.slice(0, 3)) segs = appendToolCallSegment(segs, c.id);
    segs = appendTextSegment(segs, 'The agent reported back.');
    segs = appendToolCallSegment(segs, 'c9');
    return { segs, calls };
  };

  it('anchors the block at the spawning Task call, not at the end of the turn', () => {
    const { segs, calls } = delegatedTurn();
    expect(shape(build(segs, 'Delegating.The agent reported back.', calls))).toEqual([
      'text:Delegating.',
      'agent:a1',
      'text:The agent reported back.',
      'tools:c9',
    ]);
  });

  it('keeps the agent’s own calls inside its block, out of the main batch', () => {
    const { segs, calls } = delegatedTurn();
    const out = build(segs, 'x', calls);
    const block = out.find((s) => s.kind === 'subagent') as Extract<RenderSegment, { kind: 'subagent' }>;
    expect(block.group.calls.map((c) => c.id)).toEqual(['g1', 'g2']);
    expect(block.group.parentCall?.id).toBe('task-1');
    const batched = out
      .filter((s) => s.kind === 'tools')
      .flatMap((s) => (s as Extract<RenderSegment, { kind: 'tools' }>).calls.map((c) => c.id));
    expect(batched).toEqual(['c9']);
  });

  it('anchors at the run’s FIRST OWN call when the spawning call is unknown', () => {
    // An older transcript, or a backend that reported the agent but not the
    // Task that launched it. Still the right region of the turn; still not a
    // guess about WHICH Task it was.
    const calls = [
      call('c1', 'Read'),
      call('g1', 'Grep', { agentId: 'a1' }),
    ];
    let segs = appendTextSegment(undefined, 'go');
    segs = appendToolCallSegment(segs, 'c1');
    segs = appendToolCallSegment(segs, 'g1');
    segs = appendTextSegment(segs, 'done');
    expect(shape(build(segs, 'godone', calls))).toEqual(['text:go', 'tools:c1', 'agent:a1', 'text:done']);
  });

  it('appends a block with no anchor at all rather than dropping it', () => {
    const calls = [call('c1', 'Read')];
    const segs = appendToolCallSegment(undefined, 'c1');
    const partition = groupSubagentCalls(calls, [{ id: 'a9', status: 'running' }]);
    expect(shape(buildRenderSegments(segs, '', partition))).toEqual(['tools:c1', 'agent:a9']);
  });

  it('renders a delegated run in an OLD transcript the way it always did', () => {
    const { calls } = delegatedTurn();
    expect(shape(build(undefined, 'all of it', calls))).toEqual([
      'text:all of it',
      'tools:c9',
      'agent:a1',
    ]);
  });
});

describe('lastTextSegmentId — where the turn ends talking', () => {
  it('finds the last bubble, ignoring what ran after it', () => {
    const out = build(
      (() => {
        let s = appendTextSegment(undefined, 'a');
        s = appendToolCallSegment(s, 'c1');
        s = appendTextSegment(s, 'b');
        s = appendToolCallSegment(s, 'c2');
        return s;
      })(),
      'ab',
      [call('c1'), call('c2')]
    );
    expect(lastTextSegmentId(out)).toBe('s2');
  });

  it('is null for a turn that said nothing', () => {
    expect(lastTextSegmentId(build(appendToolCallSegment(undefined, 'c1'), '', [call('c1')]))).toBeNull();
  });
});
