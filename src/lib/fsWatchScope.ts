/**
 * fsWatchScope.ts — the decisions behind the project file watcher, as pure
 * functions.
 *
 * WHY THEY LIVE HERE AND NOT IN THE HANDLER. Everything the watcher can get
 * wrong in a way a user would notice is a decision, not IO: which events are
 * noise, which directory an event means, how a burst collapses into one
 * refresh, and whether this platform can watch recursively at all. Expressed
 * only inside an `fs.watch` callback, none of it is reachable by a test — the
 * same reasoning that put the file browser's menu rules in fileBrowserOps.ts.
 * The handler (effect/fileWatchHandler.ts) is left with wiring.
 *
 * Kept stdlib-free and Effect-free, like its neighbour fsScope.ts: these are
 * string computations, so they are unit-testable without a runtime.
 */

/**
 * Directories whose contents are never worth a refresh.
 *
 * THIS LIST IS WHAT MAKES THE FEATURE USABLE. `fs.watch(root, {recursive:true})`
 * reports every descendant, so one `npm install` emits tens of thousands of
 * events and a webpack build emits thousands more — each one otherwise costing a
 * `/api/list-dir` round trip and a React re-render. Unfiltered, a watcher is
 * worse than no watcher.
 *
 * Matching is on a WHOLE PATH SEGMENT (see `isIgnoredWatchPath`), so a file
 * genuinely called `node_modules_notes.md` or `my.git.md` is not caught by it.
 *
 * The cost of the list is real and accepted: a build that writes into `dist`
 * does not auto-refresh, and neither does `node_modules` appearing or being
 * deleted. That is what the panel's manual refresh button is for, and it is why
 * that button stays.
 */
export const WATCH_IGNORED_DIRS: ReadonlySet<string> = new Set([
  // Package managers and VCS — the two loudest sources by orders of magnitude.
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  // Build output and framework caches.
  "dist",
  "build",
  "out",
  ".next",
  ".next-prod",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".vite",
  ".svelte-kit",
  ".nuxt",
  "target",
  ".gradle",
  // Test / coverage caches.
  "coverage",
  ".nyc_output",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  // Python.
  "__pycache__",
  ".venv",
  "venv",
  // Editors that rewrite their own state on every keystroke.
  ".idea",
])

/**
 * Files that are pure OS/editor bookkeeping. Exact names only — a suffix rule
 * here would be the thing that quietly swallows a real file.
 */
export const WATCH_IGNORED_FILES: ReadonlySet<string> = new Set([
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
])

/**
 * How long a burst is collected before one refresh goes out, in ms.
 *
 * A single save is rarely one event: editors write, rename a temp file over the
 * target, then touch attributes, and `fs.watch` reports each. 300ms is wide
 * enough to swallow that whole sequence (and the several files a formatter
 * rewrites on save), while staying under the ~400ms where a UI update stops
 * reading as a consequence of what you just did. It is the same window
 * globalStateHandler settled on for the same reason.
 */
export const WATCH_COALESCE_MS = 300

/**
 * The most events one window collects before it flushes early.
 *
 * A ceiling, not a target: it bounds the work of a single coalescing pass when
 * something the ignore list does not know about goes loud, rather than letting
 * one window grow without limit.
 */
export const WATCH_BATCH_MAX = 1000

/**
 * A path that is absolute on ANY platform we run on.
 *
 * The names `fs.watch` reports are relative to the watch root, so an absolute
 * one means something is wrong with our assumptions and it is refused rather
 * than resolved. The drive-letter branch requires a following separator, so a
 * POSIX file literally named `C:notes` is still treated as a relative name.
 */
const ABSOLUTE_PATH = /^(?:[/\\]|[A-Za-z]:[/\\])/

/** Split a watch-reported name into segments, accepting either separator —
 *  Windows reports `src\a\b.ts`. `.` segments carry no meaning and are dropped. */
