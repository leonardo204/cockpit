import { describe, it, expect } from 'vitest';
import {
  contextGauge,
  formatGaugePercent,
  formatTokensShort,
  gaugeToneClass,
  modelFamily,
  GAUGE_CRITICAL_RATIO,
  GAUGE_WARN_RATIO,
} from './contextGauge';

/**
 * The window gauge's derivation (specs/session-context-management.md §2.1).
 *
 * The number itself is measured by the engine; what is asserted here is the part
 * that can be wrong without anyone noticing — WHICH DENOMINATOR the percentage is
 * taken against, whether that denominator is presented as a fact or an estimate,
 * and where the two tier boundaries sit.
 *
 * The governing rule changed at v0.3.0 and these tests are what pin the new one:
 * the gauge always shows a percentage now, because a bare token count told the
 * reader nothing — but an estimated percentage is MARKED, and it is never allowed
 * to raise the banner that asks the user to split their conversation.
 */
describe('contextGauge', () => {
  it('hides entirely when the turn reported no per-step usage', () => {
    // The Agent SDK reports nothing on an aborted turn, and a reloaded session has
    // no reading until its next one. A zero would be a claim; absence is the truth.
    // THIS branch is unchanged by the revision: the revision is about the
    // denominator, not about inventing a numerator.
    expect(contextGauge(undefined, 200_000)).toEqual({ show: false });
    expect(contextGauge(0, 200_000)).toEqual({ show: false });
    expect(contextGauge(-5, 200_000)).toEqual({ show: false });
    expect(contextGauge(Number.NaN, 200_000)).toEqual({ show: false });
  });

  it('computes an EXACT percentage against a known window', () => {
    const g = contextGauge(132_000, 200_000, 'claude-sonnet-4-5');
    expect(g.show).toBe(true);
    if (!g.show) return;
    expect(g.percent).toBe(66);
    expect(g.window).toBe(200_000);
    expect(g.approximate).toBe(false);
    expect(g.tier).toBe('neutral');
    expect(g.atThreshold).toBe(false);
    expect(formatGaugePercent(g)).toBe('66%');
  });

  // -- the unknown window: a family default, MARKED -------------------------
  //
  // This is the case the user actually hit. The old behaviour was a bare `293k`,
  // which is not an amount of anything a reader can act on.

  it('estimates from the model FAMILY when no window is known, and marks it', () => {
    const g = contextGauge(132_000, undefined, 'claude-opus-4-5');
    expect(g.show).toBe(true);
    if (!g.show) return;
    expect(g.window).toBe(200_000);
    expect(g.percent).toBe(66);
    expect(g.approximate).toBe(true);
    expect(formatGaugePercent(g)).toBe('~66%');
  });

  it('uses each family’s own default', () => {
    const windowOf = (model: string | undefined) => {
      const g = contextGauge(10_000, undefined, model);
      return g.show ? g.window : undefined;
    };
    expect(windowOf('claude-sonnet-4-5')).toBe(200_000);
    expect(windowOf('sonnet')).toBe(200_000);
    expect(windowOf('gpt-5.6-sol')).toBe(128_000);
    // The o-series is OpenAI, so it takes the OpenAI default — the family's
    // ordinary size, not the 200k an exact lookup would have given it.
    expect(windowOf('o3')).toBe(128_000);
    expect(windowOf('gemini-2.5-pro')).toBe(1_048_576);
    // No model at all: the smallest window any supported provider ships, so the
    // estimate errs toward "fuller than reality" rather than toward silence.
    expect(windowOf(undefined)).toBe(128_000);
    expect(windowOf('llama-3.1-70b')).toBe(128_000);
  });

  it('escalates the family default too, when the reading exceeds it', () => {
    // A 300k reading on an unknown model cannot be 234% of 128k — that denominator
    // is disproved by the measurement itself.
    const g = contextGauge(300_000, undefined, 'some-unknown-model');
    expect(g.show).toBe(true);
    if (!g.show) return;
    expect(g.window).toBe(1_048_576);
    expect(g.approximate).toBe(true);
  });

  // -- the tier-exceeded case: the measurement disproves the window ---------
  //
  // The observed report: `293k` on what the registry called a 200k Claude window.
  // The reading is a fact about the run; the window was an inference from an id.

  it('climbs to the next tier when the measurement EXCEEDS the known window', () => {
    const g = contextGauge(293_384, 200_000, 'claude-opus-5');
    expect(g.show).toBe(true);
    if (!g.show) return;
    // Claude's next rung is the long-context tier.
    expect(g.window).toBe(1_000_000);
    expect(g.percent).toBe(29);
    expect(g.approximate).toBe(true);
    expect(formatGaugePercent(g)).toBe('~29%');
    expect(g.tier).toBe('neutral');
  });

  it('climbs the OpenAI ladder one rung at a time', () => {
    const at = (tokens: number, window: number) => {
      const g = contextGauge(tokens, window, 'gpt-5.6-sol');
      return g.show ? g.window : undefined;
    };
    // Past 128k → the o-series rung, not straight to the top.
    expect(at(150_000, 128_000)).toBe(200_000);
    // Past 200k → GPT-5's 272k input budget.
    expect(at(250_000, 200_000)).toBe(272_000);
    // Past 272k → GPT-4.1's window.
    expect(at(300_000, 272_000)).toBe(1_047_576);
  });

  it('keeps the disproved window when the family has no larger rung', () => {
    // Beyond every window any provider ships. Nothing better exists to divide by,
    // so the honest rendering is a percentage over 100 — still marked an estimate.
    const g = contextGauge(1_200_000, 1_048_576, 'gemini-2.5-pro');
    expect(g.show).toBe(true);
    if (!g.show) return;
    expect(g.window).toBe(1_048_576);
    expect(g.percent).toBe(114);
    expect(g.approximate).toBe(true);
    expect(g.tier).toBe('critical');
  });

  // -- tiers and the banner -------------------------------------------------

  it('escalates at 70% and again at 85%, boundaries inclusive', () => {
    const at = (ratio: number) =>
      contextGauge(Math.round(200_000 * ratio), 200_000, 'claude-sonnet-4-5');
    const tierOf = (ratio: number) => {
      const g = at(ratio);
      return g.show ? g.tier : 'hidden';
    };
    expect(tierOf(0.699)).toBe('neutral');
    expect(tierOf(GAUGE_WARN_RATIO)).toBe('warn');
    expect(tierOf(0.84)).toBe('warn');
    expect(tierOf(GAUGE_CRITICAL_RATIO)).toBe('critical');
    expect(tierOf(0.99)).toBe('critical');
  });

  it('flags the threshold the banner keys on only at 85% and above', () => {
    const below = contextGauge(169_000, 200_000, 'claude-sonnet-4-5');
    const above = contextGauge(171_000, 200_000, 'claude-sonnet-4-5');
    expect(below.show && below.atThreshold).toBe(false);
    expect(above.show && above.atThreshold).toBe(true);
  });

  it('NEVER raises the banner on an estimated denominator', () => {
    // The load-bearing half of the revision. Showing "~94%" is information; telling
    // someone their conversation is nearly full and should be split is a claim, and
    // a guessed denominator is not enough to make one. The colour still escalates,
    // because that is a hint rather than an interruption.
    const g = contextGauge(120_000, undefined, 'some-unknown-model');
    expect(g.show).toBe(true);
    if (!g.show) return;
    expect(g.approximate).toBe(true);
    expect(g.percent).toBe(94);
    expect(g.tier).toBe('critical');
    expect(g.atThreshold).toBe(false);
  });

  it('never reports a ratio above 100% as anything but critical', () => {
    // A window that shrank under us with nowhere left to climb.
    const g = contextGauge(2_400_000, 1_048_576, 'gemini-2.5-pro');
    expect(g.show && g.tier).toBe('critical');
    expect(g.show && g.percent).toBe(229);
  });

  // -- the pieces ------------------------------------------------------------

  it('classifies model ids into the families the ladders are keyed on', () => {
    expect(modelFamily('claude-opus-5[1m]')).toBe('claude');
    expect(modelFamily('anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('claude');
    expect(modelFamily('opus')).toBe('claude');
    expect(modelFamily('gpt-4o')).toBe('openai');
    expect(modelFamily('gpt-5.6-sol')).toBe('openai');
    expect(modelFamily('o4-mini')).toBe('openai');
    expect(modelFamily('gemini-1.5-flash')).toBe('gemini');
    expect(modelFamily('llama-3.1-70b')).toBe('unknown');
    expect(modelFamily(undefined)).toBe('unknown');
    expect(modelFamily('')).toBe('unknown');
  });

  it('formats token counts compactly', () => {
    expect(formatTokensShort(940)).toBe('940');
    expect(formatTokensShort(8_400)).toBe('8.4k');
    expect(formatTokensShort(132_000)).toBe('132k');
    expect(formatTokensShort(1_048_576)).toBe('1049k');
  });

  it('prefixes only the estimated percentage with a tilde', () => {
    expect(formatGaugePercent({ percent: 66, approximate: false })).toBe('66%');
    expect(formatGaugePercent({ percent: 66, approximate: true })).toBe('~66%');
  });

  it('maps each tier onto the classes the bar already uses', () => {
    expect(gaugeToneClass('neutral')).toBe('text-muted-foreground');
    expect(gaugeToneClass('warn')).toBe('text-yellow-500');
    expect(gaugeToneClass('critical')).toBe('text-red-500');
  });
});
