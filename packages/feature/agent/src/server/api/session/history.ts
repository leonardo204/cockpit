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
// The row→bubble mapping (including the tool-call coalescing a reloaded
// transcript needs) lives in its own module: a Next route may only export the
// handler surface, so a testable helper cannot sit here.
import { toChatMessages } from './toChatMessages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
