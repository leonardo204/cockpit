/**
 * composerHeight — how tall the chat textarea is allowed to get, as a pure
 * function of what it wants and how much COLUMN there is.
 *
 * WHY THERE IS A CEILING AT ALL. The composer and the transcript share one flex
 * column, so the composer does not overlay the conversation — it TAKES from it.
 * An uncapped auto-grow would let a pasted wall of text push the transcript down
 * to nothing, and the user would be typing at a conversation they can no longer
 * read.
 *
 * WHY THE CEILING IS RELATIVE AS WELL AS ABSOLUTE. A flat 200px cap is right on
 * a full-height window and absurd on a short one: in a 420px-tall column it is
 * half the app. The cap is therefore the SMALLER of the absolute maximum and a
 * fraction of the column, so the transcript keeps the majority of it at every
 * size. Past the cap the textarea scrolls internally — the text is never lost,
 * it just stops eating the conversation.
 *
 * WHY THE SECOND ARGUMENT IS THE COLUMN AND NOT THE WINDOW. It used to be
 * `window.innerHeight`, and that made the relative ceiling do nothing in the one
 * place a column is genuinely short: the selection popup, a ~320px box that
 * hosts a whole chat. Its composer was sized for the window it was not in and
 * ate the little conversation there was. A composer is only ever bounded by the
 * box that contains it, so the caller passes THAT — see `ComposerViewport`. The
 * main chat fills the window, so there the two are the same number and nothing
 * about it changes.
 *
 * WHY THERE IS A FLOOR, AND WHY IT YIELDS. The placeholder is a multi-line hint;
 * a one-line box clips it, and three lines is what every other LLM composer
 * opens at, so the box does not visibly grow for the first thing anybody types.
 * But a floor is a MINIMUM TAKEN FROM THE TRANSCRIPT, and in a 320px popup a
 * fixed 76px floor is the same greed the ceiling exists to prevent. So the floor
 * holds only while it leaves the transcript at least half the column, and below
 * that it gives way — down to one line, never past it. The popup answers the
 * other half of the same problem by asking for a SHORTER placeholder
 * (`chat.placeholderCompact`), so what yields is the empty box's comfort, not
 * the reader's ability to see the hint.
 *
 * Pure because jsdom has no layout: the component can only measure and obey,
 * and the arithmetic that decides the answer is pinned by cases here.
 */

/** Floor: ~3 lines, so the multi-line placeholder is never clipped. */
export const COMPOSER_MIN_HEIGHT_PX = 76;

/** …and the floor's own floor: one line of text plus the textarea's padding
 *  (76 is 3 × 20px lines + 16px padding, so one line is 36). A composer that
 *  cannot show the line you are typing is not a composer, so nothing — no
 *  fraction, no column however tiny — is allowed to go below this. */
export const COMPOSER_HARD_MIN_HEIGHT_PX = 36;

/** How much of the column the 3-line floor may claim before it yields. At 0.5
 *  the empty composer and the transcript split a short column evenly; below
 *  that the floor is taking more than it is giving. */
export const COMPOSER_FLOOR_MAX_FRACTION = 0.5;

/** Absolute ceiling: ~10 lines, then the textarea scrolls internally. */
export const COMPOSER_MAX_HEIGHT_PX = 200;

/** …and never more than this share of the column, so a short one still shows a
 *  conversation. 0.4 leaves the transcript the clear majority once the header,
 *  engine row and toolbar are counted. */
export const COMPOSER_MAX_VIEWPORT_FRACTION = 0.4;

/**
 * How a composer that does NOT live in the window learns how much room it has.
 *
 * Two methods rather than a number prop, because the one host that needs this —
 * the selection popup — keeps its box in a REF and writes it straight to the
 * DOM: a live streaming transcript must not re-render once per pixel of a resize
 * (React Performance Conventions, shell/CLAUDE.md). A number would have to be
 * state to arrive at all. So the host publishes a reader and a change signal,
 * both with identities stable for the life of the popup, and the composer pulls
 * the value when told — measuring and restyling one textarea, rendering nothing.
 */
export interface ComposerViewport {
  /** The height available to the composer's column, right now, in px. 0 (or any
   *  non-finite value) means "not measurable yet" and is treated as unknown —
   *  see `composerMaxHeight`. */
  getAvailableHeight: () => number;
  /** Called back whenever that height may have changed. Returns its own
   *  unsubscribe, in `addEventListener`'s shape. */
  subscribe: (listener: () => void) => () => void;
}

/** True for the values that mean "we could not measure the column": SSR, a
 *  hidden frame, a jsdom default, an element not laid out yet. */
function isUnknown(availableHeight: number): boolean {
  return !Number.isFinite(availableHeight) || availableHeight <= 0;
}

/**
 * The floor for a given column — normally the 3-line minimum, less when three
 * lines would cost the transcript more than half of what there is.
 *
 * An unknown column keeps the full floor: "unknown" must never be read as
 * "tiny", or a composer would open at one line for the lifetime of a frame that
 * simply had not been measured yet.
 */
export function composerMinHeight(availableHeight: number): number {
  if (isUnknown(availableHeight)) return COMPOSER_MIN_HEIGHT_PX;
  const half = Math.floor(availableHeight * COMPOSER_FLOOR_MAX_FRACTION);
  if (half >= COMPOSER_MIN_HEIGHT_PX) return COMPOSER_MIN_HEIGHT_PX;
  return Math.max(COMPOSER_HARD_MIN_HEIGHT_PX, half);
}

/**
 * The ceiling for a given column height. `availableHeight <= 0` (SSR, a hidden
 * frame, a jsdom default) means "unknown", and an unknown column must not
 * silently shrink the composer — the absolute cap stands.
 */
export function composerMaxHeight(availableHeight: number): number {
  if (isUnknown(availableHeight)) return COMPOSER_MAX_HEIGHT_PX;
  const share = Math.floor(availableHeight * COMPOSER_MAX_VIEWPORT_FRACTION);
  // The floor wins over the fraction: below it the placeholder is clipped, and
  // a composer too small to read what you are writing is not a kindness to the
  // transcript. In a genuinely tiny column the floor has already yielded, so
  // this can no longer hand the composer more than half of it.
  return Math.max(composerMinHeight(availableHeight), Math.min(COMPOSER_MAX_HEIGHT_PX, share));
}

/**
 * The height to set, from the textarea's own `scrollHeight` (measured with the
 * inline height cleared) and the height available to its column — the popup's
 * box when it lives in one, otherwise the window.
 */
export function composerHeight(contentHeight: number, availableHeight: number): number {
  const min = composerMinHeight(availableHeight);
  const max = composerMaxHeight(availableHeight);
  const wanted = Number.isFinite(contentHeight) ? contentHeight : min;
  return Math.max(min, Math.min(wanted, max));
}
