/**
 * /api/note — P6 migration
 *
 * Note CRUD (two scopes: project-level / global).
 */
import { readFile, writeFile, stat } from "fs/promises"
import { Effect } from "effect"
import {
  COCKPIT_DIR,
  NOTE_FILE,
  ensureDir,
  getProjectNotePath,
  getCockpitProjectDir,
} from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError } from "@cockpit/effect-core"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface NotePaths {
  readonly filePath: string
  readonly dir: string
}

const resolvePaths = (url: string): NotePaths => {
  const { searchParams } = new URL(url)
  const cwd = searchParams.get("cwd")
  if (cwd) {
    return {
      filePath: getProjectNotePath(cwd),
      dir: getCockpitProjectDir(cwd),
    }
  }
  return { filePath: NOTE_FILE, dir: COCKPIT_DIR }
}

const ensureDirEff = (dir: string): Effect.Effect<void, FSError> =>
  Effect.tryPromise({
    try: () => ensureDir(dir),
    catch: (cause) => new FSError({ path: dir, op: "mkdir", cause }),
  })

const readContentEff = (filePath: string): Effect.Effect<string, never> =>
  Effect.tryPromise({
    try: () => readFile(filePath, "utf-8"),
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => ""))

/**
 * File modification time in ms — the optimistic-concurrency token. A missing
 * file yields 0, so a brand-new note (mtime 0 at load) still round-trips
 * correctly and a note created out-of-band between load and save is detected
 * as a conflict.
 */
const statMtimeEff = (filePath: string): Effect.Effect<number, never> =>
  Effect.tryPromise({
    try: () => stat(filePath),
    catch: () => null,
  }).pipe(
    Effect.map((s) => s.mtimeMs),
    Effect.orElseSucceed(() => 0)
  )

export const GET = handler((req) =>
  Effect.gen(function* () {
    const { filePath, dir } = resolvePaths(req.url)
    yield* ensureDirEff(dir)
    // On read failure (file missing) fall back to empty string, matching v1
    const content = yield* readContentEff(filePath)
    const mtime = yield* statMtimeEff(filePath)
    return ok({ content, mtime })
  })
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const { filePath, dir } = resolvePaths(req.url)
    const body = (yield* parseJsonRaw(req)) as {
      content?: string
      baseMtime?: number
    }
    yield* ensureDirEff(dir)

    // Optimistic-concurrency guard: if the caller loaded at `baseMtime` and
    // the file on disk has since changed (another tab / external editor),
    // reject the write and hand back the latest content + mtime so the client
    // reloads instead of silently clobbering the other writer's edits.
    const currentMtime = yield* statMtimeEff(filePath)
    if (typeof body.baseMtime === "number" && currentMtime !== body.baseMtime) {
      const latest = yield* readContentEff(filePath)
      return ok({ conflict: true, content: latest, mtime: currentMtime }, 409)
    }

    yield* Effect.tryPromise({
      try: () => writeFile(filePath, body.content ?? "", "utf-8"),
      catch: (cause) => new FSError({ path: filePath, op: "write", cause }),
    })
    const mtime = yield* statMtimeEff(filePath)
    return ok({ success: true, mtime })
  })
)
