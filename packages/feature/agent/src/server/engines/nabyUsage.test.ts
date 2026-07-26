import { describe, it, expect } from 'vitest';
import { toSdkUsage } from './naby';

/**
 * The chat bar sums input + cache_read + cache_creation to get the context size,
 * and divides cache_read by that sum for `Cache: n%`. That is only correct if the
 * three are DISJOINT — while the runtime's `Usage.inputTokens` is a TOTAL with the
 * cached portion already inside it. Passing it through unchanged double-counted the
 * cache reads: a turn running at ~89% cache displayed 47%, on a context number
 * inflated by exactly the cache-read count.
 *
 * These assertions are written the way the BAR reads the numbers, not the way the
 * function returns them, because the bar's arithmetic is the thing that was wrong.
 */

const barContext = (u: Record<string, number>) =>
  u.input_tokens! + u.cache_read_input_tokens! + u.cache_creation_input_tokens!;
const barCachePct = (u: Record<string, number>) =>
  (u.cache_read_input_tokens! / barContext(u)) * 100;

describe('toSdkUsage — the context number the bar renders', () => {
  it('sums back to the runtime total, not the total plus the cache reads', () => {
    // The shape of the reported bug: 88,284 in context, most of it a cache hit.
    const u = toSdkUsage({ inputTokens: 88_284, outputTokens: 1_574, cachedInputTokens: 78_289 });
    expect(barContext(u)).toBe(88_284);
    // Before the fix this was 166,573 — the number on the user's screen.
    expect(barContext(u)).not.toBe(88_284 + 78_289);
  });

  it('reports the true cache ratio', () => {
    const u = toSdkUsage({ inputTokens: 88_284, outputTokens: 0, cachedInputTokens: 78_289 });
    expect(Math.round(barCachePct(u))).toBe(89); // displayed 47% before
  });

  it('passes output through untouched', () => {
    expect(toSdkUsage({ inputTokens: 10, outputTokens: 1_574, cachedInputTokens: 0 }).output_tokens).toBe(1_574);
  });

  it('a turn with no cache hit reports the whole input as input', () => {
    const u = toSdkUsage({ inputTokens: 5_000, outputTokens: 100, cachedInputTokens: 0 });
    expect(u.input_tokens).toBe(5_000);
    expect(u.cache_read_input_tokens).toBe(0);
    // The bar hides the Cache chip entirely when both cache counts are 0.
    expect(barContext(u)).toBe(5_000);
  });

  it('a fully cached turn reports 100%, and no negative input', () => {
    const u = toSdkUsage({ inputTokens: 4_000, outputTokens: 8, cachedInputTokens: 4_000 });
    expect(u.input_tokens).toBe(0);
    expect(barCachePct(u)).toBe(100);
  });

  it('clamps a provider that breaks the cached <= input contract', () => {
    // Never render a negative context. The contract says this cannot happen; the
    // clamp is here so a provider bug degrades to a wrong-but-sane number.
    const u = toSdkUsage({ inputTokens: 100, outputTokens: 0, cachedInputTokens: 999 });
    expect(u.input_tokens).toBe(0);
    expect(barContext(u)).toBe(100);
  });

  it('reports zeros for a turn with no usage yet', () => {
    // Called with undefined on system/init and on error events.
    const u = toSdkUsage(undefined);
    expect(barContext(u)).toBe(0);
    expect(u.output_tokens).toBe(0);
  });
});
