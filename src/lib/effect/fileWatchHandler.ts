/**
 * handleFileWatch — Effect-based WebSocket handler for /ws/fs-watch.
 *
 * WHAT IT IS FOR. The file browser panel used to refresh only after its OWN
 * mutations, so anything the agent wrote, a build produced, or a terminal
 * created stayed invisible until someone pressed refresh. This channel reports
 * "these directories changed" for ONE open project; the panel bumps exactly
 * those directories through the per-directory refresh nonce it already has.
 *
 * It follows globalStateHandler beat for beat, because it is the same shape:
 *   - `acquireRelease` wraps the `fs.watch` subscription, so the Scope — and
 *     therefore the socket — owns its lifetime. Closing the app, switching
 *     projects, or dropping the connection cannot leak a watcher.
 *   - `Stream.groupedWithin` coalesces a burst into one message per window.
 *   - `Schedule.spaced` drives the heartbeat.
 *   - Failures flow as Tagged Errors (WSError); no bare try/catch, no
 *     setInterval.
 *
 * IT COALESCES RATHER THAN DEBOUNCES. `Stream.debounce` keeps only the LAST
 * event of a burst, which is right for a trigger that means "rebuild the whole
 * snapshot" (what globalStateHandler does) and wrong here: each event names a
 * different directory, and dropping the others would drop those refreshes.
 * `groupedWithin` keeps the whole window and `coalesceChangedDirs` reduces it
 * to one entry per directory.
 *
 * WHAT IT REFUSES. `cwd` arrives from the client, so it is the same trust
 * boundary `/api/fs-op` guards — see `resolveWatchRoot`. A refusal is not an
 * error: the client is told the watcher is unavailable and the panel keeps
 * working exactly as it did before this channel existed.
 */
import { watch, statSync, type FSWatcher } from "fs"
import { readFile, stat } from "fs/promises"
import { isAbsolute, join, resolve } from "path"
import { Chunk, Duration, Effect, Queue, Schedule, Scope, Stream } from "effect"
import type { WebSocket } from "ws"
import type { WSError } from "@cockpit/effect-core"
import type { WSConnection } from "@cockpit/effect-services"
import { fromWebSocket } from "@cockpit/effect-runtime/server"
import { getStore } from "@cockpit/feature-agent/server/engines/naby"
import {
  GIT_REFS_COALESCE_MS,
  GIT_SIGNAL_COALESCE_MS,
  WATCH_BATCH_MAX,
  WATCH_COALESCE_MS,
  coalesceChangedDirs,
  gitDirFromPointer,
  isGitRefsSignal,
  isGitStatusSignal,
  supportsRecursiveWatch,
} from "../fsWatchScope"

const HEARTBEAT = Schedule.spaced("30 seconds")

/** Why no watcher is running. The client only needs to know that it is on its
 *  own; the distinction is for the log and for a future settings hint. */
type UnavailableReason = "invalid-cwd" | "unsupported"

/**
 * The directory this connection is allowed to watch, or null.
 *
 * `cwd` IS CLIENT INPUT. An arbitrary absolute path must never become a watch
 * target: watching is a standing resource on the server, and the change
 * messages would leak the names of files outside any project the user opened.
 * Three conditions, cheapest first — absolute, an existing directory, and a
 * project the app actually has open.
 *
 * The last check reads the same `projects` table `/api/projects` serves, via
 * `getStore()`. That is not a new dependency for the WS layer: this bundle
 * already loads the store through globalStateHandler's snapshot, so the check
 * costs one indexed read on connect and nothing after. Comparison is on
 * `resolve()`d strings rather than realpaths — a project reached through a
 * symlink simply falls back to manual refresh instead of being watched under a
 * name the client never used.
 *
 * A project that is open in the UI but not yet persisted (the beat between
 * "create" and its save) also lands here as null, and gets the manual refresh
 * button until it is saved. Refusing to watch is always the safe answer.
 */
const resolveWatchRoot = (cwd: string): Effect.Effect<string | null> =>
  Effect.try({
    try: (): string | null => {
      const raw = cwd.trim()
      if (!raw || !isAbsolute(raw)) return null
      const root = resolve(raw)
      if (!statSync(root).isDirectory()) return null
      const known = getStore()
        .listProjects()
        .some((p) => resolve(p.cwd) === root)
      return known ? root : null
    },
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => null))

