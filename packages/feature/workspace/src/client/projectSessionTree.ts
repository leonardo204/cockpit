/**
 * The sidebar project tree — per-project session state, kept out of the view.
 *
 * ProjectSidebar renders projects as a TREE: each project row expands into the
 * sessions that belong to it. Everything here is the part of that feature a
 * test can actually hold: the keyed state and its transitions, plus the two IO
 * effects (load the sessions of one project, delete one session). The
 * component keeps only `useState` + wiring.
 *
 * The state is keyed by **cwd**, not by the encoded path. The sidebar is handed
 * cwds (`ProjectInfo.cwd`) and the WebSocket's `project-state-changed` also
 * carries a cwd, so keying by cwd means neither has to be translated before a
 * lookup. Only the sessions request encodes, at the boundary.
 */
import { Effect } from "effect"
import type { AppError } from "@cockpit/effect-core"
import { loadSessionsByProject } from "./effect/workspaceClient"
import { saveProjectState } from "./effect/stateClient"

/**
 * One row of `/api/sessions/projects/<encodedPath>`. The wire type carries more
 * (firstMessages / lastMessages / searchText / engine); the sidebar rows are one
 * line tall and need none of it.
 */
export interface SidebarSessionInfo {
  /** Carries the BARE sessionId on this backend — see project-encoded.ts. Run
   *  it through `sessionIdOf` anyway, which also tolerates the legacy
   *  `<dir>/<id>.jsonl` shape. */
  path: string
  title: string
  modifiedAt: string
}

export interface ProjectSessionState {
  isExpanded: boolean
  isLoading: boolean
  sessions: SidebarSessionInfo[]
  error: string | null
}

/** cwd → that project's branch of the tree. Absent = never expanded. */
export type ProjectSessionTree = Record<string, ProjectSessionState>

export const COLLAPSED_PROJECT_STATE: ProjectSessionState = {
  isExpanded: false,
  isLoading: false,
  sessions: [],
  error: null,
}

/**
 * Mirrors `encodePath` in @cockpit/shared-utils, which cannot be imported into
 * a browser module: that file resolves `os.homedir()` at load time and would
 * drag the server path helpers into the client bundle. EmptyState.tsx keeps the
 * same mirror for the same reason.
 *
 * The server matches an encoded path against every known project by re-encoding
 * each cwd (`resolveCwdFromEncoded`), so this only has to agree with that one
 * function — an unknown project answers with an empty list, which is the
 * correct answer for a project with no sessions anyway.
 */
export function encodeProjectPath(cwd: string): string {
  return cwd.replace(/[/.]/g, "-")
}

/**
 * The sessionId a row opens. `path` is already a bare id on this backend; the
 * split/strip is kept so a legacy `.../<id>.jsonl` value still resolves, exactly
 * as SessionBrowser and EmptyState do it.
 */
export function sessionIdOf(session: SidebarSessionInfo): string {
  const tail = session.path.split("/").pop() || session.path
  return tail.replace(/\.jsonl$/, "")
}

/** Never returns undefined, so the view can read `.isExpanded` unguarded. */
export function projectStateAt(
  tree: ProjectSessionTree,
  cwd: string
): ProjectSessionState {
  return tree[cwd] ?? COLLAPSED_PROJECT_STATE
}

const patch = (
  tree: ProjectSessionTree,
  cwd: string,
  next: Partial<ProjectSessionState>
): ProjectSessionTree => ({
  ...tree,
  [cwd]: { ...projectStateAt(tree, cwd), ...next },
})

/** Expand or collapse. Collapsing KEEPS the loaded sessions, so re-expanding
 *  shows the previous list at once while the refetch runs. */
export function withExpanded(
  tree: ProjectSessionTree,
  cwd: string,
  isExpanded: boolean
): ProjectSessionTree {
  return patch(tree, cwd, { isExpanded })
}

/** Start of a fetch. Expands, because every load path is a load-to-show; the
 *  previously loaded rows stay on screen so the branch does not flicker empty. */
export function withLoading(
  tree: ProjectSessionTree,
  cwd: string
): ProjectSessionTree {
  return patch(tree, cwd, { isExpanded: true, isLoading: true, error: null })
}

export function withSessions(
  tree: ProjectSessionTree,
  cwd: string,
  sessions: readonly SidebarSessionInfo[]
): ProjectSessionTree {
  return patch(tree, cwd, {
    isLoading: false,
    error: null,
    sessions: [...sessions],
  })
}

export function withLoadError(
  tree: ProjectSessionTree,
  cwd: string,
  error: string
): ProjectSessionTree {
  return patch(tree, cwd, { isLoading: false, error })
}

/**
 * Drop one session row optimistically after a successful delete. The
 * `project-state-changed` broadcast triggers a refetch right behind it, which
 * is what confirms the removal; this only stops the row lingering until then.
 */
export function withoutSession(
  tree: ProjectSessionTree,
  cwd: string,
  sessionId: string
): ProjectSessionTree {
  const current = tree[cwd]
  if (!current) return tree
  const sessions = current.sessions.filter((s) => sessionIdOf(s) !== sessionId)
  if (sessions.length === current.sessions.length) return tree
  return { ...tree, [cwd]: { ...current, sessions } }
}

/**
 * The cwd of a `project-state-changed` push, or null for anything else.
 *
 * The server broadcasts it after EVERY session add/close (project-state
 * route.ts), so an expanded branch that ignores it goes stale the moment a tab
 * is opened or closed elsewhere in the app.
 */
export function projectStateChangedCwd(message: unknown): string | null {
  if (typeof message !== "object" || message === null) return null
  const msg = message as { type?: unknown; cwd?: unknown }
  if (msg.type !== "project-state-changed") return null
  return typeof msg.cwd === "string" && msg.cwd.length > 0 ? msg.cwd : null
}

/** True when a push for `cwd` should cost a refetch: only expanded branches. */
export function shouldRefetch(tree: ProjectSessionTree, cwd: string): boolean {
  return projectStateAt(tree, cwd).isExpanded
}

// ─────────────────────────────────────────────────────────
// IO
// ─────────────────────────────────────────────────────────

/** The sessions of one project, by cwd — encodes at this boundary and nowhere
 *  else. */
export const loadProjectSessions = (
  cwd: string
): Effect.Effect<ReadonlyArray<SidebarSessionInfo>, AppError> =>
  loadSessionsByProject<SidebarSessionInfo>(encodeProjectPath(cwd))

/**
 * Delete one session, through the SAME path a tab close takes.
 *
 * `closedSessionIds` is the only removal channel the project-state endpoint
 * has: the server runs `deleteSession(sid)` for each id and then broadcasts
 * `project-state-changed`, which makes every open project view reconcile away
 * the matching tab. `sessions: []` is safe alongside it — saves are union-ADD,
 * so an empty list removes nothing by itself.
 *
 * There is deliberately no confirmation upstream of this: closing a tab already
 * deletes its session by this exact route, so a dialog here would guard one of
 * two identical actions.
 */
export const deleteSession = (
  cwd: string,
  sessionId: string
): Effect.Effect<void, AppError> =>
  saveProjectState({ cwd, sessions: [], closedSessionIds: [sessionId] })
