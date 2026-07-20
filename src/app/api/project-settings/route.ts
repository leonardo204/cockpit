/**
 * /api/project-settings — P8+ migration
 */
import { Effect } from "effect"
import {
  getProjectSettingsPath,
  readJsonFile,
  mutateJsonFile,
} from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * A `usePty` flag used to sit here as a leftover of the removed PTY execution mode. It had
 * no reader or writer even before that removal. Dropping it is safe for settings files that
 * still contain it: reads go through `readJsonFile` (plain JSON.parse + cast, no runtime
 * validation) and the POST merge is a spread, so an unknown key is carried through
 * untouched rather than rejected.
 */
interface ProjectSettings {
  gridLayout?: boolean
  activeView?: "agent" | "explorer" | "console"
}

const DEFAULT_SETTINGS: ProjectSettings = {
  gridLayout: true,
}

export const GET = handler((req) =>
  Effect.gen(function* () {
    const cwd = new URL(req.url).searchParams.get("cwd")
    if (!cwd) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: "missing" })
      )
    }
    const settingsPath = getProjectSettingsPath(cwd)
    const settings = yield* Effect.tryPromise({
      try: () =>
        readJsonFile<ProjectSettings>(settingsPath, DEFAULT_SETTINGS),
      catch: (cause) =>
        new FSError({ path: settingsPath, op: "read", cause }),
    })
    return ok({ settings })
  })
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as {
      cwd?: string
      settings?: ProjectSettings
    }
    if (!body.cwd || !body.settings) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.cwd ? "cwd" : "settings",
          reason: "missing",
        })
      )
    }
    const { cwd, settings } = body
    const settingsPath = getProjectSettingsPath(cwd)
    // Locked read-merge-write so concurrent settings updates don't clobber each other.
    yield* Effect.tryPromise({
      try: () =>
        mutateJsonFile<ProjectSettings>(settingsPath, DEFAULT_SETTINGS, (existing) => ({
          ...existing,
          ...settings,
        })),
      catch: (cause) =>
        new FSError({ path: settingsPath, op: "write", cause }),
    })
    return ok({ success: true })
  })
)
