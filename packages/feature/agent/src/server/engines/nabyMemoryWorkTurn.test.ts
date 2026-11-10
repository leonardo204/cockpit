import { describe, it, expect } from 'vitest';
import { DEFAULT_USER_ID, type MemoryWriteRequest } from '../../../../../../../dist/naby-runtime.mjs';
import { createNabySpec, getStore } from './naby';
import type { MemoryReviewer } from '../lib/memoryReview';
import { settleMemoryWork } from '../lib/memoryWorker';
import type { RunCtx, RunEvent } from './types';

/**
 * A USER TURN NEVER WAITS ON MEMORY WORK (specs/memory-worker.md §1, §4).
 *
 * The production engine adapter with a scripted model, and a memory reviewer
 * that takes its time — 1.5 s per call. While that review is IN FLIGHT a second
 * turn is sent, and its first event must arrive as fast as a turn sent with no
 * memory work at all. The review runs in-process here (an injected reviewer
 * cannot cross into the memory process); the separate process, and the app's
 * event loop staying free while it works, is `npm run spike:memory-worker`.
 */

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function answering(text: string) {
  return {
    specificationVersion: 'v4' as const,
    provider: 'mock',
    modelId: 'claude-sonnet-4-5',
    supportedUrls: {},
    async doGenerate() {
      return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: 'end_turn' },
        usage: USAGE,
        warnings: [],
      };
    },
    async doStream() {
      throw new Error('not used');
    },
  } as never;
}

/** A turn harness that timestamps the first event. */
function harness(prompt: string, sessionId: string) {
  const events: RunEvent[] = [];
  let firstAt: number | undefined;
  let key = sessionId;
  const ctx: RunCtx = {
    prompt,
    images: undefined,
    cwd: '',
    sessionId,
    params: { prompt, engine: 'naby' },
    signal: new AbortController().signal,
    emit(event: RunEvent) {
      firstAt ??= performance.now();
      events.push(event);
    },
    rekey(id: string) {
      key = id;
    },
    currentKey() {
      return key;
    },
  };
  return { ctx, events, firstAt: () => firstAt };
}

async function firstEventLatency(sessionId: string, deps: Parameters<typeof createNabySpec>[0] = {}): Promise<number> {
  const h = harness('안녕', sessionId);
  const sent = performance.now();
  await createNabySpec({ resolveModel: () => answering('네.'), ...deps }).runner.run(h.ctx);
  expect(h.firstAt()).toBeDefined();
  return h.firstAt()! - sent;
}

describe('memory work runs beside the turn, never in front of it', () => {
  it('a slow review in flight does not delay the next turn\'s first event', async () => {
    const store = getStore();
    const { sessionId } = store.createSession('', 'memory-work-latency');

    // Baseline: the same turn with nothing owed and nothing running. Warmed
    // once first, so module loading is not counted against either side.
    await firstEventLatency(sessionId);
    const baseline = await firstEventLatency(sessionId);

    // Something for the review to look at, written the way naby_remember lands it.
    store.putMemory({
      scope: 'user',
      scopeKey: DEFAULT_USER_ID,
      type: 'semantic',
      key: 'latency-probe',
      value: 'Prefers short answers.',
      provenance: { source: 'user', sessionId, evidenceQuote: '짧게', basisKind: 'stated' },
      confidence: 0.5,
      requestedStatus: 'proposed',
      reviewState: 'pending',
    } as MemoryWriteRequest);

    let inFlight = false;
    let started = 0;
    const slow: MemoryReviewer = {
      label: 'slow (test)',
      async call() {
        started += 1;
        inFlight = true;
        await new Promise((r) => setTimeout(r, 1_500));
        inFlight = false;
        return JSON.stringify({ reviews: [] });
      },
    };

    // The turn that queues the review at its end.
    await firstEventLatency(sessionId, { memoryReviewer: slow });
    const deadline = Date.now() + 5_000;
    while (!inFlight && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(inFlight).toBe(true);

    // The next turn, sent while that review is mid-call.
    const h = harness('하나 더', sessionId);
    const sent = performance.now();
    const run = createNabySpec({ resolveModel: () => answering('네.') }).runner.run(h.ctx);
    while (h.firstAt() === undefined) await new Promise((r) => setImmediate(r));
    const during = h.firstAt()! - sent;
    // Still mid-call when the turn spoke: the turn did not wait for it.
    expect(inFlight).toBe(true);
    await run;

    console.log(`[memory-work latency] first event: baseline ${baseline.toFixed(1)}ms, during review ${during.toFixed(1)}ms`);
    // "The same as without": within a generous margin for a loaded CI box.
    expect(during).toBeLessThan(baseline + 250);
    expect(during).toBeLessThan(1_000);

    await settleMemoryWork();
    expect(started).toBeGreaterThanOrEqual(1);
  }, 20_000);
});
