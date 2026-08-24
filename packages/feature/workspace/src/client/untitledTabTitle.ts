import { defaultSessionName, sessionCreatedAtFromId } from '@cockpit/shared-utils';

/**
 * What a tab is called before anything has named it.
 *
 * THE TAB IS THE ONE PLACE THAT CANNOT ASK THE SERVER. Every other surface
 * holds a `SessionRef` and runs it through `deriveTitle`; a tab holds an id at
 * most, and for a chat that has not sent its first message it does not even
 * hold that. Both cases used to leak the identity into the label — one
 * `New Chat` shared by every new tab at once, or `Session s-mt16...` — so this
 * produces the SAME `MMDD-HHmm-animal` string the server would, out of the same
 * pure function.
 *
 * The two cases differ only in what they can honestly say about time:
 *
 *   - WITH A SESSION ID, the mint time is read back out of the id, so a session
 *     opened from a link or restored on reload is named after when it was MADE,
 *     not after when it was opened. Its animal is hashed from that id, which is
 *     exactly what the recent list and the sidebar hash, so the tab and the
 *     lists agree without either asking the other.
 *   - WITHOUT ONE there is no session yet — the first turn mints it — so the tab
 *     is named after now and seeded by its own tab id. That name lives until the
 *     first message, at which point the derived title replaces it exactly as it
 *     would have replaced the server's.
 *
 * It lives in its own file, like ./titleLock and ./tabKinds, because it is a
 * rule rather than wiring: `now` is a parameter and not a `Date.now()` call
 * inside, so a test can pin the clock and the whole answer with it.
 */
export function untitledTabTitle(
  tabId: string,
  sessionId: string | undefined,
  now: number,
): string {
  if (!sessionId) return defaultSessionName(tabId, now);
  return defaultSessionName(sessionId, sessionCreatedAtFromId(sessionId) ?? now);
}
