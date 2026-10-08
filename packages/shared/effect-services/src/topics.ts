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

/**
 * "Open Settings" may name the section to land on (the chat status bar opens
 * Harness, or Connections at the Skill Hub key). Absent = wherever Settings was
 * left. `focus` names a `data-settings-anchor` inside that section to scroll to
 * and focus once it renders.
 */
export interface OpenSettingsPayload {
  readonly section?: string
  readonly focus?: string
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
  OpenSettings: defineTopic<OpenSettingsPayload>("open-settings"),
  PinnedSessionsChanged: defineTopic<Record<string, never>>(
    "pinned-sessions-changed"
  ),
  ScheduledTasksChanged: defineTopic<Record<string, never>>(
    "scheduled-tasks-changed"
  ),
  // "A harness item's visibility changed — re-read anything derived from it."
  //
  // Enabling a skill/command/subagent changes what `/` may offer, but the
  // Settings modal that flips it lives in the TOP window while the composer that
  // renders the palette lives in a per-project iframe that never unmounts. With
  // no signal crossing that boundary the palette kept whatever it fetched when
  // the project was opened, so a freshly enabled skill stayed invisible until the
  // app restarted. Publishers must reach BOTH directions — see
  // `broadcastTopicToFrames` (parent → children); `publishTopic` alone only ever
  // reaches window.parent. legacyType → "HARNESS_CHANGED".
  HarnessChanged: defineTopic<Record<string, never>>("harness-changed"),
  // "Atlassian or Skill Hub status may have changed — re-read it." The chat
  // status bar polls per frame (each project iframe is its own JS realm), so a
  // sign-in, a sync or a toggle done in the TOP window's Settings reaches the
  // bars only through this. Publish with `announceTopic` (both directions).
  // legacyType → "CONNECTIONS_CHANGED".
  ConnectionsChanged: defineTopic<Record<string, never>>("connections-changed"),
  ScreenshotPrepare: defineTopic<ScreenshotPreparePayload>(
    "screenshot-prepare"
  ),
  ScreenshotDone: defineTopic<Record<string, never>>("screenshot-done"),
  GoHome: defineTopic<GoHomePayload>("go-home"),
} as const

export type TopicId = (typeof Topics)[keyof typeof Topics]["id"]
