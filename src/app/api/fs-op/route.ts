/**
 * /api/fs-op — the mutating half of the chat file browser: create, rename,
 * duplicate and delete, inside one project working tree.
 *
 * SCOPE & SAFETY. Same shape as /api/list-dir and /api/copy-into: `cwd` is the
 * project root the user already opened and `rel` names an entry relative to it.
 * Every path this route touches is checked with the shared `withinCwd` guard
 * (src/lib/fsScope.ts) AFTER resolution, and every user-supplied NAME is checked
 * with `isSafeSegment` BEFORE it is joined — a name is not a path, so "new file"
 * can never be a way to write two directories up. Failures answer
 * `{ok:false, reason}` with HTTP 200, the value-not-error shape the sibling
 * routes use.
 *
 * NOTHING IS EVER OVERWRITTEN. mkdir/mkfile/rename refuse a name that already
 * exists (`reason:'exists'`) rather than replacing what is there; `duplicate`
 * walks to the first free ` copy` name. This mirrors /api/copy-into, which skips
 * rather than clobbers. There is no force flag, deliberately — a file browser
 * that can silently destroy a file on a typo is worse than one that says no.
 *
 * DELETE IS THE FALLBACK PATH, NOT THE PREFERRED ONE. In the Electron app the
 * renderer calls `naby.fsOps.trash()` instead, which moves the entry to the OS
 * trash and is recoverable. `action:'delete'` here is `fs.rm` — permanent — and
 * exists for the plain-browser shell where no trash bridge is available. The
 * project ROOT itself can never be the target of a delete.
 */
import { cp, mkdir, open, readdir, rename, rm, stat } from "fs/promises"
import { dirname, isAbsolute, join, resolve } from "path"
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { copySiblingName, isSafeSegment, withinCwd } from "../../../lib/fsScope"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const ACTIONS = ["mkdir", "mkfile", "rename", "duplicate", "delete"] as const
type Action = (typeof ACTIONS)[number]

interface Body {
  readonly cwd?: string
  readonly action?: string
  readonly rel?: string
  readonly name?: string
}

type Reason =
  | "invalid-cwd"
  | "invalid-action"
  | "invalid-name"
  | "invalid-target"
  | "escape"
  | "exists"
  | "not-found"
  | "failed"

const fail = (reason: Reason) => ok({ ok: false as const, reason })

/** Relative form of `abs` under `cwd`, with POSIX separators so it matches the
 *  `rel` strings the tree already holds. */
function relOf(cwd: string, abs: string): string {
  const base = resolve(cwd)
  return resolve(abs).slice(base.length + 1).split(/[\\/]/).join("/")
}

/** Does this path exist? A `stat` that throws means "no" — the overwhelmingly
 *  common throw here is ENOENT. An unreadable-but-present path would also read
 *  as "no", and that is harmless: the operation then goes on to fail on the
 *  syscall itself and is reported as `failed`, never as a silent overwrite
 *  (create uses 'wx', duplicate uses errorOnExist). */
