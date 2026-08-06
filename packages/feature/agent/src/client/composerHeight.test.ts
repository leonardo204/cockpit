import { describe, it, expect } from 'vitest';
import {
  COMPOSER_MAX_HEIGHT_PX,
  COMPOSER_MAX_VIEWPORT_FRACTION,
  COMPOSER_MIN_HEIGHT_PX,
  composerHeight,
  composerMaxHeight,
} from './composerHeight';

/**
 * HOW MUCH OF THE COLUMN THE COMPOSER MAY TAKE.
 *
 * The composer does not float over the transcript — they share one flex column,
 * so its height is subtracted from the conversation. These cases pin the two
 * limits that keeps honest: it never grows past ~10 lines, and never past a
 * fraction of the window however tall those lines are.
 */

/** A comfortable desktop window. */
const TALL = 1000;

describe('composerMaxHeight', () => {
  it('a normal window gets the full ~10-line ceiling', () => {
    // 40% of 1000 is 400, well past the absolute cap, so the cap is what binds.
    expect(composerMaxHeight(TALL)).toBe(COMPOSER_MAX_HEIGHT_PX);
  });

  it('a short window gets a fraction of itself instead', () => {
    // 40% of 420 is 168 — the transcript keeps the rest. A flat 200px cap here
    // would hand half the app to an input box.
    expect(composerMaxHeight(420)).toBe(Math.floor(420 * COMPOSER_MAX_VIEWPORT_FRACTION));
    expect(composerMaxHeight(420)).toBeLessThan(COMPOSER_MAX_HEIGHT_PX);
  });

  it('the ceiling is the SMALLER of the two rules at every size', () => {
    for (const vh of [300, 420, 500, 640, 800, 1200, 2160]) {
      expect(composerMaxHeight(vh)).toBeLessThanOrEqual(COMPOSER_MAX_HEIGHT_PX);
      expect(composerMaxHeight(vh)).toBeLessThanOrEqual(
        Math.max(COMPOSER_MIN_HEIGHT_PX, Math.floor(vh * COMPOSER_MAX_VIEWPORT_FRACTION)),
      );
    }
  });

  it('never squeezes below the floor, however tiny the window', () => {
    // Below the floor the two-line placeholder is clipped, and a composer you
    // cannot read what you are typing in is not a favour to the transcript.
    expect(composerMaxHeight(120)).toBe(COMPOSER_MIN_HEIGHT_PX);
    expect(composerMaxHeight(1)).toBe(COMPOSER_MIN_HEIGHT_PX);
  });

  it('an unknown window (SSR, a hidden frame) keeps the absolute cap', () => {
    // 0 must not read as "a 0px window", which would pin the composer to its
    // floor for the lifetime of the frame.
    expect(composerMaxHeight(0)).toBe(COMPOSER_MAX_HEIGHT_PX);
    expect(composerMaxHeight(-1)).toBe(COMPOSER_MAX_HEIGHT_PX);
    expect(composerMaxHeight(Number.NaN)).toBe(COMPOSER_MAX_HEIGHT_PX);
  });
});

describe('composerHeight', () => {
  it('an empty or one-line input opens at the floor', () => {
    expect(composerHeight(0, TALL)).toBe(COMPOSER_MIN_HEIGHT_PX);
    expect(composerHeight(24, TALL)).toBe(COMPOSER_MIN_HEIGHT_PX);
  });

  it('grows with the text between floor and ceiling', () => {
    expect(composerHeight(120, TALL)).toBe(120);
    expect(composerHeight(199, TALL)).toBe(199);
  });

  it('THE POINT: a pasted wall of text stops at the ceiling and scrolls', () => {
    // Uncapped, this would push the conversation out of the column entirely and
    // the user would be typing at something they can no longer read.
    expect(composerHeight(5000, TALL)).toBe(COMPOSER_MAX_HEIGHT_PX);
  });

  it('the same wall of text takes less of a short window', () => {
    expect(composerHeight(5000, 420)).toBe(composerMaxHeight(420));
    expect(composerHeight(5000, 420)).toBeLessThan(composerHeight(5000, TALL));
  });

  it('the result is always inside its own bounds', () => {
    for (const vh of [0, 300, 420, 768, 1080]) {
      for (const content of [0, 40, 76, 100, 200, 900]) {
        const h = composerHeight(content, vh);
        expect(h).toBeGreaterThanOrEqual(COMPOSER_MIN_HEIGHT_PX);
        expect(h).toBeLessThanOrEqual(composerMaxHeight(vh));
      }
    }
  });

  it('an unmeasurable content height falls back to the floor, not to NaN', () => {
    expect(composerHeight(Number.NaN, TALL)).toBe(COMPOSER_MIN_HEIGHT_PX);
  });
});
