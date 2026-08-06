// Regression net for the engine-agnostic stream reducer (#10). Run with `npm test`
// (vitest) or `npx vitest run <this file>`.
import { describe, it, expect } from 'vitest';
import { applyStreamEvent, type StreamEvent } from './applyStreamEvent';
import type { ChatMessage } from './types';

const ID = 'asst-1';
const seed = (): ChatMessage[] => [{ id: ID, role: 'assistant', content: '', isStreaming: true }];
const reduce = (msgs: ChatMessage[], evs: StreamEvent[], engine?: string) =>
  evs.reduce((acc, ev) => applyStreamEvent(acc, ev, { engine, assistantId: ID }), msgs);

const delta = (text: string): StreamEvent => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
});

describe('applyStreamEvent (#10 engine-agnostic reducer)', () => {
  it('claude deltas accumulate into the assistant bubble', () => {
    const out = reduce(seed(), [delta('Hel'), delta('lo'), delta(' world')]);
    expect(out[0].content).toBe('Hello world');
  });

  it('claude complete-text assistant is skipped (deltas own text; no dup)', () => {
    const out = reduce(seed(), [
      delta('Hi'),
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } },
    ]);
    expect(out[0].content).toBe('Hi');
  });

  it('non-synthetic complete-text assistant is NOT read (single-engine: text comes via deltas)', () => {
    // The alt-engine (codex/kimi/ollama) complete-text path was removed with the
    // engine picker. A plain assistant message carries no text into the bubble;
    // only deltas and <synthetic> messages do.
    const out = reduce(seed(), [{ type: 'assistant', message: { content: [{ type: 'text', text: 'ignored' }] } }]);
    expect(out[0].content).toBe('');
  });

  it('synthetic message text is read regardless of engine', () => {
    const out = reduce(seed(), [
      { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: '/x unavailable' }] } },
    ]);
    expect(out[0].content).toBe('/x unavailable');
  });

  it('tool_use deduped by id + tool_result merged', () => {
    const out = reduce(seed(), [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { p: 'x' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { p: 'x' } }] } }, // dup
      { type: 'user', message: { content: [{ tool_use_id: 't1', content: 'data' }] } },
    ]);
    expect(out[0].toolCalls?.length).toBe(1);
    expect(out[0].toolCalls?.[0].name).toBe('Read');
    expect(out[0].toolCalls?.[0].result).toBe('data');
    expect(out[0].toolCalls?.[0].isLoading).toBe(false);
  });

  it('result finalize: clears isStreaming + toolCall isLoading', () => {
    const out = reduce(seed(), [
      delta('done'),
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read' }] } },
      { type: 'result' },
    ]);
    expect(out[0].isStreaming).toBe(false);
    expect(out[0].toolCalls?.[0].isLoading).toBe(false);
  });

  it('result.result fills an empty bubble (trimmed)', () => {
    const out = reduce(seed(), [{ type: 'result', result: '  error text  ' }]);
    expect(out[0].content).toBe('error text');
  });

  it('result does NOT overwrite existing content', () => {
    const out = reduce(seed(), [delta('real'), { type: 'result', result: 'fallback' }]);
    expect(out[0].content).toBe('real');
  });

  it('events are scoped to assistantId — other messages untouched', () => {
    const msgs: ChatMessage[] = [{ id: 'user-1', role: 'user', content: 'q' }, ...seed()];
    const out = reduce(msgs, [delta('x')]);
    expect(out[0].content).toBe('q');
    expect(out[1].content).toBe('x');
  });
});

