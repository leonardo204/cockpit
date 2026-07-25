/**
 * /api/list-dir — enumerate the immediate children of one directory inside a
 * project working tree, for the chat file-browser panel.
 *
 * SCOPE & SAFETY. The panel is project-scoped: `cwd` is the project root the
 * user already opened, `rel` a directory relative to it (default the root). The
 * resolved target must be `cwd` itself or strictly inside it — any `..` that
 * would escape the tree is refused with `{ok:false, reason:'escape'}` and HTTP
 * 200, the same value-not-error shape /api/create-project uses. It only ever
 * READS one directory level (no recursion, no file contents, no writes); the
 * tree lazy-loads deeper levels with more calls as folders are expanded.
 */
import { readdir } from "fs/promises"
import { isAbsolute, join, resolve, sep } from "path"
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface Entry {
  readonly name: string
  readonly isDir: boolean
}

type Reason = "invalid-cwd" | "escape" | "not-found"

const fail = (reason: Reason) => ok({ ok: false as const, reason })

/** The target must be the project root itself or strictly inside it — never a
 *  sibling or ancestor reached via `..`. */
function withinCwd(cwd: string, target: string): boolean {
  const base = resolve(cwd)
  const t = resolve(target)
  return t === base || t.startsWith(base + sep)
}

export const GET = handler((req) =>
  Effect.gen(function* () {
    const url = new URL(req.url)
    const cwd = (url.searchParams.get("cwd") ?? "").trim()
    const rel = (url.searchParams.get("rel") ?? "").trim()

    if (!cwd || !isAbsolute(cwd)) return fail("invalid-cwd")
    const target = resolve(join(cwd, rel))
    if (!withinCwd(cwd, target)) return fail("escape")

    const dirents = yield* Effect.tryPromise({
      try: () => readdir(target, { withFileTypes: true }),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null))
    if (!dirents) return fail("not-found")

    // Directories first, then files; each group alphabetical (locale-aware).
    const entries: Entry[] = dirents
      .map((d) => ({ name: d.name, isDir: d.isDirectory() }))
      .sort((a, b) =>
        a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name),
      )

    return ok({ ok: true as const, entries })
  }),
)
