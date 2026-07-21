import type { ChatMessage, ToolCallInfo } from './types';

// Single engine-agnostic stream→messages reducer (#10 line 1).
//
// Pure: maps the SSE events every engine route emits (claude/deepseek SDK, codex,
// kimi, ollama, PTY — all share this vocabulary, verified) into ChatMessage updates,
// scoped to the current turn's assistant bubble (`assistantId`). The caller owns the
// assistant placeholder lifecycle:
//   - originator (useChatStream): creates it on send, passes its id (behavior unchanged)
//   - viewer (useLiveStream): creates it on `system.init`, passes its id
// Hook-side concerns (throttling, onSessionId/onFetchTitle/token usage/retry & rate-limit
// indicators) stay OUT of here.

interface Block {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
}
interface ToolResultBlock {
  tool_use_id?: string;
  content?: unknown;
}
export interface StreamEvent {
  type?: string;
  subtype?: string;
  _human?: boolean; // synthetic human-prompt user event (rendered by useLiveStream)
  _turnId?: string; // per-turn unique id (the dispatch runId) — identity for live-bubble dedup
  _ts?: number; // server clock at startRun — time boundary for disk-copy dedup
  message?: { model?: string; role?: string; content?: unknown };
  event?: { type?: string; delta?: { type?: string; text?: string } };
  result?: unknown;
  error?: string; // {type:'error'} events emitted by engines / the orchestrator's failure path
  // system/task_notification fields (SDKTaskNotificationMessage) — a background task reporting back.
  task_id?: string;
  status?: 'completed' | 'failed' | 'stopped';
  summary?: string;
  output_file?: string;
  // system/harness fields (naby engine) — an observational report that the
  // BACKEND's harness did something (background task, context compaction,
  // injected hook output). Both are short pre-sanitized labels produced in the
  // runtime, never raw message bodies.
  harness_subtype?: string;
  harness_detail?: string;
}

export function applyStreamEvent(
  messages: ChatMessage[],
  ev: StreamEvent,
  opts: { engine?: string; assistantId: string }
): ChatMessage[] {
  const { engine, assistantId } = opts;

  // claude/deepseek/PTY: streamed text deltas
  if (ev.type === 'stream_event') {
    const e = ev.event;
    if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
      const txt = e.delta.text;
      return messages.map((m) => (m.id === assistantId ? { ...m, content: (m.content || '') + txt } : m));
    }
    return messages;
  }

  // complete assistant message: codex/kimi/ollama/synthetic carry text here (claude's
  // text comes via deltas → skipped to avoid duplication); tool_use blocks for all engines
  if (ev.type === 'assistant') {
    const content = ev.message?.content;
    if (!Array.isArray(content)) return messages;
    const blocks = content as Block[];
    let out = messages;

    const isSynthetic = ev.message?.model === '<synthetic>';
    if (engine === 'codex' || engine === 'kimi' || engine === 'ollama' || isSynthetic) {
      const newText = blocks.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('');
      if (newText) out = out.map((m) => (m.id === assistantId ? { ...m, content: (m.content || '') + newText } : m));
    }

    for (const b of blocks) {
      if (b.name) {
        const tc: ToolCallInfo = {
          id: b.id || `tool-${assistantId}-${b.name}`,
          name: b.name,
          input: b.input || {},
          isLoading: true,
        };
        out = out.map((m) => {
          if (m.id !== assistantId) return m;
          if (m.toolCalls?.some((x) => x.id === tc.id)) return m;
          return { ...m, toolCalls: [...(m.toolCalls || []), tc] };
        });
      }
    }
    return out;
  }

  // tool_result (user turn): merge into the matching toolCall
  if (ev.type === 'user') {
    const content = ev.message?.content;
    if (!Array.isArray(content)) return messages;
    let out = messages;
    for (const b of content as ToolResultBlock[]) {
      if (b.tool_use_id) {
        const tid = b.tool_use_id;
        const result = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        out = out.map((m) =>
          m.id === assistantId
            ? { ...m, toolCalls: m.toolCalls?.map((tc) => (tc.id === tid ? { ...tc, result, isLoading: false } : tc)) }
            : m
        );
      }
    }
    return out;
  }

  // system/harness — the backend's harness reporting activity that is NOT conversation
  // (background task lifecycle, context compaction, injected hook output). Rendered through
  // the EXISTING muted one-line bar: a role:'system' row with systemEvent.kind 'meta', which
  // MessageBubble already renders as a pill rather than a bubble. No new rendering path.
  //
  // Appended as its own row instead of merged into the assistant bubble, because it is not
  // something the assistant said — merging it would put backend bookkeeping into the reply
  // text. It also deliberately does NOT touch `isStreaming`: a harness event says nothing
  // about whether the turn is still going, and clearing the flag here would end the bubble
  // early. The turn still ends only on `result`.
  //
  // Low-noise: the server already dedupes and caps these per run, and the identity check
  // below makes the reducer idempotent, so a replayed/duplicated event cannot stack up
  // repeated bars (the viewer re-runs this reducer over reconnect snapshots).
  if (ev.type === 'system' && ev.subtype === 'harness') {
    const label = ev.harness_subtype || 'harness event';
    const detail = ev.harness_detail;
    const id = `harness-${assistantId}-${label}${detail ? `-${detail}` : ''}`;
    if (messages.some((m) => m.id === id)) return messages;
    const content = detail ? `${label} · ${detail}` : label;
    const row = {
      id,
      role: 'system',
      content,
      systemEvent: { kind: 'meta', ...(detail ? { detail: content } : {}) },
    } as ChatMessage;
    // Insert the harness row IMMEDIATELY BEFORE the current assistant bubble
    // rather than at the very end. These events (SessionStart hooks firing,
    // rate-limit notices) happen around the START of the turn, but the assistant
    // bubble is created up front, so appending stacked them BELOW the reply —
    // reading as "the hooks ran after the answer." Placing them just above the
    // bubble keeps chronological order. If the bubble does not exist yet, append
    // (it will be added after, still below these rows).
    const idx = messages.findIndex((m) => m.id === assistantId);
    if (idx < 0) return [...messages, row];
    return [...messages.slice(0, idx), row, ...messages.slice(idx)];
  }

  // in-stream error ({type:'error', error}) — emitted by codex/kimi/ollama/deepseek and the
  // orchestrator's failure path. Without this the viewer (useLiveStream, which routes through
  // this reducer) drops it silently and a failed turn shows as an empty bubble. (useChatStream
  // handles 'error' itself and returns before calling this, so it is unaffected.)
  if (ev.type === 'error') {
    const errText = ev.error || 'An error occurred. Please try again.';
    return messages.map((m) =>
      m.id === assistantId
        ? {
            ...m,
            content: m.content ? `${m.content}\n\n⚠️ ${errText}` : `⚠️ ${errText}`,
            isStreaming: false,
          }
        : m
    );
  }

  // turn end: finalize the assistant bubble
  if (ev.type === 'result') {
    const resultText = typeof ev.result === 'string' ? ev.result.trim() : '';
    return messages.map((m) =>
      m.id === assistantId
        ? {
            ...m,
            content: !m.content && resultText ? resultText : m.content,
            isStreaming: false,
            toolCalls: m.toolCalls?.map((tc) => ({ ...tc, isLoading: false })),
          }
        : m
    );
  }

  return messages;
}
