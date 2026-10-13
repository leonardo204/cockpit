/**
 * /api/pick-folder/favorites
 *
 * POST `{op: "add" | "remove", folder}` → `{favorites}` — the STORED list after
 * the change, stale entries included (Settings shows those as missing).
 *
 * A route of its own rather than `PUT /api/settings`, because that PUT merges
 * top-level keys: a client sending a whole new array would overwrite an add
 * made a moment earlier from another window. Here the read-modify-write runs
 * under the settings file lock (`mutateJsonFile`), so two adds both land.
 *
 * `add` takes only an existing absolute directory — the menu's star and the
 * Settings picker can only ever offer one, so anything else is refused rather
 * than stored. `remove` takes any string: removing a favorite whose folder has
 * gone is exactly what the missing hint invites.
 */
import { Effect } from "effect"
import {
  PROJECT_FOLDER_FAVORITES_KEY,
  SETTINGS_FILE,
  addFavorite,
  mutateJsonFile,
  normalizeFavorites,
  removeFavorite,
} from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError } from "@cockpit/effect-core"
import { usableStartDir } from "../../../../lib/projectFolderStart"

type Body = { op?: unknown; folder?: unknown }

export const POST = handler((req) =>
  Effect.gen(function* () {
    const { op, folder } = (yield* parseJsonRaw(req)) as Body
    if ((op !== "add" && op !== "remove") || typeof folder !== "string" || !folder) {
      return ok({ ok: false as const, reason: "invalid" })
    }
    if (op === "add" && usableStartDir(folder) === null) {
      return ok({ ok: false as const, reason: "not-a-folder" })
    }

    const merged = yield* Effect.tryPromise({
      try: () =>
        mutateJsonFile<Record<string, unknown>>(SETTINGS_FILE, {}, (current) => ({
          ...current,
          [PROJECT_FOLDER_FAVORITES_KEY]:
            op === "add"
              ? addFavorite(current[PROJECT_FOLDER_FAVORITES_KEY], folder)
              : removeFavorite(current[PROJECT_FOLDER_FAVORITES_KEY], folder),
        })),
      catch: (cause) => new FSError({ path: SETTINGS_FILE, op: "write", cause }),
    })
    return ok({
      ok: true as const,
      favorites: normalizeFavorites(merged[PROJECT_FOLDER_FAVORITES_KEY]),
    })
  })
)
