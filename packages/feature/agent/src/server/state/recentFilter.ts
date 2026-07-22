/**
 * recentFilter — the ONE predicate deciding whether a session appears in the
 * "recent" views.
 *
 * There are two recent views and they used to drift:
 *   - the sidebar dropdown  → getGlobalSessionsSnapshot (state/globalState.ts,
 *     backed by ~/.cockpit/state.json), and
 *   - the search panel      → buildRecentSessions (api/global-state.ts, backed
 *     by the Naby store / app.db).
 * They diverged on TWO rules: the "clear recents" watermark and whether a
 * projectless session (no `cwd`) is shown. The search panel used to SKIP
 * projectless sessions (`if (!ref.cwd) continue`), so the 102 legacy sessions
 * with no cwd vanished from the maximized modal while the dropdown still listed
 * them. Both views now import this predicate so the two rules cannot drift again.
 */

/**
 * "Clear recents" watermark (epoch ms). Sessions last used at/before it are
 * hidden from BOTH recent views — the session and its transcript are NOT
 * deleted; a later turn bumps its last-used time past the watermark and it
 * reappears. A single shared key so the dropdown and the panel clear together.
 */
export const CLEARED_BEFORE_KEY = 'recent.clearedBefore';

/** Parse the raw stored watermark setting into an epoch-ms number (0 = unset). */
export function parseClearedBefore(raw: string | undefined | null): number {
  return raw ? Number(raw) || 0 : 0;
}

/**
 * Whether a session is visible in the recent views.
 *
 * The rules, in one place:
 *   - HIDDEN when last used at/before the "clear recents" watermark.
 *   - INCLUDED even without a project link. A projectless session (`cwd`
 *     absent/empty) is still a recent session — it is shown and opened by
 *     `sessionId`. This is the fix for the empty maximized modal: neither view
 *     filters by `cwd` any more.
 *
 * `lastActive` is the view's MRU timestamp (state.json's `lastActive` /
 * the store's `lastUsedAt`).
 */
export function isRecentVisible(
  session: { lastActive: number; cwd?: string },
  clearedBefore: number,
): boolean {
  if (clearedBefore > 0 && session.lastActive <= clearedBefore) return false;
  // NOTE: intentionally no `cwd` filter — projectless sessions are included.
  return true;
}
