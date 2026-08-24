// packages/feature/agent/src/client/cacheBreakdown.ts
//
// WHAT THE CACHE-HIT PERCENTAGE IS MADE OF — the derivation, kept pure.
//
// The status bar shows `캐시 적중: 75%`, and the question a reader actually has
// when they see it is "75% of what, and what was the other 25%". This decides the
// answer, away from JSX, because the honest answer is bounded by what is MEASURED
// and that boundary is exactly the kind of thing that erodes in a template.
//
// WHAT THE API REPORTS, AND WHAT IT DOES NOT
// ------------------------------------------
// A turn's `usage` carries four counts and nothing else:
//
//   input_tokens                  prompt tokens billed at the full rate
//   cache_creation_input_tokens   prompt tokens WRITTEN into the cache this turn
//   cache_read_input_tokens       prompt tokens READ back out of the cache
//   output_tokens                 (not this function's business)
//
// The first three partition the turn's input, which is why the bar's "turn input"
// is their sum. So the truthful expansion of the percentage is those same three
// numbers: how much was read from cache, how much was written to it, how much went
// uncached. That is a MEASUREMENT and it adds up.
//
// WHAT THIS FUNCTION REFUSES TO DERIVE, and the request that made it necessary:
// "tell me WHICH things were hit". It cannot be answered from these fields.
// Anthropic caches a prompt PREFIX and reports token counts over it; it never says
// which blocks inside that prefix were reused. naby knows what it INJECTED (the
// runtime's memory and skill injectors both track `tokensUsed`), but knowing what
// you put into the prefix is not knowing which part the server served from cache —
// presenting injection sizes as cache attribution would be inventing a measurement
// out of two unrelated ones. The composition of the prefix is stated in the
// tooltip in WORDS instead, kept clearly apart from these numbers.
//
// ABSENT STAYS ABSENT. Every count reaches the client through a `|| 0` (see
// useChatStream / useChatHistory), so a zero here means "the provider said zero OR
// said nothing" and the two are indistinguishable. Neither is worth a line: a
// tooltip reading `캐시 없이 보냄: 0` claims a fact about a turn that may simply not
// have been reported. The line disappears instead — the same rule the gauge and the
// plan chip already follow.

/** Which of the three input categories a line reports. Not a translation key: the
 *  component maps these to literal `t()` calls, so the dictionary stays greppable
 *  and a missing translation is a build-visible fact rather than a runtime one. */
export type CacheLineKind = 'read' | 'write' | 'uncached';

/** One line of the tooltip's breakdown — a category and its measured size. Only
 *  categories that were actually reported get one. */
export interface CacheBreakdownLine {
  kind: CacheLineKind;
  tokens: number;
}

export type CacheBreakdown =
  | { show: false }
  | {
      show: true;
      /** 0..100, rounded — `read / total`. THE SAME NUMBER THE ROW PRINTS: the row
       *  reads it from here rather than recomputing it, so the tooltip's counts and
       *  the percentage beside them cannot come to disagree. */
      percent: number;
      /** The turn's whole input — read + write + uncached. The denominator, exposed
       *  because the percentage is only checkable against it. */
      total: number;
      /** In reading order: what came out of the cache, what went into it, what
       *  neither. A category that was not reported is ABSENT, never a zero. */
      lines: CacheBreakdownLine[];
    };

/** A count as arithmetic may use it. Anything not a positive finite number is
 *  treated as nothing at all — `NaN` must never reach a percentage, and a negative
 *  count is not a thing that exists. */
function counted(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Expand a turn's usage into the three measured input categories.
 *
 * `show: false` is returned when neither cache count is present — the same
 * condition the row already used to decide whether to draw the stat at all, moved
 * here so the stat and its tooltip cannot disagree about whether there is anything
 * to say. A turn with input but no caching is not a 0% cache hit; it is a turn the
 * cache had no part in, and the row stays silent about it.
 */
export function cacheBreakdown(usage: {
  inputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}): CacheBreakdown {
  const read = counted(usage.cacheReadInputTokens);
  const write = counted(usage.cacheCreationInputTokens);
  const uncached = counted(usage.inputTokens);

  if (read === 0 && write === 0) return { show: false };

  const total = read + write + uncached;
  const lines: CacheBreakdownLine[] = [];
  if (read > 0) lines.push({ kind: 'read', tokens: read });
  if (write > 0) lines.push({ kind: 'write', tokens: write });
  if (uncached > 0) lines.push({ kind: 'uncached', tokens: uncached });

  return {
    show: true,
    // `total` is necessarily positive here (one of the two cache counts is), so
    // this cannot divide by zero.
    percent: Math.round((read / total) * 100),
    total,
    lines,
  };
}
