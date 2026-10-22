/**
 * Client-side ProjectService — browser-side calls /api/projects via fetch.
 *
 * Decoupled from the ProjectService in server/effect/project.ts:
 * - server reads fs directly (ProjectServiceLive)
 * - client goes over HTTP (this file)
 *
 * A later phase can merge both into a single ProjectService Tag with two Live implementations.
 */
import { Effect } from "effect"
import { AppError } from "@cockpit/effect-core"
import type { ProjectsData } from "../../server/effect/project"
import type { ProjectGroup } from "../projectGroups"

/** Browser fetch wrapper; failures are uniformly mapped to AppError. */
export const fetchProjects: Effect.Effect<ProjectsData, AppError> =
  Effect.tryPromise({
    try: async () => {
      const res = await fetch("/api/projects")
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      return (await res.json()) as ProjectsData
    },
    catch: (cause) =>
      new AppError({ message: "fetch /api/projects failed", cause }),
  })

export const saveProjects = (
  data: ProjectsData
): Effect.Effect<void, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
    },
    catch: (cause) =>
      new AppError({ message: "save /api/projects failed", cause }),
  })

/**
 * Persist ONLY the sidebar width.
 *
 * A width-only body on purpose: the route updates a UI pref when the field is
 * present and leaves it alone when it is not, so this cannot disturb the project
 * list, the active index, or the collapsed flag — none of which the person
 * dragging a divider intended to change.
 */
export const saveSidebarWidth = (
  sidebarWidth: number
): Effect.Effect<void, AppError> => savePref({ sidebarWidth }, "sidebar width")

/**
 * Persist ONLY the file-browser width. Called from the project IFRAME, which
 * shares this server with the outer window — one settings store, so the panel
 * keeps its width across projects and across launches.
 */
export const saveFilesWidth = (
  filesWidth: number
): Effect.Effect<void, AppError> => savePref({ filesWidth }, "file browser width")

/**
 * Persist ONLY the sidebar project groups. Same one-field rule: a groups save
 * never carries the project list, and a project-list save never carries the
 * groups (the route leaves absent groups alone and prunes removed projects).
 */
export const saveProjectGroups = (
  groups: ReadonlyArray<ProjectGroup>
): Effect.Effect<void, AppError> => savePref({ groups }, "project groups")

/** One-field POST. See the note above about absent fields being left alone. */
const savePref = (
  body: Record<string, unknown>,
  what: string
): Effect.Effect<void, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
    },
    catch: (cause) => new AppError({ message: `save ${what} failed`, cause }),
  })
