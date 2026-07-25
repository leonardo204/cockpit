/**
 * /api/copy-into — copy files/folders dropped from the OS (Finder/Explorer) into
 * a folder of the current project, the ordinary "drag into a file browser to add
 * it" gesture.
 *
 * SCOPE & SAFETY. The DESTINATION is resolved from the project root `cwd` + a
 * relative `destRel` and must stay inside `cwd` (an escaping `..` is refused).
 * The SOURCES are absolute paths the renderer obtained via `webUtils.getPathForFile`
 * for files the user just dropped — arbitrary on-disk locations, which is expected
 * (you are copying your own files in). Each source is copied to
 * `<dest>/<basename>` recursively; an existing target is SKIPPED, never
 * overwritten (a copy must not clobber). Results are reported per item.
 */
import { cp, stat } from "fs/promises"
import { basename, isAbsolute, join, resolve, sep } from "path"
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface Body {
  readonly cwd?: string
  readonly destRel?: string
  readonly sources?: string[]
}

type Reason = "invalid-cwd" | "escape" | "dest-not-dir" | "no-sources"

const fail = (reason: Reason) => ok({ ok: false as const, reason })

function withinCwd(cwd: string, target: string): boolean {
  const base = resolve(cwd)
  const t = resolve(target)
  return t === base || t.startsWith(base + sep)
}

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as Body
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : ""
    const destRel = typeof body.destRel === "string" ? body.destRel.trim() : ""
    const sources = Array.isArray(body.sources)
      ? body.sources.filter((s): s is string => typeof s === "string" && s.length > 0)
      : []

    if (!cwd || !isAbsolute(cwd)) return fail("invalid-cwd")
    if (sources.length === 0) return fail("no-sources")

    const dest = resolve(join(cwd, destRel))
    if (!withinCwd(cwd, dest)) return fail("escape")

    const destStat = yield* Effect.tryPromise({
      try: () => stat(dest),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null))
    if (!destStat || !destStat.isDirectory()) return fail("dest-not-dir")

    const copied: string[] = []
    const skipped: string[] = []
    const failed: string[] = []

    for (const src of sources) {
      const name = basename(src)
      if (!name) {
        failed.push(src)
        continue
      }
      const target = join(dest, name)
      const exists = yield* Effect.tryPromise({
        try: () => stat(target).then(() => true),
        catch: () => false,
      }).pipe(Effect.orElseSucceed(() => false))
      if (exists) {
        skipped.push(name)
        continue
      }
      const done = yield* Effect.tryPromise({
        try: () => cp(src, target, { recursive: true, errorOnExist: true, force: false }).then(() => true),
        catch: () => false,
      }).pipe(Effect.orElseSucceed(() => false))
      if (done) copied.push(name)
      else failed.push(name)
    }

    return ok({ ok: true as const, copied, skipped, failed })
  }),
)
