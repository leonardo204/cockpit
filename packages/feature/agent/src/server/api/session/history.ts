/**
 * /api/session/[sessionId]/history — a session's full transcript for the chat
 * view (useChatHistory.loadHistory).
 *
 * RE-BACKED ONTO THE NABY STORE (Phase C-2). The transcript is now
 * `getMessages(sessionId)` from `app.db` (the messages table), mapped into the
 * `ChatMessage` shape the client renders — NOT parsed from a
 * `~/.claude/projects/<enc>/<id>.jsonl` file. The conversation renders straight
 * from the database the engine wrote.
 *
 * The WIRE CONTRACT is unchanged — `{ messages: ChatMessage[] }` with
 * `ChatMessage { id, role, content, images?, timestamp?, systemEvent?,
 * toolCalls? }`. The store's RuntimeMessage stream carries user/assistant text
 * (with the assistant's tool calls) plus separate `tool` result rows; we fold
 * each tool result into its calling assistant message's `toolCalls[].result`,
 * exactly the pairing the old jsonl `tool_use` / `tool_result` reader produced.
 */
import { Effect } from 'effect';
import { dynamicHandler, ok } from '@cockpit/effect-runtime/server';
import {
  AppError,
  NotFoundError,
  ValidationError,
} from '@cockpit/effect-core';
import { getStore } from '../../engines/naby';
import type { RuntimeMessage } from '../../engines/naby';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ChatMessage {
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
 */
function toChatMessages(messages: RuntimeMessage[]): ChatMessage[] {
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

export const GET = dynamicHandler<
  { sessionId: string },
  AppError | NotFoundError | ValidationError
>((_req, { sessionId }) =>
  Effect.gen(function* () {
    if (!sessionId) {
      return yield* Effect.fail(
        new ValidationError({ field: 'sessionId', reason: 'missing' })
      );
    }
    const store = getStore();
    // Unknown session id → 404, same status the old "file not found" path used.
    if (!store.getSession(sessionId)) {
      return yield* Effect.fail(
        new NotFoundError({ resource: 'session', id: sessionId })
      );
    }
    const messages = yield* Effect.try({
      try: () => toChatMessages(store.getMessages(sessionId)),
      catch: (cause) =>
        new AppError({ message: 'load session history failed', cause }),
    });
    return ok({ messages });
  })
);
