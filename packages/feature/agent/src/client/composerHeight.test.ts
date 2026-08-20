import { describe, it, expect } from 'vitest';
import {
  COMPOSER_FLOOR_MAX_FRACTION,
  COMPOSER_HARD_MIN_HEIGHT_PX,
  COMPOSER_MAX_HEIGHT_PX,
  COMPOSER_MAX_VIEWPORT_FRACTION,
  COMPOSER_MIN_HEIGHT_PX,
  composerHeight,
  composerMaxHeight,
  composerMinHeight,
} from './composerHeight';

/**
 * HOW MUCH OF THE COLUMN THE COMPOSER MAY TAKE.
 *
 * The composer does not float over the transcript — they share one flex column,
 * so its height is subtracted from the conversation. These cases pin the two
 * limits that keeps honest: it never grows past ~10 lines, and never past a
 * fraction of the COLUMN however tall those lines are.
 *
 * The second argument is the column, not the window. It used to be
 * `window.innerHeight`, which made the relative ceiling meaningless in the one
 * place a column is genuinely short — the selection popup, a ~320px box hosting
 * a whole chat inside a large window. The numbers a full-height tab produces are
 * unchanged (there the two ARE the same number); what changed is that a small
 * host now gets a small answer.
 */

/** A comfortable desktop window — and, for a chat in a tab, its column too. */
const TALL = 1000;

/** The selection popup's conversation column at the default box: a ~320px popup
 *  less its header, quote block and hint row. */
const POPUP_COLUMN = 170;

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

  it('never squeezes below the floor while the floor still fits', () => {
    // Down to twice the floor the 3-line minimum is honoured outright: below it
    // the placeholder is clipped, and a composer you cannot read what you are
    // typing in is not a favour to the transcript.
    // 40% of 160 is 64, under the floor — so here the floor is what binds, and
    // it binds at its full three lines.
    expect(composerMaxHeight(160)).toBe(COMPOSER_MIN_HEIGHT_PX);
    expect(composerMaxHeight(2 * COMPOSER_MIN_HEIGHT_PX)).toBe(COMPOSER_MIN_HEIGHT_PX);
  });

  it('…and yields with it once the column cannot afford three lines', () => {
    // A floor is a minimum TAKEN FROM THE TRANSCRIPT. In a column too short to
    // split evenly, holding 76px would be the same greed the ceiling exists to
    // prevent, so the ceiling follows the floor down instead of overruling it.
    expect(composerMaxHeight(120)).toBe(composerMinHeight(120));
    expect(composerMaxHeight(120)).toBeLessThan(COMPOSER_MIN_HEIGHT_PX);
    expect(composerMaxHeight(1)).toBe(COMPOSER_HARD_MIN_HEIGHT_PX);
  });

  it('an unknown column (SSR, a hidden frame, a popup not yet laid out) keeps the absolute cap', () => {
    // 0 must not read as "a 0px column", which would pin the composer to its
    // floor for the lifetime of the frame. The popup measures `clientHeight`,
    // which is 0 until the first placement, so this is a live path and not only
    // an SSR one.
    expect(composerMaxHeight(0)).toBe(COMPOSER_MAX_HEIGHT_PX);
    expect(composerMaxHeight(-1)).toBe(COMPOSER_MAX_HEIGHT_PX);
    expect(composerMaxHeight(Number.NaN)).toBe(COMPOSER_MAX_HEIGHT_PX);
  });
});

