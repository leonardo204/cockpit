/**
 * Project wire contract — the shapes exchanged with `/api/projects`.
 *
 * The file-I/O half (ProjectService / ProjectServiceLive, which read & wrote
 * `~/.cockpit/projects.json`) was removed in Phase E: the projects list is now
 * served store-backed by `/api/projects/route.ts` off the Naby store, so the
 * old JSON persistence layer is dead. Only the wire types remain here — they
 * are imported as `type`s by the route and the browser client.
 */

import type { ProjectGroup } from "../../client/projectGroups"

// ─────────────────────────────────────────────────────────
// Data model — wire contract for /api/projects/route.ts.
// ─────────────────────────────────────────────────────────

export interface ProjectInfo {
  readonly cwd: string
  readonly sessionId?: string
  /**
   * Epoch ms of the last time the user opened this project IN THIS APP.
   *
   * This file is the app's record of "projects I have opened" — the home
   * screen's recents list reads it, ordered most-recent-first. It is written
   * whenever a project is opened or switched to. The display name is derived
   * from `cwd` at render time so it cannot go stale against the folder it
   * names — unless the user renamed the project (`title` below).
   *
   * Optional because entries written before this field existed must keep
   * loading; they simply sort last.
   */
  readonly lastOpenedAt?: number
  /**
   * The name the user gave this project in the sidebar (specs/project-groups.md
   * §8). Present on a GET only when it is non-empty and differs from the folder
   * name, so an install that never renamed anything sees the old wire format.
   * Ignored on a list POST — a rename goes through `ProjectsData.rename`.
   */
  readonly title?: string
}

export interface ProjectsData {
  readonly projects: ReadonlyArray<ProjectInfo>
  readonly activeIndex: number
  readonly collapsed: boolean
  /**
   * Expanded sidebar width in px. OPTIONAL both ways: absent from a GET on an
   * install that has never resized (the client keeps its default), and absent
   * from a POST that is saving something else, which the route reads as "leave
   * it alone" rather than "reset it".
   */
  readonly sidebarWidth?: number
  /** File-browser panel width in px. Same optional-both-ways rule as above. */
  readonly filesWidth?: number
  /**
   * Sidebar project groups (specs/project-groups.md), stored in the settings key
   * `sidebar.projectGroups`. Always present on a GET (normalized against the
   * project list; `[]` when there are none). OPTIONAL on a POST: absent means
   * "leave the stored groups alone", like every other field here.
   */
  readonly groups?: ReadonlyArray<ProjectGroup>
  /**
   * POST only: rename one project (specs/project-groups.md §8.2). An empty
   * title, or the folder name, clears the rename; an unknown cwd is a no-op.
   */
  readonly rename?: { readonly cwd: string; readonly title: string }
}
