/**
 * /api/fs-op — the OS-side half of the chat file browser: create, rename,
 * duplicate and delete, plus open-with-default-app, reveal-in-file-manager and
 * read-file-text, inside one project working tree.
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
 *
 * OPEN AND REVEAL ARE FALLBACKS OF THE SAME KIND. The Electron bridge
 * (`naby.fsOps.open/reveal`) is preferred where it is visible, but the server
 * runs on the same machine as the files — this is a purely local app — so it
 * can hand a file to the OS default application or spring the file manager
 * itself, the way /api/pick-folder already runs the OS folder chooser. Without
 * this fallback the menu simply omitted both items wherever the bridge was
 * dark (a plain browser tab, and Windows builds where the subframe bridge does
 * not surface), which read as "Windows has no Open".
 *
 * READ IS THE ONLY ACTION THAT RETURNS FILE CONTENT, AND IT IS BOUNDED TWICE.
 * It exists so the in-app markdown viewer has a text source; it lives here
 * rather than in a route of its own so the containment guard above is not
 * written a second time. Two ceilings, because they answer different questions:
 * `PREVIEW_BYTES` is how much text a viewer may be handed at once (past it the
 * response carries `truncated:true` and the real `size`, so the UI can say so
 * instead of quietly showing a prefix as if it were the document), and
 * `MAX_READ_BYTES` is the point where a prefix stops being a useful stand-in
 * for the file at all and the honest answer is `too-large`. A directory is
 * refused: `readFile` on one throws EISDIR, and a folder has no text to show.
 *
 * READ DOES NOT SNIFF FOR BINARY. Deciding what is renderable belongs to the
 * caller — the file browser only asks for extensions it already knows are
 * markdown — and a byte-level heuristic here would just be a second, weaker
 * copy of that judgement.
 */
import { execFile, spawn } from "child_process"
import { cp, mkdir, open, readdir, rename, rm, stat } from "fs/promises"
import { basename, dirname, isAbsolute, join, resolve } from "path"
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { copySiblingName, isSafeSegment, withinCwd, wouldNestInSelf } from "../../../lib/fsScope"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const ACTIONS = ["mkdir", "mkfile", "rename", "duplicate", "move", "copy", "delete", "open", "reveal", "openWith", "read"] as const
type Action = (typeof ACTIONS)[number]

/** The most text one `read` ever returns. Beyond this the response is marked
 *  `truncated` — a viewer that renders 2 MiB of markdown is already past the
 *  point where anyone is reading it. */
const PREVIEW_BYTES = 2 * 1024 * 1024
/** Past this, a leading slice is no longer a usable stand-in for the file, so
 *  `read` refuses instead of handing back a misleading fragment. */
const MAX_READ_BYTES = 32 * 1024 * 1024

/**
 * Hand `abs` to the OS default application for its type. Resolves `false` when
 * the OS reports it could not — a missing handler, mostly.
 *
 * Windows goes through PowerShell rather than `cmd /c start`: `start` treats
 * its first QUOTED argument as a window title, so a path with spaces becomes
 * the title of nothing. `Invoke-Item -LiteralPath` takes the path literally and
 * exits non-zero when no application is associated, which is exactly the truth
 * the caller wants to report. (/api/pick-folder leans on PowerShell the same
 * way.) Single quotes in the path are doubled — that is PS's own escape for a
 * literal quote inside a single-quoted string.
 */
function openWithOs(abs: string): Promise<boolean> {
  return new Promise((done) => {
    if (process.platform === "win32") {
      const literal = abs.replace(/'/g, "''")
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", `Invoke-Item -LiteralPath '${literal}'`],
        (err) => done(!err),
      )
      return
    }
    const [file, args] =
      process.platform === "darwin" ? ["open", [abs]] : ["xdg-open", [abs]]
    execFile(file, args as string[], (err) => done(!err))
  })
}

/**
 * Open the OS file manager with `abs` selected — or its parent folder where
 * selection is not a thing (xdg-open has no select flag).
 *
 * FIRE-AND-FORGET, like the Electron bridge's `fs:reveal`: whether the user
 * then closes the window is not ours to report. It also cannot be awaited
 * honestly on Windows — `explorer.exe` exits 1 out of habit even when the
 * window opened, so an exit code here is noise, not a result. The 'error'
 * listener only swallows a missing binary (ENOENT) so nothing rejects.
 */
