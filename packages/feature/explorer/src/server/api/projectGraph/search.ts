/**
 * /api/projectGraph/search — P8+ migration
 *
 * Query params:
 *   cwd              — absolute project path (validated)
 *   q                — search query; separator/case-folded before
 *                      matching, so `user_profile` / `userProfile` /
 *                      `user-profile` / `USER_PROFILE` all hit the
 *                      same indexed names
 *   limit            — per-category cap (1–100, default 15)
 *   includeLiterals  — when "true"/"1", also search identifier-shaped
 *                      string literals harvested from source. Surfaces
 *                      tool names / event names / config keys / route
 *                      paths that live only as string literals (e.g.
 *                      `name: "user_profile"`) and would otherwise be
 *                      invisible to symbol-only search. Off by default
 *                      to keep Cmd+K palette responses lean.
 */
import { Effect } from "effect"
import {
  getCodeIndex,
  searchIndex,
} from "@cockpit/feature-explorer/server/codeMap/projectGraph/codeIndex"
import { validateCwd } from "@cockpit/feature-explorer/server/files/shared"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { AppError, ValidationError } from "@cockpit/effect-core"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function parseBool(v: string | null): boolean {
  if (!v) return false
  const s = v.toLowerCase()
  return s === "true" || s === "1" || s === "yes"
}

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const cwdParam = sp.get("cwd")
    const q = sp.get("q") ?? ""
    const limit = Math.min(
      Math.max(parseInt(sp.get("limit") ?? "15", 10) || 15, 1),
      100
    )
    const includeLiterals = parseBool(sp.get("includeLiterals"))
    const cwdCheck = yield* Effect.promise(() => validateCwd(cwdParam))
    if (!cwdCheck.ok) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: cwdCheck.reason })
      )
    }
    const cwd = cwdCheck.abs
    if (q.trim().length < 1) {
      return ok(
        includeLiterals
          ? { files: [], symbols: [], literals: [] }
          : { files: [], symbols: [] }
      )
    }
    const result = yield* Effect.tryPromise({
      try: async () => {
        const index = await getCodeIndex(cwd)
        return searchIndex(index, q, limit, { includeLiterals })
      },
      catch: (cause) =>
        new AppError({ message: "Search failed", cause }),
    })
    return ok(result)
  })
)
