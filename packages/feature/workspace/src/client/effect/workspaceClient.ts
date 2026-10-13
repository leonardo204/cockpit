/**
 * Client-side workspace IO — Effect wrappers
 *
 * Wraps the ~20 fetch call sites across 7 workspace-domain UI components
 * (SettingsModal / TabManager / TabManagerTopBar / NoteModal / SessionBrowser /
 * EmptyState / I18nProvider).
 *
 * Complements stateClient / projectClient:
 *   - projectClient — `/api/projects` GET/POST
 *   - stateClient — project-state / global-state / scheduled-tasks
 *   - workspaceClient (this file) — settings / version / note / sessions /
 *     project-settings / pick-folder / open-vscode / open-cursor / git-worktree
 */
import { Effect } from "effect"
import { AppError } from "@cockpit/effect-core"
import {
  PROJECT_FOLDER_DEFAULT_KEY,
  PROJECT_FOLDER_LAST_KEY,
  normalizeFavorites,
} from "@cockpit/shared-utils"

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

// ─────────────────────────────────────────────────────────
// /api/settings
// ─────────────────────────────────────────────────────────

export interface SettingsResponse {
  language?: string
  /** 'light' | 'dark' | 'system' — see shared-utils/bootTheme.ts. */
  theme?: string
  /** The four font knobs — see shared-utils/fontSettings.ts. Typed loosely on
   *  purpose: the file is hand-editable, so every reader normalizes. */
  fonts?: unknown
  [key: string]: unknown
}

export const loadSettings = (): Effect.Effect<SettingsResponse, AppError> =>
  httpJson("/api/settings")

/** Backend uses PUT for merge-update, not POST. */
export const saveSettings = (
  body: Record<string, unknown>
): Effect.Effect<unknown, AppError> =>
  httpJson("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

// ─────────────────────────────────────────────────────────
// /api/version
// ─────────────────────────────────────────────────────────

export const loadCockpitVersion = (): Effect.Effect<
  { version?: string },
  AppError
> => httpJson("/api/version")

// ─────────────────────────────────────────────────────────
// /api/note
// ─────────────────────────────────────────────────────────

export interface NoteResponse {
  content?: string
  /** File mtime (ms) at load — the optimistic-concurrency token for saves. */
  mtime?: number
}

/**
 * Result of a save attempt. A `conflict` means the note changed on disk since
 * `baseMtime` (another tab / external editor); it carries the latest content
 * so the caller can reload instead of clobbering.
 */
export type SaveNoteResult =
  | { conflict: false; mtime?: number }
  | { conflict: true; content: string; mtime?: number }

/**
 * Global note uses `/api/note`; project note uses `/api/note?cwd=...`.
 */
const noteUrl = (cwd?: string | null) =>
  cwd ? `/api/note?cwd=${encodeURIComponent(cwd)}` : "/api/note"

export const loadNote = (
  cwd?: string | null
): Effect.Effect<NoteResponse, AppError> => httpJson(noteUrl(cwd))

/**
 * Saves the note with an optimistic-concurrency check. Unlike the generic
 * `httpPostJson` helper, a 409 here is a normal outcome (a detected conflict),
 * not a transport failure — so it is surfaced as a `SaveNoteResult` value
 * rather than an `AppError`. Genuine network/HTTP failures still fail the
 * Effect.
 */
export const saveNote = (
  cwd: string | null | undefined,
  content: string,
  baseMtime?: number
): Effect.Effect<SaveNoteResult, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const url = noteUrl(cwd)
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, baseMtime }),
      })
      if (res.status === 409) {
        const data = (await res.json()) as {
          content?: string
          mtime?: number
        }
        return {
          conflict: true as const,
          content: data.content ?? "",
          mtime: data.mtime,
        }
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { mtime?: number }
      return { conflict: false as const, mtime: data.mtime }
    },
    catch: (cause) =>
      new AppError({ message: `POST ${noteUrl(cwd)} failed`, cause }),
  })

// ─────────────────────────────────────────────────────────
// /api/sessions/projects
// ─────────────────────────────────────────────────────────

/**
 * The sessions/projects backend returns Array<ProjectInfo> directly (not wrapped in `{projects:[]}`).
 */
