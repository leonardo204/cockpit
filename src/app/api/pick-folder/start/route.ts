/**
 * /api/pick-folder/start
 *
 * What the project folder chooser needs before it opens:
 *
 *   - `startPath` — where "Browse other folder…" (or the chooser on its own)
 *     opens: the configured default, else the parent of the last picked folder,
 *     else home;
 *   - `favorites` / `last` — the quick menu's entries, EXISTING folders only;
 *   - `home` — so the client can show paths as `~/…`.
 *
 * Answered here rather than in the browser because every part needs a
 * filesystem check — see src/lib/projectFolderStart.ts for the order and why
 * each step may fall through.
 *
 * Shared by both dialog paths: the client asks this route first, then hands
 * the chosen start folder to the Electron bridge or to
 * `/api/pick-folder?defaultPath=`.
 */
import { Effect } from "effect"
import { SETTINGS_FILE, readJsonFile } from "@cockpit/shared-utils"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { projectFolderChoices } from "../../../../lib/projectFolderStart"

export const GET = handler(() =>
  Effect.gen(function* () {
    // An unreadable settings file is "nothing configured", not a failure: the
    // chooser must still open, at home.
    const settings = yield* Effect.tryPromise({
      try: () => readJsonFile<Record<string, unknown>>(SETTINGS_FILE, {}),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => ({} as Record<string, unknown>)))

    return ok(projectFolderChoices(settings ?? {}))
  })
)
