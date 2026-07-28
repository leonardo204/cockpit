/**
 * /api/global-state — the cross-project "Recent sessions" search panel
 * (RecentSessionsModal).
 *
 * The list itself comes from `../state/recentSessions` — the ONE store-backed
 * builder both recent views share. This route is only the panel's UI-specific
 * wrapper: it asks for the search corpus (which the dropdown does not need) and
 * owns the status/title WRITES the panel performs.
 *
 * STATUS ROUND-TRIP: the GET reads and the POST writes a session's coarse
 * status via a Naby setting (`session.status.<id>`), so the panel's own
 * update→reload cycle stays inside the store. A custom title likewise
 * round-trips through `session.customTitle.<id>` (shared with the
 * pinned-sessions route, so a rename is one source of truth).
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
  buildRecentSessions,
  countHiddenByWatermark,
  customTitleKey,
  statusKey,
} from "../state/recentSessions"
import { CLEARED_BEFORE_KEY } from "../state/recentFilter"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * How many sessions the panel shows. Matches the retention the legacy recent
 * list enforced on disk; unbounded would mean reading every message of every
 * session on record to render one screen.
 */
const PANEL_LIMIT = 100

/** The panel searches, so it pays for the corpus the dropdown skips. */
const panelSessions = () =>
  buildRecentSessions({ limit: PANEL_LIMIT, includeSearchText: true })

/**
 * The panel payload. `hiddenCount` is what the "clear recents" watermark is
 * holding back — sent so the view can SAY that sessions are hidden rather than
 * letting them look deleted. See countHiddenByWatermark.
 */
const panelPayload = () => ({
  sessions: panelSessions(),
  hiddenCount: countHiddenByWatermark(),
})

export const GET = handler(() =>
  Effect.try({
    try: () => panelPayload(),
    catch: (cause) => new FSError({ path: "app.db:global-state", op: "read", cause }),
  }).pipe(Effect.map((payload) => ok(payload)))
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
        return panelPayload()
      },
      catch: (cause) => new FSError({ path: "app.db:global-state", op: "write", cause }),
    })
    return ok(sessions)
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
export const DELETE = handler((req) =>
  Effect.try({
    try: () => {
      const store = getStore()
      // `?undo=1` REMOVES the watermark instead of setting one, bringing every
      // hidden session back. Clearing used to be one-way — the only route back
      // was to open a session and run a turn, which is not something a user can
      // be expected to discover — so the panel now offers an undo beside the
      // hidden count and calls this.
      if (new URL(req.url).searchParams.get("undo") === "1") {
        store.setSetting(CLEARED_BEFORE_KEY, "")
      } else {
        store.setSetting(CLEARED_BEFORE_KEY, String(Date.now()))
      }
      return panelPayload()
    },
    catch: (cause) => new FSError({ path: "app.db:global-state", op: "write", cause }),
  }).pipe(Effect.map((payload) => ok(payload)))
)