export const loadSessionProjects = <T = unknown>(): Effect.Effect<
  ReadonlyArray<T>,
  AppError
> => httpJson("/api/sessions/projects")

/**
 * Fetch sessions by encoded project path — backend likewise returns Array<SessionInfo> directly.
 */
export const loadSessionsByProject = <T = unknown>(
  encodedPath: string
): Effect.Effect<ReadonlyArray<T>, AppError> =>
  httpJson(`/api/sessions/projects/${encodeURIComponent(encodedPath)}`)

// ─────────────────────────────────────────────────────────
// /api/project-settings
// ─────────────────────────────────────────────────────────

export interface ProjectSettings {
  [key: string]: unknown
}

export const loadProjectSettings = (
  cwd: string
): Effect.Effect<ProjectSettings, AppError> =>
  httpJson(`/api/project-settings?cwd=${encodeURIComponent(cwd)}`)

export const saveProjectSettings = (
  body: Record<string, unknown>
): Effect.Effect<unknown, AppError> =>
  httpPostJson("/api/project-settings", body)

// ─────────────────────────────────────────────────────────
// folder picker — window.naby.fsOps.pickFolder, else /api/pick-folder
// ─────────────────────────────────────────────────────────

/** The one bridge method this file uses. Typed locally: the shell must NEVER
 *  import from `electron` (Next would try to bundle it), so the preload's shape
 *  is restated here rather than imported. */
interface FolderPickerBridge {
  // `defaultPath` is new; a preload that predates it simply ignores the extra
  // argument and opens at home, which is the old behaviour — so no version
  // check is needed for it.
  pickFolder(message?: string, defaultPath?: string): Promise<string | null>
}

/**
 * The Electron folder chooser, or null in a plain browser.
 *
 * Feature-detected exactly like FileBrowserPanel's `fsBridge()`. The desktop
 * app has to prefer this: the HTTP fallback shells out to `osascript`, and the
 * panel that process owns has NO MENU BAR — so cmd+C / cmd+V do nothing in its
 * "New Folder" name field, which is where a user naturally pastes a path or a
 * project name. The IPC path opens the same native panel owned by the app, with
 * the app's Edit menu, and the shortcuts work.
 */
const folderPickerBridge = (): FolderPickerBridge | null => {
  if (typeof window === "undefined") return null
  const w = window as unknown as {
    naby?: { fsOps?: Partial<FolderPickerBridge> }
  }
  const ops = w.naby?.fsOps
  return typeof ops?.pickFolder === "function" ? (ops as FolderPickerBridge) : null
}

/**
 * Returns `{folder: string | null}` — null = user cancelled (a NORMAL outcome,
 * never an error). Same shape from both paths, so the four call sites
 * (Workspace / SessionBrowser / EmptyState open + create) do not know or care
 * which one answered.
 *
 * The route remains the fallback for the cockpit standalone dev server, where
 * there is no Electron bridge at all.
 *
 * WHERE IT OPENS, AND WHAT IT REMEMBERS. Both paths get the start folder from
 * `/api/pick-folder/start` (the configured default, else the parent of the last
 * pick, else home), and a successful pick is written back as the last folder.
 * Neither step can fail the pick: a start lookup that errors opens the panel
 * at home, and a write that errors loses only the memory of this one pick.
 *
 * `remember: false` is for callers whose pick is not a project: Settings
 * choosing the default folder, and Create, which remembers the folder it MADE
 * (via `rememberProjectFolder`) rather than the parent the user picked.
 *
 * `startAt` skips the lookup and opens exactly there — the quick folder menu
 * (ProjectFolderMenu.tsx) has already fetched the choices, and a favorite opens
 * the chooser INSIDE that folder rather than at the resolved start.
 */
