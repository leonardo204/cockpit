/**
 * /api/project-state — a project's session list + per-session UI state.
 *
 * RE-BACKED ONTO THE NABY STORE (Phase C, part 1). The session list for a project
 * is now the set of sessions LINKED to that cwd in `app.db` (`SessionRef.cwd`),
 * not the per-project `~/.cockpit/projects/<enc>/session.json` file. The client
 * reads/writes `{ sessions, activeSessionId?, planModes? }`. The per-engine maps
 * (`engines` / `ollamaModels` / `deepseekModels`) were dropped with the engine
 * picker — Naby is single-engine. A POST is tolerant of legacy clients that still
 * send those keys (they are ignored), but the response no longer emits them.
 *
 * WHERE EACH FIELD LIVES NOW:
 *   - `sessions[]`       → `listSessionsByProject(cwd)` (MRU), the session→project
 *                          links. A POST `setSessionProject`s each incoming id.
 *   - `activeSessionId`  → a Naby setting keyed by cwd (`ui.activeSession.<cwd>`),
 *                          falling back to the MRU head.
 *   - `planModes`        → per-session Naby settings (`session.planMode.<id>`), so
 *                          the plan-mode checkbox still round-trips.
 *
 * UNION / NO-SHRINK is inherent here: a POST only ADDS links for the sessions the
 * tab lists and only REMOVES via `closedSessionIds` (deleteSession). Sessions a
 * given tab does not list stay linked — a tab can never collapse the shared set.
 *
 * WHAT A POST MEANS lives in @cockpit/feature-agent/server/state/projectState —
 * the two request shapes (a project save, which still REQUIRES its cwd, and a
 * projectless close, which deletes ids and carries no project), the one removal
 * loop both end in, and the state read back. This file keeps the HTTP: parse,
 * map a refusal to ValidationError, wrap the store work, broadcast.
 */
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"
import { getStore } from "@cockpit/feature-agent/server/engines/naby"
import {
  applyProjectStateRequest,
  broadcastCwdOf,
  parseProjectStateRequest,
  readProjectState,
} from "@cockpit/feature-agent/server/state/projectState"
import { broadcastToGlobalState } from "../../../lib/globalStateBroadcast"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = handler((req) =>
  Effect.gen(function* () {
    const cwd = new URL(req.url).searchParams.get("cwd")
    if (!cwd) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: "missing" })
      )
    }
    const state = yield* Effect.try({
      try: () => readProjectState(getStore(), cwd),
      catch: (cause) => new FSError({ path: "app.db:project-state", op: "read", cause }),
    })
    return ok(state)
  })
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = yield* parseJsonRaw(req)

    // Two shapes, one channel. `parseProjectStateRequest` decides which — and a
    // project save with no cwd is still refused there, exactly as before.
    const parsed = parseProjectStateRequest(body)
    if (!parsed.ok) {
      return yield* Effect.fail(new ValidationError(parsed.error))
    }
    const request = parsed.request

    const state = yield* Effect.try({
      try: () => applyProjectStateRequest(getStore(), request),
      catch: (cause) => new FSError({ path: "app.db:project-state", op: "write", cause }),
    })

    // #10: notify other browser tabs to reconcile in-app tabs. closedSessionIds
    // carries the precise removals so viewers remove exactly those tabs. A
    // projectless close broadcasts cwd '' — it belongs to no project, so every
    // viewer applies it (see broadcastCwdOf).
    const cwd = broadcastCwdOf(request)
    const closedIds = request.closedSessionIds
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
