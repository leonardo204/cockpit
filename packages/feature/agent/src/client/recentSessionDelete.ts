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
 * The one case that is not a click at all is a PROJECTLESS session. Legacy rows
 * arrive with `cwd === ''` and are deliberately still listed (recentFilter.ts),
 * but `/api/project-state` rejects an empty cwd (`if (!body.cwd)` →
 * ValidationError), so the only removal channel cannot address them. Their ×
 * is rendered disabled and explains itself, rather than failing silently on
 * click.
 */

/** The fields both recent views carry (GlobalSession / RecentSessionInfo). */
export interface RecentDeleteTarget {
  cwd: string
  sessionId: string
}

/** Why a row's × is inert. Shown to the user, never swallowed. */
export type RecentDeleteBlock = 'no-project'

/** The reason this row cannot be deleted, or null when it can. */
export function recentDeleteBlock(session: RecentDeleteTarget): RecentDeleteBlock | null {
  return session.cwd.trim().length === 0 ? 'no-project' : null
}

export function canDeleteRecentSession(session: RecentDeleteTarget): boolean {
  return recentDeleteBlock(session) === null
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
