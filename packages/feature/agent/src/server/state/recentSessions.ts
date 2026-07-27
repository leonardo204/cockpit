/**
 * recentSessions — the ONE builder behind every "recent sessions" view.
 *
 * There are two such views and they differ in UI ONLY:
 *   - the sidebar dropdown (top N, no search corpus), and
 *   - the maximized search panel (everything, plus `searchText`).
 * Both are built here, from one store: the Naby `app.db`.
 *
 * WHY THIS EXISTS. The two views used to read different stores — the dropdown
 * read `~/.cockpit/state.json`, the panel read the Naby store — and keeping two
 * stores agreeing is a game that only ever gets lost. It lost twice: once when
 * the maximized panel was empty while the dropdown was full, and again when the
 * unread badge would not clear because the read (state.json) and the "mark read"
 * write (store) disagreed. Sharing a *predicate* (./recentFilter) was not
 * enough, because the drift was in the DATA, not in the rules. So there is one
 * store now, and this module is the only door to it.
 *
 * Corollary, and the reason this comment is long: do not add a second source
 * here. If a view needs a field the store does not have, put the field in the
 * store.
 */
import { getStore, storeDbPath } from '../engines/naby';
import type { RuntimeMessage, SessionRef } from '../../../../../../../dist/naby-runtime.mjs';
import {
  deriveTitle,
  engineFromProvider,
  sampleMessages,
  userTexts,
} from '../api/sessions/nabyBrowse';
import { CLEARED_BEFORE_KEY, isRecentVisible, parseClearedBefore } from './recentFilter';

/** Coarse run/read state shown as the dot and the badge. */
export type SessionStatus = 'normal' | 'loading' | 'unread';

/**
 * The wire shape both views render. The dropdown reads a subset of it; the
 * search panel reads all of it. One shape, so a field added for one view is
 * available to the other instead of being fetched from somewhere else.
 */
export interface RecentSession {
  cwd: string;
  sessionId: string;
  lastActive: number;
  status: string;
  title?: string;
  lastUserMessage?: string;
  firstMessages?: string[];
  lastMessages?: string[];
  searchText?: string;
  engine?: string;
}

/** Where a session's coarse status lives. The engine writes it, both views read
 *  it, and the "mark read" path clears it — one key, so the badge can't stick. */
export const statusKey = (sessionId: string) => `session.status.${sessionId}`;

/** A user-supplied rename. Shared with the pinned-sessions route so a rename is
 *  one source of truth rather than per-view. */
export const customTitleKey = (sessionId: string) => `session.customTitle.${sessionId}`;

/** The file backing every recent view — what a change watcher must watch. */
export function recentSessionsSourcePath(): string {
  return storeDbPath();
}

/** The slice of the store this builder reads. Narrow on purpose: it is the whole
 *  contract, so a test can satisfy it without a database. */
export interface RecentSessionsStore {
  listSessions(): SessionRef[];
  getMessages(sessionId: string): RuntimeMessage[];
  getSetting(key: string): string | undefined;
}

/**
 * Build the recent-session list from the store: MRU-ordered, watermark-filtered,
 * each row enriched with a title and message previews read from the SAME store.
 *
 * `limit` is applied BEFORE the per-session message reads, so the dropdown's
 * top-15 costs fifteen message reads rather than one per session on record.
 * `includeSearchText` is opt-in for the same reason — the untruncated corpus is
 * only worth building for the panel that actually searches it.
 */
export function buildRecentSessions(
  opts?: { limit?: number; includeSearchText?: boolean },
  store: RecentSessionsStore = getStore(),
): RecentSession[] {
  const clearedBefore = parseClearedBefore(store.getSetting(CLEARED_BEFORE_KEY));

  // listSessions() is already MRU (last_used_at DESC).
  //
  // Visibility is the shared predicate: hidden by the "clear recents" watermark,
  // and projectless sessions ARE included. A session with no cwd is still a
  // recent session — it is listed and opened by sessionId. Hidden-by-watermark
  // rows keep their session and transcript; a new turn un-hides them.
  const visible = store
    .listSessions()
    .filter((ref) => isRecentVisible({ lastActive: ref.lastUsedAt, cwd: ref.cwd }, clearedBefore));

  const selected = opts?.limit === undefined ? visible : visible.slice(0, opts.limit);

  return selected.map((ref): RecentSession => {
    const texts = userTexts(store.getMessages(ref.sessionId));
    const custom = store.getSetting(customTitleKey(ref.sessionId));
    const title = custom && custom.trim() ? custom : deriveTitle(ref, texts);
    const { firstMessages, lastMessages } = sampleMessages(texts);
    // Deliberately NOT falling back to `ref.status`. That column is the session
    // LIFECYCLE ('active' | 'ended'); this field is the run/read state the views
    // compare against 'loading' | 'unread'. Two vocabularies, one field name —
    // letting the wrong one through paints a dot that means nothing.
    const status = store.getSetting(statusKey(ref.sessionId)) ?? 'normal';

    // A projectless session has no cwd; the wire shape requires a string, so
    // send '' and let the client render a placeholder + open by sessionId.
    const cwd = ref.cwd ?? '';

    return {
      cwd,
      sessionId: ref.sessionId,
      lastActive: ref.lastUsedAt,
      status,
      title,
      lastUserMessage: texts[texts.length - 1],
      firstMessages,
      lastMessages,
      // Untruncated corpus for the search panel: cwd + title + every user
      // message, lowercased. Display fields stay truncated; matching reads this.
      ...(opts?.includeSearchText
        ? { searchText: [cwd, title, ...texts].join('\n').toLowerCase() }
        : {}),
      engine: engineFromProvider(ref.providerId),
    };
  });
}
