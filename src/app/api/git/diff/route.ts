/**
 * /api/git/diff — what actually changed, as git computed it.
 *
 * THREE THINGS IT CAN BE ASKED, and they are three different diffs:
 *
 *   ?path=…            the working tree against the index — the edits a commit
 *                      would LEAVE BEHIND.
 *   ?path=…&staged=1   the index against HEAD — the edits a commit would TAKE.
 *   ?commit=<hash>     what one commit changed, every file of it.
 *
 * The first two are the two halves the panel shows apart, so the viewer has to
 * be able to ask for either; showing one when the reader clicked the other is
 * the mistake this parameter exists to prevent.
 *
 * READ-ONLY. `git diff` and `git show` write nothing. The one client string that
 * reaches git is a pathspec, and it goes after `--` with the same containment
 * guard the write routes use — a `path` is a file the reader clicked in a list
 * this app produced, and this checks the echo came back unchanged.
 */
import { execFile } from "child_process"
import { isAbsolute, resolve } from "path"
import { promisify } from "util"
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { withinCwd } from "../../../../lib/fsScope"
import { MAX_FILES, buildDiffFiles } from "../../../../lib/gitDiffScope"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const run = promisify(execFile)

const TIMEOUT_MS = 10_000
const MAX_BUFFER = 64 * 1024 * 1024

type Reason = "invalid-cwd" | "bad-path" | "bad-commit" | "failed"

const fail = (reason: Reason) => ok({ ok: false as const, reason })

/**
 * A commit-ish this route will pass to git.
 *
 * Hex only, and no `..`, so it cannot become a RANGE or a flag. `git show
 * a..b --` would answer with a diff nobody asked for, and a "commit" beginning
 * with a dash is an option.
 */
function isCommitish(s: string): boolean {
  return /^[0-9a-fA-F]{4,64}$/.test(s)
}

/** The same shape check the write path used: relative, no climbing, no leading
 *  dash. The filesystem containment test follows it below. */
function isSafeRepoPath(path: string): boolean {
  if (!path || path.length > 4096) return false
  if (path.startsWith("-") || path.startsWith("/")) return false
  if (/^[A-Za-z]:[\\/]/.test(path)) return false
  if (path.includes("\0") || path.includes("\n")) return false
  const segments = path.split("/")
  return !segments.includes("..") && !segments.includes(".git")
}

const git = (cwd: string, args: string[]) =>
  Effect.tryPromise({
    try: () =>
      run("git", ["-C", cwd, "--no-optional-locks", ...args], {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      }).then((r) => r.stdout),
    catch: (cause) => cause,
  }).pipe(Effect.either)

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const cwd = (sp.get("cwd") ?? "").trim()
    if (!cwd || !isAbsolute(cwd)) return fail("invalid-cwd")

    const commit = (sp.get("commit") ?? "").trim()
    const path = (sp.get("path") ?? "").trim()
    const staged = sp.get("staged") === "1"

    // WHICH DIFF, AS TWO ARGUMENT LISTS RATHER THAN ONE BUILT BY CONCATENATION.
    // `--numstat -z` gives the paths (unambiguously — see gitDiffScope.ts) and
    // the counts; the second gives the text. They must describe the SAME diff,
    // which is why they are written next to each other and differ in one flag.
    let statArgs: string[]
    let textArgs: string[]

    if (commit) {
      if (!isCommitish(commit)) return fail("bad-commit")
      // `--no-renames` is NOT passed: a rename shown as a delete plus an add is
      // the reader losing the one fact that makes the change readable.
      //
      // `-m --first-parent` is what gives a MERGE commit a diff at all. git's
      // default for a merge is to print nothing, which in a viewer reads as
      // "this commit changed nothing" — the least true thing it could say about
      // a merge. Against the mainline parent is the diff a person means.
      //
      // `--format=` empties the commit header, which this route does not parse
      // (the graph already has it) and which would otherwise land in the diff
      // text ahead of the first file marker.
      const base = ["show", "--no-color", "-m", "--first-parent", "--format="]
      statArgs = [...base, "--numstat", "-z", commit]
      textArgs = [...base, "--unified=3", commit]
    } else {
      if (!path) return fail("bad-path")
      if (!isSafeRepoPath(path)) return fail("bad-path")
      // A relative path can still resolve outside the project once joined to a
      // real root — the shape check above cannot see that, and this can.
      if (!withinCwd(cwd, resolve(cwd, path))) return fail("bad-path")

      const base = ["diff", "--no-color", ...(staged ? ["--cached"] : [])]
      statArgs = [...base, "--numstat", "-z", "--", path]
      textArgs = [...base, "--unified=3", "--", path]
    }

    const [statRes, textRes] = yield* Effect.all([git(cwd, statArgs), git(cwd, textArgs)], {
      concurrency: "unbounded",
    })

    // A NOT-A-REPOSITORY, A BAD HASH, OR A PATH GIT DOES NOT KNOW all exit
    // non-zero, and all mean the same thing to the reader: there is nothing here
    // to show. Reported as a refusal rather than a 500 so the tab can say so.
    if (statRes._tag === "Left" || textRes._tag === "Left") return fail("failed")

    const files = buildDiffFiles(statRes.right, textRes.right)

    return ok({
      ok: true as const,
      files,
      // Reported so the viewer can say the list is an extract. Computed from the
      // cap rather than from a second count of the whole diff.
      truncated: files.length >= MAX_FILES,
    })
  }),
)
