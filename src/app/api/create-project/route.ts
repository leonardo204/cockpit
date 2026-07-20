/**
 * /api/create-project
 *
 * Creates a new project directory and returns its absolute path, so the home
 * screen's "Create" affordance means something concrete: pick a location with
 * the OS folder picker (/api/pick-folder), name the folder, get an empty
 * directory back, and open it as a project.
 *
 * OUTCOMES ARE VALUES, NOT ERRORS. A name that collides with an existing
 * non-empty folder, or one containing a path separator, is a normal thing for a
 * user to type — it is answered with `{ok:false, reason}` and HTTP 200, the
 * same shape /api/note uses for a save conflict. HTTP failures stay reserved
 * for genuine faults (unreadable parent, fs error), which `handler` maps for us.
 *
 * WHAT IT WILL NOT DO: it creates ONE directory inside a parent the user just
 * picked in a native dialog. It never recurses, never overwrites, never deletes,
 * and refuses anything that would escape the picked parent — the request body
 * carries a name, not a path.
 */
import { mkdir, readdir, stat } from "fs/promises"
import { dirname, isAbsolute, join, resolve } from "path"
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError } from "@cockpit/effect-core"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface CreateProjectBody {
  /** Absolute path of the directory to create inside — comes from the native picker. */
  readonly parent?: string
  /** A single path component. Separators and `..` are rejected, not sanitised. */
  readonly name?: string
}

type Reason =
  | "invalid-parent"
  | "parent-missing"
  | "invalid-name"
  | "exists"

const nameIsSafe = (name: string): boolean => {
  if (name.length === 0 || name.length > 255) return false
  // A NAME, not a path: no separators, no traversal, no leading dash (which
  // reads as a flag to half the tools that will later be run in this folder),
  // no control characters.
  if (/[/\\]/.test(name)) return false
  if (name === "." || name === "..") return false
  if (name.startsWith("-")) return false
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) return false
  return true
}

const fail = (reason: Reason) => ok({ ok: false as const, reason })

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as CreateProjectBody
    const parent = typeof body.parent === "string" ? body.parent.trim() : ""
    const name = typeof body.name === "string" ? body.name.trim() : ""

    if (!parent || !isAbsolute(parent)) return fail("invalid-parent")
    if (!nameIsSafe(name)) return fail("invalid-name")

    const target = resolve(join(parent, name))
    // Belt and braces over `nameIsSafe`: the created directory must sit
    // DIRECTLY inside the parent the user picked.
    if (dirname(target) !== resolve(parent)) return fail("invalid-name")

    const parentStat = yield* Effect.tryPromise({
      try: () => stat(parent).then((s) => (s.isDirectory() ? s : null)),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null))
    if (!parentStat) return fail("parent-missing")

    // An existing EMPTY directory is a perfectly good new project — the picker
    // lets people create folders too, and refusing one they just made would be
    // pedantic. An existing non-empty one is refused: "create" must not adopt
    // someone else's files by accident.
    const existing = yield* Effect.tryPromise({
      try: () => readdir(target).then((entries) => ({ found: true, empty: entries.length === 0 })),
      catch: () => ({ found: false, empty: false }),
    }).pipe(Effect.orElseSucceed(() => ({ found: false, empty: false })))

    if (existing.found) {
      if (!existing.empty) return fail("exists")
      return ok({ ok: true as const, path: target })
    }

    yield* Effect.tryPromise({
      try: () => mkdir(target, { recursive: false }),
      catch: (cause) => new FSError({ path: target, op: "write", cause }),
    })

    return ok({ ok: true as const, path: target })
  })
)
