/**
 * /api/projectGraph/risk — risk-scored impact analysis.
 *
 * Wraps the existing `impactFromIndex` BFS and overlays a risk score
 * (callFreq + coeditProb + hasTest + pagerank) on every impacted node.
 * Returns the top-K high-risk nodes plus a suggestedTests array.
 *
 * Query params:
 *   cwd       — absolute project path (validated)
 *   qname     — qualified name of the symbol being changed
 *   filePath  — optional disambiguation
 *   depth     — 1..5, default 2 (same as /impact)
 *   topK      — 1..50, default 20
 */
import { Effect } from "effect"
import { getCodeIndex } from "@cockpit/feature-explorer/server/codeMap/projectGraph/codeIndex"
import {
  scoreImpact,
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
    const qname = sp.get("qname") ?? ""
    const filePath = sp.get("filePath") ?? undefined
    const depth = Math.min(
      Math.max(parseInt(sp.get("depth") ?? "2", 10) || 2, 1),
      5,
    )
    const topK = Math.min(
      Math.max(parseInt(sp.get("topK") ?? "20", 10) || 20, 1),
      50,
    )

    const cwdCheck = yield* Effect.promise(() => validateCwd(cwdParam))
    if (!cwdCheck.ok) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: cwdCheck.reason }),
      )
    }
    if (qname.trim().length < 1) {
      return yield* Effect.fail(
        new ValidationError({ field: "qname", reason: "missing" }),
      )
    }
    const cwd = cwdCheck.abs

    const result = yield* Effect.tryPromise({
      try: async () => {
        const index = await getCodeIndex(cwd)
        const analytics = getOrTriggerAnalytics(cwd, index)
        return await scoreImpact(index, analytics, {
          qname,
          filePath,
          depth,
          topK,
        })
      },
      catch: (cause) =>
        new AppError({ message: "Risk analysis failed", cause }),
    })
    return ok(result)
  }),
)
