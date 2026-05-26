/**
 * /api/projectGraph/context — multi-source semantic context retrieval.
 *
 * Inputs: any combination of `query` / `cursor` / `openFiles`. Returns
 * Top-K coordinates ranked by PPR + TF-IDF + PageRank, each tagged with
 * the signals that pulled it in. See contextBuilder.ts for the algorithm.
 *
 * Query params:
 *   cwd        — absolute project path (validated)
 *   query      — free-text (TF-IDF seed)
 *   cursor     — `<filePath>::<qualifiedName>` or `<filePath>:<line>`
 *   openFiles  — comma-separated project-relative paths
 *   topK       — 1..50, default 15
 *   damping    — 0.5..0.95, default 0.85 (rare to override)
 */
import { Effect } from "effect"
import { getCodeIndex } from "@cockpit/feature-explorer/server/codeMap/projectGraph/codeIndex"
import {
  buildContext,
  getOrTriggerAnalytics,
} from "@cockpit/feature-explorer/server/codeMap/analytics/index"
import { validateCwd } from "@cockpit/feature-explorer/server/files/shared"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { AppError, ValidationError } from "@cockpit/effect-core"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const cwdParam = sp.get("cwd")
    const query = sp.get("query") ?? undefined
    const cursor = sp.get("cursor") ?? undefined
    const openFilesRaw = sp.get("openFiles") ?? ""
    const openFiles = openFilesRaw
      ? openFilesRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined
    const topK = Math.min(
      Math.max(parseInt(sp.get("topK") ?? "15", 10) || 15, 1),
      50,
    )
    const damping = Math.min(
      Math.max(parseFloat(sp.get("damping") ?? "0.85") || 0.85, 0.5),
      0.95,
    )

    const cwdCheck = yield* Effect.promise(() => validateCwd(cwdParam))
    if (!cwdCheck.ok) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: cwdCheck.reason }),
      )
    }
    const hasSeed =
      (query && query.trim().length > 0) ||
      (cursor && cursor.trim().length > 0) ||
      (openFiles && openFiles.length > 0)
    if (!hasSeed) {
      return yield* Effect.fail(
        new ValidationError({
          field: "query|cursor|openFiles",
          reason: "at-least-one-required",
        }),
      )
    }
    const cwd = cwdCheck.abs

    const result = yield* Effect.tryPromise({
      try: async () => {
        const index = await getCodeIndex(cwd)
        const analytics = getOrTriggerAnalytics(cwd, index)
        return buildContext(index, analytics, {
          query,
          cursor,
          openFiles,
          topK,
          damping,
        })
      },
      catch: (cause) =>
        new AppError({ message: "Context lookup failed", cause }),
    })
    return ok(result)
  }),
)
