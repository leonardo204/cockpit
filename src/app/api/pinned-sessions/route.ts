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
 */
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"
import { getStore } from "@cockpit/feature-agent/server/engines/naby"

export interface PinnedSession {
  sessionId: string
  cwd: string
  customTitle?: string
}

const customTitleKey = (sessionId: string) => `session.customTitle.${sessionId}`

function readPinned(): PinnedSession[] {
  const store = getStore()
  return store.listPinnedSessions().map((ref): PinnedSession => {
    const custom = store.getSetting(customTitleKey(ref.sessionId))
    return {
      sessionId: ref.sessionId,
      cwd: ref.cwd ?? "",
      customTitle: custom && custom.trim() ? custom : ref.title,
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

        // Pin each listed session and persist its custom title (when given).
        for (const s of desired) {
          if (!s.sessionId) continue
          store.setSessionPinned(s.sessionId, true)
          if (s.customTitle !== undefined) {
            store.setSetting(customTitleKey(s.sessionId), s.customTitle)
          }
        }
      },
      catch: (cause) =>
        new FSError({ path: "app.db:pinned-sessions", op: "write", cause }),
    })
    return ok({ success: true })
  })
)
