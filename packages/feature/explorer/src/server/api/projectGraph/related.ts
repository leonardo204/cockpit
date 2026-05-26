/**
 * /api/projectGraph/related — broader 1-hop relatedness around a symbol.
 *
 * Returns callers / callees plus PPR neighbours plus coedit partners.
 * Each result carries one or more `relations` tags explaining why it's
 * here. See relatedBuilder.ts for the algorithm.
 *
 * Query params:
 *   cwd       — absolute project path (validated)
 *   qname     — qualified name (e.g. `Class>method`)
 *   filePath  — optional disambiguation for cross-file name collisions
 *   topK      — 1..30, default 10
 *   include   — structural | coedit | all (default all)
 */
import { Effect } from "effect"
import { getCodeIndex } from "@cockpit/feature-explorer/server/codeMap/projectGraph/codeIndex"
import {
  buildRelated,
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
    const topK = Math.min(
      Math.max(parseInt(sp.get("topK") ?? "10", 10) || 10, 1),
      30,
    )
    const includeRaw = (sp.get("include") ?? "all").toLowerCase()
    const include: "structural" | "coedit" | "all" =
      includeRaw === "structural" || includeRaw === "coedit"
        ? includeRaw
        : "all"

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
        return await buildRelated(index, analytics, {
          qname,
          filePath,
          topK,
          include,
        })
      },
      catch: (cause) =>
        new AppError({ message: "Related lookup failed", cause }),
    })
    return ok(result)
  }),
)