const exists = (p: string) =>
  Effect.tryPromise({ try: () => stat(p).then(() => true), catch: () => false }).pipe(
    Effect.orElseSucceed(() => false),
  )

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as Body
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : ""
    const action = typeof body.action === "string" ? body.action : ""
    const rel = typeof body.rel === "string" ? body.rel.trim() : ""
    const name = typeof body.name === "string" ? body.name : ""

    if (!cwd || !isAbsolute(cwd)) return fail("invalid-cwd")
    if (!ACTIONS.includes(action as Action)) return fail("invalid-action")

    // The entry the action is ABOUT: for mkdir/mkfile the parent directory, for
    // the rest the item itself. Resolved and contained before anything reads it.
    const target = resolve(join(cwd, rel))
    if (!withinCwd(cwd, target)) return fail("escape")

    const needsName = action === "mkdir" || action === "mkfile" || action === "rename"
    if (needsName && !isSafeSegment(name)) return fail("invalid-name")

    switch (action as Action) {
      // -- create ------------------------------------------------------------
      case "mkdir":
      case "mkfile": {
        const created = join(target, name)
        // Belt and braces: the name was already refused if it carried a
        // separator, so this can only fail if that check ever regresses.
        if (!withinCwd(cwd, created)) return fail("escape")
        if (yield* exists(created)) return fail("exists")

        const done = yield* Effect.tryPromise({
          try: async () => {
            if (action === "mkdir") {
              // Not recursive: `rel` is an existing folder in the tree, so a
              // missing parent means the tree is stale, not that we should
              // invent directories the user did not ask for.
              await mkdir(created)
            } else {
              // 'wx' fails if the path exists — the create is atomic against a
              // file that appeared between the check above and here.
              const fh = await open(created, "wx")
              await fh.close()
            }
            return true
          },
          catch: () => false,
        }).pipe(Effect.orElseSucceed(() => false))
        if (!done) return fail("failed")
        return ok({ ok: true as const, rel: relOf(cwd, created) })
      }

      // -- rename ------------------------------------------------------------
      case "rename": {
        if (!rel) return fail("invalid-target") // the project root has no sibling
        if (!(yield* exists(target))) return fail("not-found")

        const renamed = join(dirname(target), name)
        if (!withinCwd(cwd, renamed)) return fail("escape")
        // Renaming to the same name is a no-op, not a collision.
        if (renamed !== target && (yield* exists(renamed))) return fail("exists")

        const done = yield* Effect.tryPromise({
          try: () => rename(target, renamed).then(() => true),
          catch: () => false,
        }).pipe(Effect.orElseSucceed(() => false))
        if (!done) return fail("failed")
        return ok({ ok: true as const, rel: relOf(cwd, renamed) })
      }

      // -- duplicate ---------------------------------------------------------
      case "duplicate": {
        if (!rel) return fail("invalid-target") // duplicating the root is not a file op
        const info = yield* Effect.tryPromise({
          try: () => stat(target),
          catch: () => null,
        }).pipe(Effect.orElseSucceed(() => null))
        if (!info) return fail("not-found")

        const parent = dirname(target)
        // One directory read decides every candidate, instead of a stat per try.
        const siblings = yield* Effect.tryPromise({
          try: () => readdir(parent),
          catch: () => null,
        }).pipe(Effect.orElseSucceed(() => null))
        if (!siblings) return fail("failed")
        const takenNames = new Set(siblings)

        const base = target.slice(parent.length + 1)
        const copyName = copySiblingName(base, info.isDirectory(), (c) => takenNames.has(c))
        if (!copyName) return fail("exists")

        const copyPath = join(parent, copyName)
        if (!withinCwd(cwd, copyPath)) return fail("escape")

        const done = yield* Effect.tryPromise({
          // errorOnExist + force:false is the same non-clobbering contract
          // /api/copy-into uses.
          try: () =>
            cp(target, copyPath, { recursive: true, errorOnExist: true, force: false }).then(
              () => true,
            ),
          catch: () => false,
        }).pipe(Effect.orElseSucceed(() => false))
        if (!done) return fail("failed")
        return ok({ ok: true as const, rel: relOf(cwd, copyPath) })
      }

      // -- delete (permanent; Electron uses the trash bridge instead) --------
      case "delete": {
        if (!rel) return fail("invalid-target") // never the project root
        if (!(yield* exists(target))) return fail("not-found")

        const done = yield* Effect.tryPromise({
          // `force:false` so a vanished entry is reported rather than silently
          // called a success; recursive because a folder row must be deletable.
          try: () => rm(target, { recursive: true, force: false }).then(() => true),
          catch: () => false,
        }).pipe(Effect.orElseSucceed(() => false))
        if (!done) return fail("failed")
        return ok({ ok: true as const, rel })
      }
    }
  }),
)
