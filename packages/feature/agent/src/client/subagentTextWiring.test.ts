/**
 * subagentTextWiring.test.ts — a subagent's words must never read as naby's.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BUG THIS PINS, WHICH SHIPPED
 *
 * A delegated run narrates while it works: "I'll start by examining the key
 * files", "I've been blocked from reading further files, so I'm stopping here".
 * That text arrived on the same channel as naby's own answer and was appended to
 * the same assistant bubble, so a transcript that was two voices read as one.
 * The user could not tell which sentences were addressed to them — and one of
 * the voices was reporting a failure that was not naby's.
 *
 * The engine knew the difference the whole time: `parent_tool_use_id` names the
 * `Task` call that spawned a subagent and is null on the main thread. It was
 * already used to keep a subagent's token usage out of the window gauge, and
 * spent on nothing else.
 *
 * None of this is visible to a type checker: both paths produce a perfectly
 * well-formed message. So the routing is asserted here.
 */
import { describe, expect, it } from 'vitest';
import { applyStreamEvent } from './applyStreamEvent';
import { appendSubagentText, groupSubagentCalls, type SubagentTask } from './subagentGroups';
import type { ChatMessage } from './types';

const bubble = (): ChatMessage => ({
  id: 'a1',
  role: 'assistant',
  content: '',
  isStreaming: true,
});

const task = (over: Partial<SubagentTask> = {}): SubagentTask => ({
  id: 'agent-1',
  toolCallId: 'call-task-1',
  status: 'running',
  agentType: 'general-purpose',
  ...over,
});

describe('routing a subagent’s narration', () => {
  it('does NOT append it to the answer', () => {
    // The whole bug in one assertion.
    const before = [{ ...bubble(), subagents: [task()] }];
    const after = applyStreamEvent(
      before,
      {
        type: 'subagent_text',
        agent_tool_call_id: 'call-task-1',
        text: "I'll start by examining the key files.",
      },
      { assistantId: 'a1' },
    );
    expect(after[0]!.content).toBe('');
  });

  it('puts it on the subagent that produced it', () => {
    const after = applyStreamEvent(
      [{ ...bubble(), subagents: [task()] }],
      { type: 'subagent_text', agent_tool_call_id: 'call-task-1', text: 'hello' },
      { assistantId: 'a1' },
    );
    expect(after[0]!.subagents?.[0]?.text).toBe('hello');
  });

  it('still lets the main thread speak', () => {
    // The guard must not silence naby. An ordinary delta is untouched.
    const after = applyStreamEvent(
      [bubble()],
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'the answer' } },
      },
      { assistantId: 'a1' },
    );
    expect(after[0]!.content).toContain('the answer');
  });

  it('drops narration for a run this turn never saw, rather than inventing one', () => {
    // A block with no lifecycle would be a subagent that appears to exist and
    // can never finish.
    const after = applyStreamEvent(
      [{ ...bubble(), subagents: [task()] }],
      { type: 'subagent_text', agent_tool_call_id: 'call-unknown', text: 'stray' },
      { assistantId: 'a1' },
    );
    expect(after[0]!.subagents?.[0]?.text).toBeUndefined();
    expect(after[0]!.content).toBe('');
  });
});

describe('accumulating it', () => {
  it('joins the chunks in order', () => {
    let tasks: SubagentTask[] | undefined = [task()];
    tasks = appendSubagentText(tasks, 'call-task-1', 'one ');
    tasks = appendSubagentText(tasks, 'call-task-1', 'two');
    expect(tasks?.[0]?.text).toBe('one two');
  });

  it('keeps two subagents apart', () => {
    let tasks: SubagentTask[] | undefined = [
      task(),
      task({ id: 'agent-2', toolCallId: 'call-task-2' }),
    ];
    tasks = appendSubagentText(tasks, 'call-task-1', 'first');
    tasks = appendSubagentText(tasks, 'call-task-2', 'second');
    expect(tasks?.[0]?.text).toBe('first');
    expect(tasks?.[1]?.text).toBe('second');
  });

  it('is a no-op on empty text and on no tasks', () => {
    expect(appendSubagentText(undefined, 'c', 'x')).toBeUndefined();
    const t = [task()];
    expect(appendSubagentText(t, 'call-task-1', '')).toBe(t);
  });
});

describe('the block gets it', () => {
  it('carries the text onto the group the transcript renders', () => {
    const { groups } = groupSubagentCalls([], [task({ text: 'what it said' })]);
    expect(groups[0]?.text).toBe('what it said');
  });
});