/**
 * Spring the OS's own "Open with…" chooser for `abs` — the escape hatch for a
 * file whose DEFAULT association is wrong, which is exactly when `open` above
 * launches the wrong thing.
 *
 * Returns `false` on a platform that has no such chooser (Linux has no
 * standard one), so the route can refuse honestly; the menu hides the item on
 * those clients anyway.
 *
 * FIRE-AND-FORGET past that point, same contract as `revealInOs`: the chooser
 * belongs to the user now, and "they pressed cancel" is not a failure to
 * report. Windows' rundll32 has no meaningful exit code, and osascript exits
 * non-zero on cancel — awaiting either would only manufacture false errors.
 * There is deliberately NO Electron-bridge twin for this: `shell` has no
 * open-with API, so main would spawn these same commands; the server is
 * equally local and already holds the containment check.
 */
function openWithChooser(abs: string): boolean {
  if (process.platform === "win32") {
    // The classic "How do you want to open this file?" dialog, association
    // checkbox included. Arguments as an array, so a path with spaces is one
    // argument and never becomes two.
    const child = spawn("rundll32.exe", ["shell32.dll,OpenAs_RunDLL", abs], { stdio: "ignore" })
    child.on("error", () => {})
    child.unref()
    return true
  }
  if (process.platform === "darwin") {
    // Finder's "Open With…", reconstructed: `choose application` is the OS
    // application picker (prompt left off so the OS localizes it), and Finder's
    // `open … using` is the canonical open-with verb. Backslashes and quotes in
    // the path are escaped for the AppleScript string literal; the path itself
    // was contained by `withinCwd` before this is ever built.
    const literal = abs.replace(/[\\"]/g, "\\$&")
    const script = `tell application "Finder" to open (POSIX file "${literal}" as alias) using (choose application)`
    const child = spawn("osascript", ["-e", script], { stdio: "ignore" })
    child.on("error", () => {})
    child.unref()
    return true
  }
  return false
}

function revealInOs(abs: string): void {
  const [file, args] =
    process.platform === "win32"
      ? ["explorer.exe", [`/select,${abs}`]]
      : process.platform === "darwin"
        ? ["open", ["-R", abs]]
        : ["xdg-open", [dirname(abs)]]
  const child = spawn(file, args as string[], { stdio: "ignore" })
  child.on("error", () => {})
  child.unref()
}

interface Body {
  readonly cwd?: string
  readonly action?: string
  readonly rel?: string
  readonly name?: string
  /** `move` / `copy` only: the DESTINATION DIRECTORY, project-relative. The
   *  empty string is the project root, which is a legal destination — unlike
   *  `rel`, where it means "the project itself" and every mutating action
   *  refuses it. */
  readonly destRel?: string
}

type Reason =
  | "invalid-cwd"
  | "invalid-action"
  | "invalid-name"
  | "invalid-target"
  | "escape"
  | "exists"
  | "not-found"
  | "too-large"
  /** The destination is not a directory, so nothing can be put in it. */
  | "dest-not-dir"
  /** The destination is the source itself or somewhere inside it. Its own
   *  reason because it is the one refusal a user might otherwise read as a bug:
   *  the drag looked legal and both paths are in the project. */
  | "nest-in-self"
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
    const destRel = typeof body.destRel === "string" ? body.destRel.trim() : ""

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

      // -- move / copy -------------------------------------------------------
      //
      // ONE ITEM PER REQUEST, like every other action here. A multi-select paste
      // is N requests, which is what lets each one come back with its OWN reason
      // — "three moved, this one collided, that one vanished" — instead of a
      // single verdict over a batch where the interesting part is which member
      // failed and why.
      //
      // The two share everything except the last syscall, so they share a block:
      // a copy that validated differently from a move is a copy that could reach
      // somewhere a move could not.
      case "move":
      case "copy": {
        if (!rel) return fail("invalid-target") // the project root moves nowhere
        if (!(yield* exists(target))) return fail("not-found")

        // The DESTINATION DIRECTORY. `destRel: ""` is the project root, which is
        // a legal place to drop something — the only action here for which the
        // empty string is not a refusal.
        const destDir = resolve(join(cwd, destRel))
        if (!withinCwd(cwd, destDir)) return fail("escape")

        const destInfo = yield* Effect.tryPromise({
          try: () => stat(destDir),
          catch: () => null,
        }).pipe(Effect.orElseSucceed(() => null))
        if (!destInfo) return fail("not-found")
        if (!destInfo.isDirectory()) return fail("dest-not-dir")

        // INTO ITSELF. Checked before anything is touched, because the failure
        // it prevents is unbounded: `cp -r` of a folder into its own descendant
        // recurses until the disk fills, and it is a gesture a user can make by
        // accident in one drag.
        if (wouldNestInSelf(target, destDir)) return fail("nest-in-self")

        const landing = join(destDir, basename(target))
        if (!withinCwd(cwd, landing)) return fail("escape")

        // ALREADY THERE. For a move this is also the "dropped it back where it
        // came from" case, which is a no-op rather than a collision — reporting
        // `exists` for a drag that changed nothing would be a refusal the user
        // cannot act on.
        if (landing === target) return ok({ ok: true as const, rel })
        if (yield* exists(landing)) return fail("exists")

        const done = yield* Effect.tryPromise({
          try: () =>
            (action === "move"
              ? rename(target, landing)
              : // errorOnExist + force:false is the same non-clobbering contract
                // `duplicate` and /api/copy-into use. The `exists` check above is
                // the answer the user gets; this is what makes the race safe.
                cp(target, landing, { recursive: true, errorOnExist: true, force: false })
            ).then(() => true),
          catch: () => false,
        }).pipe(Effect.orElseSucceed(() => false))
        // A cross-device move fails here (EXDEV) rather than silently becoming a
        // copy-then-delete: a half-finished fallback is how a move loses a file,
        // and inside one project tree this does not arise.
        if (!done) return fail("failed")
        return ok({ ok: true as const, rel: relOf(cwd, landing) })
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

      // -- open / openWith / reveal (fallbacks; Electron prefers the bridge) --
      case "open":
      case "openWith": {
        if (!rel) return fail("invalid-target") // "open the root" is what reveal is for
        const info = yield* Effect.tryPromise({
          try: () => stat(target),
          catch: () => null,
        }).pipe(Effect.orElseSucceed(() => null))
        if (!info) return fail("not-found")
        // A directory never reaches the OS from here: `open` on a folder would
        // spring a file-manager window on someone who meant to expand the row,
        // and a folder has no application association to re-pick.
        // Same rule as the menu and the double-click handler.
        if (info.isDirectory()) return fail("invalid-target")

        if (action === "openWith") {
          const sprung = yield* Effect.sync(() => openWithChooser(target))
          if (!sprung) return fail("failed") // no chooser on this OS
          return ok({ ok: true as const, rel })
        }

        const done = yield* Effect.tryPromise({
          try: () => openWithOs(target),
          catch: () => false,
        }).pipe(Effect.orElseSucceed(() => false))
        if (!done) return fail("failed")
        return ok({ ok: true as const, rel })
      }

      // -- read (the in-app viewer's text source) ----------------------------
      case "read": {
        if (!rel) return fail("invalid-target") // the project root is a directory
        const info = yield* Effect.tryPromise({
          try: () => stat(target),
          catch: () => null,
        }).pipe(Effect.orElseSucceed(() => null))
        if (!info) return fail("not-found")
        if (info.isDirectory()) return fail("invalid-target")
        if (info.size > MAX_READ_BYTES) return fail("too-large")

        const truncated = info.size > PREVIEW_BYTES
        const text = yield* Effect.tryPromise({
          // A POSITIONAL read, not `readFile`: the cap has to bound what is
          // pulled off disk, not merely what is sent, or a 30 MiB file would
          // still be materialised in full to hand back 2 MiB of it.
          try: async () => {
            const fh = await open(target, "r")
            try {
              const cap = Math.min(info.size, PREVIEW_BYTES)
              const buf = Buffer.alloc(cap)
              const { bytesRead } = await fh.read(buf, 0, cap, 0)
              return buf.subarray(0, bytesRead).toString("utf8")
            } finally {
              await fh.close()
            }
          },
          catch: () => null,
        }).pipe(Effect.orElseSucceed(() => null))
        if (text === null) return fail("failed")

        return ok({
          ok: true as const,
          rel,
          // A cut at a byte offset can land mid-codepoint, and Node renders that
          // dangling tail as U+FFFD. Dropping it only in the truncated case
          // keeps an intact file byte-for-byte what it is on disk.
          content: truncated ? text.replace(/\uFFFD+$/, "") : text,
          truncated,
          size: info.size,
        })
      }

      case "reveal": {
        // The root IS revealable — "show me this project in the file manager"
        // — so no `!rel` refusal here, unlike every mutating action above.
        if (!(yield* exists(target))) return fail("not-found")
        yield* Effect.sync(() => revealInOs(target))
        return ok({ ok: true as const, rel })
      }
    }
  }),
)