/** Close a watcher without caring whether it was already closed. */
const closeQuietly = (watcher: FSWatcher | null): Effect.Effect<void> =>
  Effect.try({
    try: () => {
      watcher?.close()
    },
    catch: () => null,
  }).pipe(Effect.ignore)

/**
 * Start one recursive watcher over the project tree, or answer null.
 *
 * TWO GUARDS, DELIBERATELY. `supportsRecursiveWatch` is a claim about the
 * platform (macOS and Windows always; Linux only on Node 20.13+/22+) and
 * `Effect.try` is the fact — a host that throws
 * ERR_FEATURE_UNAVAILABLE_ON_PLATFORM, or hits an inotify watch limit, must
 * degrade rather than take the panel down with it.
 *
 * The 'error' listener CLOSES the watcher instead of leaving it armed. When the
 * project tree is deleted or renamed out from under us the OS keeps reporting
 * the failure, and a watcher that re-fires forever is the spin this feature must
 * never become. The socket stays up on its heartbeat and the panel keeps its
 * manual refresh.
 */
const openWatcher = (
  root: string,
  events: Queue.Queue<string>,
): Effect.Effect<FSWatcher | null> => {
  if (!supportsRecursiveWatch(process.platform, process.version)) {
    return Effect.succeed(null)
  }
  return Effect.try({
    try: (): FSWatcher =>
      watch(root, { recursive: true }, (_event, filename) => {
        // Buffer filenames (no encoding given) and the null the platform sends
        // when it cannot name the entry are both dropped here rather than
        // guessed at; fsWatchScope explains why an unattributable event is
        // worse than a missed one.
        if (typeof filename === "string") {
          Effect.runFork(Queue.offer(events, filename))
        }
      }),
    catch: () => null,
  }).pipe(
    Effect.tap((watcher) =>
      Effect.sync(() => {
        watcher.on("error", () => Effect.runSync(closeQuietly(watcher)))
      }),
    ),
    Effect.orElseSucceed(() => null),
  )
}

/**
 * WHERE THIS PROJECT'S GIT DIRECTORY IS, or null when it has none.
 *
 * `<root>/.git` IS NOT ALWAYS A DIRECTORY. In a submodule or a linked worktree
 * it is a FILE holding `gitdir: <path>`, and this repository is its own example
 * — `shell/.git` is one. Watching the pointer would see nothing at all, because
 * git updates the real directory and never the file, so a submodule would
 * silently never refresh: exactly the case a developer here would hit first.
 */
const resolveGitDir = (root: string): Effect.Effect<string | null> =>
  Effect.tryPromise({
    try: async (): Promise<string | null> => {
      const dotGit = join(root, ".git")
      const info = await stat(dotGit)
      if (info.isDirectory()) return dotGit
      if (!info.isFile()) return null
      const pointed = gitDirFromPointer(await readFile(dotGit, "utf8"))
      if (!pointed) return null
      // Relative pointers are relative to the project root, not to the cwd of
      // whatever process is reading them.
      const resolved = isAbsolute(pointed) ? pointed : resolve(root, pointed)
      const target = await stat(resolved)
      return target.isDirectory() ? resolved : null
    },
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => null))

/**
 * A SECOND, NARROW WATCHER — on the git directory, non-recursively.
 *
 * The tree watch excludes `.git` and must keep excluding it: git rewrites that
 * directory constantly, and a rebase through the recursive watcher would be a
 * refresh storm. But a `git add` or `commit` run in a terminal changes NOTHING
 * in the working tree, so without this the file panel's colours would stay wrong
 * until the user pressed refresh — which is not a feature, it is a gap the user
 * has to know about.
 *
 * Non-recursive, and filtered to four filenames (`GIT_STATUS_SIGNAL_FILES`), so
 * the object writes and lock churn that made the wholesale watch impossible are
 * never seen at all.
 *
 * Missing git is not a failure: a project without version control simply gets no
 * watcher, and the panel shows no colours to keep fresh.
 */
