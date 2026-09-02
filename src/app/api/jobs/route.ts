/**
 * /api/jobs — what background work naby has going, and how it ended.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS ROUTE HAD TO EXIST BEFORE ANY INDICATOR COULD
 *
 * Until now the UI's only knowledge of a running job came from the turn's event
 * stream — lifecycle edges that are transport, never persisted, and that stop
 * arriving the moment the turn ends. So a job that outlived its turn was
 * invisible everywhere at once: no spinner in the transcript, no dot on the tab,
 * nothing in the sidebar. The registry that knew the truth (`listRunningJobs`)
 * had, verifiably, zero callers in the whole shell.
 *
 * A job's life is not a property of a conversation turn, so its state cannot
 * live in one. This route reads the registry and the records directory — the
 * only two places that outlive a turn — and answers the same way whether the
 * asking tab is the one that started the work, a different tab, or a fresh
 * window after a restart.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * READ-ONLY, AND NOT A POLLER'S SERVER
 *
 * Nothing here starts, stops or touches a job; `killJob` is deliberately not
 * exposed. The caller is a UI that redraws when something already woke it, not a
 * loop asking "is it done yet" — the repo bans standing pollers and this route
 * does not become one just by being cheap to call.
 */
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import {
  listJobRecords,
  listRunningJobs,
} from "../../../../../dist/naby-runtime.mjs"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * How many finished jobs come back with the running ones.
 *
 * The running set is the answer to "is anything happening"; the recent set is
 * the answer to "what just happened", which is what a person opening the panel
 * after lunch actually wants. Bounded because a long-lived home accumulates
 * records and nobody scrolls a job list.
 */
const RECENT_LIMIT = 30

export const GET = handler(() =>
  Effect.gen(function* () {
    const result = yield* Effect.sync(() => {
      // THE REGISTRY FIRST, because it is the only source that can say
      // `running` truthfully — a record on disk saying `running` may belong to a
      // child this process never knew (see `markLostJobs`).
      const live = listRunningJobs()
      const liveIds = new Set(live.map((j) => j.id))
      // `listJobRecords` already folds the registry over the records, so a job
      // that IS live comes back live; filtering by id here only avoids listing
      // it twice.
      const recent = listJobRecords(RECENT_LIMIT).filter((j) => !liveIds.has(j.id))
      return { running: live, recent }
    })

    return ok({
      ok: true as const,
      ...result,
      // Reported rather than derived on the client so every reader agrees on
      // the number the indicator shows.
      runningCount: result.running.length,
    })
  }),
)
