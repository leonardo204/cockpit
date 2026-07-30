/**
 * The store's message stream → the chat view's message list.
 *
 * A SEPARATE MODULE, not a helper inside `history.ts`, for a mechanical reason:
 * `history.ts` is re-exported wholesale by the Next route shim
 * (`src/app/api/session/[sessionId]/history/route.ts` does `export *`), and Next
 * type-checks a route's exports against a closed set — a route that exports a
 * plain function fails the build. So the pure mapping lives here, where it can
 * also be unit-tested without dragging in the store.
 */
import type { RuntimeMessage } from '../../engines/naby';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    result?: string;
    isLoading: boolean;
    skillContent?: string;
  }>;
}

/**
 * Map the store's RuntimeMessage stream into the client's ChatMessage list.
 * `tool` rows are not rendered as their own bubbles — their output is folded
 * into the matching assistant message's tool call (by toolCallId), mirroring the
 * old tool_use/tool_result pairing.
 *
 * COALESCING (why this is not a 1:1 row→bubble map). The runtime persists ONE
 * assistant row PER TOOL CALL — `session.ts` appends
 * `{ role:'assistant', content:'', toolCalls:[one] }` on every `tool_request`,
 * because the provider pairing contract wants each call adjacent to its result.
 * That is right for the transcript and wrong for the transcript VIEW: mapped
 * naively, a reloaded turn that ran eight tools rendered as eight separate
 * assistant bubbles, each announcing "1 tool call" — while the SAME turn watched
 * live showed one bubble with eight rows in it, because `applyStreamEvent`
 * appends every call into the current assistant bubble.
 *
 * So a tool-call-only assistant row (empty content, non-empty toolCalls) is
 * merged into the assistant bubble immediately preceding it, reproducing what
 * the live stream produces. `tool` rows never break the run — they are consumed
 * below and emit nothing — but a `user` row does, since it emits a bubble of its
 * own and therefore stops being "the previous assistant message".
 *
 * An assistant row that CARRIES TEXT always starts a new bubble. That keeps the
 * final answer as its own bubble with the machinery that produced it above it,
 * instead of appending prose to a block of tool rows.
 *
 * Ids stay deterministic: a merged group keeps the id of the row that opened it,
 * so the same stored transcript always reloads with the same message ids.
 */
export function toChatMessages(messages: RuntimeMessage[]): ChatMessage[] {
  // First pass: collect every tool output keyed by the call it answers.
  const toolResults = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'tool') {
      toolResults.set(m.toolCallId, m.output?.content ?? '');
    }
  }

  // Second pass: build user/assistant bubbles in order.
  const out: ChatMessage[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'user') {
      out.push({ id: `user-${i}`, role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const toolCalls = (m.toolCalls ?? []).map((tc) => ({
        id: tc.toolCallId,
        name: tc.toolName,
        input: (tc.input as Record<string, unknown>) ?? {},
        result: toolResults.get(tc.toolCallId),
        isLoading: false,
      }));
      // A tool-call-only row folds into the assistant bubble it continues.
      const previous = out[out.length - 1];
      const isToolCallOnly = m.content.trim() === '' && toolCalls.length > 0;
      if (isToolCallOnly && previous && previous.role === 'assistant') {
        previous.toolCalls = [...(previous.toolCalls ?? []), ...toolCalls];
        return;
      }
      out.push({
        id: `assistant-${i}`,
        role: 'assistant',
        content: m.content,
        ...(toolCalls.length ? { toolCalls } : {}),
      });
    }
    // role === 'tool' is consumed above (folded into its assistant call).
  });
  return out;
}
