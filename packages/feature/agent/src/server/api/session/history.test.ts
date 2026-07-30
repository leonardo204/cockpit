import { describe, it, expect } from 'vitest';
import { toChatMessages } from './toChatMessages';
import type { RuntimeMessage } from '../../engines/naby';

/**
 * HISTORY COALESCING — what a reloaded transcript looks like.
 *
 * The runtime writes one assistant row per tool call (`session.ts`, on every
 * `tool_request`), because a provider replay needs each call adjacent to its
 * result. Mapped 1:1 that produced one bubble per call on reload, so a turn that
 * ran three tools came back as three assistant bubbles each labelled "1 tool
 * call" — while the same turn watched LIVE showed a single bubble holding all
 * three, because `applyStreamEvent` appends calls into the current bubble.
 *
 * These tests pin the reload path to the live shape.
 */

const assistantText = (content: string): RuntimeMessage => ({
  role: 'assistant',
  content,
});

const toolCallRow = (
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown> = {}
): RuntimeMessage => ({
  role: 'assistant',
  content: '',
  toolCalls: [{ toolCallId, toolName, input }],
});

const toolResultRow = (
  toolCallId: string,
  toolName: string,
  content: string
): RuntimeMessage => ({
  role: 'tool',
  toolCallId,
  toolName,
  output: { content },
});

describe('toChatMessages — coalescing tool-call rows', () => {
  it('folds text + three tool calls into ONE assistant message', () => {
    const out = toChatMessages([
      { role: 'user', content: 'find the bug' },
      assistantText('Let me look around.'),
      toolCallRow('c1', 'Glob', { pattern: '**/*.ts' }),
      toolResultRow('c1', 'Glob', 'a.ts\nb.ts'),
      toolCallRow('c2', 'Read', { file_path: '/a.ts' }),
      toolResultRow('c2', 'Read', 'contents of a'),
      toolCallRow('c3', 'Grep', { pattern: 'TODO' }),
      toolResultRow('c3', 'Grep', 'no matches'),
    ]);

    expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
    const assistant = out[1]!;
    expect(assistant.content).toBe('Let me look around.');
    expect(assistant.toolCalls?.map((tc) => tc.name)).toEqual([
      'Glob',
      'Read',
      'Grep',
    ]);
  });

  it('keeps folding tool results onto their own call after the merge', () => {
    const out = toChatMessages([
      assistantText('working'),
      toolCallRow('c1', 'Read', { file_path: '/a.ts' }),
      toolResultRow('c1', 'Read', 'contents of a'),
      toolCallRow('c2', 'Bash', { command: 'ls' }),
      toolResultRow('c2', 'Bash', 'a.ts b.ts'),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]!.toolCalls).toEqual([
      {
        id: 'c1',
        name: 'Read',
        input: { file_path: '/a.ts' },
        result: 'contents of a',
        isLoading: false,
      },
      {
        id: 'c2',
        name: 'Bash',
        input: { command: 'ls' },
        result: 'a.ts b.ts',
        isLoading: false,
      },
    ]);
  });

  it('starts a fresh bubble when an assistant row carries text', () => {
    // The final answer is its own bubble, with the machinery that produced it
    // sitting above rather than glued onto the end of it.
    const out = toChatMessages([
      assistantText('checking'),
      toolCallRow('c1', 'Read'),
      toolResultRow('c1', 'Read', 'ok'),
      assistantText('Found it: the parser drops the last token.'),
    ]);

    expect(out).toHaveLength(2);
    expect(out[0]!.toolCalls).toHaveLength(1);
    expect(out[1]!.content).toBe('Found it: the parser drops the last token.');
    expect(out[1]!.toolCalls).toBeUndefined();
  });

  it('does not merge across a user message', () => {
    const out = toChatMessages([
      { role: 'user', content: 'first' },
      toolCallRow('c1', 'Read'),
      { role: 'user', content: 'second' },
      toolCallRow('c2', 'Read'),
    ]);

    expect(out.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(out[1]!.toolCalls?.map((tc) => tc.id)).toEqual(['c1']);
    expect(out[3]!.toolCalls?.map((tc) => tc.id)).toEqual(['c2']);
  });

  it('opens a bubble on the first call when no assistant text precedes it', () => {
    const out = toChatMessages([
      { role: 'user', content: 'go' },
      toolCallRow('c1', 'Read'),
      toolResultRow('c1', 'Read', 'ok'),
      toolCallRow('c2', 'Edit'),
      toolResultRow('c2', 'Edit', 'ok'),
    ]);

    expect(out).toHaveLength(2);
    expect(out[1]!.content).toBe('');
    expect(out[1]!.toolCalls?.map((tc) => tc.name)).toEqual(['Read', 'Edit']);
  });

  it('gives a merged group the id of the row that opened it, stably', () => {
    const rows: RuntimeMessage[] = [
      { role: 'user', content: 'go' },
      assistantText('one moment'),
      toolCallRow('c1', 'Read'),
      toolCallRow('c2', 'Read'),
    ];
    const first = toChatMessages(rows);
    const second = toChatMessages(rows);

    expect(first.map((m) => m.id)).toEqual(['user-0', 'assistant-1']);
    // Deterministic: the same stored transcript reloads with the same ids, so a
    // scroll-to-message anchor survives a reload.
    expect(second.map((m) => m.id)).toEqual(first.map((m) => m.id));
  });

  it('leaves a tool call with no result unresolved rather than inventing one', () => {
    const out = toChatMessages([
      assistantText('running'),
      toolCallRow('c1', 'Bash', { command: 'sleep 100' }),
    ]);

    expect(out[0]!.toolCalls?.[0]!.result).toBeUndefined();
    expect(out[0]!.toolCalls?.[0]!.isLoading).toBe(false);
  });

  it('does not mutate the caller\'s rows while merging', () => {
    const row = toolCallRow('c1', 'Read');
    toChatMessages([assistantText('hi'), row, toolCallRow('c2', 'Read')]);
    expect(row.role === 'assistant' && row.toolCalls).toHaveLength(1);
  });
});
