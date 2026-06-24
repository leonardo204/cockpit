import { query } from '@anthropic-ai/claude-agent-sdk';
import type { RunCtx, ImageData } from '../types';

type SdkOptions = Record<string, unknown>;

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: ImageData['media_type']; data: string } };

/** Build the SDK options for one attempt. `abort` is the controller for THIS attempt (the loop
 *  creates a fresh one per compaction retry and forwards ctx.signal into it). Engine-specific
 *  knobs (env, permissionMode, CLAUDE_CONFIG_DIR, plan canUseTool) live in here. `resume` is the
 *  session id to resume (undefined on first attempt for a new session). */
export type BuildSdkOptions = (abort: AbortController, resume: string | undefined) => SdkOptions;

const MAX_COMPACTION_RETRIES = 1;

/** Forward ctx.signal into a fresh AbortController (query() takes an AbortController, not a
 *  signal; each compaction retry needs its own). */
function follow(ctx: RunCtx): AbortController {
  const ac = new AbortController();
  if (ctx.signal.aborted) ac.abort();
  else ctx.signal.addEventListener('abort', () => ac.abort(), { once: true });
  return ac;
}

/**
 * Shared SDK run loop for Anthropic-SDK engines (claude / claude2 / deepseek).
 *
 * Identical across these engines: build content (text ∪ images) → query() → stream events to
 * the registry → on system.init rekey to the real sessionId → on context compaction (stream
 * ends without a result) re-query with 'continue'. The only engine variance is `buildOptions`
 * (env, permissionMode, config dir), injected by the caller.
 */
export async function runSdkLoop(ctx: RunCtx, buildOptions: BuildSdkOptions): Promise<void> {
  const hasImages = !!(ctx.images && ctx.images.length > 0);

  // Build message content: images first (so the model sees them before text), then text.
  const content: ContentBlock[] = [];
  if (ctx.images) {
    for (const img of ctx.images) {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
    }
  }
  if (ctx.prompt) content.push({ type: 'text', text: ctx.prompt });

  const firstAbort = follow(ctx);
  const baseOptions = buildOptions(firstAbort, ctx.sessionId);

  let response;
  if (hasImages) {
    const messages = (async function* () {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content },
        parent_tool_use_id: null,
        session_id: ctx.sessionId || `session-${ctx.currentKey()}`,
      };
    })();
    response = query({ prompt: messages, options: baseOptions });
  } else {
    response = query({ prompt: ctx.prompt as string, options: baseOptions });
  }

  let currentResponse = response;

  for (let attempt = 0; attempt <= MAX_COMPACTION_RETRIES; attempt++) {
    let receivedResult = false;

    for await (const message of currentResponse) {
      if (ctx.signal.aborted) break;

      const msg = message as { type?: string; subtype?: string; session_id?: string };
      // New session: the engine reveals its real sessionId in the system.init event.
      if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
        ctx.rekey(msg.session_id);
      }
      if (msg.type === 'result') receivedResult = true;

      ctx.emit(message as { type: string; [k: string]: unknown });
    }

    if (receivedResult || ctx.signal.aborted) break;

    // Stream ended without a result → likely context compaction; re-query to continue.
    const retryAbort = follow(ctx);
    const resume = ctx.currentKey(); // real sessionId after rekey, else the provisional runId
    currentResponse = query({
      prompt: 'continue',
      options: { ...buildOptions(retryAbort, resume), resume },
    });
  }
}
