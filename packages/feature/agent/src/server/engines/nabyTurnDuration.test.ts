import { describe, it, expect } from 'vitest';
import { createNabySpec, getStore } from './naby';
import { toChatMessages } from '../api/session/toChatMessages';
import type { RunCtx, RunEvent } from './types';

/**
 * THE TURN REPORTS HOW LONG IT TOOK — on the wire, and on disk, and the same
 * numbers in both.
 *
 * Driven through the production `createNabySpec` with a hand-rolled model, so
 * what is asserted is the engine's own wiring rather than a restatement of it.
 * Three claims, each one a way this has already been got wrong somewhere:
 *
 *   1. Both numbers come from the ENGINE. The client must not subtract
 *      timestamps of its own: its clock is a different clock, and a stream can
 *      arrive late (a viewer joining, a snapshot replay), which would time the
 *      delivery instead of the turn.
 *   2. The end time is the turn's END, not its start. `startedAt + duration`
 *      has to be the value, or a four-minute turn reports the moment the user
 *      pressed enter as the moment the answer arrived.
 *   3. The transcript is written BEFORE `result` is emitted. The client renders
 *      the number when `result` lands and then reconciles its tail from disk
 *      (`Chat.tsx`, reconcileFromDiskRef) — so a stamp landing after the event
 *      can lose that race, and the duration appears and then vanishes.
 *
 * NO NETWORK AND NO KEYS. The store is the throwaway one vitest.setup.ts points
 * NABY_DB_PATH at.
 */

const ANSWER = '세션 스토어는 런타임에 두는 편이 낫다.';

/** The smallest thing `ai@7` will accept as a model — see nabyVoiceTurn.test.ts
 *  for why this is hand-rolled rather than `ai/test`'s mock. */
function fixedModel(answer: string, delayMs = 0) {
  return {
    specificationVersion: 'v4' as const,
    provider: 'mock',
    modelId: 'claude-sonnet-4-5',
    supportedUrls: {},
    async doGenerate() {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return {
        content: [{ type: 'text' as const, text: answer }],
        finishReason: { unified: 'stop' as const, raw: 'end_turn' },
        usage: {
          inputTokens: { total: 1234, noCache: 1234, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
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
  onEmit?: (event: RunEvent) => void,
): { ctx: RunCtx; events: RunEvent[] } {
  const events: RunEvent[] = [];
  let key = sessionId;
  const ctx: RunCtx = {
    prompt,
    images: undefined,
    cwd: '',
    sessionId,
    params: { prompt, engine: 'naby', model: 'claude-sonnet-4-5' },
    signal: new AbortController().signal,
    emit(event: RunEvent) {
      events.push(event);
      onEmit?.(event);
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

function resultOf(events: RunEvent[]): RunEvent {
  const result = events.find((e) => e.type === 'result');
  expect(result, 'the turn emitted no result event').toBeDefined();
  return result!;
}

describe('a naby turn reports its own duration and end time', () => {
  it('puts both on the result event, from the engine’s clock', async () => {
    const store = getStore();
    const { sessionId } = store.createSession('', 'source');
    const before = Date.now();
    const spec = createNabySpec({ resolveModel: () => fixedModel(ANSWER) as never });
    const { ctx, events } = harness(sessionId, '스토어를 어디에 둘까?');
    await spec.runner.run(ctx);
    const after = Date.now();

    const result = resultOf(events);
    expect(typeof result.duration_ms).toBe('number');
    expect(typeof result.ended_at).toBe('number');
    // The end time is a real reading taken inside the turn, not a constant and
    // not the client's.
    expect(result.ended_at as number).toBeGreaterThanOrEqual(before);
    expect(result.ended_at as number).toBeLessThanOrEqual(after);
  });

  it('the end time is when the turn ENDED, not when it started', async () => {
    // A turn with a measurable length: `ended_at - duration_ms` must land back
    // at the start, which is the arithmetic that makes the pair meaningful. A
    // pair built from two separate `Date.now()` calls would not close.
    const store = getStore();
    const { sessionId } = store.createSession('', 'source');
    const startedNoLaterThan = Date.now();
    const spec = createNabySpec({ resolveModel: () => fixedModel(ANSWER, 60) as never });
    const { ctx, events } = harness(sessionId, '조금 오래 걸리는 턴');
    await spec.runner.run(ctx);

    const result = resultOf(events);
    const duration = result.duration_ms as number;
    const endedAt = result.ended_at as number;
    expect(duration).toBeGreaterThanOrEqual(60);
    expect(endedAt - duration).toBeGreaterThanOrEqual(startedNoLaterThan - 1);
    expect(endedAt - duration).toBeLessThanOrEqual(endedAt);
  });

  it('has already written the transcript by the time result is emitted', async () => {
    // The ordering claim, checked at the only instant that can show it: inside
    // the emit callback, before the client would ever get the event.
    const store = getStore();
    const { sessionId } = store.createSession('', 'source');
    let stampedAtEmit: unknown;
    const spec = createNabySpec({ resolveModel: () => fixedModel(ANSWER) as never });
    const { ctx, events } = harness(sessionId, '기록이 먼저인가?', (event) => {
      if (event.type !== 'result') return;
      const rows = store.getMessages(sessionId);
      const last = [...rows].reverse().find((m) => m.role === 'assistant');
      stampedAtEmit = last && last.role === 'assistant' ? last.turn : undefined;
    });
    await spec.runner.run(ctx);

    expect(stampedAtEmit, 'the turn stamp had not landed when result was emitted').toBeDefined();
    const result = resultOf(events);
    expect(stampedAtEmit).toEqual({
      durationMs: result.duration_ms,
      endedAt: result.ended_at,
    });
  });

  it('a reloaded transcript shows the same numbers the live turn did', async () => {
    // The whole point of persisting it: the completed run reconciles from disk
    // seconds later, so the reload has to agree with the event or the number
    // appears and then vanishes.
    const store = getStore();
    const { sessionId } = store.createSession('', 'source');
    const spec = createNabySpec({ resolveModel: () => fixedModel(ANSWER) as never });
    const { ctx, events } = harness(sessionId, '다시 열어도 남아 있나?');
    await spec.runner.run(ctx);

    const result = resultOf(events);
    const reloaded = toChatMessages(store.getMessages(sessionId));
    const lastAssistant = [...reloaded].reverse().find((m) => m.role === 'assistant');
    expect(lastAssistant?.durationMs).toBe(result.duration_ms);
    expect(lastAssistant?.completedAt).toBe(new Date(result.ended_at as number).toISOString());
  });

  it('never puts a measurement on the user’s own message', async () => {
    const store = getStore();
    const { sessionId } = store.createSession('', 'source');
    const spec = createNabySpec({ resolveModel: () => fixedModel(ANSWER) as never });
    const { ctx } = harness(sessionId, '내 메시지에는 붙지 않는다');
    await spec.runner.run(ctx);

    for (const row of store.getMessages(sessionId)) {
      if (row.role !== 'assistant') expect(row).not.toHaveProperty('turn');
    }
    const reloaded = toChatMessages(store.getMessages(sessionId));
    for (const m of reloaded) {
      if (m.role !== 'assistant') expect(m.durationMs).toBeUndefined();
    }
  });
});
