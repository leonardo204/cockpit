import { describe, it, expect } from 'vitest';
import { createTranscriptRecorder } from './transcriptRecorder';
import type { TranscriptStore } from './transcriptRecorder';
import type { RuntimeMessage } from '../engines/naby';
import type { RunEvent } from '../engines/types';

/**
 * The engines do not agree on how a reply reaches the orchestrator, and every
 * one of these tests is a shape that actually ships:
 *   claude/deepseek  complete `assistant` messages + partial deltas + result.result
 *   codex/kimi       complete `assistant` messages, a `result` carrying no text,
 *                    and tool-result blocks with NO `type` field
 *   ollama           deltas and nothing else
 * A recorder that assumed any one of them would triple a claude reply or lose an
 * ollama one outright.
 */

function fakeStore(
  existing: Record<string, { cwd?: string }> = {},
): TranscriptStore & { rows: RuntimeMessage[]; touched: unknown[]; linked: unknown[] } {
  const rows: RuntimeMessage[] = [];
  const touched: unknown[] = [];
  const linked: unknown[] = [];
  return {
    rows,
    touched,
    linked,
    touchSession: (sessionId: string, providerId?: string) => {
      touched.push({ sessionId, providerId });
      return undefined;
    },
    getSession: (sessionId: string) => existing[sessionId],
    setSessionProject: (sessionId: string, cwd: string | null) => {
      linked.push({ sessionId, cwd });
    },
    appendMessage: (_id: string, msg: RuntimeMessage) => {
      rows.push(msg);
    },
  };
}

const assistantText = (text: string): RunEvent => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
});

const delta = (text: string): RunEvent => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
});

const toolCall = (id: string, name: string, input: unknown): RunEvent => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name, input }] },
});

/** codex/kimi omit `type` on the result block; ollama/claude include it. */
const toolResult = (id: string, content: string, withType = true): RunEvent => ({
  type: 'user',
  message: {
    content: [{ ...(withType ? { type: 'tool_result' } : {}), tool_use_id: id, content }],
  },
});

const text = (rows: RuntimeMessage[]) =>
  rows.filter((r) => r.role === 'assistant' && r.content).map((r) => r.content);

