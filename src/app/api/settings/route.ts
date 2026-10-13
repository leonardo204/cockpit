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
  // 'light' | 'dark' | 'system'. Lives here — and not only in localStorage —
  // because the desktop shell boots on an ephemeral port and localStorage is
  // scoped per origin, port included: it is empty on every restart. Read back
  // server-side by src/app/layout.tsx. See shared-utils/bootTheme.ts.
  theme?: string
  // The four font knobs (family / size / chat size / code family). Same reason
  // as `theme`, one preference later: an ephemeral port makes localStorage
  // useless across restarts, so the durable copy lives here and is read back
  // server-side by src/app/layout.tsx. Shape and validation live in
  // shared-utils/fontSettings.ts — this route stores what it is given and the
  // readers normalize, exactly as they do for a hand-edited theme.
  fonts?: unknown
  // Where the project folder chooser starts (shared-utils/projectFolder.ts).
  // `projectFolderDefault` is the folder chosen in Settings — `null` once
  // cleared, since this PUT merges and cannot delete a key. `projectFolderLast`
  // is the folder most recently picked or created; the chooser opens at its
  // parent. `projectFolderFavorites` is the quick menu's pinned folders, in
  // insertion order, at most ten — written through /api/pick-folder/favorites
  // (a locked add/remove), never as a whole array here. All three are read back
  // through src/lib/projectFolderStart.ts, which ignores any value that is not
  // an existing absolute directory.
  projectFolderDefault?: string | null
  projectFolderLast?: string
  projectFolderFavorites?: string[]
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
