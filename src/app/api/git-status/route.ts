/**
 * /api/git-status — which files in a project have changed, so the file tree can
 * colour them.
 *
 * SCOPE. One `git status` per call, read-only, and nothing else. A full git
 * integration (stage, diff, commit, branches, worktrees) once lived in this app
 * and went with the explorer package; rebuilding it to tint some text would be
 * paying for a feature nobody asked for. The parsing — which is where porcelain
 * quietly goes wrong — is in `lib/gitStatusScope.ts`, pure and tested.
 *
 * SAFETY. `cwd` is the project root the user already opened, the same input
 * `/api/list-dir` takes, and this route is strictly READ-ONLY: no path from the
 * client reaches git, only the directory it runs in. There is nothing to escape
 * with, which is why `withinCwd` — the guard the write and delete routes share —
 * has no job here.
 *
 * The flags are load-bearing:
 *
 *   `--no-optional-locks`  git would otherwise refresh the index and take
 *                          `.git/index.lock`. This runs on every panel refresh
 *                          and must never contend with the user's own terminal.
 *   `-z`                   raw NUL-separated paths. Without it git QUOTES paths
 *                          with spaces or non-ASCII bytes, and this project's
 *                          tree has Korean filenames.
 *   `-uall`                list files inside untracked directories, not just the
 *                          directory. A collapsed folder gets its colour from
 *                          the paths beneath it, so the shorthand would leave
 *                          every file in a new folder uncoloured.
 *   `--ignored=no`         ignored files are not changes; colouring them would
 *                          tint node_modules.
 */
import { execFile } from "child_process"
import { isAbsolute } from "path"
import { promisify } from "util"
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import {
  MAX_STATUS_ENTRIES,
  buildStatusMap,
  parsePorcelain,
} from "../../../lib/gitStatusScope"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const run = promisify(execFile)

type Reason = "invalid-cwd" | "failed"

const fail = (reason: Reason) => ok({ ok: false as const, reason })

/** A repository big enough to blow past this is one whose status nobody is
 *  reading anyway. Bounded so a pathological repo cannot hold a request open. */
const TIMEOUT_MS = 5000
const MAX_BUFFER = 8 * 1024 * 1024

export const GET = handler((req) =>
  Effect.gen(function* () {
    const url = new URL(req.url)
    const cwd = (url.searchParams.get("cwd") ?? "").trim()
    if (!cwd || !isAbsolute(cwd)) return fail("invalid-cwd")

    const result = yield* Effect.tryPromise({
      try: () =>
        run(
          "git",
          [
            "-C",
            cwd,
            "--no-optional-locks",
            "status",
            "--porcelain",
            "-z",
            "-uall",
            "--ignored=no",
          ],
          { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: "utf8" },
        ),
      catch: (cause) => cause,
    }).pipe(Effect.either)

    if (result._tag === "Left") {
      // NOT A REPOSITORY IS NOT AN ERROR. A project without version control is
      // an ordinary project; it simply has nothing to colour. git exits 128 for
      // it, and the same exit covers a few other "cannot answer" cases — all of
      // which mean the same thing to this route, so they share the answer.
      //
      // A missing git binary lands here too, and it should: the panel degrades
      // to no colours rather than showing an error the reader cannot act on.
      return ok({ ok: true as const, repo: false, changed: {}, truncated: false })
    }

    const entries = parsePorcelain(result.right.stdout)
    const truncated = entries.length > MAX_STATUS_ENTRIES
    // TRUNCATION IS REPORTED, NOT SILENT. A tree with no colours because the
    // answer was cut off has to be distinguishable from a clean tree, or the
    // panel would confidently say "nothing changed" about a repo mid-rebase.
    const changed = buildStatusMap(truncated ? entries.slice(0, MAX_STATUS_ENTRIES) : entries)

    return ok({ ok: true as const, repo: true, changed, truncated })
  }),
)
