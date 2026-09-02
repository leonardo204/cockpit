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
 *
 * `.git` IS ON THE LIST BUT IS NOT UNWATCHED. It is excluded from the TREE
 * watch, where its churn would be pure noise, and watched separately for the
 * four files that mean the file tree's colours are now wrong — see
 * `GIT_STATUS_SIGNAL_FILES` above.
 */
/**
 * The files inside the git directory whose change means "the status the tree is
 * showing is now wrong".
 *
 * WATCHING `.git` WHOLESALE IS NOT AN OPTION and that is why this list exists.
 * Git rewrites that directory constantly — every object written, every lock
 * taken and dropped, every reflog line — and a rebase would be a refresh storm.
 * These four are the ones that actually move the answer:
 *
 *   `index`        staging. `git add`, `git reset`, and a commit all rewrite it.
 *   `HEAD`         which commit the tree is measured against — a checkout or a
 *                  branch switch changes every file's status at once.
 *   `MERGE_HEAD`   a merge began or ended, which is when `conflicted` appears
 *                  and disappears.
 *   `ORIG_HEAD`    written by the operations that rewrite history (rebase,
 *                  reset --hard), which is the case where nothing else here is
 *                  a reliable signal that the dust has settled.
 *
 * `index.lock` IS DELIBERATELY ABSENT. It is created and deleted around every
 * one of those operations, so reacting to it would mean reading the status
 * mid-write — the one moment git's own answer is not to be trusted.
 */
export const GIT_STATUS_SIGNAL_FILES: ReadonlySet<string> = new Set([
  "index",
  "HEAD",
  "MERGE_HEAD",
  "ORIG_HEAD",
])

/** Does this filename, as reported by a watch on the git directory, mean the
 *  status should be re-read? `filename` may carry a subdirectory (`refs/heads/x`)
 *  on some platforms, so only a bare match counts — a ref file changing is
 *  always accompanied by one of the four above. */
export function isGitStatusSignal(filename: string): boolean {
  return GIT_STATUS_SIGNAL_FILES.has(filename)
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SECOND QUESTION: WHERE ARE THE BRANCHES, AND HOW FAR AHEAD ARE WE?
 *
 * The four files above answer the file tree's question — "is this path changed"
 * — and that is genuinely all they answer. The git PANEL asks two more, and the
 * four are silent on both. Measured, by watching a real repository while running
 * each command:
 *
 *   git branch <new>   touches ONLY refs/heads/<new>
 *   git branch -d      touches ONLY refs/heads/<name> and config
 *   git tag            touches ONLY refs/tags/<name>
 *   git fetch          touches ONLY FETCH_HEAD and refs/remotes/…
 *   git push           touches ONLY refs/remotes/…
 *   git remote add     touches ONLY config
 *   git gc / pack-refs touches ONLY packed-refs and every refs/… it folded in
 *
 * Not one of those writes `index` or `HEAD`. So a person who types `git fetch`
 * in a terminal — or an agent that does it for them — moves the panel's
 * ahead/behind counters and the panel is never told. It sits there showing a
 * number that was true a minute ago, which is worse than showing nothing.
 *
 * WHY IT IS A SEPARATE SIGNAL rather than four more entries in the set above:
 * these do not change any file's status, and waking the file tree to re-read a
 * status that cannot have moved would be paying its whole refresh for nothing.
 * Two questions, two signals, each sent to whoever asked it.
 */
export const GIT_REFS_SIGNAL_FILES: ReadonlySet<string> = new Set([
  // Written by every fetch, and by nothing else — the only flat file that moves
  // when a fetch brings new commits down.
  "FETCH_HEAD",
  // `git gc` and `pack-refs` fold every loose ref into this one file, after
  // which the individual `refs/…` paths are deleted rather than updated.
  "packed-refs",
  // Remotes live here, and so does branch tracking. `git remote add` writes
  // nothing else at all.
  "config",
])

/**
 * Does this filename mean the branches, remotes or tags moved?
 *
 * Accepts both shapes the watchers report: a bare flat filename from the watch
 * on the git directory itself, and a `heads/main`-style path from the recursive
 * watch on `refs/`.
 *
 * `packed-refs.new` IS EXCLUDED for the same reason `index.lock` is excluded
 * above: it is the temporary file `pack-refs` writes before renaming it into
 * place, so reacting to it means reading refs halfway through being rewritten.
 */
export function isGitRefsSignal(filename: string): boolean {
  if (filename.endsWith(".lock") || filename.endsWith(".new")) return false
  if (GIT_REFS_SIGNAL_FILES.has(filename)) return true
  // From the git-dir watch, a nested path arrives with its `refs/` prefix; from
  // the refs watch it arrives without one. Both are a ref moving.
  return filename.startsWith("refs/") || /^(heads|remotes|tags)\//.test(filename)
}

/**
 * How long to wait after a refs signal before re-reading.
 *
 * LONGER THAN THE STATUS WINDOW, because the operations behind it are burstier
 * by an order of magnitude: one `git fetch` on a busy repository rewrites every
 * remote-tracking ref it advanced, and `pack-refs` rewrites all of them at once.
 * None of that is urgent — nobody is watching a branch list for sub-second
 * latency — so the window is sized to collapse the whole burst into one read.
 */
export const GIT_REFS_COALESCE_MS = 800

/**
 * How long to wait after a git signal before re-reading.
 *
 * LONGER THAN THE TREE'S OWN COALESCING, on purpose. A single `git commit`
 * touches `index` and `HEAD` and `ORIG_HEAD` within milliseconds of each other,
 * and a rebase does it once per replayed commit. This is the window in which all
 * of that collapses into one re-read, and it is also long enough that the status
 * is read AFTER git has finished rather than during.
 */
export const GIT_SIGNAL_COALESCE_MS = 400

/**
 * Where a project's git directory actually is, given what `<root>/.git` contains.
 *
 * `.git` IS NOT ALWAYS A DIRECTORY, and this repository is its own proof: the
 * shell is a submodule, so `shell/.git` is a FILE reading
 *
 *     gitdir: ../.git/modules/shell
 *
 * The same shape appears for every linked worktree (`git worktree add`). Watching
 * the file itself would see nothing — git updates the real directory, not the
 * pointer — so a submodule would silently never refresh, which is precisely the
 * case a developer on this project would hit first.
 *
 * Pure: the caller does the reading and the existence check, so this is only the
 * parsing rule, and it can be tested without a filesystem.
 *
 * Returns null for anything it does not recognise. A pointer file it cannot parse
 * is better answered with "no git watch" than with a guessed path — the panel
 * still has its refresh button, and a watch on the wrong directory would be a
 * feature that reports someone else's commits.
 */
export function gitDirFromPointer(contents: string): string | null {
  const line = contents.split(/\r?\n/).find((l) => l.startsWith("gitdir:"))
  if (!line) return null
  const path = line.slice("gitdir:".length).trim()
  return path === "" ? null : path
}

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