const openGitWatcher = (
  gitDir: string,
  signals: Queue.Queue<string>,
  refsSignals: Queue.Queue<string>,
): Effect.Effect<FSWatcher | null> =>
  Effect.try({
    try: (): FSWatcher =>
      watch(gitDir, { recursive: false }, (_event, filename) => {
        if (typeof filename !== "string") return
        if (isGitStatusSignal(filename)) {
          Effect.runFork(Queue.offer(signals, filename))
        }
        // A FILENAME CAN BE BOTH, and neither branch is an `else`. On the
        // platforms that report nested paths from a non-recursive watch, a
        // `refs/heads/x` write arrives here as well as at the refs watcher; and
        // `config` is a refs signal that is not a status one. Routing by
        // question rather than by first match is what keeps a fetch from being
        // swallowed because something else matched first.
        if (isGitRefsSignal(filename)) {
          Effect.runFork(Queue.offer(refsSignals, filename))
        }
      }),
    catch: () => null,
  }).pipe(
    Effect.tap((watcher) =>
      Effect.sync(() => {
        watcher.on("error", () => Effect.runSync(closeQuietly(watcher)))
      }),
    ),
    Effect.orElseSucceed(() => null),
  )

/**
 * A THIRD WATCHER — on `<gitDir>/refs`, recursively.
 *
 * The git-dir watch above is deliberately NON-recursive, and must stay that way:
 * recursing there means watching `objects/`, where git writes a file per blob,
 * and `logs/`, which every ref update appends to. That was the storm the narrow
 * watch was built to avoid.
 *
 * But `refs/` is where branches, tags and remote-tracking refs actually live,
 * and a non-recursive watch on the parent cannot see inside it on most
 * platforms. So `refs/` gets its own recursive watch: it holds no objects, no
 * logs and no locks worth speaking of — a few dozen tiny files whose changes are
 * exactly the events the panel needs and nothing else.
 *
 * Failure is not an error. A repository whose refs are entirely packed may have
 * an almost-empty `refs/`, and `packed-refs` is caught by the flat watch above;
 * a platform that refuses the recursive watch simply falls back to that.
 */
const openRefsWatcher = (
  gitDir: string,
  refsSignals: Queue.Queue<string>,
): Effect.Effect<FSWatcher | null> =>
  Effect.try({
    try: (): FSWatcher =>
      watch(join(gitDir, "refs"), { recursive: true }, (_event, filename) => {
        // Paths arrive relative to `refs/` here (`heads/main`), which
        // `isGitRefsSignal` accepts alongside the `refs/`-prefixed form.
        if (typeof filename === "string" && isGitRefsSignal(filename)) {
          Effect.runFork(Queue.offer(refsSignals, filename))
        }
      }),
    catch: () => null,
  }).pipe(
    Effect.tap((watcher) =>
      Effect.sync(() => {
        watcher.on("error", () => Effect.runSync(closeQuietly(watcher)))
      }),
    ),
    Effect.orElseSucceed(() => null),
  )

const watchGitDir = (
  gitDir: string,
  signals: Queue.Queue<string>,
  refsSignals: Queue.Queue<string>,
): Effect.Effect<boolean, never, Scope.Scope> =>
  Effect.acquireRelease(openGitWatcher(gitDir, signals, refsSignals), closeQuietly).pipe(
    Effect.map((watcher) => watcher !== null),
  )

const watchGitRefs = (
  gitDir: string,
  refsSignals: Queue.Queue<string>,
): Effect.Effect<boolean, never, Scope.Scope> =>
  Effect.acquireRelease(openRefsWatcher(gitDir, refsSignals), closeQuietly).pipe(
    Effect.map((watcher) => watcher !== null),
  )

/** The watcher as a scoped resource: true when one is running. */
const watchTree = (
  root: string,
  events: Queue.Queue<string>,
): Effect.Effect<boolean, never, Scope.Scope> =>
  Effect.acquireRelease(openWatcher(root, events), closeQuietly).pipe(
    Effect.map((watcher) => watcher !== null),
  )

/**
 * Tell the client it is on its own, then park.
 *
 * PARK, DO NOT RETURN. Ending the program would close the socket, the client's
 * shared-connection pool would reconnect, and an unwatchable project would
 * become a reconnect loop — the exact spin the degradation path exists to
 * avoid. Parked, the connection costs one heartbeat and is released with the
 * Scope when the panel closes.
 */
const parkUnavailable = (
  conn: WSConnection,
  reason: UnavailableReason,
): Effect.Effect<never, WSError> =>
  conn.send({ type: "fs-watch-unavailable", reason }).pipe(Effect.zipRight(Effect.never))

