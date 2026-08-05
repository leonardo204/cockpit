import type { ChatMessage, ToolCallInfo } from './types';
import { renderHarnessPill } from './harnessPill';
import { applySubagentTaskEvent, type SubagentTaskPhase } from './subagentGroups';
import { appendTextSegment, appendToolCallSegment } from './turnSegments';

/**
 * Add a run of assistant text to the turn — to `content` (the whole answer, one
 * string, as every other reader of a message still expects) AND to `segments`
 * (where the answer's parts sit relative to the tools).
 *
 * The split rule lives in `appendTextSegment`: text that arrives after tool
 * activity opens a NEW bubble rather than growing the one from before the
 * tools. Both fields are updated here and nowhere else, so they cannot drift.
 */
export function withAssistantText(m: ChatMessage, text: string): ChatMessage {
  if (!text) return m;
  return {
    ...m,
    content: (m.content || '') + text,
    segments: appendTextSegment(m.segments, text),
  };
}

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
  // Subagent attribution the naby engine puts on a tool_use block when the
  // BACKEND ran the call inside a delegated agent (see subagentGroups.ts).
  agent_id?: string;
  agent_type?: string;
  parent_tool_use_id?: string;
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
  // system/harness lifecycle of ONE delegated run (naby engine). Present only on
  // subagent / background-task edges; when it is, the event builds a subagent
  // BLOCK instead of a standalone pill — four parallel agents used to emit four
  // interchangeable `task_started · agent=general-purpose` bars that said
  // nothing about which run was which.
  harness_task_id?: string;
  harness_task_phase?: SubagentTaskPhase;
  harness_task_agent?: string;
  harness_task_tool_use_id?: string;
  harness_task_status?: 'completed' | 'failed' | 'stopped';
}

export function applyStreamEvent(
  messages: ChatMessage[],
  ev: StreamEvent,
  // `engine` is accepted for call-site compatibility (Naby is single-engine) but
  // no longer branches anything — text handling is delta + synthetic only.
  opts: { engine?: string; assistantId: string }
):ChatMessage[] {
  const { assistantId } = opts;

  // claude/deepseek/PTY: streamed text deltas
  if (ev.type === 'stream_event') {
    const e = ev.event;
    if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
      const txt = e.delta.text;
      return messages.map((m) => (m.id === assistantId ? withAssistantText(m, txt) : m));
    }
    return messages;
  }

  // complete assistant message: synthetic messages carry text here (the Naby
  // engine's real text comes via deltas → skipped to avoid duplication);
  // tool_use blocks are always read.
  if (ev.type === 'assistant') {
    const content = ev.message?.content;
    if (!Array.isArray(content)) return messages;
    const blocks = content as Block[];
    let out = messages;

    const isSynthetic = ev.message?.model === '<synthetic>';
    if (isSynthetic) {
      const newText = blocks.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('');
      if (newText) out = out.map((m) => (m.id === assistantId ? withAssistantText(m, newText) : m));
    }

    for (const b of blocks) {
      if (b.name) {
        const tc: ToolCallInfo = {
          id: b.id || `tool-${assistantId}-${b.name}`,
          name: b.name,
          input: b.input || {},
          isLoading: true,
          // Attribution rides the block through unchanged. Absent (every engine
          // but naby's, and every main-thread call) leaves the row exactly as it
          // was, so nothing about the ordinary batch changes.
          ...(b.agent_id ? { agentId: b.agent_id } : {}),
          ...(b.agent_type ? { agentType: b.agent_type } : {}),
          ...(b.parent_tool_use_id ? { parentToolCallId: b.parent_tool_use_id } : {}),
        };
        out = out.map((m) => {
          if (m.id !== assistantId) return m;
          if (m.toolCalls?.some((x) => x.id === tc.id)) return m;
          // The call lands in the turn's call list AND at this point in the
          // turn's order — which is what stops the next thing the model says
          // from being glued onto what it said before this call ran.
          return {
            ...m,
            toolCalls: [...(m.toolCalls || []), tc],
            segments: appendToolCallSegment(m.segments, tc.id),
          };
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
    // A SUBAGENT'S LIFECYCLE IS NOT A PILL — it is the state of a block.
    //
    // These events (`task_started` / `task_progress` / `task_updated` /
    // `task_notification`) used to render as one muted bar each, and a turn that
    // delegated four times produced a column of near-identical bars while the
    // agents' actual work sat anonymously inside the turn's "N tool calls"
    // batch. Folded onto the assistant bubble instead, they become that bubble's
    // subagent blocks: started opens one, ended closes it, and the calls the
    // backend attributed to that agent render underneath it.
    //
    // Idempotent by construction (applySubagentTaskEvent), which the viewer
    // needs: a reconnect replays the entire turn through this reducer.
    if (ev.harness_task_id && ev.harness_task_phase) {
      const taskId = ev.harness_task_id;
      const phase = ev.harness_task_phase;
      const idx = messages.findIndex((m) => m.id === assistantId);
      // No bubble yet ⇒ nothing to attach to. Dropped rather than conjuring a
      // bubble: a block with no turn around it would sit above the answer it
      // belongs to. (The bubble is created on send / on system.init, i.e. before
      // any tool can run, so this is the pathological case, not the normal one.)
      if (idx < 0) return messages;
      const target = messages[idx]!;
      const nextTasks = applySubagentTaskEvent(target.subagents, {
        id: taskId,
        phase,
        ...(ev.harness_task_agent ? { agentType: ev.harness_task_agent } : {}),
        ...(ev.harness_task_tool_use_id ? { toolCallId: ev.harness_task_tool_use_id } : {}),
        ...(ev.harness_task_status ? { status: ev.harness_task_status } : {}),
      });
      if (nextTasks === target.subagents) return messages;
      const out = [...messages];
      out[idx] = { ...target, subagents: nextTasks };
      return out;
    }

    // The ROW IDENTITY is keyed on the raw codes, not on the rendered text: the
    // reducer's idempotence must not depend on the UI language, or switching
    // locale mid-stream would re-add rows it had already collapsed.
    const id = `harness-${assistantId}-${ev.harness_subtype || 'harness event'}${
      ev.harness_detail ? `-${ev.harness_detail}` : ''
    }`;
    if (messages.some((m) => m.id === id)) return messages;
    // P3-M9: a pill that ADDRESSES the user carries a code (the server has no
    // locale); everything else passes through verbatim, as before.
    const { label, detail } = renderHarnessPill(ev.harness_subtype, ev.harness_detail);
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
            // The failure is the last thing this turn said, so it goes through
            // the same door as everything else it said: after a tool batch it
            // gets its own bubble rather than being appended to prose the model
            // produced before the tools ran.
            ...withAssistantText(m, m.content ? `\n\n⚠️ ${errText}` : `⚠️ ${errText}`),
            isStreaming: false,
          }
        : m
    );
  }

  // turn end: finalize the assistant bubble
  if (ev.type === 'result') {
    const resultText = typeof ev.result === 'string' ? ev.result.trim() : '';
    return messages.map((m) => {
      if (m.id !== assistantId) return m;
      // The fallback text (a turn that produced no prose of its own) is text the
      // turn now says, so it becomes a segment too — otherwise the bubble would
      // hold it while the segment list, which is what gets rendered, stayed
      // empty and showed nothing.
      const base = !m.content && resultText ? withAssistantText(m, resultText) : m;
      return {
        ...base,
        isStreaming: false,
        toolCalls: base.toolCalls?.map((tc) => ({ ...tc, isLoading: false })),
      };
    });
  }

  return messages;
}
