/**
 * /api/project-state — a project's session list + per-session UI state.
 *
 * RE-BACKED ONTO THE NABY STORE (Phase C, part 1). The session list for a project
 * is now the set of sessions LINKED to that cwd in `app.db` (`SessionRef.cwd`),
 * not the per-project `~/.cockpit/projects/<enc>/session.json` file. The WIRE
 * CONTRACT is unchanged — the client still reads/writes
 * `{ sessions, activeSessionId?, engines?, ollamaModels?, deepseekModels?, planModes? }`
 * — so the running UI cannot tell the difference.
 *
 * WHERE EACH FIELD LIVES NOW:
 *   - `sessions[]`       → `listSessionsByProject(cwd)` (MRU), the session→project
 *                          links. A POST `setSessionProject`s each incoming id.
 *   - `activeSessionId`  → a Naby setting keyed by cwd (`ui.activeSession.<cwd>`),
 *                          falling back to the MRU head.
 *   - `planModes`        → per-session Naby settings (`session.planMode.<id>`), so
 *                          the plan-mode checkbox still round-trips.
 *   - `engines` / `ollamaModels` / `deepseekModels` → the engine-picker was
 *                          removed; these are vestigial and return `{}`.
 *
 * UNION / NO-SHRINK is inherent here: a POST only ADDS links for the sessions the
 * tab lists and only REMOVES via `closedSessionIds` (deleteSession). Sessions a
 * given tab does not list stay linked — a tab can never collapse the shared set.
 */
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"
import { getStore } from "@cockpit/feature-agent/server/engines/naby"
import { broadcastToGlobalState } from "../../../lib/globalStateBroadcast"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface ProjectState {
  sessions: string[]
  activeSessionId?: string
  engines?: Record<string, string>
  ollamaModels?: Record<string, string>
  deepseekModels?: Record<string, string>
  planModes?: Record<string, boolean>
}

const activeSessionKey = (cwd: string) => `ui.activeSession.${cwd}`
const planModeKey = (sessionId: string) => `session.planMode.${sessionId}`

/**
 * Build the wire state for a project from the store: the MRU session list, the
 * stored/derived active session, empty (vestigial) engine maps, and the per-
 * session plan-mode flags for exactly the sessions in the list.
 */
function readProjectState(cwd: string): ProjectState {
  const store = getStore()
  const sessions = store.listSessionsByProject(cwd).map((s) => s.sessionId)
  const inSet = new Set(sessions)

  const storedActive = store.getSetting(activeSessionKey(cwd))
  const activeSessionId =
    storedActive && inSet.has(storedActive) ? storedActive : sessions[0]

  const planModes: Record<string, boolean> = {}
  for (const sid of sessions) {
    if (store.getSetting(planModeKey(sid)) === "true") planModes[sid] = true
  }

  return {
    sessions,
    ...(activeSessionId ? { activeSessionId } : {}),
    // Vestigial (engine-picker removed) — returned empty to keep the shape.
    engines: {},
    ollamaModels: {},
    deepseekModels: {},
    ...(Object.keys(planModes).length ? { planModes } : {}),
  }
}

export const GET = handler((req) =>
  Effect.gen(function* () {
    const cwd = new URL(req.url).searchParams.get("cwd")
    if (!cwd) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: "missing" })
      )
    }
    const state = yield* Effect.try({
      try: () => readProjectState(cwd),
      catch: (cause) => new FSError({ path: "app.db:project-state", op: "read", cause }),
    })
    return ok(state)
  })
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as Partial<ProjectState> & {
      cwd?: string
      closedSessionIds?: string[]
    }
    if (!body.cwd) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: "missing" })
      )
    }
    if (!Array.isArray(body.sessions)) {
      return yield* Effect.fail(
        new ValidationError({ field: "sessions", reason: "must be array" })
      )
    }

    const cwd = body.cwd
    const incoming = body.sessions
    const closedIds = body.closedSessionIds ?? []
    const planModesIn = body.planModes ?? {}
    const activeIn = body.activeSessionId

    const state = yield* Effect.try({
      try: () => {
        const store = getStore()

        // Removal happens ONLY via closedSessionIds — deleteSession drops the
        // session and everything keyed to it. Do this first so a session that is
        // both listed and closed ends up closed.
        for (const sid of closedIds) store.deleteSession(sid)

        // Link each incoming session to this project. Only for sessions that
        // exist in the store (a tab should not conjure a session row); linking is
        // idempotent and never touches messages/memory. This is the UNION add —
        // sessions other tabs linked stay linked.
        const closed = new Set(closedIds)
        for (const sid of incoming) {
          if (closed.has(sid)) continue
          if (store.getSession(sid)) store.setSessionProject(sid, cwd)
        }

        // Persist per-session plan-mode flags (skip closed/deleted ids).
        for (const [sid, on] of Object.entries(planModesIn)) {
          if (closed.has(sid)) continue
          store.setSetting(planModeKey(sid), String(Boolean(on)))
        }

        // Persist the active session when it survives (present and not closed).
        if (activeIn && !closed.has(activeIn) && store.getSession(activeIn)) {
          store.setSetting(activeSessionKey(cwd), activeIn)
        }

        return readProjectState(cwd)
      },
      catch: (cause) => new FSError({ path: "app.db:project-state", op: "write", cause }),
    })

    // #10: notify other browser tabs to reconcile in-app tabs. closedSessionIds
    // carries the precise removals so viewers remove exactly those tabs.
    yield* Effect.sync(() =>
      broadcastToGlobalState({ type: "project-state-changed", cwd, closedSessionIds: closedIds })
    )
    return ok(state)
  })
)

/**
 * DELETE — remove a project (CASCADE).
 *
 * Replaces the old per-project state-file delete: `removeProject` drops the
 * project row AND every session it owns (with their messages/memory/usage), so
 * the project's sessions do not linger as ghosts. Idempotent — removing an
 * already-absent project is a success. The client contract is unchanged.
 */
export const DELETE = handler((req) =>
  Effect.gen(function* () {
    const cwd = new URL(req.url).searchParams.get("cwd")
    if (!cwd) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: "missing" })
      )
    }
    yield* Effect.try({
      try: () => getStore().removeProject(cwd),
      catch: (cause) => new FSError({ path: "app.db:project-state", op: "rm", cause }),
    })
    yield* Effect.sync(() =>
      broadcastToGlobalState({ type: "project-state-changed", cwd, closedSessionIds: [] })
    )
    return ok({ deleted: true })
  })
)