// A TURN IS A SEQUENCE, NOT ONE EVER-GROWING BUBBLE.
//
// The reducer keeps `content` (the whole answer, one string — copy, search and
// the "has the answer started" test all still read it) AND `segments`, which say
// where the splits in it are. The rule under test: text that arrives after a
// tool has run opens a NEW bubble instead of being appended to the sentence the
// model produced before the tool ran.
describe('applyStreamEvent — the turn’s order', () => {
  const toolUse = (id: string, name = 'Read'): StreamEvent => ({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input: {} }] },
  });

  it('a delta after a tool call starts a new segment, never extends the old bubble', () => {
    const out = reduce(seed(), [
      delta('Let me look.'),
      toolUse('t1'),
      delta('Now I will fix it.'),
    ]);
    expect(out[0].segments).toEqual([
      { kind: 'text', id: 's0', text: 'Let me look.' },
      { kind: 'tools', id: 's1', callIds: ['t1'] },
      { kind: 'text', id: 's2', text: 'Now I will fix it.' },
    ]);
    // …and the message still holds the whole answer as one string.
    expect(out[0].content).toBe('Let me look.Now I will fix it.');
  });

  it('consecutive deltas stay in one bubble', () => {
    const out = reduce(seed(), [delta('Hel'), delta('lo')]);
    expect(out[0].segments).toEqual([{ kind: 'text', id: 's0', text: 'Hello' }]);
  });

  it('consecutive calls stay in one batch', () => {
    const out = reduce(seed(), [delta('go'), toolUse('t1'), toolUse('t2'), toolUse('t3')]);
    expect(out[0].segments?.[1]).toEqual({ kind: 'tools', id: 's1', callIds: ['t1', 't2', 't3'] });
  });

  it('a tool RESULT leaves the order untouched', () => {
    // The result updates the call, which lives in `toolCalls`. Rebuilding the
    // segment list here would wake every memoized bubble above it for nothing.
    const before = reduce(seed(), [delta('a'), toolUse('t1')]);
    const after = applyStreamEvent(
      before,
      { type: 'user', message: { content: [{ tool_use_id: 't1', content: 'data' }] } },
      { assistantId: ID }
    );
    expect(after[0].segments).toBe(before[0].segments);
  });

  it('replaying the turn (reconnect snapshot) rebuilds the same order', () => {
    const events = [delta('a'), toolUse('t1'), delta('b')];
    const once = reduce(seed(), events);
    // The viewer resets the bubble before replaying (useChatStream), which is
    // what the fresh seed models here.
    const twice = reduce(seed(), events);
    expect(twice[0].segments).toEqual(once[0].segments);
  });

  it('an in-stream error after tools gets its own bubble', () => {
    const out = reduce(seed(), [delta('working'), toolUse('t1'), { type: 'error', error: 'boom' }]);
    expect(out[0].segments?.map((s) => s.kind)).toEqual(['text', 'tools', 'text']);
    expect(out[0].content).toBe('working\n\n⚠️ boom');
  });

  it('the result fallback becomes a segment, so an empty turn still renders', () => {
    const out = reduce(seed(), [{ type: 'result', result: '  error text  ' }]);
    expect(out[0].segments).toEqual([{ kind: 'text', id: 's0', text: 'error text' }]);
  });

  it('synthetic message text joins the order like any other text', () => {
    const out = reduce(seed(), [
      toolUse('t1'),
      { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: '/x unavailable' }] } },
    ]);
    expect(out[0].segments).toEqual([
      { kind: 'tools', id: 's0', callIds: ['t1'] },
      { kind: 'text', id: 's1', text: '/x unavailable' },
    ]);
  });
});

