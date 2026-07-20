/**
 * Server-only AppRuntime composition.
 *
 * Must be imported from `@cockpit/effect-runtime/server`; **never** from the root
 * package (which is the browser bundle entry).
 */
import { Effect, Layer, ManagedRuntime } from "effect"
import {
  LoggerLivePretty,
  LoggerLiveProd,
  TracerLivePretty,
  TracerLiveNoop,
  ConfigLive,
  CockpitConfig,
} from "@cockpit/effect-core"
import {
  SchedulerLive,
  AgentServiceLive,
  SnapshotServiceLive,
  SessionCleanupLive,
} from "@cockpit/feature-agent/effect"

const isDev = process.env.COCKPIT_ENV === "dev"

const ServerBaseLayer = Layer.unwrapEffect(
  Effect.gen(function* () {
    const cfg = yield* CockpitConfig
    const loggerLayer = isDev ? LoggerLivePretty : LoggerLiveProd(cfg.logFile)
    const tracerLayer = isDev ? TracerLivePretty : TracerLiveNoop
    return Layer.mergeAll(loggerLayer, tracerLayer, ConfigLive)
  })
)

// F1-03 chat-first trim: the DB service layers (Pg / MySQL / Redis / Neo4j /
// Mongo) came from @cockpit/feature-console's database bubbles and were dropped
// with that package, along with the pg / mysql2 / ioredis / neo4j-driver deps.
export const AppLayer = Layer.mergeAll(
  ServerBaseLayer,
  // Scheduler
  SchedulerLive,
  // Agent
  AgentServiceLive,
  // Tool-call snapshots (shadow git)
  SnapshotServiceLive,
  // Ollama session transcript retention (daily sweep)
  SessionCleanupLive
)

export type AppContext = Layer.Layer.Success<typeof AppLayer>

export const AppRuntime = ManagedRuntime.make(AppLayer)

let disposed = false
export const disposeAppRuntime = async (): Promise<void> => {
  if (disposed) return
  disposed = true
  await AppRuntime.dispose()
}
