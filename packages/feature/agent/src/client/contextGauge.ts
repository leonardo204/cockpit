// packages/feature/agent/src/client/contextGauge.ts
//
// HOW FULL IS THE WINDOW — the derivation, kept pure (specs/session-context-
// management.md §2.1).
//
// The number itself is a MEASUREMENT taken by the engine (the last step's reported
// input tokens, cache reads included) and the window comes from the runtime's model
// registry; both arrive on the turn's `result` event. All that is left is the part
// that is easy to get quietly wrong — when to show a ratio, when to show only a
// count, and which of the three tiers a percentage falls in — so it lives here,
// away from JSX, and is asserted directly.
//
// THE RULE THAT DECIDES EVERY BRANCH: never show a number that is not true. No
// measurement → show nothing. A measurement with no known window → show the count
// and NO ratio, because a percentage against a guessed denominator looks exactly as
// authoritative as a real one.

/** The tiers, in the order they escalate. `neutral` is the ordinary state and gets
 *  the muted colour every other stat in the bar already uses. */
export type ContextGaugeTier = 'neutral' | 'warn' | 'critical';

/** 70% — the first tier boundary (§2.1). */
export const GAUGE_WARN_RATIO = 0.7;
/** 85% — the second, and the point at which the input banner appears (§2.1). */
export const GAUGE_CRITICAL_RATIO = 0.85;

export type ContextGauge =
  | { show: false }
  | {
      show: true;
      /** The measured occupancy, in tokens. Always present when `show`. */
      tokens: number;
      /** The window, when the model is one the registry knows. */
      window?: number;
      /** 0..100, rounded. Absent exactly when `window` is. */
      percent?: number;
      tier: ContextGaugeTier;
      /** True at or above 85% — what the threshold banner keys on. Never true
       *  without a window, since a ratio is what "85%" means. */
      atThreshold: boolean;
    };

/**
 * Derive what the status bar should show.
 *
 * `tokens` undefined (or non-positive) hides the gauge entirely: it means no step
 * of the last turn reported usage, and the honest rendering of "we did not measure
 * it" is silence, not a zero.
 */
export function contextGauge(
  tokens: number | undefined,
  window: number | undefined,
): ContextGauge {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) {
    return { show: false };
  }
  if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) {
    // Measured, but against an unknown window: the count is true, the ratio would
    // not be. Neutral, because a tier is a statement about fullness.
    return { show: true, tokens, tier: 'neutral', atThreshold: false };
  }
  const ratio = tokens / window;
  const percent = Math.round(ratio * 100);
  const tier: ContextGaugeTier =
    ratio >= GAUGE_CRITICAL_RATIO ? 'critical' : ratio >= GAUGE_WARN_RATIO ? 'warn' : 'neutral';
  return {
    show: true,
    tokens,
    window,
    percent,
    tier,
    atThreshold: ratio >= GAUGE_CRITICAL_RATIO,
  };
}

/** `132000` → `132k`. Compact because this sits in a one-line stats row beside
 *  three other numbers; exact token counts are in the usage modal. */
export function formatTokensShort(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const k = tokens / 1000;
  // One decimal below 10k (`8.4k` reads better than `8k` when it matters), whole
  // thousands above it (`132k`, not `132.4k`).
  return k < 10 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
}

/** The Tailwind text colour for a tier, reusing the classes the bar already uses
 *  for its other states (muted / amber / red) so nothing new enters the palette. */
export function gaugeToneClass(tier: ContextGaugeTier): string {
  return tier === 'critical'
    ? 'text-red-500'
    : tier === 'warn'
      ? 'text-yellow-500'
      : 'text-muted-foreground';
}
