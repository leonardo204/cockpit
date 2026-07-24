/**
 * Topics — cross-iframe message protocol registry.
 *
 * All 20+ hard-coded `window.parent.postMessage({ type: "..." })` call sites
 * converge here. Any topic change is visible at compile time.
 */
import { defineTopic } from "./iframeBus"

// ─────────────────────────────────────────────────────────
// Type definitions (message payload schemas)
// ─────────────────────────────────────────────────────────

export interface SessionChangePayload {
  readonly cwd: string
  readonly sessionId: string
}

export interface ViewChangePayload {
  readonly cwd: string
  readonly view: "agent" | "explorer" | "console"
}

export interface OpenNotePayload {
  readonly cwd: string
}

export interface LangChangePayload {
  readonly lang: string
}

export interface TabAddPayload {
  readonly title: string
  readonly cwd: string
}

export interface TabClosePayload {
  readonly tabId: string
}

export interface SwitchSessionPayload {
  readonly sessionId: string
  readonly cwd: string
}

export interface ProjectChangePayload {
  readonly projectId: string
  readonly cwd: string
}

// ─────────────────────────────────────────────────────────
// Topics for the remaining 12 postMessage call sites.
// ─────────────────────────────────────────────────────────

export interface OpenProjectPayload {
  readonly cwd: string
  readonly sessionId?: string
}

export interface SessionCompletePayload {
  readonly cwd: string
  readonly sessionId: string
  readonly lastUserMessage?: string
}

export interface ScreenshotPreparePayload {
  readonly cwd: string
}

/**
 * "The last tab in this project was closed — take me home."
 *
 * The tab bar lives inside the per-project iframe, but the home screen is a
 * PARENT-window view (Workspace's EmptyState). The iframe therefore cannot
 * navigate itself home; it can only say that it should be left, which is what
 * this topic carries. `cwd` identifies the sender so the parent ignores a
 * message from a project it is no longer showing.
 */
export interface GoHomePayload {
  readonly cwd: string
}

// ─────────────────────────────────────────────────────────
// Topics table — single source of truth; add new protocols here.
// ─────────────────────────────────────────────────────────

export const Topics = {
  SessionChange: defineTopic<SessionChangePayload>("session-change"),
  ViewChange: defineTopic<ViewChangePayload>("view-change"),
  OpenNote: defineTopic<OpenNotePayload>("open-note"),
  LangChange: defineTopic<LangChangePayload>("lang-change"),
  TabAdd: defineTopic<TabAddPayload>("tab-add"),
  TabClose: defineTopic<TabClosePayload>("tab-close"),
  SwitchSession: defineTopic<SwitchSessionPayload>("switch-session"),
  ProjectChange: defineTopic<ProjectChangePayload>("project-change"),

  OpenProject: defineTopic<OpenProjectPayload>("open-project"),
  SessionComplete: defineTopic<SessionCompletePayload>("session-complete"),
  OpenTokenStats: defineTopic<Record<string, never>>("open-token-stats"),
  // "Open the app Settings modal." The modal is a PARENT-window view (Workspace),
  // but the engine switcher / chat header that ask for it live inside the
  // per-project iframe, so the request crosses the frame boundary like the other
  // parent-owned modals (token stats, notes). legacyType → "OPEN_SETTINGS".
  OpenSettings: defineTopic<Record<string, never>>("open-settings"),
  PinnedSessionsChanged: defineTopic<Record<string, never>>(
    "pinned-sessions-changed"
  ),
  ScheduledTasksChanged: defineTopic<Record<string, never>>(
    "scheduled-tasks-changed"
  ),
  ScreenshotPrepare: defineTopic<ScreenshotPreparePayload>(
    "screenshot-prepare"
  ),
  ScreenshotDone: defineTopic<Record<string, never>>("screenshot-done"),
  GoHome: defineTopic<GoHomePayload>("go-home"),
} as const

export type TopicId = (typeof Topics)[keyof typeof Topics]["id"]
