import { describe, it, expect } from 'vitest';
import { planTextRender } from './textRender';

describe('planTextRender — the same words must not appear twice', () => {
  it('a streaming message: deltas render, the complete event only accumulates', () => {
    // The sequence a streaming engine produces for one message.
    let saw = false;
    const deltas = ['Hel', 'lo', ' there'].map((_, i) => {
      const p = planTextRender(true, saw);
      saw = p.sawPartialNext;
      return { i, ...p };
    });
    expect(deltas.every((d) => d.render && !d.accumulate)).toBe(true);

    const complete = planTextRender(false, saw);
    // Accumulated for the transcript, NOT rendered — it is already on screen.
    expect(complete).toEqual({ render: false, accumulate: true, sawPartialNext: false });
  });

  it('a NON-streaming engine renders its complete message, unchanged', () => {
    // The ai-sdk path emits no partials, so the complete event is the only chance
    // to put anything on screen. This is the case a naive fix breaks.
    expect(planTextRender(false, false)).toEqual({
      render: true,
      accumulate: true,
      sawPartialNext: false,
    });
  });

  it('the flag resets per message, so a second message decides for itself', () => {
    // Message 1 streamed; message 2 did not. Message 2 must still render.
    const afterStreamed = planTextRender(false, true);
    expect(afterStreamed.sawPartialNext).toBe(false);
    expect(planTextRender(false, afterStreamed.sawPartialNext).render).toBe(true);
  });

  it('a partial never accumulates, so tokens cannot be counted as turns', () => {
    // `turns` drives the autonomy loop's step accounting; counting deltas would
    // make a single answer look like hundreds of turns.
    for (const saw of [false, true]) {
      expect(planTextRender(true, saw).accumulate).toBe(false);
    }
  });
});
