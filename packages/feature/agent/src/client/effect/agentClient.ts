/**
 * Client-side agent IO — Effect wrappers
 *
 * Wraps the fetch call sites across the agent-domain UI components
 * (Chat / ChatInput / TokenStatsModal / ProjectSessionsModal / MessageBubble).
 *
 * Complements scheduledTasksClient.ts: this file covers chat-adjacent IO for
 * session / skills / settings / file / naby-stats endpoints.
 */
import { Effect } from "effect"
import { AppError } from "@cockpit/effect-core"

// ─────────────────────────────────────────────────────────
// HTTP primitives
// ─────────────────────────────────────────────────────────

const httpJson = <A>(
  url: string,
  init?: RequestInit
): Effect.Effect<A, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(url, init)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as A
    },
    catch: (cause) =>
      new AppError({
        message: `${init?.method ?? "GET"} ${url} failed`,
        cause,
      }),
  })

const httpPostJson = <A>(
  url: string,
  body: unknown
): Effect.Effect<A, AppError> =>
  httpJson<A>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

const httpPutJson = <A>(
  url: string,
  body: unknown
): Effect.Effect<A, AppError> =>
  httpJson<A>(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

// ─────────────────────────────────────────────────────────
// /api/settings (duplicated here to avoid an agent → workspace reverse dependency)
// ─────────────────────────────────────────────────────────

export const loadAgentSettings = <A = Record<string, unknown>>(): Effect.Effect<
  A,
  AppError
> => httpJson<A>("/api/settings")

export const saveAgentSettings = (
  body: Record<string, unknown>
): Effect.Effect<unknown, AppError> => httpPutJson("/api/settings", body)

// ─────────────────────────────────────────────────────────
// /api/commands — slash command list: in-process builtins merged with
// Naby-owned enabled commands (Phase 1.6 HP-02). Passing the active `cwd`
// includes that project's project-scope owned commands alongside the always-on
// user-scope ones; omitting it yields user-scope + builtins only.
// ─────────────────────────────────────────────────────────

export const loadSlashCommands = <T = unknown>(
  cwd?: string
): Effect.Effect<ReadonlyArray<T>, AppError> =>
  httpJson<ReadonlyArray<T>>(
    cwd ? `/api/commands?cwd=${encodeURIComponent(cwd)}` : "/api/commands",
    // `no-store` because this URL is now REFETCHED, not fetched once. The
    // composer re-reads it whenever a harness item is enabled or the window
    // regains focus, and the request is byte-identical to the previous one — a
    // conditional/heuristic cache hit would hand back the very list the user
    // just changed, which is indistinguishable from the bug this refetch exists
    // to fix. Correctness beats a cache on a local sub-10ms endpoint.
    { cache: "no-store" }
  )

// ─────────────────────────────────────────────────────────
// /api/session-by-path (used inside Chat.tsx; complements the helper inside useChatHistory)
// ─────────────────────────────────────────────────────────

export const querySessionByPath = (
  body: Record<string, unknown>
): Effect.Effect<Record<string, unknown> | null, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch("/api/session-by-path", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) return null
      return (await res.json()) as Record<string, unknown>
    },
    catch: (cause) =>
      new AppError({ message: "POST /api/session-by-path failed", cause }),
  })

// ─────────────────────────────────────────────────────────
// /api/session/:id/fork
// ─────────────────────────────────────────────────────────

export const forkSession = <A = { sessionId?: string }>(
  sessionId: string,
  body: Record<string, unknown>
): Effect.Effect<A, AppError> =>
  httpPostJson<A>(
    `/api/session/${encodeURIComponent(sessionId)}/fork`,
    body
  )

// ─────────────────────────────────────────────────────────
// /api/sessions/projects/:encodedPath (duplicated here; backend returns an Array directly)
// ─────────────────────────────────────────────────────────

export const loadSessionsByProject = <T = unknown>(
  encodedPath: string
): Effect.Effect<ReadonlyArray<T>, AppError> =>
  httpJson(`/api/sessions/projects/${encodeURIComponent(encodedPath)}`)

// ─────────────────────────────────────────────────────────
// /api/global-state (GET) — the full persisted recent-session list (up to 100).
// Backs the recent-sessions search panel; the sidebar dropdown still streams
// its top-15 view over /ws/global-state.
// ─────────────────────────────────────────────────────────

export interface RecentSessionInfo {
  cwd: string
  sessionId: string
  lastActive: number
  status: string
  title?: string
  lastUserMessage?: string
  firstMessages?: string[]
  lastMessages?: string[]
  /** Untruncated full-text corpus (cwd + title + summary + all user messages), lowercased. */
  searchText?: string
  engine?: string
}

/**
 * The recents payload. `hiddenCount` is how many sessions the "clear recents"
 * watermark is holding back, so the panel can say they are hidden rather than
 * letting them look deleted.
 */
export interface RecentSessionsPayload {
  sessions: ReadonlyArray<RecentSessionInfo>
  hiddenCount: number
}

export const loadRecentSessions = (): Effect.Effect<RecentSessionsPayload, AppError> =>
  httpJson<{ sessions?: RecentSessionInfo[]; hiddenCount?: number }>(
    "/api/global-state"
  ).pipe(
    Effect.map((r) => ({ sessions: r.sessions ?? [], hiddenCount: r.hiddenCount ?? 0 }))
  )

/**
 * Clear the recent-sessions list (DELETE /api/global-state). Hides the current
 * recents behind a `recent.clearedBefore` watermark — sessions and transcripts
 * are NOT deleted (still reachable via Browse all sessions). Returns the
 * now-filtered list so the caller can update in place.
 */
export const clearRecentSessions = (): Effect.Effect<RecentSessionsPayload, AppError> =>
  httpJson<{ sessions?: RecentSessionInfo[]; hiddenCount?: number }>("/api/global-state", {
    method: "DELETE",
  }).pipe(
    Effect.map((r) => ({ sessions: r.sessions ?? [], hiddenCount: r.hiddenCount ?? 0 }))
  )

/**
 * Undo a clear (DELETE /api/global-state?undo=1) — removes the watermark, so
 * every hidden session returns to the list. Clearing used to be one-way: the
 * only route back was to open a session and run a turn in it, which is not
 * something a user can be expected to find.
 */
export const restoreRecentSessions = (): Effect.Effect<RecentSessionsPayload, AppError> =>
  httpJson<{ sessions?: RecentSessionInfo[]; hiddenCount?: number }>(
    "/api/global-state?undo=1",
    { method: "DELETE" }
  ).pipe(
    Effect.map((r) => ({ sessions: r.sessions ?? [], hiddenCount: r.hiddenCount ?? 0 }))
  )

// ─────────────────────────────────────────────────────────
// /api/naby/stats (Naby-store usage & cost)
// ─────────────────────────────────────────────────────────
//
// Sources the token/usage modal from NABY'S OWN records (app.db `usage` table).
//
// There WAS a second wrapper here — `loadClaudeStats`, for a route that scanned
// `~/.claude/projects` and `~/.claude2/projects` for jsonl transcripts and
// aggregated their token counts. Nothing had called it since the modal was
// re-backed onto the store, and it was the last client-side reference to a
// vendor directory, so both it and its route are gone (harness-standalone §2.5).

export const loadNabyStats = <A = Record<string, unknown>>(): Effect.Effect<A, AppError> =>
  httpJson(`/api/naby/stats`)