describe('transcriptRecorder — every engine into the one store', () => {
  it('records a claude-shaped reply once, though it arrives three times over', () => {
    const store = fakeStore();
    const rec = createTranscriptRecorder({ store: () => store, providerId: 'claude', cwd: '/p', prompt: 'hi' });

    // The SDK sends partials, then the complete message, then the same text again
    // in the terminal event.
    rec.observe(delta('Hel'));
    rec.observe(delta('lo there'));
    rec.observe(assistantText('Hello there'));
    rec.observe({ type: 'result', subtype: 'success', result: 'Hello there' });
    rec.flush('s1');

    expect(text(store.rows)).toEqual(['Hello there']);
    expect(store.rows[0]).toEqual({ role: 'user', content: 'hi' });
  });

  it('records an ollama-shaped reply, which exists only as deltas', () => {
    const store = fakeStore();
    const rec = createTranscriptRecorder({ store: () => store, providerId: 'ollama', prompt: 'q' });

    rec.observe(delta('the '));
    rec.observe(delta('answer'));
    rec.observe({ type: 'result', subtype: 'success', usage: {} }); // no text on it
    rec.flush('s1');

    expect(text(store.rows)).toEqual(['the answer']);
  });

  it('falls back to the terminal result when that is the only text there is', () => {
    const store = fakeStore();
    const rec = createTranscriptRecorder({ store: () => store, providerId: 'naby-like', prompt: 'q' });

    rec.observe({ type: 'result', subtype: 'success', result: 'only here' });
    rec.flush('s1');

    expect(text(store.rows)).toEqual(['only here']);
  });

  it('pairs a tool call with its result by id, including the codex/kimi block with no type', () => {
    const store = fakeStore();
    const rec = createTranscriptRecorder({ store: () => store, providerId: 'codex', prompt: 'run it' });

    rec.observe(toolCall('t1', 'Bash', { command: 'ls' }));
    rec.observe(toolResult('t1', 'a.txt\nb.txt', false));
    rec.observe(assistantText('two files'));
    rec.flush('s1');

    const call = store.rows.find((r) => r.role === 'assistant' && r.toolCalls?.length);
    const result = store.rows.find((r) => r.role === 'tool');
    expect(call).toMatchObject({
      role: 'assistant',
      content: '',
      toolCalls: [{ toolCallId: 't1', toolName: 'Bash', input: { command: 'ls' } }],
    });
    // The history view joins on this id and drops an orphan, so it has to match.
    expect(result).toMatchObject({ role: 'tool', toolCallId: 't1', toolName: 'Bash' });
    expect((result as { output: { content: string } }).output.content).toBe('a.txt\nb.txt');
  });

  it('marks a failed tool result as an error', () => {
    const store = fakeStore();
    const rec = createTranscriptRecorder({ store: () => store, providerId: 'ollama' });

    rec.observe(toolCall('t1', 'Bash', {}));
    rec.observe({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }] },
    });
    rec.flush('s1');

    expect(store.rows.find((r) => r.role === 'tool')).toMatchObject({
      output: { content: 'boom', isError: true },
    });
  });

  it('keeps text that preceded a tool call ahead of it', () => {
    const store = fakeStore();
    const rec = createTranscriptRecorder({ store: () => store, providerId: 'ollama', prompt: 'go' });

    rec.observe(delta('let me look'));
    rec.observe(toolCall('t1', 'Read', {}));
    rec.observe(toolResult('t1', 'contents'));
    rec.flush('s1');

    // user, the spoken line, the call, the result — in that order. Ordering is
    // the only thing the transcript view has: its ids are positional.
    expect(store.rows.map((r) => r.role)).toEqual(['user', 'assistant', 'assistant', 'tool']);
    expect(store.rows[1]).toMatchObject({ content: 'let me look' });
  });

  it('links the session to its project and names the engine that answered', () => {
    const store = fakeStore();
    const rec = createTranscriptRecorder({ store: () => store, providerId: 'codex', cwd: '/work/proj', prompt: 'q' });
    rec.observe(assistantText('a'));
    rec.flush('s9');

    expect(store.touched).toEqual([{ sessionId: 's9', providerId: 'codex' }]);
    expect(store.linked).toEqual([{ sessionId: 's9', cwd: '/work/proj' }]);
  });

  it('leaves an existing project link alone rather than moving the session', () => {
    const store = fakeStore({ s9: { cwd: '/where/it/already/lives' } });
    const rec = createTranscriptRecorder({ store: () => store, providerId: 'codex', cwd: '/somewhere/else', prompt: 'q' });
    rec.observe(assistantText('a'));
    rec.flush('s9');

    expect(store.linked).toEqual([]);
  });

  it('writes nothing when the engine never revealed a session id, and never writes twice', () => {
    const store = fakeStore();
    const rec = createTranscriptRecorder({ store: () => store, providerId: 'kimi', prompt: 'q' });
    rec.observe(assistantText('a'));

    rec.flush(undefined);
    expect(store.rows).toHaveLength(0);

    rec.flush('s1');
    rec.flush('s1');
    expect(store.rows.filter((r) => r.role === 'user')).toHaveLength(1);
  });

  it('survives a malformed event rather than failing the run', () => {
    const store = fakeStore();
    const rec = createTranscriptRecorder({ store: () => store, providerId: 'codex', prompt: 'q' });

    expect(() => {
      rec.observe({ type: 'assistant' });
      rec.observe({ type: 'assistant', message: { content: 'not-an-array' } });
      rec.observe({ type: 'user', message: { content: [{ tool_use_id: 42 }] } });
      rec.observe({ type: 'stream_event' });
    }).not.toThrow();

    rec.flush('s1');
    expect(store.rows).toEqual([{ role: 'user', content: 'q' }]);
  });

  it('ignores the live-view events that are not part of a conversation', () => {
    const store = fakeStore();
    const rec = createTranscriptRecorder({ store: () => store, providerId: 'claude', prompt: 'q' });

    rec.observe({ type: 'system', subtype: 'init', session_id: 's1' });
    rec.observe({ type: 'thinking', text: 'working it out' });
    rec.observe({ type: 'approval_request', approvalId: 'a1' });
    rec.observe(assistantText('done'));
    rec.flush('s1');

    expect(store.rows.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(text(store.rows)).toEqual(['done']);
  });
});
