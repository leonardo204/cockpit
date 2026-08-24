/**
 * /api/pinned-sessions — the user's pinned sessions (usePinnedSessions).
 *
 * RE-BACKED ONTO THE NABY STORE (Phase C-2). Pinned state now lives in `app.db`:
 * GET is `listPinnedSessions()`, and POST reconciles the store's pinned flags to
 * the set the client sends (`setSessionPinned(id, true/false)`). It no longer
 * reads or writes `~/.cockpit/pinned-sessions.json`. A pinned session's custom
 * title round-trips through a Naby setting (`session.customTitle.<id>`, shared
 * with /api/global-state so a rename has one source of truth).
 *
 * The WIRE CONTRACT is unchanged — GET returns `{ sessions: PinnedSession[] }`
 * and POST accepts `{ sessions: PinnedSession[] }` (the full desired set), with
 * `PinnedSession { sessionId, cwd, customTitle? }`.
 *
 * ORDER IS PART OF THAT CONTRACT (schema v7). GET lists in pin order — earliest
 * pin first, which is how the tab bar stacks pinned tabs left-to-right — and
 * POST persists whatever order it is handed. Before v7 the store sorted pinned
 * sessions by last-used, so pinned tabs rearranged themselves as soon as the
 * user typed in one.
 */
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"
import { getStore } from "@cockpit/feature-agent/server/engines/naby"
import {
  deriveTitle,
  userTexts,
} from "@cockpit/feature-agent/server/api/sessions/nabyBrowse"

export interface PinnedSession {
  sessionId: string
  cwd: string
  /**
   * The USER'S OWN name for the session, and only that.
   *
   * It used to fall back to the derived title, which made the two
   * indistinguishable on the wire — so a client could not tell "the user named
   * this" from "this is what the conversation is about". The chat tab needs
   * exactly that distinction: a real rename must override and freeze the tab
   * label, while a derived title must not.
   */
  customTitle?: string
  /**
   * The DERIVED title, for rendering when there is no rename.
   *
   * It used to be the session row's stored `title` column, which is not the
   * same thing: that column is empty for almost every session, so the panel
   * fell through to `sessionId.slice(0, 8)` and a pinned session was labelled
   * with a piece of its id while every other list showed it by its first
   * message. It is now the one `deriveTitle` every other surface uses — the
   * stored title, else the first message, else the default `MMDD-HHmm-animal`
   * name of an empty session.
   */
  title?: string
}

const customTitleKey = (sessionId: string) => `session.customTitle.${sessionId}`

function readPinned(): PinnedSession[] {
  const store = getStore()
  return store.listPinnedSessions().map((ref): PinnedSession => {
    const custom = store.getSetting(customTitleKey(ref.sessionId))
    // The pinned list is short by construction (it is what one person chose to
    // keep), so reading each transcript here costs a handful of queries and
    // buys the same title the recent list and the browsers show.
    const title = deriveTitle(ref, userTexts(store.getMessages(ref.sessionId)))
    return {
      sessionId: ref.sessionId,
      cwd: ref.cwd ?? "",
      ...(custom && custom.trim() ? { customTitle: custom } : {}),
      ...(title ? { title } : {}),
    }
  })
}

export const GET = handler(() =>
  Effect.try({
    try: () => readPinned(),
    catch: (cause) =>
      new FSError({ path: "app.db:pinned-sessions", op: "read", cause }),
  }).pipe(Effect.map((sessions) => ok({ sessions })))
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as { sessions?: PinnedSession[] }
    if (!Array.isArray(body.sessions)) {
      return yield* Effect.fail(
        new ValidationError({ field: "sessions", reason: "must be array" })
      )
    }
    const desired = body.sessions
    yield* Effect.try({
      try: () => {
        const store = getStore()
        const desiredIds = new Set(desired.map((s) => s.sessionId))

        // Unpin anything currently pinned that the client no longer lists.
        for (const ref of store.listPinnedSessions()) {
          if (!desiredIds.has(ref.sessionId)) {
            store.setSessionPinned(ref.sessionId, false)
          }
        }

        // THE ARRAY ORDER IS THE TRUTH. The client always sends its full,
        // ordered pinned set, and that order is what the tab bar and the sidebar
        // list render — including after a manual drag. So each session is
        // stamped by its INDEX rather than by the clock: a plain pin appends
        // (the client appends), and a reorder is persisted by the same write
        // with no second endpoint.
        //
        // The stamps are spaced from a single base so they stay monotonic and
        // comparable; their absolute value carries no meaning beyond ordering.
        const base = Date.now()
        desired.forEach((s, index) => {
          if (!s.sessionId) return
          store.setSessionPinned(s.sessionId, false)
          store.setSessionPinned(s.sessionId, true, base + index)
          if (s.customTitle !== undefined) {
            store.setSetting(customTitleKey(s.sessionId), s.customTitle)
          }
        })
      },
      catch: (cause) =>
        new FSError({ path: "app.db:pinned-sessions", op: "write", cause }),
    })
    return ok({ success: true })
  })
)
