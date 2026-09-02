/**
 * /api/git/overview — everything the git panel's header and Changes list need,
 * in one request.
 *
 * WHY ONE ROUTE AND NOT FIVE. The panel refreshes on every `git-change` the
 * `.git` watcher reports — which is every stage, every commit, every fetch — and
 * five round trips per refresh would mean the header and the file list can
 * disagree on screen: a commit lands, the branch updates, and the Changes list
 * still shows what was just committed until its own request returns. One route
 * reading one repository state cannot tear like that.
 *
 * READ-ONLY. Nothing here changes the repository, so — exactly as in
 * `/api/git-status` — no client string reaches git at all. `cwd` names the
 * directory git runs IN and never appears as an argument; the writes live in
 * `/api/git/op`, which is where the argv allowlist and the containment guard are.
 *
 * NOT A REPOSITORY IS NOT AN ERROR, same as the status route: a project without
 * version control is an ordinary project, and the panel says so rather than
 * showing a failure the reader cannot act on.
 */
import { execFile } from "child_process"
import { isAbsolute } from "path"
import { promisify } from "util"
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import {
  parseAheadBehind,
  parseBranchRefs,
  parseHead,
  parseRemoteRefs,
  splitWorkingTree,
} from "../../../../lib/gitPanelScope"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const run = promisify(execFile)

/** Local reads only — nothing here touches a network. A repository slow enough
 *  to miss this is one whose panel would be unusable anyway. */
const TIMEOUT_MS = 5000
const MAX_BUFFER = 8 * 1024 * 1024

/**
 * Run one git command, or answer null.
 *
 * NULL RATHER THAN A FAILURE, because most of these commands have a legitimate
 * "no answer" that git spells as a non-zero exit: no upstream configured, no
 * commits yet, no remotes. Every one of those is a state the panel draws, not an
 * error it reports, and an Effect failure here would collapse the whole overview
 * because one branch has no upstream.
 */
const git = (cwd: string, args: string[]): Effect.Effect<string | null> =>
  Effect.tryPromise({
    try: () =>
      run("git", ["-C", cwd, "--no-optional-locks", ...args], {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        encoding: "utf8",
        // Stops git waiting on a credential prompt no one can answer. Nothing
        // here talks to a remote, but `env` is inherited and a misconfigured
        // helper can still block; `LC_ALL` pins the language any message comes
        // back in.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      }).then((r) => r.stdout),
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => null))

export const GET = handler((req) =>
  Effect.gen(function* () {
    const cwd = (new URL(req.url).searchParams.get("cwd") ?? "").trim()
    if (!cwd || !isAbsolute(cwd)) {
      return ok({ ok: false as const, reason: "invalid-cwd" as const })
    }

    // Is this a repository at all? Asked first and on its own, because every
    // answer below is meaningless without it and they would all quietly come
    // back empty — a clean repo and a directory with no git look identical.
    const repoRoot = yield* git(cwd, ["rev-parse", "--show-toplevel"])
    if (repoRoot === null) {
      return ok({ ok: true as const, repo: false as const })
    }

    // The rest are independent reads of the same repository state, so they run
    // together rather than in a chain of six awaits.
    const [statusOut, headOut, branchOut, remoteOut, remotesOut] = yield* Effect.all(
      [
        git(cwd, ["status", "--porcelain", "-z", "-uall", "--ignored=no"]),
        git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
        git(cwd, [
          "for-each-ref",
          "--format=%(refname:short)%00%(upstream:short)%00%(HEAD)",
          "--sort=-committerdate",
          "refs/heads",
        ]),
        git(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/remotes"]),
        git(cwd, ["remote"]),
      ],
      { concurrency: "unbounded" },
    )

    const head = parseHead(headOut ?? "")
    const branches = parseBranchRefs(branchOut ?? "")
    const current = branches.find((b) => b.current)

    // AHEAD/BEHIND NEEDS AN UPSTREAM AND HAS NO SENSIBLE DEFAULT. The
    // implementation this replaces fell back to `origin/main` when none was
    // configured, which is a guess that reads as a fact: a branch tracking
    // nothing would be shown as 40 commits behind a branch it has no
    // relationship with. Absent means absent.
    const upstream = current?.upstream ?? null
    const aheadBehind = upstream
      ? parseAheadBehind(
          (yield* git(cwd, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`])) ?? "",
        )
      : null

    return ok({
      ok: true as const,
      repo: true as const,
      root: repoRoot.trim(),
      head,
      upstream,
      aheadBehind,
      branches,
      remoteBranches: parseRemoteRefs(remoteOut ?? ""),
      remotes: (remotesOut ?? "").split("\n").map((r) => r.trim()).filter(Boolean),
      ...splitWorkingTree(statusOut ?? ""),
    })
  }),
)
