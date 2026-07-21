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

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const statusKey = (sessionId: string) => `session.status.${sessionId}`
const customTitleKey = (sessionId: string) => `session.customTitle.${sessionId}`
// "Clear recents" watermark (epoch ms). Sessions last used at/before it are
// hidden from the recent list — the session and its transcript are NOT deleted
// (still reachable via Browse all sessions); a later turn bumps `lastUsedAt`
// past the watermark and the session reappears. Shared with the WS snapshot in
// state/globalState.ts so the sidebar dropdown and this panel clear together.
const CLEARED_BEFORE_KEY = 'recent.clearedBefore'

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
  const clearedRaw = store.getSetting(CLEARED_BEFORE_KEY)
  const clearedBefore = clearedRaw ? Number(clearedRaw) || 0 : 0
  // listSessions() is already MRU (last_used_at DESC).
  for (const ref of store.listSessions()) {
    // Recent is a cross-PROJECT view; a projectless session has no cwd for the
    // card to open, so skip it (mirrors the old list, which only held sessions
    // with a real cwd).
    if (!ref.cwd) continue

    // Hidden by a "clear recents" — the row is gone from the list but the
    // session + transcript remain; a new turn (bumping lastUsedAt) un-hides it.
    if (clearedBefore > 0 && ref.lastUsedAt <= clearedBefore) continue

    const messages = store.getMessages(ref.sessionId)
    const texts = userTexts(messages)
    const custom = store.getSetting(customTitleKey(ref.sessionId))
    const title =
      custom && custom.trim() ? custom : deriveTitle(ref, texts)
    const { firstMessages, lastMessages } = sampleMessages(texts)
    const status = store.getSetting(statusKey(ref.sessionId)) ?? ref.status ?? "normal"

    out.push({
      cwd: ref.cwd,
      sessionId: ref.sessionId,
      lastActive: ref.lastUsedAt,
      status,
      title,
      lastUserMessage: texts[texts.length - 1],
      firstMessages,
      lastMessages,
      // Untruncated corpus for the search panel: cwd + title + every user
      // message, lowercased. Display fields stay truncated; matching reads this.
      searchText: [ref.cwd, title, ...texts].join("\n").toLowerCase(),
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
