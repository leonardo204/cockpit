/**
 * /api/git/log — the commits behind the graph, already laid out into lanes.
 *
 * WHY THE LAYOUT HAPPENS HERE. The lane assignment needs every commit in the
 * window in order, and it is the same pure pass whether it runs on the server or
 * in the component. Doing it here means the client receives rows it can draw
 * directly, and — more to the point — the algorithm sits next to its tests
 * rather than inside a React render.
 *
 * READ-ONLY, with the same reasoning as `/api/git/overview`: no client string
 * reaches git in argument position. `limit` and `offset` are parsed to numbers
 * and clamped, so what lands in argv is a number this file produced.
 */
import { execFile } from "child_process"
import { isAbsolute } from "path"
import { promisify } from "util"
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { LOG_FORMAT, layoutGraph, parseLog } from "../../../../lib/gitLogScope"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const run = promisify(execFile)

const TIMEOUT_MS = 10000
const MAX_BUFFER = 32 * 1024 * 1024

/**
 * How many commits one page is.
 *
 * The cap is a rendering limit before it is a git one. Every row is an SVG node
 * plus its edges, and a graph nobody can scroll to the bottom of is not more
 * informative than one they can — it is just slower. The panel asks for more
 * when the reader reaches the end.
 */
const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000

/** Clamp to a whole number in range, whatever arrived. `NaN` falls back rather
 *  than reaching argv as the string "NaN". */
function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const cwd = (sp.get("cwd") ?? "").trim()
    if (!cwd || !isAbsolute(cwd)) {
      return ok({ ok: false as const, reason: "invalid-cwd" as const })
    }

    const limit = clampInt(sp.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT)
    const offset = clampInt(sp.get("offset"), 0, 0, 1_000_000)

    const result = yield* Effect.tryPromise({
      try: () =>
        run(
          "git",
          [
            "-C",
            cwd,
            "--no-optional-locks",
            "log",
            // TOPO ORDER IS NOT COSMETIC. The lane algorithm never looks ahead;
            // it assumes a parent is always drawn after its children. Date order
            // — git's default — breaks that whenever a branch was committed to
            // earlier than the mainline it merges into, and the graph then grows
            // lanes that never close.
            "--topo-order",
            // The whole repository, not just HEAD, so other branches are lines
            // on the graph rather than being invisible until checked out.
            "--all",
            `--format=${LOG_FORMAT}`,
            `-n`,
            String(limit),
            `--skip=${offset}`,
          ],
          {
            timeout: TIMEOUT_MS,
            maxBuffer: MAX_BUFFER,
            encoding: "utf8",
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
          },
        ),
      catch: (cause) => cause,
    }).pipe(Effect.either)

    if (result._tag === "Left") {
      // Not a repository, no git binary, or — the case worth naming — a
      // repository with NO COMMITS YET, where `git log` exits 128 because there
      // is no HEAD to walk. A newly created project hits that on first open, and
      // it is an empty graph, not a broken panel.
      return ok({ ok: true as const, repo: false as const, rows: [], laneCount: 0, hasMore: false })
    }

    const commits = parseLog(result.right.stdout)
    const { rows, laneCount } = layoutGraph(commits)

    return ok({
      ok: true as const,
      repo: true as const,
      rows,
      laneCount,
      // A full page means there is probably another one. Reported rather than
      // computed from a total, because counting every commit in the repository
      // to decide whether to show one button is a walk of the entire history.
      hasMore: commits.length === limit,
    })
  }),
)