describe('composerMinHeight — the floor, and when it gives way', () => {
  // WHY THE FLOOR IS NOT SIMPLY 76. It exists so the multi-line placeholder is
  // not clipped, which makes it a bill the transcript pays for a hint. In a tab
  // that bill is nothing; in a 320px popup it is the whole complaint. The rule:
  // three lines as long as the transcript keeps at least half the column, then
  // down with the column, and never below one readable line. The popup pays the
  // other half by asking a SHORTER placeholder (chat.placeholderCompact), so
  // what yields is the empty box's comfort rather than the hint's legibility.

  it('a full-height window is untouched — this is the main chat', () => {
    expect(composerMinHeight(TALL)).toBe(COMPOSER_MIN_HEIGHT_PX);
    expect(composerMinHeight(420)).toBe(COMPOSER_MIN_HEIGHT_PX);
  });

  it('holds exactly to its boundary: the floor may take half the column, not more', () => {
    const boundary = COMPOSER_MIN_HEIGHT_PX / COMPOSER_FLOOR_MAX_FRACTION; // 152
    expect(composerMinHeight(boundary + 1)).toBe(COMPOSER_MIN_HEIGHT_PX);
    expect(composerMinHeight(boundary)).toBe(COMPOSER_MIN_HEIGHT_PX);
    // One pixel under, and three lines would cost the transcript more than half.
    expect(composerMinHeight(boundary - 1)).toBe(
      Math.floor((boundary - 1) * COMPOSER_FLOOR_MAX_FRACTION),
    );
    expect(composerMinHeight(boundary - 1)).toBeLessThan(COMPOSER_MIN_HEIGHT_PX);
  });

  it('below the boundary it takes half, so the transcript always keeps half', () => {
    for (const available of [80, 100, 120, 140, 151]) {
      expect(composerMinHeight(available)).toBeLessThanOrEqual(
        Math.max(COMPOSER_HARD_MIN_HEIGHT_PX, available * COMPOSER_FLOOR_MAX_FRACTION),
      );
    }
  });

  it('but never below one readable line, however absurd the column', () => {
    // Past this the box shows nothing of what you are typing, and half of
    // nothing is not a kindness to the transcript either.
    expect(composerMinHeight(40)).toBe(COMPOSER_HARD_MIN_HEIGHT_PX);
    expect(composerMinHeight(2)).toBe(COMPOSER_HARD_MIN_HEIGHT_PX);
  });

  it('an unknown column keeps the FULL floor — unknown is not tiny', () => {
    // The popup's column measures 0 until it is placed. Reading that as "tiny"
    // would open every popup composer at one line and leave it there.
    expect(composerMinHeight(0)).toBe(COMPOSER_MIN_HEIGHT_PX);
    expect(composerMinHeight(-10)).toBe(COMPOSER_MIN_HEIGHT_PX);
    expect(composerMinHeight(Number.NaN)).toBe(COMPOSER_MIN_HEIGHT_PX);
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

describe('the main chat is the baseline — these numbers must not move', () => {
  // The second argument changed meaning (window → column) and the floor learned
  // to yield. Neither is allowed to be visible in a full-height tab, where the
  // window IS the column and nothing is short. This block is the regression
  // fence: every case here is what the composer did before any of it.
  const MAIN_CHAT_COLUMNS = [1440, 1080, 900, TALL, 768, 640, 500, 420, 300];

  it('the ceiling at every real window size is what it always was', () => {
    for (const column of MAIN_CHAT_COLUMNS) {
      const before = Math.max(
        COMPOSER_MIN_HEIGHT_PX,
        Math.min(COMPOSER_MAX_HEIGHT_PX, Math.floor(column * COMPOSER_MAX_VIEWPORT_FRACTION)),
      );
      expect(composerMaxHeight(column), `ceiling moved at ${column}px`).toBe(before);
    }
  });

  it('and so is the height for everything from an empty box to a pasted wall', () => {
    for (const column of MAIN_CHAT_COLUMNS) {
      for (const content of [0, 24, 76, 120, 199, 200, 5000]) {
        const before = Math.max(
          COMPOSER_MIN_HEIGHT_PX,
          Math.min(
            content,
            Math.max(
              COMPOSER_MIN_HEIGHT_PX,
              Math.min(COMPOSER_MAX_HEIGHT_PX, Math.floor(column * COMPOSER_MAX_VIEWPORT_FRACTION)),
            ),
          ),
        );
        expect(composerHeight(content, column), `height moved at ${column}/${content}`).toBe(before);
      }
    }
  });
});

describe('THE BUG: a composer inside the selection popup', () => {
  // The popup is a ~320px box hosting a whole chat inside a large window. The
  // composer used to be handed `window.innerHeight`, so the relative ceiling was
  // computed against a window it was not in: the one rule that protects a short
  // column did nothing in the only place a column is genuinely short, and the
  // input ate the conversation. It is handed its OWN column now.

  it('the same wall of text takes far less of a popup than of the window', () => {
    const inPopup = composerHeight(5000, POPUP_COLUMN);
    const inWindow = composerHeight(5000, TALL);
    expect(inWindow).toBe(COMPOSER_MAX_HEIGHT_PX);
    expect(inPopup).toBe(composerMaxHeight(POPUP_COLUMN));
    expect(inPopup).toBeLessThan(inWindow);
    // …and it leaves the transcript more of the popup than it takes. Under the
    // old rule this was 200px of a 170px column: the conversation was gone.
    expect(POPUP_COLUMN - inPopup).toBeGreaterThan(inPopup);
  });

  it('the ceiling shrinks WITH the popup, which is what a resize has to move', () => {
    // Dragging the bottom edge up must lower the cap monotonically — a ceiling
    // that only fell in steps would leave a resized popup with a composer sized
    // for the box before it.
    const columns = [400, 320, 260, 200, 160, 120, 90];
    for (let i = 1; i < columns.length; i += 1) {
      expect(composerMaxHeight(columns[i]!)).toBeLessThanOrEqual(composerMaxHeight(columns[i - 1]!));
    }
    expect(composerMaxHeight(90)).toBeLessThan(composerMaxHeight(400));
  });

  it('even an EMPTY composer gives ground once the popup is genuinely tiny', () => {
    // The floor is what an empty box takes, and in a 100px column three lines
    // would be most of the conversation.
    expect(composerHeight(0, 100)).toBeLessThan(COMPOSER_MIN_HEIGHT_PX);
    expect(composerHeight(0, 100)).toBe(composerMinHeight(100));
    // Still readable, though: one line is the hard stop.
    expect(composerHeight(0, 100)).toBeGreaterThanOrEqual(COMPOSER_HARD_MIN_HEIGHT_PX);
  });

  it('the transcript keeps at least half of any column, at every size', () => {
    // The property the whole file exists for, stated once over the range a
    // popup can actually be dragged to.
    for (let column = 60; column <= 600; column += 7) {
      const taken = composerHeight(5000, column);
      expect(taken, `composer took more than half of a ${column}px column`).toBeLessThanOrEqual(
        Math.max(COMPOSER_HARD_MIN_HEIGHT_PX, column * COMPOSER_FLOOR_MAX_FRACTION),
      );
    }
  });

  it('a popup that has not been laid out yet is UNKNOWN, not tiny', () => {
    // `clientHeight` is 0 until the first placement, and in jsdom it is 0
    // forever. Reading that as a 0px column would pin every popup composer to
    // one line; the contract is the absolute cap, exactly as a tab gets.
    expect(composerHeight(5000, 0)).toBe(COMPOSER_MAX_HEIGHT_PX);
    expect(composerHeight(5000, Number.NaN)).toBe(COMPOSER_MAX_HEIGHT_PX);
    expect(composerHeight(0, 0)).toBe(COMPOSER_MIN_HEIGHT_PX);
  });
});
