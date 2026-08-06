/**
 * contextBannerReveal — when the "this conversation has grown long" banner is on
 * screen (specs/session-context-management.md §2.1).
 *
 * WHAT THE BANNER IS. At 85% of the window, one line above the input offering the
 * one intervention naby has: continue in a new tab. It is an offer, not a block.
 *
 * THE RULES, and why each one exists:
 *
 *   * IT FOLLOWS THE MEASUREMENT. Shown while the gauge is at the threshold and
 *     hidden when it is not — a session that dropped back under (compaction, a new
 *     tab, a turn that reported less) is not nearly full any more.
 *   * DISMISSING IT LASTS FOR THAT SESSION. The spec asks for exactly that, so the
 *     state is a SESSION ID and not a boolean: a dismissal must not follow the user
 *     into the next conversation, and switching tabs must not silently carry it
 *     across. In memory only — nothing here claims to outlive the app.
 *   * TAKING THE OFFER DISMISSES IT TOO. After the new tab opens, repeating the
 *     offer in the old conversation invites a second empty tab.
 *
 * Pure, like `checkinReveal`, so the lifecycle is pinned by cases rather than by
 * reading a component: the component keeps one `useState` and a reducer call.
 */

/** Which session (if any) the user has dismissed the banner for. */
export interface ContextBannerState {
  dismissedFor: string | null;
}

export const initialContextBannerState: ContextBannerState = { dismissedFor: null };

export type ContextBannerEvent =
  /** The ✕. */
  | { kind: 'dismiss'; sessionId: string }
  /** The offer was taken — a new tab was opened from this session. */
  | { kind: 'continued'; sessionId: string };

export function reduceContextBanner(
  prev: ContextBannerState,
  ev: ContextBannerEvent,
): ContextBannerState {
  switch (ev.kind) {
    case 'dismiss':
    case 'continued':
      // Both mean the same thing to this banner: this session has had its answer.
      return { dismissedFor: ev.sessionId };
  }
}

/**
 * Should the banner render?
 *
 * `sessionId` is required: a tab with no session yet has no conversation to be
 * long, and nothing to continue.
 */
export function contextBannerVisible(
  state: ContextBannerState,
  input: { atThreshold: boolean; sessionId: string | undefined },
): boolean {
  if (!input.atThreshold) return false;
  if (!input.sessionId) return false;
  return state.dismissedFor !== input.sessionId;
}
