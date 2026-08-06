/**
 * composerHeight — how tall the chat textarea is allowed to get, as a pure
 * function of what it wants and how much window there is.
 *
 * WHY THERE IS A CEILING AT ALL. The composer and the transcript share one flex
 * column, so the composer does not overlay the conversation — it TAKES from it.
 * An uncapped auto-grow would let a pasted wall of text push the transcript down
 * to nothing, and the user would be typing at a conversation they can no longer
 * read.
 *
 * WHY THE CEILING IS RELATIVE AS WELL AS ABSOLUTE. A flat 200px cap is right on
 * a full-height window and absurd on a short one: in a 420px-tall window it is
 * half the app. The cap is therefore the SMALLER of the absolute maximum and a
 * fraction of the window, so the transcript keeps the majority of the column at
 * every size. Past the cap the textarea scrolls internally — the text is never
 * lost, it just stops eating the conversation.
 *
 * WHY THERE IS A FLOOR. The placeholder is a two-line hint; a one-line box
 * clips it. Three lines is also what every other LLM composer opens at, so the
 * box does not visibly grow for the first thing anybody types.
 *
 * Pure because jsdom has no layout: the component can only measure and obey,
 * and the arithmetic that decides the answer is pinned by cases here.
 */

/** Floor: ~3 lines, so the multi-line placeholder is never clipped. */
export const COMPOSER_MIN_HEIGHT_PX = 76;

/** Absolute ceiling: ~10 lines, then the textarea scrolls internally. */
export const COMPOSER_MAX_HEIGHT_PX = 200;

/** …and never more than this share of the window, so a short window still shows
 *  a conversation. 0.4 leaves the transcript the clear majority once the
 *  header, engine row and toolbar are counted. */
export const COMPOSER_MAX_VIEWPORT_FRACTION = 0.4;

/**
 * The ceiling for a given window height. `viewportHeight <= 0` (SSR, a hidden
 * frame, a jsdom default) means "unknown", and an unknown window must not
 * silently shrink the composer — the absolute cap stands.
 */
export function composerMaxHeight(viewportHeight: number): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return COMPOSER_MAX_HEIGHT_PX;
  const share = Math.floor(viewportHeight * COMPOSER_MAX_VIEWPORT_FRACTION);
  // The floor wins over the fraction: below it the placeholder is clipped, and
  // a composer too small to read what you are writing is not a kindness to the
  // transcript.
  return Math.max(COMPOSER_MIN_HEIGHT_PX, Math.min(COMPOSER_MAX_HEIGHT_PX, share));
}

/**
 * The height to set, from the textarea's own `scrollHeight` (measured with the
 * inline height cleared) and the current window height.
 */
export function composerHeight(contentHeight: number, viewportHeight: number): number {
  const max = composerMaxHeight(viewportHeight);
  const wanted = Number.isFinite(contentHeight) ? contentHeight : COMPOSER_MIN_HEIGHT_PX;
  return Math.max(COMPOSER_MIN_HEIGHT_PX, Math.min(wanted, max));
}
