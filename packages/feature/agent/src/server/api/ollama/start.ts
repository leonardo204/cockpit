/**
 * /api/ollama/start — P8+ migration
 */
import { spawn, execSync } from "child_process"
import { Effect } from "effect"
import { resolveOllamaBaseURL } from "@cockpit/shared-utils"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { AppError, NotFoundError } from "@cockpit/effect-core"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function isOllamaRunning(): Promise<boolean> {
  try {
    // Health-check the configured server (config file > env > default). Note the
    // spawned fallback is always the LOCAL `ollama serve`; a remote baseUrl that
    // is down won't be helped by spawning locally — that boundary is unchanged.
    const base = await resolveOllamaBaseURL()
    const res = await fetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    })
    return res.ok
  } catch {
    return false
  }
}

function findOllama(): string | null {
  try {
    return execSync("which ollama", { encoding: "utf-8" }).trim() || null
  } catch {
    return null
  }
}

export const POST = handler(() =>
  Effect.gen(function* () {
    if (yield* Effect.promise(() => isOllamaRunning())) {
      return ok({ status: "already_running" })
    }

    const ollamaPath = findOllama()
    if (!ollamaPath) {
      return yield* Effect.fail(
        new NotFoundError({ resource: "binary", id: "ollama" })
      )
    }

    yield* Effect.sync(() => {
      const child = spawn(ollamaPath, ["serve"], {
        detached: true,
        stdio: "ignore",
      })
      child.unref()
    })

    // Wait for readiness (up to 8s)
    const started = yield* Effect.promise(async () => {
      for (let i = 0; i < 16; i++) {
        await new Promise((r) => setTimeout(r, 500))
        if (await isOllamaRunning()) return true
      }
      return false
    })

    if (!started) {
      return yield* Effect.fail(
        new AppError({
          message: "Ollama started but not responding yet (timeout)",
        })
      )
    }
    return ok({ status: "started" })
  })
)
