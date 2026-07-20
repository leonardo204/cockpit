/**
 * ProjectService — Effect wrapper over the project-list persistence layer.
 *
 * Wraps readJsonFile / writeJsonFile from `@cockpit/shared-utils` and turns any
 * fs throw into an FSError so callers get a typed failure channel.
 *
 * Layout follows the EFFECT.md §4 service template:
 * - Tag, Service interface, and Live implementation in one file.
 * - Promise-based utils wrapped via Effect.tryPromise.
 * - All errors unified under FSError (Tagged).
 */
import { Context, Effect, Layer } from "effect"
import { join } from "path"
import { COCKPIT_DIR, readJsonFile, writeJsonFile } from "@cockpit/shared-utils"
import { FSError } from "@cockpit/effect-core"

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

const DEFAULT_DATA: ProjectsData = {
  projects: [],
  activeIndex: 0,
  collapsed: false,
}

const PROJECTS_FILE = join(COCKPIT_DIR, "projects.json")

// ─────────────────────────────────────────────────────────
// Service Tag
// ─────────────────────────────────────────────────────────

export interface ProjectService {
  readonly read: Effect.Effect<ProjectsData, FSError>
  readonly write: (data: ProjectsData) => Effect.Effect<void, FSError>
}

export const ProjectService =
  Context.GenericTag<ProjectService>("@cockpit/ProjectService")

// ─────────────────────────────────────────────────────────
// Live implementation
// ─────────────────────────────────────────────────────────

export const ProjectServiceLive = Layer.succeed(
  ProjectService,
  ProjectService.of({
    read: Effect.tryPromise({
      try: () => readJsonFile<ProjectsData>(PROJECTS_FILE, DEFAULT_DATA),
      catch: (cause) =>
        new FSError({ path: PROJECTS_FILE, op: "read", cause }),
    }),
    write: (data) =>
      Effect.tryPromise({
        try: () => writeJsonFile(PROJECTS_FILE, data),
        catch: (cause) =>
          new FSError({ path: PROJECTS_FILE, op: "write", cause }),
      }),
  })
)