export const pickFolder = (
  message?: string,
  options: { remember?: boolean; startAt?: string } = {}
): Effect.Effect<{ folder?: string | null }, AppError> =>
  // `suspend` so the detection happens when the effect RUNS, not when the
  // module is evaluated — this module is imported dynamically, but SSR would
  // otherwise be free to decide there is no bridge on the server's behalf.
  Effect.suspend(() =>
    Effect.gen(function* () {
      const startPath = options.startAt ?? (yield* projectFolderStart())
      const bridge = folderPickerBridge()
      const result = bridge
        ? yield* Effect.tryPromise({
            try: async () => ({ folder: await bridge.pickFolder(message, startPath) }),
            catch: (cause) =>
              new AppError({ message: "fsOps.pickFolder failed", cause }),
          })
        : yield* httpJson<{ folder?: string | null }>(
            startPath
              ? `/api/pick-folder?defaultPath=${encodeURIComponent(startPath)}`
              : "/api/pick-folder"
          )
      // Only a real pick is remembered — a cancel (`null`) leaves the last
      // folder as it was.
      if (options.remember !== false && typeof result.folder === "string" && result.folder) {
        yield* rememberProjectFolder(result.folder)
      }
      return result
    })
  )

/**
 * The folder the chooser should open at, or undefined to let it pick (home).
 * Never fails: see `pickFolder` — a broken lookup must not cost the user the
 * dialog.
 */
export const projectFolderStart = (): Effect.Effect<string | undefined> =>
  loadProjectFolderChoices().pipe(Effect.map((c) => c.startPath))

/**
 * The quick folder menu's inputs (`/api/pick-folder/start`): the resolved start,
 * the favorites and the last folder — existing folders only — and home, for
 * `~` display. Never fails: an unreachable server is "no choices", which makes
 * the menu step aside and the chooser open where it always did.
 */
export interface ProjectFolderChoices {
  startPath?: string
  favorites: string[]
  last: string | null
  home?: string
}

const NO_CHOICES: ProjectFolderChoices = { favorites: [], last: null }

const nonEmpty = (v: unknown): string | undefined =>
  typeof v === "string" && v ? v : undefined

export const loadProjectFolderChoices = (): Effect.Effect<ProjectFolderChoices> =>
  httpJson<Record<string, unknown>>("/api/pick-folder/start").pipe(
    Effect.map(
      (r): ProjectFolderChoices => ({
        startPath: nonEmpty(r.startPath),
        favorites: normalizeFavorites(r.favorites),
        last: nonEmpty(r.last) ?? null,
        home: nonEmpty(r.home),
      })
    ),
    Effect.orElseSucceed(() => NO_CHOICES)
  )

/**
 * Add or remove a favorite folder. Answers the STORED list afterwards (stale
 * entries included), or `ok: false` when the server refused — `add` takes only
 * an existing absolute directory.
 */
export type FavoritesResult =
  | { ok: true; favorites: string[] }
  | { ok: false; reason: string }

export const updateProjectFolderFavorite = (
  op: "add" | "remove",
  folder: string
): Effect.Effect<FavoritesResult, AppError> =>
  httpPostJson<FavoritesResult>("/api/pick-folder/favorites", { op, folder })

/** Record `folder` as the last project folder. Never fails (best effort). */
export const rememberProjectFolder = (folder: string): Effect.Effect<void> =>
  saveSettings({ [PROJECT_FOLDER_LAST_KEY]: folder }).pipe(
    Effect.asVoid,
    Effect.orElse(() => Effect.void)
  )

/** Set the default project folder, or clear it with `null`. The settings PUT
 *  merges and cannot delete a key, so "cleared" is stored as `null`, which the
 *  start resolver treats exactly like an absent key. */
export const saveProjectFolderDefault = (
  folder: string | null
): Effect.Effect<unknown, AppError> =>
  saveSettings({ [PROJECT_FOLDER_DEFAULT_KEY]: folder })

// ─────────────────────────────────────────────────────────
// /api/create-project
// ─────────────────────────────────────────────────────────

/**
 * A refused name (collision, separator, missing parent) is a NORMAL outcome and
 * arrives as `{ok:false, reason}` with HTTP 200 — same contract as saveNote's
 * conflict. Only genuine faults fail the Effect.
 */
export type CreateProjectResult =
  | { ok: true; path: string }
  | { ok: false; reason: string }

export const createProject = (
  parent: string,
  name: string
): Effect.Effect<CreateProjectResult, AppError> =>
  httpPostJson("/api/create-project", { parent, name })
