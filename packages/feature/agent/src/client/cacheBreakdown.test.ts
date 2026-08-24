import { describe, it, expect } from 'vitest';
import { cacheBreakdown } from './cacheBreakdown';

/**
 * WHAT THE CACHE TOOLTIP IS ALLOWED TO SAY.
 *
 * The feature exists because "캐시 적중: 75%" answers nothing on its own — 75% of
 * what, and what was the other 25%. The expansion is the three MEASURED categories
 * that partition a turn's input, and the two rules that keep it honest are both
 * tested here:
 *
 *   1. the counts add up to the denominator the percentage was taken against, so a
 *      reader can check the number rather than trust it;
 *   2. a category that was not reported produces NO LINE — never `0`. Every count
 *      reaches the client through a `|| 0`, so a zero is indistinguishable from an
 *      absence, and printing it would turn "we were not told" into a claim. This is
 *      the same rule contextGauge and the plan chip already follow.
 *
 * What is deliberately NOT here, and must not be added: any assertion mapping a hit
 * to named content (system prompt / memories / skills). Anthropic reports token
 * counts over a cached prefix and never says which blocks inside it were reused, so
 * there is no measurement to test against.
 */

/** A turn where all three categories were reported. 750 of 1000 input tokens came
 *  out of the cache — the 75% the bar prints. */
const FULL = {
  inputTokens: 200,
  cacheCreationInputTokens: 50,
  cacheReadInputTokens: 750,
};

describe('cacheBreakdown — the three counts', () => {
  it('reports read, write and uncached when all three are present', () => {
    const b = cacheBreakdown(FULL);
    expect(b.show).toBe(true);
    if (!b.show) return;
    expect(b.lines).toEqual([
      { kind: 'read', tokens: 750 },
      { kind: 'write', tokens: 50 },
      { kind: 'uncached', tokens: 200 },
    ]);
  });

  it('adds the counts up to the total the percentage divides by', () => {
    const b = cacheBreakdown(FULL);
    if (!b.show) throw new Error('expected a breakdown');
    const summed = b.lines.reduce((acc, line) => acc + line.tokens, 0);
    expect(summed).toBe(b.total);
    expect(b.total).toBe(1000);
    // The relationship the tooltip is claiming: the percentage IS read / total.
    // If these ever diverge the tooltip becomes three numbers that do not explain
    // the one above them.
    expect(b.percent).toBe(75);
    const read = b.lines.find((line) => line.kind === 'read');
    expect(Math.round(((read?.tokens ?? 0) / b.total) * 100)).toBe(b.percent);
  });

  it('rounds the percentage the way the row already printed it', () => {
    // `(x).toFixed(0)` was inlined in the JSX; the row now reads this field, and
    // for a non-negative ratio the two agree — including at a .5 tie, which both
    // resolve upward.
    const b = cacheBreakdown({ inputTokens: 1, cacheCreationInputTokens: 1, cacheReadInputTokens: 2 });
    if (!b.show) throw new Error('expected a breakdown');
    expect(b.percent).toBe(50);
    // 1/8 = 12.5% — an exact tie, and both roundings take it up.
    const tie = cacheBreakdown({ inputTokens: 7, cacheCreationInputTokens: 0, cacheReadInputTokens: 1 });
    if (!tie.show) throw new Error('expected a breakdown');
    expect(tie.percent).toBe(13);
    expect(tie.percent).toBe(Number(((1 / 8) * 100).toFixed(0)));
  });
});

describe('cacheBreakdown — absent stays absent', () => {
  it('drops the uncached line rather than printing a zero', () => {
    const b = cacheBreakdown({ inputTokens: 0, cacheCreationInputTokens: 50, cacheReadInputTokens: 750 });
    if (!b.show) throw new Error('expected a breakdown');
    expect(b.lines.map((l) => l.kind)).toEqual(['read', 'write']);
    expect(b.total).toBe(800);
  });

  it('drops the write line rather than printing a zero', () => {
    // The ordinary steady-state turn: the prefix was already cached, so nothing
    // new was written into it.
    const b = cacheBreakdown({ inputTokens: 200, cacheCreationInputTokens: 0, cacheReadInputTokens: 750 });
    if (!b.show) throw new Error('expected a breakdown');
    expect(b.lines.map((l) => l.kind)).toEqual(['read', 'uncached']);
    expect(b.total).toBe(950);
  });

  it('drops the read line rather than printing a zero — the first turn of a session', () => {
    // Nothing to read yet; the cache is being written for the next turn. The stat
    // still shows (0%), which is the case the tooltip's last line explains.
    const b = cacheBreakdown({ inputTokens: 200, cacheCreationInputTokens: 800, cacheReadInputTokens: 0 });
    if (!b.show) throw new Error('expected a breakdown');
    expect(b.lines.map((l) => l.kind)).toEqual(['write', 'uncached']);
    expect(b.percent).toBe(0);
  });

  it('treats an undefined count as absent, not as zero-and-therefore-a-line', () => {
    const b = cacheBreakdown({ cacheReadInputTokens: 750 });
    if (!b.show) throw new Error('expected a breakdown');
    expect(b.lines).toEqual([{ kind: 'read', tokens: 750 }]);
    expect(b.total).toBe(750);
    expect(b.percent).toBe(100);
  });

  it('never lets a malformed count reach the percentage', () => {
    // NaN through a division is NaN, and `NaN%` is exactly the kind of thing this
    // row must not print. Negative counts are not a thing that exists.
    const b = cacheBreakdown({
      inputTokens: Number.NaN,
      cacheCreationInputTokens: -5,
      cacheReadInputTokens: 750,
    });
    if (!b.show) throw new Error('expected a breakdown');
    expect(b.lines).toEqual([{ kind: 'read', tokens: 750 }]);
    expect(Number.isFinite(b.percent)).toBe(true);
    expect(b.percent).toBe(100);
  });
});

describe('cacheBreakdown — when there is nothing to say', () => {
  it('hides the stat when neither cache count was reported', () => {
    // A turn the cache had no part in is NOT a 0% cache hit — that would assert a
    // measurement about caching on a turn that reported none. The row stays silent,
    // which is the condition it already used inline.
    expect(cacheBreakdown({ inputTokens: 4000 })).toEqual({ show: false });
    expect(cacheBreakdown({})).toEqual({ show: false });
    expect(
      cacheBreakdown({ inputTokens: 4000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }),
    ).toEqual({ show: false });
  });
});
