/**
 * /api/settings — P6 migration
 *
 * Settings read/write; PUT is a merge-update.
 */
import { Effect } from "effect"
import {
  SETTINGS_FILE,
  readJsonFile,
  mutateJsonFile,
} from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError } from "@cockpit/effect-core"

interface Settings {
  language?: string // 'en' | 'ko' | 'auto'
  [key: string]: unknown
}

const readSettings: Effect.Effect<Settings, FSError> = Effect.tryPromise({
  try: () => readJsonFile<Settings>(SETTINGS_FILE, {}),
  catch: (cause) =>
    new FSError({ path: SETTINGS_FILE, op: "read", cause }),
})

export const GET = handler(() =>
  Effect.gen(function* () {
    const settings = yield* readSettings
    return ok(settings)
  })
)

export const PUT = handler((req) =>
  Effect.gen(function* () {
    const patch = (yield* parseJsonRaw(req)) as Partial<Settings>
    // Locked read-merge-write — serializes with push.ts's withFileLock(SETTINGS_FILE)
    // so a concurrent VAPID-key write can't clobber this merge (and vice versa).
    const merged = yield* Effect.tryPromise({
      try: () =>
        mutateJsonFile<Settings>(SETTINGS_FILE, {}, (current) => ({
          ...current,
          ...patch,
        })),
      catch: (cause) =>
        new FSError({ path: SETTINGS_FILE, op: "write", cause }),
    })
    return ok(merged)
  })
)
