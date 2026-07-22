/**
 * Project wire contract — the shapes exchanged with `/api/projects`.
 *
 * The file-I/O half (ProjectService / ProjectServiceLive, which read & wrote
 * `~/.cockpit/projects.json`) was removed in Phase E: the projects list is now
 * served store-backed by `/api/projects/route.ts` off the Naby store, so the
 * old JSON persistence layer is dead. Only the wire types remain here — they
 * are imported as `type`s by the route and the browser client.
 */

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
   * whenever a project is opened or switched to, and it is the ONLY thing this
   * change adds to the wire format: the display name stays derived from `cwd`
   * at render time so it cannot go stale against the folder it names.
   *
   * Optional because entries written before this field existed must keep
   * loading; they simply sort last.
   */
  readonly lastOpenedAt?: number
}

export interface ProjectsData {
  readonly projects: ReadonlyArray<ProjectInfo>
  readonly activeIndex: number
  readonly collapsed: boolean
}
