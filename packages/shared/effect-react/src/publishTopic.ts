/**
 * publishTopic — convenience helper for React components and hooks.
 *
 * Replaces the boilerplate
 * `BrowserRuntime.runFork(Effect.flatMap(IframeBus, (b) => b.publish(...)))`
 * so each call site only needs a single line.
 *
 * Usage:
 *   publishTopic(Topics.OpenProject, { cwd, sessionId })
 */
"use client"

import { Effect } from "effect"
import { IframeBus, type Topic } from "@cockpit/effect-services"
import { BrowserRuntime } from "@cockpit/effect-runtime"

export const publishTopic = <T>(topic: Topic<T>, msg: T): void => {
  BrowserRuntime.runFork(
    Effect.flatMap(IframeBus, (bus) => bus.publish(topic, msg))
  )
}

/**
 * broadcastTopicToFrames — the DOWNWARD half of the bus.
 *
 * `IframeBus.publish` posts to `window.parent` only. From inside an iframe that
 * reaches the shell; from the TOP window `window.parent === window`, so the
 * message never leaves the frame it was sent in and every child iframe misses
 * it. A publisher that lives in a parent-window view (the Settings modal) and a
 * subscriber that lives in a per-project iframe (the composer) therefore need
 * this second call — the same pattern ThemeProvider and useScheduledTasks
 * already hand-roll.
 *
 * The payload is the bus's own merged v1+v2 envelope (`{ type: legacyType,
 * topic: id, msg, ...msg }`), not an ad-hoc object, so a listener written
 * against either shape works and a later bus unification can adopt these call
 * sites without touching their subscribers.
 */
export const broadcastTopicToFrames = <T>(topic: Topic<T>, msg: T): void => {
  if (typeof document === "undefined") return
  const payload = {
    type: topic.legacyType,
    topic: topic.id,
    msg,
    ...(typeof msg === "object" && msg !== null ? msg : {}),
  }
  document.querySelectorAll("iframe").forEach((frame) => {
    try {
      frame.contentWindow?.postMessage(payload, "*")
    } catch {
      /* cross-origin or torn-down frame — nothing to notify */
    }
  })
}

/**
 * Publish a topic in BOTH directions: up to the parent (via the bus) and down
 * into every child iframe. Use it for "something global changed, re-read it"
 * notifications whose publisher and subscriber may sit on either side of the
 * frame boundary.
 */
export const announceTopic = <T>(topic: Topic<T>, msg: T): void => {
  publishTopic(topic, msg)
  broadcastTopicToFrames(topic, msg)
}
