import { describe, it, expect } from 'vitest';
import {
  contextGauge,
  formatTokensShort,
  gaugeToneClass,
  GAUGE_CRITICAL_RATIO,
  GAUGE_WARN_RATIO,
} from './contextGauge';

/**
 * The window gauge's derivation (specs/session-context-management.md §2.1).
 *
 * The number itself is measured by the engine; what is asserted here is the part
 * that can be wrong without anyone noticing — WHEN a ratio may be shown at all,
 * and where the two tier boundaries sit. The governing rule is that the gauge
 * would rather say nothing than say something untrue.
 */
describe('contextGauge', () => {
  it('hides entirely when the turn reported no per-step usage', () => {
    // The Agent SDK reports nothing on an aborted turn, and a reloaded session has
    // no reading until its next one. A zero would be a claim; absence is the truth.
    expect(contextGauge(undefined, 200_000)).toEqual({ show: false });
    expect(contextGauge(0, 200_000)).toEqual({ show: false });
    expect(contextGauge(-5, 200_000)).toEqual({ show: false });
    expect(contextGauge(Number.NaN, 200_000)).toEqual({ show: false });
  });

  it('shows tokens WITHOUT a ratio when the model window is unknown', () => {
    const g = contextGauge(132_000, undefined);
    expect(g.show).toBe(true);
    if (!g.show) return;
    expect(g.tokens).toBe(132_000);
    expect(g.percent).toBeUndefined();
    expect(g.window).toBeUndefined();
    // A tier is a statement about fullness, which is exactly what is unknown here.
    expect(g.tier).toBe('neutral');
    expect(g.atThreshold).toBe(false);
  });

  it('computes the percentage against a known window', () => {
    const g = contextGauge(132_000, 200_000);
    expect(g.show).toBe(true);
    if (!g.show) return;
    expect(g.percent).toBe(66);
    expect(g.window).toBe(200_000);
    expect(g.tier).toBe('neutral');
    expect(g.atThreshold).toBe(false);
  });

  it('escalates at 70% and again at 85%, boundaries inclusive', () => {
    const at = (ratio: number) => contextGauge(Math.round(200_000 * ratio), 200_000);
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
    const below = contextGauge(169_000, 200_000);
    const above = contextGauge(171_000, 200_000);
    expect(below.show && below.atThreshold).toBe(false);
    expect(above.show && above.atThreshold).toBe(true);
  });

  it('never reports a ratio above 100% as anything but critical', () => {
    // A window that shrank under us (a model switch mid-session) must not produce a
    // tier the palette has no colour for.
    const g = contextGauge(400_000, 200_000);
    expect(g.show && g.tier).toBe('critical');
    expect(g.show && g.percent).toBe(200);
  });

  it('formats token counts compactly', () => {
    expect(formatTokensShort(940)).toBe('940');
    expect(formatTokensShort(8_400)).toBe('8.4k');
    expect(formatTokensShort(132_000)).toBe('132k');
    expect(formatTokensShort(1_048_576)).toBe('1049k');
  });

  it('maps each tier onto the classes the bar already uses', () => {
    expect(gaugeToneClass('neutral')).toBe('text-muted-foreground');
    expect(gaugeToneClass('warn')).toBe('text-yellow-500');
    expect(gaugeToneClass('critical')).toBe('text-red-500');
  });
});
