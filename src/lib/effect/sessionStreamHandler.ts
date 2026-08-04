/**
 * handleSessionStream — Effect-based WS handler for /ws/session-stream (#10).
 *
 * On connect: send a snapshot of the in-flight turn (run-snapshot) or run-idle.
 * Then tail live events (run-event) driven by sessionRunHub's listener.
 * Mirrors terminalFollowHandler: acquireRelease wraps the listener, the Scope owns
 * cleanup, heartbeat keeps the socket alive.
 */
import { Effect, Queue, Schedule, Scope, Stream } from "effect"
import type { WebSocket } from "ws"
import { ValidationError, WSError } from "@cockpit/effect-core"
import type { WSConnection } from "@cockpit/effect-services"
import { fromWebSocket } from "@cockpit/effect-runtime/server"
import {
  getAttachAnnouncement,
  addRunListener,
  type RunEvent,
} from "@cockpit/feature-agent/server/sessionRunHub"

const HEARTBEAT = Schedule.spaced("30 seconds")

export const handleSessionStream = (
  conn: WSConnection,
  sessionId: string
): Effect.Effect<void, WSError | ValidationError, Scope.Scope> =>
  Effect.gen(function* () {
    if (!sessionId) {
      return yield* Effect.fail(
        new ValidationError({ field: "sessionId", reason: "missing" })
      )
    }

    // 1. Subscribe FIRST (buffer into an unbounded queue) so no event that fires between
    //    the snapshot read and the subscription is lost. Overlap with the snapshot is
    //    removed below by the `seq > snapshotSeq` filter — together: gap-free, dup-free.
    const queue = yield* Queue.unbounded<RunEvent>()
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        addRunListener(sessionId, (ev) => {
          Effect.runFork(Queue.offer(queue, ev))
        })
      ),
      (unsub) => Effect.sync(unsub)
    )

    // 2. What is going on for this session, decided in ONE place (the hub):
    //    a live turn (`run-snapshot`, a consistent backlog whose `startedAt`
    //    lets clients cut the in-flight turn's disk image by timestamp instead
    //    of by prompt text — see useLiveStream), a turn that has been reserved
    //    but has not started yet (`run-pending`, which is what a tab opened by
    //    the fast-growth button attaches into), or nothing (`run-idle`).
    const announcement = getAttachAnnouncement(sessionId)
    const snapshotSeq =
      announcement.type === "run-snapshot" ? announcement.seq : -1
    yield* conn.send(announcement)

    // 3. Heartbeat.
    yield* Effect.forkScoped(
      Effect.repeat(conn.send({ type: "ping" }), HEARTBEAT)
    )

    // 4. Live tail — only events strictly after the snapshot.
    yield* Stream.fromQueue(queue).pipe(
      Stream.filter((ev) => ev.seq > snapshotSeq),
      Stream.mapEffect((ev) =>
        conn.send({ type: "run-event", seq: ev.seq, message: ev.message })
      ),
      Stream.runDrain
    )
  }).pipe(Effect.withSpan("ws.handleSessionStream", { attributes: { sessionId } }))

// Bridge for wsServer.ts
export const runSessionStreamHandler = (
  ws: WebSocket,
  sessionId: string
): void => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const conn = yield* fromWebSocket(ws, "session-stream")
      yield* handleSessionStream(conn, sessionId)
    })
  ).pipe(
    Effect.catchTag("ValidationError", (e) =>
      Effect.sync(() => ws.close(4400, e.reason))
    ),
    Effect.catchAll((e) =>
      Effect.logError("[ws/session-stream]").pipe(
        Effect.annotateLogs("error", JSON.stringify(e))
      )
    )
  )
  const fiber = Effect.runFork(program)
  ws.on("close", () => {
    Effect.runFork(fiber.interruptAsFork(fiber.id()))
  })
}
