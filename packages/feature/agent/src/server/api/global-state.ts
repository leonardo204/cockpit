/**
 * /api/global-state — the cross-project "Recent sessions" search panel
 * (RecentSessionsModal).
 *
 * RE-BACKED ONTO THE NABY STORE (Phase C-2). The recent list is now
 * `listSessions()` from `app.db` (MRU, already sorted), filtered to sessions
 * that belong to a project (have a `cwd`). Titles and previews are built from
 * the store's messages table — NOT `~/.cockpit/state.json` and NOT any provider
 * `.jsonl`. So the panel shows only Naby's own sessions.
 *
 * STATUS ROUND-TRIP: the GET reads and the POST writes a session's coarse
 * status via a Naby setting (`session.status.<id>`), keeping the panel's own
 * update→reload cycle working WITHOUT resurrecting `state.json`. A custom title
 * likewise round-trips through `session.customTitle.<id>` (shared with the
 * pinned-sessions route, so a rename is one source of truth).
 *
 * KNOWN SCOPED LIMITATION: the live run/notification status the engine writes
 * still goes to `state.json` via the separate `updateGlobalState` path (WS
 * sidebar dropdown / scheduled tasks), which this route deliberately no longer
 * reads. So the search panel's status dot reflects only statuses set through
 * this route; wiring engine status into the store is a later phase.
 *
 * The WIRE CONTRACT is unchanged — GET returns
 * `{ sessions: RecentSessionInfo[] }` with
 * `{ cwd, sessionId, lastActive, status, title?, lastUserMessage?,
 *    firstMessages?, lastMessages?, searchText?, engine? }`.
 */
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"
import { getStore } from "../engines/naby"
import {
  deriveTitle,
  engineFromProvider,
  sampleMessages,
  userTexts,
} from "./sessions/nabyBrowse"
import {
  CLEARED_BEFORE_KEY,
  isRecentVisible,
  parseClearedBefore,
} from "../state/recentFilter"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const statusKey = (sessionId: string) => `session.status.${sessionId}`
const customTitleKey = (sessionId: string) => `session.customTitle.${sessionId}`

interface RecentSession {
  cwd: string
  sessionId: string
  lastActive: number
  status: string
  title?: string
  lastUserMessage?: string
  firstMessages?: string[]
  lastMessages?: string[]
  searchText?: string
  engine?: string
}

/**
 * Build the recent-session list from the store: every session linked to a
 * project, MRU-ordered, each enriched with a title + first/last preview + full
 * search corpus read from its messages.
 */
function buildRecentSessions(): RecentSession[] {
  const store = getStore()
  const out: RecentSession[] = []
  const clearedBefore = parseClearedBefore(store.getSetting(CLEARED_BEFORE_KEY))
  // listSessions() is already MRU (last_used_at DESC).
  for (const ref of store.listSessions()) {
    // Visibility (watermark + projectless inclusion) is the SAME shared
    // predicate the sidebar dropdown uses, so the two recent views can't drift.
    // Notably this NO LONGER skips projectless sessions: a session with no cwd
    // is still a recent session — it is listed and opened by sessionId. Skipping
    // them was the bug that left the maximized modal empty while the dropdown
    // (which never filtered by cwd) still showed them. Hidden-by-"clear recents"
    // rows keep their session + transcript; a new turn un-hides them.
    if (!isRecentVisible({ lastActive: ref.lastUsedAt, cwd: ref.cwd }, clearedBefore)) continue

    const messages = store.getMessages(ref.sessionId)
    const texts = userTexts(messages)
    const custom = store.getSetting(customTitleKey(ref.sessionId))
    const title =
      custom && custom.trim() ? custom : deriveTitle(ref, texts)
    const { firstMessages, lastMessages } = sampleMessages(texts)
    const status = store.getSetting(statusKey(ref.sessionId)) ?? ref.status ?? "normal"

    // A projectless session has no cwd; the wire shape requires a string, so
    // send '' and let the client render a placeholder + open by sessionId.
    const cwd = ref.cwd ?? ''
    out.push({
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
      searchText: [cwd, title, ...texts].join("\n").toLowerCase(),
      engine: engineFromProvider(ref.providerId),
    })
  }
  return out
}

export const GET = handler(() =>
  Effect.try({
    try: () => buildRecentSessions(),
    catch: (cause) => new FSError({ path: "app.db:global-state", op: "read", cause }),
  }).pipe(Effect.map((sessions) => ok({ sessions })))
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as {
      cwd?: string
      sessionId?: string
      status?: string
      title?: string
    }
    if (!body.cwd || !body.sessionId) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.cwd ? "cwd" : "sessionId",
          reason: "missing",
        })
      )
    }
    const { sessionId, status, title } = body
    const sessions = yield* Effect.try({
      try: () => {
        const store = getStore()
        // Persist the status (and title override, when supplied) as Naby
        // settings so the panel's own reload sees them — no state.json write.
        store.setSetting(statusKey(sessionId), status || "normal")
        if (title !== undefined) {
          store.setSetting(customTitleKey(sessionId), title)
        }
        return buildRecentSessions()
      },
      catch: (cause) => new FSError({ path: "app.db:global-state", op: "write", cause }),
    })
    return ok({ sessions })
  })
)

/**
 * DELETE — clear the recent-sessions list.
 *
 * Sets the `recent.clearedBefore` watermark to now, which hides every currently
 * recent session from BOTH the search panel (this route's GET) and the sidebar
 * dropdown (the WS snapshot reads the same key). This does NOT delete any
 * session, transcript, or project — cleared sessions stay reachable via Browse
 * all sessions, and any session that runs again bumps its `lastUsedAt` past the
 * watermark and returns to the list. Returns the (now-empty) filtered list.
 */
export const DELETE = handler(() =>
  Effect.try({
    try: () => {
      const store = getStore()
      store.setSetting(CLEARED_BEFORE_KEY, String(Date.now()))
      return buildRecentSessions()
    },
    catch: (cause) => new FSError({ path: "app.db:global-state", op: "write", cause }),
  }).pipe(Effect.map((sessions) => ok({ sessions })))
)
