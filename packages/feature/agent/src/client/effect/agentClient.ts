/**
 * Client-side agent IO — Effect wrappers
 *
 * Wraps the fetch call sites across the agent-domain UI components
 * (Chat / ChatInput / TokenStatsModal / ProjectSessionsModal / MessageBubble).
 *
 * Complements scheduledTasksClient.ts: this file covers chat-adjacent IO for
 * session / skills / settings / file / claude-stats / naby-stats endpoints.
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
    cwd ? `/api/commands?cwd=${encodeURIComponent(cwd)}` : "/api/commands"
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

export const loadRecentSessions = (): Effect.Effect<
  ReadonlyArray<RecentSessionInfo>,
  AppError
> =>
  httpJson<{ sessions: RecentSessionInfo[] }>("/api/global-state").pipe(
    Effect.map((r) => r.sessions ?? [])
  )

/**
 * Clear the recent-sessions list (DELETE /api/global-state). Hides the current
 * recents behind a `recent.clearedBefore` watermark — sessions and transcripts
 * are NOT deleted (still reachable via Browse all sessions). Returns the
 * now-filtered list so the caller can update in place.
 */
export const clearRecentSessions = (): Effect.Effect<
  ReadonlyArray<RecentSessionInfo>,
  AppError
> =>
  httpJson<{ sessions: RecentSessionInfo[] }>("/api/global-state", {
    method: "DELETE",
  }).pipe(Effect.map((r) => r.sessions ?? []))

// ─────────────────────────────────────────────────────────
// /api/claude-stats?engine= (token usage)
// ─────────────────────────────────────────────────────────

export const loadClaudeStats = <A = Record<string, unknown>>(
  engine: string
): Effect.Effect<A, AppError> =>
  httpJson(`/api/claude-stats?engine=${encodeURIComponent(engine)}`)

// ─────────────────────────────────────────────────────────
// /api/naby/stats (Naby-store usage & cost — the re-backed source)
// ─────────────────────────────────────────────────────────
//
// Sources the token/usage modal from NABY'S OWN records (app.db `usage` table)
// instead of the provider's ~/.claude transcripts. Same StatsData shape as the
// old claude-stats endpoint, so the modal's charts are unchanged.

export const loadNabyStats = <A = Record<string, unknown>>(): Effect.Effect<A, AppError> =>
  httpJson(`/api/naby/stats`)
