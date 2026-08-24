/**
 * Where the recent-sessions hover preview goes — and, just as much, where it
 * must NOT go.
 *
 * THE BUG THIS ENCODES. The preview is a `fixed` panel anchored to the right of
 * the hovered row. It used to be measured from the row's OPEN TARGET (the inner
 * <button>), whose right edge sits *inside* the row — the delete × is its
 * sibling, ~24px further right. `openTarget.right + 8` therefore started the
 * panel roughly 16px LEFT of the row's right edge, i.e. on top of the ×. And the
 * × is hover-revealed, so the only way to see it was to hover the row, which is
 * the very thing that raised the panel over it. Reported as "the × is hidden by
 * the popup". The panel keeps `pointer-events-none`, so the button was still
 * clickable the whole time — blind, which is not an affordance.
 *
 * THE RULE: measure from the WHOLE ROW, and leave a gap. The anchor rect handed
 * in must be the row (the element that CONTAINS the ×), not the open target, so
 * `rect.right + GAP` clears the button by construction rather than by a magic
 * inset that a future padding change would eat. GlobalSessionMonitor's hover
 * handlers live on the row for exactly this reason — and, usefully, that also
 * means moving the pointer from the row's text onto the × never crosses a
 * mouseleave boundary, so neither the panel nor the button flickers on the way.
 *
 * Pure and separate because jsdom has no layout: this is the only form in which
 * the geometry can be asserted at all.
 */

/** `w-72` — the panel's fixed width. */
export const RECENT_TOOLTIP_WIDTH = 288
/** `max-h-[260px]` — its tallest possible height, used to keep it on screen. */
export const RECENT_TOOLTIP_MAX_HEIGHT = 260
/** The breathing room between the row and the panel. Also what clears the ×. */
export const RECENT_TOOLTIP_GAP = 8
/** Never flush against the viewport edge. */
export const RECENT_TOOLTIP_MARGIN = 8

/** The measured row — `getBoundingClientRect()` of the element the pointer is
 *  on, which must be the row itself. */
export interface RecentTooltipAnchor {
  top: number
  left: number
  right: number
}

export interface RecentTooltipViewport {
  width: number
  height: number
}

export interface RecentTooltipPosition {
  top: number
  left: number
}

/**
 * Place the preview beside the row: to its RIGHT by default, flipped to its LEFT
 * when there is no room, and never off the top or bottom of the viewport.
 *
 * The flip is the one case where the panel is not right of the row, and it is
 * safe for the ×: the button lives at the row's right end, so a panel entirely
 * to the LEFT of `rect.left` cannot cover it either.
 */
export function recentTooltipPosition(
  rect: RecentTooltipAnchor,
  viewport: RecentTooltipViewport
): RecentTooltipPosition {
  let left = rect.right + RECENT_TOOLTIP_GAP
  if (left + RECENT_TOOLTIP_WIDTH > viewport.width) {
    const flipped = rect.left - RECENT_TOOLTIP_WIDTH - RECENT_TOOLTIP_GAP
    // Last resort: the LEFT margin, not the right one. A window too narrow for
    // either side still must not slide the panel back over the row's right end,
    // which is where the × is; pinning left keeps it as far from the button as
    // the viewport allows.
    left = flipped >= RECENT_TOOLTIP_MARGIN ? flipped : RECENT_TOOLTIP_MARGIN
  }

  let top = rect.top
  if (top + RECENT_TOOLTIP_MAX_HEIGHT > viewport.height) {
    top = Math.max(
      RECENT_TOOLTIP_MARGIN,
      viewport.height - RECENT_TOOLTIP_MAX_HEIGHT - RECENT_TOOLTIP_MARGIN
    )
  }

  return { top, left }
}
