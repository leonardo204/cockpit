/**
 * /api/changed-since — which files have been written since a moment, for a
 * project that has no git repository.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS AT ALL
 *
 * The file tree colours changed rows from `git status`, and git's four states
 * all mean the same thing underneath: "differs from the commit you made". That
 * is a baseline the USER created, deliberately, which is why it needs no
 * explaining.
 *
 * A project with no repository has no such baseline, and every substitute is
 * something the app chose rather than something the user did. This one — the
 * moment the project was opened — is the only substitute that needs no history,
 * no configuration and no prior agent activity, and its meaning fits in a
 * sentence the tooltip can say out loud.
 *
 * IT ANSWERS IN THE SAME SHAPE `/api/git-status` DOES, deliberately: one map of
 * path → state with the folders already rolled in. The tree then needs no idea
 * which source it is reading, and the whole client path — the context, the
 * tint, the roll-up — is the code that was already there.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT COSTS, AND WHAT BOUNDS IT
 *
 * A walk of the project tree, which git got for free. Three bounds, because a
 * project with no `.gitignore` is exactly the project most likely to have a
 * `node_modules` in it:
 *
 *   the watcher's ignore list   `node_modules`, `.git`, `dist`, caches — the
 *                               same set the file watcher already skips, so the
 *                               two agree about what counts as project content.
 *   MAX_WALK_DEPTH              a bound on pathological trees.
 *   MAX_STATUS_ENTRIES          the same cap the git route uses, and truncation
 *                               is REPORTED rather than implied.
 *
 * SAFETY. `cwd` is the project root the user already opened — the same input
 * `/api/list-dir` takes — and this route only ever STATS. It returns names and
 * timestamps, never contents, and it takes no path from the client other than
 * the root itself, so there is nothing to escape with.
 */
import { readdir, stat } from "fs/promises"
import { isAbsolute, join } from "path"
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import {
  MAX_STATUS_ENTRIES,
  MAX_WALK_DEPTH,
  buildStatusMap,
  isTouchedSince,
  type GitStatusEntry,
} from "../../../lib/gitStatusScope"
import { isIgnoredWatchPath } from "../../../lib/fsWatchScope"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Reason = "invalid-cwd" | "invalid-since" | "failed"

const fail = (reason: Reason) => ok({ ok: false as const, reason })

export const GET = handler((req) =>
  Effect.gen(function* () {
    const url = new URL(req.url)
    const cwd = (url.searchParams.get("cwd") ?? "").trim()
    const since = Number(url.searchParams.get("since"))

    if (!cwd || !isAbsolute(cwd)) return fail("invalid-cwd")
    // A missing or nonsense `since` would mark either everything or nothing, and
    // both are worse than saying no: the caller has a bug and a tree full of
    // confident colour would hide it.
    if (!Number.isFinite(since) || since <= 0) return fail("invalid-since")

    const found: GitStatusEntry[] = []
    let truncated = false

    const walk = (dirAbs: string, dirRel: string, depth: number): Promise<void> =>
      (async () => {
        if (truncated || depth > MAX_WALK_DEPTH) return
        const dirents = await readdir(dirAbs, { withFileTypes: true }).catch(() => null)
        if (!dirents) return

        for (const d of dirents) {
          if (truncated) return
          const rel = dirRel ? `${dirRel}/${d.name}` : d.name
          // The watcher's own list, so the tree and the watcher agree about what
          // is project content and what is churn.
          if (isIgnoredWatchPath(rel)) continue

          if (d.isDirectory()) {
            await walk(join(dirAbs, d.name), rel, depth + 1)
            continue
          }
          // Symlinks are not followed: `isFile()` is false for them, and a
          // symlink into a mounted volume is the classic way a walk stops
          // returning. Nothing else is skipped.
          if (!d.isFile()) continue

          const info = await stat(join(dirAbs, d.name)).catch(() => null)
          if (!info) continue
          if (!isTouchedSince(info.mtimeMs, since)) continue

          if (found.length >= MAX_STATUS_ENTRIES) {
            truncated = true
            return
          }
          found.push({ path: rel, state: "touched", staged: false })
        }
      })()

    yield* Effect.tryPromise({
      try: () => walk(cwd, "", 0),
      catch: (cause) => cause,
    }).pipe(
      // A project that cannot be walked — deleted under us, permissions — gets
      // no colours rather than an error the reader cannot act on, which is the
      // same degradation the git route chose.
      Effect.orElseSucceed(() => undefined),
    )

    return ok({
      ok: true as const,
      repo: false as const,
      changed: buildStatusMap(found),
      truncated,
    })
  }),
)
