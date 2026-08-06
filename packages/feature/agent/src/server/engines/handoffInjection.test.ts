import { describe, it, expect } from 'vitest';
import { createNabySpec, getStore } from './naby';
import { HANDOFF_BLOCK_HEADER } from '../lib/sessionHandoff';
import type { RunCtx, RunEvent } from './types';

/**
 * THE HANDOFF ACTUALLY REACHES THE MODEL (specs/session-context-management §2.2).
 *
 * Storing a handoff and injecting one are two different claims, and only the
 * second is the feature. So this drives the REAL engine spec — the same
 * `createNabySpec` the chat route loads — through the production `resolveModel`
 * seam, and reads the system prompt out of the model call itself. If the injection
 * were removed, the row would still be written and only this test would fail.
 *
 * NO NETWORK AND NO KEYS: the model is a hand-rolled `LanguageModelV4` that records
 * its prompt and answers one sentence. It is injected through the same seam
 * SPIKE-02 uses, so the tested path is the production path minus the provider.
 *
 * The store is the throwaway one vitest.setup.ts points NABY_DB_PATH at.
 */

type Seen = { system?: string };

/** The smallest thing `ai@7` will accept as a model: it records the system prompt
 *  and returns one text step. Hand-rolled rather than `ai/test`'s mock because the
 *  engine runs inside the prebuilt runtime bundle, which carries its OWN copy of
 *  `ai` — a mock from the shell's tree would be a different module's class.
 *
 *  `servedModelId` is what the provider says it ACTUALLY served, which is a
 *  different thing from the id we configured — see the window-gauge tests. */
function recordingModel(seen: Seen, opts?: { modelId?: string; servedModelId?: string }) {
  return {
    specificationVersion: 'v4' as const,
    provider: 'mock',
    modelId: opts?.modelId ?? 'claude-sonnet-4-5',
    supportedUrls: {},
    async doGenerate(options: { prompt: unknown }) {
      const prompt = options.prompt as { role: string; content: unknown }[];
      const system = prompt.find((m) => m.role === 'system');
      if (system && typeof system.content === 'string') seen.system = system.content;
      return {
        content: [{ type: 'text' as const, text: 'ok.' }],
        finishReason: { unified: 'stop' as const, raw: 'end_turn' },
        usage: {
          inputTokens: { total: 1234, noCache: 1234, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        ...(opts?.servedModelId
          ? {
              response: {
                id: 'resp-1',
                timestamp: new Date(0),
                modelId: opts.servedModelId,
              },
            }
          : {}),
        warnings: [] as never[],
      };
    },
    async doStream() {
      throw new Error('not used');
    },
  };
}

function harness(
  sessionId: string,
  prompt: string,
  model = 'claude-sonnet-4-5',
): { ctx: RunCtx; events: RunEvent[] } {
  const events: RunEvent[] = [];
  let key = sessionId;
  const ctx: RunCtx = {
    prompt,
    images: undefined,
    cwd: '',
    sessionId,
    // The model is NAMED so the window registry has something to look up — the
    // same field the chat route sends from the model switcher. Without it the
    // test-injected resolver labels the turn 'injected-model', which is correctly
    // an unknown window.
    params: { prompt, engine: 'naby', model },
    signal: new AbortController().signal,
    emit(event: RunEvent) {
      events.push(event);
    },
    rekey(id: string) {
      key = id;
    },
    currentKey() {
      return key;
    },
  };
  return { ctx, events };
}

async function runWith(
  handoff: string | undefined,
  opts?: { requestedModel?: string; modelId?: string; servedModelId?: string },
): Promise<{ seen: Seen; events: RunEvent[] }> {
  const store = getStore();
  const { sessionId } = store.createSession('', 'source');
  if (handoff) store.setSessionHandoff(sessionId, handoff);
  const seen: Seen = {};
  const spec = createNabySpec({
    resolveModel: () =>
      recordingModel(seen, {
        ...(opts?.modelId ? { modelId: opts.modelId } : {}),
        ...(opts?.servedModelId ? { servedModelId: opts.servedModelId } : {}),
      }) as never,
  });
  const { ctx, events } = harness(sessionId, 'where were we?', opts?.requestedModel);
  await spec.runner.run(ctx);
  return { seen, events };
}

describe('handoff injection', () => {
  it('injects the labelled handoff block into every turn of a continued session', async () => {
    const { seen } = await runWith('AGREED: ship on Friday. OPEN: pricing.');
    expect(seen.system).toBeDefined();
    expect(seen.system).toContain(HANDOFF_BLOCK_HEADER);
    expect(seen.system).toContain('AGREED: ship on Friday. OPEN: pricing.');
  });

  it('says nothing about a handoff in an ordinary session', async () => {
    // The no-op invariant: a session that was not continued from anywhere has the
    // prompt it always had.
    const { seen } = await runWith(undefined);
    expect(seen.system ?? '').not.toContain(HANDOFF_BLOCK_HEADER);
  });

  it('reports the window occupancy and its denominator on the result event', async () => {
    // The gauge's fields (§2.1), measured end to end: the mock reports a
    // 1234-token prompt on its single step, and the model id resolves to Claude's
    // 200k window through the registry.
    const { events } = await runWith(undefined);
    const result = events.find((e) => e.type === 'result');
    expect(result).toBeDefined();
    expect(result?.context_tokens).toBe(1234);
    expect(result?.context_window).toBe(200_000);
    expect(result?.context_model).toBe('claude-sonnet-4-5');
    // …and it is NOT the per-turn total, which lives on `usage` and means something
    // else entirely.
    expect(result?.usage).toBeDefined();
  });

  it('reports the model the PROVIDER served, not the one we asked for', async () => {
    // THE BUG THIS EXISTS FOR. The turn is requested as `default` — the Agent SDK's
    // own "let Claude pick" row, and the app's most common path — which no registry
    // can size, so the gauge lost its percentage entirely. The run knows the answer
    // and now says so, and the denominator is resolved from THAT.
    const { events } = await runWith(undefined, {
      requestedModel: 'default',
      modelId: 'default',
      servedModelId: 'claude-opus-5[1m]',
    });
    const result = events.find((e) => e.type === 'result');
    expect(result?.context_model).toBe('claude-opus-5[1m]');
    // …and the served id carries the long-context tier, which is five times the
    // window the requested name would have implied — if it implied one at all.
    expect(result?.context_window).toBe(1_000_000);
  });
});