// A DELEGATED RUN IS A BLOCK, NOT A STRING OF PILLS.
//
// Two halves, both of which have to hold for the transcript to stop lying about
// what happened: a subagent's tool calls must arrive TAGGED (so they can leave
// the generic batch), and the lifecycle events that used to render as
// interchangeable `system/task_started · agent=general-purpose` bars must be
// absorbed into the block they describe.
describe('applyStreamEvent — subagent attribution + lifecycle absorption', () => {
  const taskEvent = (
    id: string,
    phase: 'started' | 'progress' | 'ended',
    extra: Partial<StreamEvent> = {}
  ): StreamEvent => ({
    type: 'system',
    subtype: 'harness',
    harness_subtype: `system/task_${phase === 'ended' ? 'notification' : phase}`,
    harness_task_id: id,
    harness_task_phase: phase,
    harness_task_agent: 'general-purpose',
    ...extra,
  });

  it('a tool_use block carries its subagent attribution onto the call', () => {
    const out = reduce(seed(), [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'Grep',
              input: { pattern: 'x' },
              agent_id: 'a1',
              agent_type: 'general-purpose',
              parent_tool_use_id: 'task-1',
            },
          ],
        },
      },
    ]);
    expect(out[0].toolCalls?.[0]).toMatchObject({
      id: 't1',
      agentId: 'a1',
      agentType: 'general-purpose',
      parentToolCallId: 'task-1',
    });
  });

  it('an unattributed tool_use stays unattributed (no default, no guess)', () => {
    const out = reduce(seed(), [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read' }] } },
    ]);
    expect(out[0].toolCalls?.[0].agentId).toBeUndefined();
  });

  it('task lifecycle builds the bubble’s subagent list instead of pill rows', () => {
    const out = reduce(seed(), [
      taskEvent('a1', 'started', { harness_task_tool_use_id: 'task-1' }),
      taskEvent('a1', 'progress'),
      taskEvent('a1', 'ended', { harness_task_status: 'completed' }),
    ]);
    // No standalone rows were added — the whole point.
    expect(out).toHaveLength(1);
    expect(out.some((m) => m.role === 'system')).toBe(false);
    expect(out[0].subagents).toEqual([
      { id: 'a1', status: 'completed', agentType: 'general-purpose', toolCallId: 'task-1' },
    ]);
  });

  it('four parallel runs stay four entries', () => {
    const out = reduce(
      seed(),
      ['a1', 'a2', 'a3', 'a4'].map((id) => taskEvent(id, 'started'))
    );
    expect(out[0].subagents?.map((t) => t.id)).toEqual(['a1', 'a2', 'a3', 'a4']);
  });

  it('replaying the turn (reconnect snapshot) does not duplicate a block', () => {
    const events = [taskEvent('a1', 'started'), taskEvent('a1', 'ended', { harness_task_status: 'completed' })];
    const once = reduce(seed(), events);
    const twice = reduce(once, events);
    expect(twice[0].subagents).toHaveLength(1);
    expect(twice[0].subagents?.[0].status).toBe('completed');
    expect(twice).toBe(once); // nothing changed ⇒ nothing re-rendered
  });

  it('a BACKGROUND SHELL JOB rides the same edges, kept apart by its kind', () => {
    // It carries no agent type — `harness_task_type` is the only field that says
    // what it is, and the block the bubble draws depends on it.
    const out = reduce(seed(), [
      {
        type: 'system',
        subtype: 'harness',
        harness_subtype: 'system/task_started',
        harness_task_id: 'b1',
        harness_task_phase: 'started',
        harness_task_type: 'local_bash',
        harness_task_tool_use_id: 'bash-1',
        harness_task_at: 1_000,
      },
      {
        type: 'system',
        subtype: 'harness',
        harness_subtype: 'system/task_notification',
        harness_task_id: 'b1',
        harness_task_phase: 'ended',
        harness_task_status: 'completed',
        harness_task_at: 61_000,
      },
    ]);
    expect(out.some((m) => m.role === 'system')).toBe(false);
    expect(out[0].subagents).toEqual([
      {
        id: 'b1',
        status: 'completed',
        taskType: 'local_bash',
        toolCallId: 'bash-1',
        startedAt: 1_000,
        endedAt: 61_000,
      },
    ]);
  });

  it('the elapsed clock survives a reconnect replay (server time, not arrival)', () => {
    const events: StreamEvent[] = [
      {
        type: 'system',
        subtype: 'harness',
        harness_subtype: 'system/task_started',
        harness_task_id: 'b1',
        harness_task_phase: 'started',
        harness_task_type: 'local_bash',
        harness_task_at: 1_000,
      },
    ];
    const once = reduce(seed(), events);
    const twice = reduce(once, events);
    expect(twice[0].subagents?.[0].startedAt).toBe(1_000);
    expect(twice).toBe(once);
  });

  it('a harness event that is NOT a task still renders as its muted pill row', () => {
    const out = reduce(seed(), [
      { type: 'system', subtype: 'harness', harness_subtype: 'system/compact_boundary', harness_detail: 'trigger=auto' },
    ]);
    const pill = out.find((m) => m.role === 'system');
    expect(pill?.content).toBe('system/compact_boundary · trigger=auto');
    expect(out.find((m) => m.id === ID)?.subagents).toBeUndefined();
  });
});
