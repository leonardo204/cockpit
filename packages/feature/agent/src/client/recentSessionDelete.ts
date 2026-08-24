/**
 * recentSessionDelete — the rules behind the × on a "Recent sessions" row.
 *
 * THE × CLOSES THE SESSION, which in this app means it is DELETED. That is
 * already the established meaning of the glyph: closing a tab queues the session
 * into `closedSessionIds`, which the project-state route turns into
 * `store.deleteSession(sid)` ("the session and everything keyed to it"), and the
 * sidebar tree's per-row × takes the very same route. This control takes it too
 * — one channel, one meaning, no second "hidden from this list only" state
 * (recentFilter.ts keeps ONE global `recent.clearedBefore` watermark and no
 * per-session flag, and inventing one would make × mean different things in two
 * lists showing the same rows).
 *
 * ONE CLICK, NO CONFIRMATION. Same as a tab close, same as the sidebar row.
 * What carries the weight instead is legibility: the control is styled as a
 * destructive action and its tooltip says the conversation is deleted rather
 * than merely dismissed (`sessions.deleteSessionFromRecent`).
 *
 * EVERY ROW IS DELETABLE, INCLUDING A PROJECTLESS ONE. There was briefly a
 * `recentDeleteBlock` predicate here whose single member was 'no-project':
 * legacy rows arrive with `cwd === ''`, are deliberately still listed
 * (recentFilter.ts), and the removal request had to name a project — so their ×
 * rendered disabled. That was a limit of the REQUEST, never of the deletion:
 * `store.deleteSession(sessionId)` takes an id and nothing else. The channel now
 * carries a projectless shape too (projectSessionTree.deleteSession →
 * state/projectState.ts), so the reason is gone — and with it the predicate,
 * rather than leaving one that always answers null. If a row ever does become
 * undeletable, bring the concept back WITH its member; a permanently-true
 * predicate is ceremony that teaches the next reader nothing.
 */

/** The fields both recent views carry (GlobalSession / RecentSessionInfo). */
export interface RecentDeleteTarget {
  cwd: string
  sessionId: string
}

/**
 * Drop one row from a recent list optimistically after a successful delete —
 * the same shape as `withoutSession` for the sidebar tree, and for the same
 * reason: the server's confirmation (the `project-state-changed` broadcast, and
 * the next global-state snapshot rebuilt from the store) lands behind the
 * click, and the row must not linger until then.
 *
 * Identity is (cwd, sessionId), matching the React key both views use: the list
 * is cross-project, and one sessionId is not enough to name a row.
 */
export function withoutRecentSession<T extends { cwd: string; sessionId: string }>(
  list: readonly T[],
  cwd: string,
  sessionId: string
): T[] {
  return list.filter((s) => !(s.cwd === cwd && s.sessionId === sessionId))
}