export const handleFileWatch = (
  conn: WSConnection,
  cwd: string,
): Effect.Effect<void, WSError, Scope.Scope> =>
  Effect.gen(function* () {
    yield* Effect.forkScoped(Effect.repeat(conn.send({ type: "ping" }), HEARTBEAT))

    const root = yield* resolveWatchRoot(cwd)
    if (root === null) return yield* parkUnavailable(conn, "invalid-cwd")

    const events = yield* Queue.unbounded<string>()
    const watching = yield* watchTree(root, events)
    if (!watching) return yield* parkUnavailable(conn, "unsupported")

    yield* conn.send({ type: "fs-watch-ready" })

    // THE GIT SIGNAL, ON ITS OWN CHANNEL. It is a separate message from
    // `fs-change` because it means a different thing: no directory listing has
    // changed, only the colours have. Sending it as a directory bump would make
    // the tree re-fetch every expanded folder to learn something none of them
    // can tell it.
    //
    // Forked, so a project with no repository (or a watch that could not be
    // opened) simply contributes nothing while the tree watch runs on.
    const gitDir = yield* resolveGitDir(root)
    if (gitDir !== null) {
      const signals = yield* Queue.unbounded<string>()
      const refsSignals = yield* Queue.unbounded<string>()
      const watchingGit = yield* watchGitDir(gitDir, signals, refsSignals)
      if (watchingGit) {
        yield* Effect.forkScoped(
          Stream.fromQueue(signals).pipe(
            // One `git commit` touches index, HEAD and ORIG_HEAD within
            // milliseconds; a rebase does it once per replayed commit. The
            // window collapses all of that into one message, and is long enough
            // that the status is read after git has finished rather than during.
            Stream.groupedWithin(WATCH_BATCH_MAX, Duration.millis(GIT_SIGNAL_COALESCE_MS)),
            Stream.filter((batch) => Chunk.size(batch) > 0),
            Stream.mapEffect(() => conn.send({ type: "git-change" })),
            Stream.runDrain,
          ),
        )
      }

      // THE REFS CHANNEL — branches, tags, remotes and how far ahead we are.
      //
      // Its own message, because it answers a different question from
      // `git-change` and has a different audience: the git panel redraws its
      // branch list and counters, and the file tree — whose colours cannot have
      // moved — is left alone.
      //
      // Opened even when the recursive refs watch could not be: the flat watch
      // above still reports `FETCH_HEAD`, `packed-refs` and `config` into the
      // same queue, which covers fetch and gc on a platform that refuses it.
      yield* watchGitRefs(gitDir, refsSignals)
      if (watchingGit) {
        yield* Effect.forkScoped(
          Stream.fromQueue(refsSignals).pipe(
            Stream.groupedWithin(WATCH_BATCH_MAX, Duration.millis(GIT_REFS_COALESCE_MS)),
            Stream.filter((batch) => Chunk.size(batch) > 0),
            Stream.mapEffect(() => conn.send({ type: "git-refs-change" })),
            Stream.runDrain,
          ),
        )
      }
    }

    yield* Stream.fromQueue(events).pipe(
      Stream.groupedWithin(WATCH_BATCH_MAX, Duration.millis(WATCH_COALESCE_MS)),
      Stream.map((batch) => coalesceChangedDirs(Chunk.toReadonlyArray(batch))),
      // A window that was entirely node_modules churn has nothing to say.
      Stream.filter((dirs) => dirs.length > 0),
      Stream.mapEffect((dirs) => conn.send({ type: "fs-change", dirs })),
      Stream.runDrain,
    )
  }).pipe(Effect.withSpan("ws.handleFileWatch"))

// ─────────────────────────────────────────────────────────
// Bridge for wsServer.ts
// ─────────────────────────────────────────────────────────

/** Run a raw WebSocket as an Effect program. Closing the WS releases the Scope,
 *  which closes the watcher and interrupts the heartbeat. */
export const runFileWatchHandler = (ws: WebSocket, cwd: string): void => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const conn = yield* fromWebSocket(ws, "watch")
      yield* handleFileWatch(conn, cwd ?? "")
    }),
  ).pipe(
    Effect.catchAll((e) =>
      Effect.logError("[ws/fs-watch]").pipe(
        Effect.annotateLogs("error", JSON.stringify(e)),
      ),
    ),
  )
  const fiber = Effect.runFork(program)
  ws.on("close", () => {
    Effect.runFork(fiber.interruptAsFork(fiber.id()))
  })
}