function segmentsOf(relPath: string): string[] {
  return relPath.split(/[/\\]+/).filter((s) => s !== "" && s !== ".")
}

/**
 * Is this path inside (or itself) something we deliberately do not watch?
 *
 * Segment-exact on purpose: `node_modules/react/index.js` is ignored at any
 * depth, and so is a bare `node_modules`, but `node_modules_notes.md` and
 * `my.git.md` are ordinary files and must survive.
 */
export function isIgnoredWatchPath(relPath: string): boolean {
  const segments = segmentsOf(relPath)
  if (segments.length === 0) return false
  const last = segments[segments.length - 1]
  if (WATCH_IGNORED_FILES.has(last)) return true
  return segments.some((s) => WATCH_IGNORED_DIRS.has(s))
}

/**
 * The directory whose LISTING changed, given the name `fs.watch` reported.
 *
 * The tree renders directories, so a change to `src/a/b.ts` is a change to the
 * listing of `src/a` — not of the project root, and not of `b.ts`. Returning
 * the precise parent is what keeps a burst from re-fetching the whole visible
 * tree. `''` is the project root itself.
 *
 * `null` means "no refresh": an ignored path, a name that escapes the project
 * (`..` or an absolute path — the watch root is the trust boundary and nothing
 * outside it may be named), or no name at all. Some platforms report a null
 * filename; without one we cannot tell whether the event came from an ignored
 * subtree, and a bump we cannot attribute is exactly the unfiltered noise the
 * ignore list exists to prevent.
 */
export function changedDirOf(filename: string | null | undefined): string | null {
  if (!filename) return null
  if (ABSOLUTE_PATH.test(filename)) return null
  const segments = segmentsOf(filename)
  if (segments.length === 0) return null
  if (segments.includes("..")) return null
  if (isIgnoredWatchPath(filename)) return null
  segments.pop()
  return segments.join("/")
}

/**
 * One window of raw event names → the directories to refresh, at most once each.
 *
 * This is the coalescing rule: a save that fires five events in one directory is
 * one refresh, and two files touched in the same directory are also one. Order
 * is first-seen so the refresh sequence follows the events that caused it.
 */
export function coalesceChangedDirs(
  filenames: ReadonlyArray<string | null | undefined>,
): string[] {
  const seen = new Set<string>()
  const dirs: string[] = []
  for (const filename of filenames) {
    const dir = changedDirOf(filename)
    if (dir === null || seen.has(dir)) continue
    seen.add(dir)
    dirs.push(dir)
  }
  return dirs
}

/**
 * Can this host watch a whole tree with one watcher?
 *
 * PER PLATFORM:
 *   - macOS (`darwin`) and Windows (`win32`): yes, always — the OS provides
 *     FSEvents / ReadDirectoryChangesW and Node has exposed them for years.
 *   - Linux: only on Node 20.13+ or 22+. `recursive: true` throws
 *     `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` on anything older, and this shell
 *     declares `engines.node >= 20`, so older-20 and 21.x are inside the
 *     supported range and must be answered honestly rather than crashed into.
 *   - Anything else: assumed no.
 *
 * A `false` here is not an error. The caller sends `fs-watch-unavailable` and
 * the panel goes on working exactly as it did before this feature existed:
 * self-refresh after its own mutations, plus the manual refresh button. The
 * caller ALSO guards the `watch()` call itself, because this predicate is a
 * claim about the platform and the call is the fact.
 */
export function supportsRecursiveWatch(
  platform: string,
  nodeVersion: string,
): boolean {
  if (platform === "darwin" || platform === "win32") return true
  if (platform !== "linux") return false
  const parsed = /^v?(\d+)\.(\d+)\./.exec(nodeVersion)
  if (!parsed) return false
  const major = Number(parsed[1])
  const minor = Number(parsed[2])
  if (major >= 22) return true
  if (major === 20) return minor >= 13
  return false
}
