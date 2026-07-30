/**
 * fsScope.ts — the containment rule shared by every project-scoped fs route.
 *
 * WHY IT IS HERE AND NOT COPIED A THIRD TIME. `/api/list-dir` and
 * `/api/copy-into` each carried their own `withinCwd()`. Two copies of a
 * security check is a smell; three (once `/api/fs-op` arrived, which WRITES and
 * DELETES) is a liability — the day one copy is relaxed, the other two still
 * read as if the rule held. The rule now has one definition, and the routes
 * that must not be escaped all import it.
 *
 * The contract is unchanged from the copies it replaces: a target is acceptable
 * only if it is the project root itself or strictly inside it. `..` that walks
 * out, an absolute `rel`, and a sibling directory whose name merely starts with
 * the root's name (`/work/proj-old` against `/work/proj`) are all refused — the
 * `+ sep` in the prefix test is what stops the last one.
 *
 * Kept stdlib-only and free of Effect: these are pure path computations, so
 * they are unit-testable without a runtime and safe to call from anywhere on
 * the server.
 */
import { extname, resolve, sep } from "path"

/** The target must be the project root itself or strictly inside it — never a
 *  sibling or ancestor reached via `..`. */
export function withinCwd(cwd: string, target: string): boolean {
  const base = resolve(cwd)
  const t = resolve(target)
  return t === base || t.startsWith(base + sep)
}

/**
 * A single path segment the user typed (a new name, a rename target).
 *
 * Refused: empty/whitespace, `.` and `..`, anything carrying a separator, and
 * NUL. `withinCwd` would catch an escape anyway, but a name is not a path —
 * "new file" must not be a way to write two directories up, and refusing the
 * shape is a clearer answer than resolving it and then rejecting the result.
 */
export function isSafeSegment(name: string): boolean {
  if (!name || name.trim() !== name) return false
  if (name === "." || name === "..") return false
  if (name.includes("/") || name.includes("\\")) return false
  if (name.includes("\0")) return false
  return true
}

/**
 * Finder's duplicate naming, applied to the candidate list rather than to the
 * disk: `report.txt` → `report copy.txt` → `report copy 2.txt` → …, and for a
 * directory (no extension split) `src` → `src copy` → `src copy 2`.
 *
 * `taken` answers "does this sibling already exist?". The caller drives it from
 * `stat`, so the search never clobbers — it walks until it finds a free name.
 * The extension is preserved because a duplicate that loses `.txt` stops
 * opening in the same app, which is the whole point of duplicating a file.
 */
export function copySiblingName(
  name: string,
  isDir: boolean,
  taken: (candidate: string) => boolean,
): string | null {
  // Directories keep their whole name; `node_modules.bak` is not an extension
  // anyone wants moved to the end. Dotfiles (`.env`) are all "extension" to
  // `extname`, so they are treated as a bare stem too.
  const ext = isDir || name.startsWith(".") ? "" : extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name

  for (let n = 1; n <= 1000; n++) {
    const suffix = n === 1 ? " copy" : ` copy ${n}`
    const candidate = `${stem}${suffix}${ext}`
    if (!taken(candidate)) return candidate
  }
  // A thousand duplicates of one file is not a case worth inventing a name for.
  return null
}
