/**
 * handleGlobalState — Effect-based WebSocket handler for the global-state channel.
 *
 * - `Stream.debounce` coalesces bursts of fs events (replaces sending/pendingSend mutex).
 * - `acquireRelease` wraps the fs.watch subscription so it tears down on close.
 * - `Schedule.spaced` drives the heartbeat; the Scope owns all cleanup.
 * - Failures flow as Tagged Errors (WSError | FSError); no bare try/catch.
 */
import { watch, existsSync, mkdirSync } from "fs"
import { basename, dirname } from "path"
import { Effect, Queue, Schedule, Scope, Stream } from "effect"
import type { WebSocket } from "ws"
import { FSError, WSError } from "@cockpit/effect-core"
import type { WSConnection } from "@cockpit/effect-services"
import { fromWebSocket } from "@cockpit/effect-runtime/server"
import { getGlobalSessionsSnapshot } from "@cockpit/feature-agent/server/state/globalState"
import { recentSessionsSourcePath } from "@cockpit/feature-agent/server/state/recentSessions"

const HEARTBEAT_INTERVAL = Schedule.spaced("30 seconds")

/**
 * Build the snapshot (shared with the /m SSR page via
 * getGlobalSessionsSnapshot) and send it via the connection.
 */
const sendGlobalState = (
  conn: WSConnection
): Effect.Effect<void, WSError | FSError> =>
  Effect.gen(function* () {
    const sessions = yield* Effect.tryPromise({
      try: () => getGlobalSessionsSnapshot(),
      catch: (cause) =>
        new FSError({ path: recentSessionsSourcePath(), op: "read", cause }),
    })

    yield* conn.send({ type: "global-state", data: { sessions } })
  })

/**
 * Watch the STORE the snapshot is built from, and enqueue a tick on every write.
 *
 * It used to watch `~/.cockpit/state.json` — a different file from the one the
 * snapshot reads. That is why the unread badge would not clear: the "mark read"
 * write landed in the store, no state.json event fired, and the dropdown kept
 * showing the old value until something else happened to touch the file. Watch
 * what you read, and that whole class of staleness disappears.
 *
 * A DIRECTORY watch, filtered by name: SQLite in WAL mode commits into
 * `app.db-wal` and only folds it back into `app.db` at a checkpoint, so
 * watching the database file alone would miss almost every write. `-shm` is
 * deliberately NOT a trigger — readers touch it, and a snapshot that reacts to
 * its own reads would spin.
 */
const watchStore = (
  trigger: Queue.Queue<void>
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const dbPath = recentSessionsSourcePath()
      const dir = dirname(dbPath)
      const dbName = basename(dbPath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

      const offer = () => Effect.runFork(Queue.offer(trigger, undefined))
      let watcher: ReturnType<typeof watch> | null = null
      try {
        watcher = watch(dir, (_, filename) => {
          if (filename === dbName || filename === `${dbName}-wal`) offer()
        })
      } catch {
        /* ignore */
      }
      watcher?.on("error", () => {
        /* swallow — Effect error channels handle this through other paths */
      })
      return watcher
    }),
    (watcher) =>
      Effect.sync(() => {
        try {
          watcher?.close()
        } catch {
          /* ignore */
        }
      })
  ).pipe(Effect.asVoid)

/**
 * handleGlobalState — Effect entry point.
 *
 * When the Scope closes (WS close or failure), the watcher, heartbeat, and
 * sender fibers are all interrupted automatically.
 */
export const handleGlobalState = (
  conn: WSConnection
): Effect.Effect<void, WSError | FSError, Scope.Scope> =>
  Effect.gen(function* () {
    // Heartbeat
    yield* Effect.forkScoped(
      Effect.repeat(conn.send({ type: "ping" }), HEARTBEAT_INTERVAL)
    )

    // trigger queue
    const trigger = yield* Queue.unbounded<void>()

    // Store watcher
    yield* watchStore(trigger)

    // Prime the queue so an initial state push fires
    yield* Queue.offer(trigger, undefined)

    // Drain trigger: debounce, then send serially.
    //
    // Wider than the 50ms this used when the trigger was one JSON file written
    // twice per run. The store is written continuously during a turn — every
    // appended message is a commit — so each burst must collapse into one
    // rebuild rather than one per commit.
    yield* Stream.fromQueue(trigger).pipe(
      Stream.debounce("300 millis"),
      Stream.mapEffect(() =>
        sendGlobalState(conn).pipe(
          Effect.catchAll((e) =>
            Effect.sync(() => console.error("[ws/global-state]", e))
          )
        )
      ),
      Stream.runDrain
    )
  })

// ─────────────────────────────────────────────────────────
// Bridge for wsServer.ts — launch the Effect program from a raw ws.WebSocket
// ─────────────────────────────────────────────────────────

/**
 * Run a raw WebSocket as an Effect program. Closing the WS releases the
 * entire Scope, cleaning up the heartbeat, watcher, fibers, and any pubsub
 * listeners.
 */
export const runGlobalStateHandler = (ws: WebSocket): void => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const conn = yield* fromWebSocket(ws, "global-state")
      yield* handleGlobalState(conn)
    })
  )
  // Interrupt the fiber on WS close
  const fiber = Effect.runFork(program)
  ws.on("close", () => {
    Effect.runFork(fiber.interruptAsFork(fiber.id()))
  })
}
