/**
 * /api/project-state — P6 migration
 *
 * Project session-list CRUD (indexed by cwd).
 */
import { rm } from "node:fs/promises"
import { Effect } from "effect"
import {
  getSessionFilePath,
  readJsonFile,
  writeJsonFile,
  withFileLock,
} from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"
import { broadcastToGlobalState } from "../../../lib/globalStateBroadcast"

/**
 * Persisted shape. Session files written by older builds may still contain a `chatModes`
 * key (the removed SDK/PTY execution-mode picker). That is safe: reads go through
 * `readJsonFile`, a plain JSON.parse + cast with no runtime validation, so an unknown key
 * is carried through untouched and never read; and the POST handler rebuilds `next`
 * field-by-field, so the stale key is simply dropped the next time the file is written.
 */
interface ProjectState {
  sessions: string[]
  activeSessionId?: string
  engines?: Record<string, string>
  ollamaModels?: Record<string, string>
  deepseekModels?: Record<string, string>
  planModes?: Record<string, boolean>
}

export const GET = handler((req) =>
  Effect.gen(function* () {
    const cwd = new URL(req.url).searchParams.get("cwd")
    if (!cwd) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: "missing" })
      )
    }
    const filePath = getSessionFilePath(cwd)
    const state = yield* Effect.tryPromise({
      try: () => readJsonFile<ProjectState>(filePath, { sessions: [] }),
      catch: (cause) => new FSError({ path: filePath, op: "read", cause }),
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
        new ValidationError({
          field: "sessions",
          reason: "must be array",
        })
      )
    }

    const cwd = body.cwd
    const incoming = body.sessions
    const closedIds = body.closedSessionIds ?? []
    const filePath = getSessionFilePath(cwd)

    // Read-modify-write under a lock: UNION the incoming sessions with what's already
    // persisted, then subtract explicitly-closed ids. A browser tab only knows ITS OWN open
    // subset; a plain overwrite would let a tab with fewer tabs shrink the shared set and
    // collapse the others (the "not opened here" == "closed" bug). Union makes those
    // distinct — removal happens ONLY via closedSessionIds.
    const state = yield* Effect.tryPromise({
      try: () =>
        withFileLock(filePath, async () => {
          const existing = await readJsonFile<ProjectState>(filePath, { sessions: [] })
          const closed = new Set(closedIds)
          const union: string[] = []
          for (const sid of [...existing.sessions, ...incoming]) {
            if (!closed.has(sid) && !union.includes(sid)) union.push(sid)
          }
          const inSet = new Set(union)
          const merge = <T>(a?: Record<string, T>, b?: Record<string, T>) => {
            const m: Record<string, T> = { ...(a ?? {}), ...(b ?? {}) }
            for (const id of Object.keys(m)) if (!inSet.has(id)) delete m[id] // drop closed/orphan
            return m
          }
          const engines = merge(existing.engines, body.engines)
          const ollamaModels = merge(existing.ollamaModels, body.ollamaModels)
          const deepseekModels = merge(existing.deepseekModels, body.deepseekModels)
          const planModes = merge<boolean>(existing.planModes, body.planModes)
          const active = body.activeSessionId ?? existing.activeSessionId
          const next: ProjectState = {
            sessions: union,
            ...(active && inSet.has(active) ? { activeSessionId: active } : {}),
            ...(Object.keys(engines).length ? { engines } : {}),
            ...(Object.keys(ollamaModels).length ? { ollamaModels } : {}),
            ...(Object.keys(deepseekModels).length ? { deepseekModels } : {}),
            ...(Object.keys(planModes).length ? { planModes } : {}),
          }
          await writeJsonFile(filePath, next)
          return next
        }),
      catch: (cause) => new FSError({ path: filePath, op: "write", cause }),
    })

    // #10: notify other browser tabs to reconcile in-app tabs. closedSessionIds carries the
    // precise removals so viewers remove exactly those tabs (never collapse by set diff).
    yield* Effect.sync(() =>
      broadcastToGlobalState({ type: "project-state-changed", cwd, closedSessionIds: closedIds })
    )
    return ok(state)
  })
)

/**
 * DELETE — remove a project's whole session-state file.
 *
 * Used when a project is removed from the recents list: the product decision is
 * that deleting a project also discards its session history, so its sessions do
 * not linger as ghosts in the session browsers. Idempotent — deleting an
 * already-absent file is a success (`rm(..., { force: true })`), so a
 * double-remove or a project that never had a state file does not error.
 *
 * NOTE: this removes the per-project `state.json` (the session LIST the tabs and
 * recents read). Transcript bodies the Agent SDK may have written elsewhere are
 * not this file's concern; they are unreferenced once the list is gone.
 */
export const DELETE = handler((req) =>
  Effect.gen(function* () {
    const cwd = new URL(req.url).searchParams.get("cwd")
    if (!cwd) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: "missing" })
      )
    }
    const filePath = getSessionFilePath(cwd)
    yield* Effect.tryPromise({
      try: () => rm(filePath, { force: true }),
      catch: (cause) => new FSError({ path: filePath, op: "rm", cause }),
    })
    yield* Effect.sync(() =>
      broadcastToGlobalState({ type: "project-state-changed", cwd, closedSessionIds: [] })
    )
    return ok({ deleted: true })
  })
)
