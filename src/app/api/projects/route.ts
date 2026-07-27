/**
 * /api/projects — list and persist the user's project workspace.
 *
 * RE-BACKED ONTO THE NABY STORE (Phase C, part 1). The project list is now owned
 * by `app.db` (the Naby store), not `~/.cockpit/projects.json`. The WIRE CONTRACT
 * is unchanged — the client still reads/writes `ProjectsData { projects, activeIndex,
 * collapsed }` with `ProjectInfo { cwd, sessionId?, lastOpenedAt? }` — only the
 * backing store moved, so the running UI cannot tell the difference.
 *
 * WHERE EACH FIELD LIVES NOW:
 *   - `projects[]`  → the store's `projects` table (keyed by cwd, MRU order).
 *     `lastOpenedAt` is the project row's `last_opened_at`; the client still
 *     drives it (a save carries the value it wants), so MRU semantics are intact.
 *   - `activeIndex` / `collapsed` → app-wide UI prefs, stored in Naby settings
 *     (`ui.activeIndex`, `ui.collapsed`) rather than smuggled into projects.json.
 *   - `ProjectInfo.sessionId?` is a vestigial optional the store does not model;
 *     it is simply not echoed back (its absence is contract-valid) and ignored on
 *     write. The client keeps working because the field was always optional.
 *
 * Implementation contract (see EFFECT.md §3):
 * - No bare try/catch — store failures are wrapped as FSError so `handler` maps
 *   them to 503 exactly as the file-backed version did.
 */
import { basename } from "node:path"
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError } from "@cockpit/effect-core"
import type { ProjectsData } from "@cockpit/feature-workspace/server"
import { getStore } from "@cockpit/feature-agent/server/engines/naby"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const ACTIVE_INDEX_KEY = "ui.activeIndex"
const COLLAPSED_KEY = "ui.collapsed"
const SIDEBAR_WIDTH_KEY = "ui.sidebarWidth"
const FILES_WIDTH_KEY = "ui.filesWidth"

/** Kept in step with the panels' own MIN/MAX constants. Clamped here too,
 *  because a stored width is read straight into a layout and a bad one from any
 *  source would leave the user unable to see the handle that fixes it. */
const SIDEBAR_MIN_WIDTH = 160
const SIDEBAR_MAX_WIDTH = 480
const FILES_MIN_WIDTH = 200
const FILES_MAX_WIDTH = 640

/** Read a stored px width back, or undefined when unset or unreadable. */
const readWidth = (raw: string | undefined, min: number, max: number): number | undefined => {
  const n = Number.parseInt(raw ?? "", 10)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined
}

// ─────────────────────────────────────────────────────────
// GET — read the project list (from the store)
// ─────────────────────────────────────────────────────────

export const GET = handler(() =>
  Effect.try({
    try: (): ProjectsData => {
      const store = getStore()
      const projects = store.listProjects().map((p) => ({
        cwd: p.cwd,
        lastOpenedAt: p.lastOpenedAt,
      }))
      const rawIndex = Number.parseInt(store.getSetting(ACTIVE_INDEX_KEY) ?? "0", 10)
      const activeIndex = Number.isFinite(rawIndex) && rawIndex >= 0 ? rawIndex : 0
      const collapsed = store.getSetting(COLLAPSED_KEY) === "true"
      const sidebarWidth = readWidth(
        store.getSetting(SIDEBAR_WIDTH_KEY),
        SIDEBAR_MIN_WIDTH,
        SIDEBAR_MAX_WIDTH
      )
      const filesWidth = readWidth(
        store.getSetting(FILES_WIDTH_KEY),
        FILES_MIN_WIDTH,
        FILES_MAX_WIDTH
      )
      return {
        projects,
        activeIndex,
        collapsed,
        ...(sidebarWidth === undefined ? {} : { sidebarWidth }),
        ...(filesWidth === undefined ? {} : { filesWidth }),
      }
    },
    catch: (cause) => new FSError({ path: "app.db:projects", op: "read", cause }),
  }).pipe(Effect.map((data) => ok(data)))
)

// ─────────────────────────────────────────────────────────
// POST — save the project list (into the store)
// ─────────────────────────────────────────────────────────

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as Partial<ProjectsData>
    yield* Effect.try({
      try: () => {
        const store = getStore()

        // EVERY FIELD IS OPTIONAL, AND ABSENT MEANS "LEAVE IT ALONE".
        //
        // This is a PATCH, not a replace, because a caller that only wants to
        // record a UI preference must not have to send the project list to do
        // it — and the cost of getting that wrong is not a stale flag. An absent
        // `projects` used to read as an empty list, and the reconcile below
        // would then remove every project, CASCADING away each one's sessions
        // and their messages. A save of the sidebar width would have wiped the
        // workspace.
        if (Array.isArray(body?.projects)) {
          const incoming = body.projects
          const incomingCwds = new Set(
            incoming.map((p) => p.cwd).filter((c): c is string => !!c)
          )

          // Drop projects the client no longer lists. removeProject CASCADEs the
          // project's sessions (and their messages/memory/usage) — this unifies
          // the old delete-purge: removing a project from recents discards its
          // session history, same product decision as before, now atomic in-store.
          for (const existing of store.listProjects()) {
            if (!incomingCwds.has(existing.cwd)) store.removeProject(existing.cwd)
          }

          // Upsert each incoming project. Title defaults to the cwd basename (the
          // wire format carries no title — display name is derived from cwd). The
          // client still owns lastOpenedAt, so persist it when present rather than
          // bumping to now — that keeps MRU ordering client-driven as before.
          for (const p of incoming) {
            if (!p.cwd) continue
            store.upsertProject(p.cwd, {
              title: basename(p.cwd) || p.cwd,
              ...(typeof p.lastOpenedAt === "number"
                ? { lastOpenedAt: p.lastOpenedAt }
                : {}),
            })
          }
        }

        // App-wide UI prefs → settings (not projects.json).
        if (typeof body?.activeIndex === "number") {
          store.setSetting(ACTIVE_INDEX_KEY, String(body.activeIndex))
        }
        if (typeof body?.collapsed === "boolean") {
          store.setSetting(COLLAPSED_KEY, String(body.collapsed))
        }
        if (typeof body?.sidebarWidth === "number" && Number.isFinite(body.sidebarWidth)) {
          const clamped = Math.min(
            SIDEBAR_MAX_WIDTH,
            Math.max(SIDEBAR_MIN_WIDTH, Math.round(body.sidebarWidth))
          )
          store.setSetting(SIDEBAR_WIDTH_KEY, String(clamped))
        }
        if (typeof body?.filesWidth === "number" && Number.isFinite(body.filesWidth)) {
          const clamped = Math.min(
            FILES_MAX_WIDTH,
            Math.max(FILES_MIN_WIDTH, Math.round(body.filesWidth))
          )
          store.setSetting(FILES_WIDTH_KEY, String(clamped))
        }
      },
      catch: (cause) => new FSError({ path: "app.db:projects", op: "write", cause }),
    })
    return ok({ success: true })
  })
)
