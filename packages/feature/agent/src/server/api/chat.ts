import { Effect } from 'effect';
import { handler, parseJsonRaw } from '@cockpit/effect-runtime/server';
import { dispatchChat } from '../engines/orchestrator';
import { nabySpec } from '../engines/naby';
import type { DispatchParams } from '../engines/types';

// Thin Next.js mount point. All dispatch lives in the orchestrator + naby runner so it can be
// called in-process by the scheduled-task manager too — and so this route exports only POST.
//
// FORK CHANGE (F1-01, completed here): this route dispatched upstream's `claudeSpec` — the
// Claude Agent SDK engine we replaced. The client posts every non-{codex,kimi,ollama,deepseek}
// turn here (useChatStream.ts), so while it pointed at claudeSpec the naby engine was
// registered but UNREACHABLE from the chat UI: the runtime, the gate and the provider
// registry were all wired up and nothing ever called them. Pointing it at `nabySpec` is what
// makes the default chat path run through OUR runtime, which is the whole point of the fork.
export const POST = handler((request) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(request)) as DispatchParams;
    const outcome = yield* Effect.promise(() => dispatchChat(nabySpec, body, request));
    if (!outcome.ok) {
      return new Response(JSON.stringify({ error: outcome.error }), {
        status: outcome.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return Response.json({ runKey: outcome.runKey, sessionId: outcome.sessionId });
  })
);
