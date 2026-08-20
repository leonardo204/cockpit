/**
 * /api/fs-image — the bytes behind `![](./diagram.png)`, and the header probe
 * that lets the viewer reserve a box for it before they arrive.
 *
 * WHY A ROUTE AND NOT A DATA URI. The markdown viewer used to hand
 * `./diagram.png` straight to the browser, which resolved it against the app's
 * OWN origin and 404'd — no route in the app served binary content at all.
 * The obvious repair, inlining the bytes as base64 into the `src`, is the one
 * approach that must NOT be taken: the reference editor this port follows
 * measured a 56-image document growing from 358 KB of HTML to 3.7 MB when
 * inlined, and a data URI bypasses the engine's image cache entirely, so every
 * re-render decodes every picture again. A URL is cacheable, lazy-loadable, and
 * costs the document nothing but a few dozen characters.
 *
 * WHY HTTP RATHER THAN A CUSTOM PROTOCOL. The reference is a WebKit app and
 * registers a scheme. We are a Next server, so this is an ordinary route —
 * which is strictly better here: it works in the packaged Electron app and in a
 * plain browser tab with no protocol registration on either side.
 *
 * SCOPE & SAFETY — THE SAME GUARD AS /api/fs-op, ORDERED THE SAME WAY. A
 * markdown file must never become a way to read an arbitrary file off the disk,
 * and a markdown file is a document the user may not have written. `cwd` is the
 * project root already open in the app, `rel` names an entry under it, and the
 * target is RESOLVED FIRST and then checked with the shared `withinCwd`
 * (src/lib/fsScope.ts) — resolving after checking would let `a/../../etc` pass
 * a string test and then escape. On top of containment there is an extension
 * whitelist, so even a contained path only yields bytes when it is a format the
 * viewer shows: `?rel=.env` is refused before it is opened.
 *
 * THE WHITELIST IS THE SHARED ONE (`imageMediaType`, @cockpit/shared-utils).
 * The client rewriter consults the same map to decide whether to emit an `<img>`
 * at all. If the two ever diverge the reader gets a broken-image icon instead
 * of the placeholder that explains itself — a silent failure. One constant.
 *
 * REFUSALS ARE HTTP STATUS CODES HERE, not the `{ok:false, reason}` value the
 * sibling routes use, because the GET's only client is an `<img>` element and
 * an image element cannot read a JSON body. The POST probe, whose client is
 * ordinary code, keeps the house style.
 *
 * SVG HARDENING. SVG is served as `image/svg+xml` and reaches the page only
 * through `<img>`, where script inside it cannot run. `nosniff` keeps the
 * declared type binding, and the response carries its own
 * `default-src 'none'; sandbox` CSP so that a user who navigates DIRECTLY to
 * one of these URLs — the one context where the SVG is a document rather than
 * an image — still gets no script. Nothing in the viewer path routes an image
 * into `<object>` or `<embed>`; keep it that way.
 */
import { readFile, stat } from "fs/promises"
import { isAbsolute, join, resolve } from "path"
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { imageMediaType } from "@cockpit/shared-utils"
import { withinCwd } from "../../../lib/fsScope"
import {
  createDimensionCache,
  dimensionCacheKey,
  probeImageSize,
  type CachedSize,
} from "../../../lib/imageDimensions"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Past this an image is not something a markdown reader is waiting on, and
 * `readFile` would materialise the whole thing in the server's heap. A refusal
 * the viewer turns into a placeholder is the better answer.
 */
const MAX_IMAGE_BYTES = 64 * 1024 * 1024

/** One probe request covers one document. A markdown file with more images
 *  than this is not a document anyone is reading top to bottom. */
const MAX_PROBE_BATCH = 300

/**
 * Module scope, and deliberately so. This holds two integers per entry behind a
 * hard bound (see createDimensionCache) — a cache, not a resource, so EFFECT.md
 * §4's "never globalThis singletons" rule, which is about pools and
 * subprocesses that need finalising, does not apply. It exists because the
 * preview re-renders constantly and re-opening dozens of image headers on every
 * render is pure waste.
 */
const DIMENSIONS = createDimensionCache(512)

/** The strong validator for a file's current contents. Keyed on mtime AND
 *  length so a replaced file invalidates without anyone running a watcher. */
const etagOf = (mtimeMs: number, byteSize: number) => `"${Math.floor(mtimeMs)}-${byteSize}"`

/** A conditional request matches when any of its ETags is ours; `W/` prefixes
 *  are stripped because a weak validator for identical bytes is still a match. */
function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false
  if (header.trim() === "*") return true
  return header
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//, ""))
    .includes(etag)
}

const refuse = (status: number, reason: string) =>
  new Response(JSON.stringify({ ok: false, reason }), {
    status,
    headers: { "content-type": "application/json" },
  })

// ─────────────────────────────────────────────────────────
// GET — the bytes
// ─────────────────────────────────────────────────────────

export const GET = handler((req) =>
  Effect.gen(function* () {
    const params = new URL(req.url).searchParams
    const cwd = (params.get("cwd") ?? "").trim()
    const rel = (params.get("rel") ?? "").trim()

    if (!cwd || !isAbsolute(cwd)) return refuse(400, "invalid-cwd")
    // The project root is a directory; there is no image at the empty path.
    if (!rel) return refuse(400, "invalid-target")

    // Resolve, THEN contain — the ordering /api/fs-op uses, and the only one
    // that survives a `..` buried in the middle of the path.
    const target = resolve(join(cwd, rel))
    if (!withinCwd(cwd, target)) return refuse(403, "escape")

    // Checked before the file is opened: a contained path is not enough on its
    // own to make something readable through this route.
    const mediaType = imageMediaType(rel)
    if (!mediaType) return refuse(415, "unsupported-type")

    const info = yield* Effect.tryPromise({
      try: () => stat(target),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null))
    if (!info) return refuse(404, "not-found")
    // A directory named `img.png` is not an image, and `readFile` on one throws
    // EISDIR — refused as not-found rather than as a server failure.
    if (info.isDirectory()) return refuse(404, "not-found")
    if (info.size > MAX_IMAGE_BYTES) return refuse(413, "too-large")

    const etag = etagOf(info.mtimeMs, info.size)
    const headers: Record<string, string> = {
      "content-type": mediaType,
      etag,
      // The working tree changes under the viewer, so the browser revalidates
      // rather than trusting a stale copy. A revalidation against a local
      // server is a sub-10ms 304 with no body (see shell/CLAUDE.md on latency),
      // and the ETag above is what makes it free.
      "cache-control": "private, max-age=0, must-revalidate",
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
      "content-security-policy": "default-src 'none'; sandbox",
    }

    if (etagMatches(req.headers.get("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers })
    }

    const bytes = yield* Effect.tryPromise({
      // On the libuv threadpool, not the event loop. Bounded by the size check
      // above, which is what makes buffering the whole file acceptable.
      try: () => readFile(target),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null))
    if (!bytes) return refuse(404, "not-found")

    return new Response(bytes, { status: 200, headers })
  }),
)

// ─────────────────────────────────────────────────────────
// POST — the header probe, in one batch per document
// ─────────────────────────────────────────────────────────

interface ProbeBody {
  readonly cwd?: string
  readonly rels?: unknown
}

/**
 * One image's dimensions, as a `[rel, size]` pair so the batch can be
 * reassembled without a shared mutable map.
 *
 * NEVER FAILS. The three gates below are the SAME three GET applies, in the
 * same order — a probe must not be a weaker door into the filesystem than the
 * fetch it precedes — but a refusal here is a `null`, not an error: an image
 * whose dimensions are unknown must still render.
 */
const probeOne = (
  cwd: string,
  rel: string,
): Effect.Effect<readonly [string, CachedSize]> =>
  Effect.tryPromise({
    try: async (): Promise<CachedSize> => {
      const target = resolve(join(cwd, rel))
      if (!withinCwd(cwd, target) || !imageMediaType(rel)) return null
      const info = await stat(target).catch(() => null)
      if (!info || info.isDirectory() || info.size > MAX_IMAGE_BYTES) return null

      const key = dimensionCacheKey(target, info.mtimeMs, info.size)
      const cached = DIMENSIONS.get(key)
      if (cached !== undefined) return cached

      const probed = await probeImageSize(target)
      DIMENSIONS.set(key, probed)
      return probed
    },
    catch: () => null,
  }).pipe(
    Effect.orElseSucceed(() => null),
    Effect.map((size) => [rel, size] as const),
  )

/**
 * `{ cwd, rels }` → `{ ok:true, sizes: { [rel]: {width,height} | null } }`.
 *
 * ONE REQUEST PER DOCUMENT, not one per image: a document of fifty screenshots
 * would otherwise open fifty connections before it could lay itself out.
 *
 * A rel that is refused answers `null` rather than dropping out of the map or
 * failing the batch. The caller needs "asked, and there is no answer" to be
 * distinguishable from "not asked yet", or it re-probes the same broken path on
 * every render; and an image with no dimensions must still render, so a refusal
 * here is never fatal.
 */
export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as ProbeBody
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : ""
    if (!cwd || !isAbsolute(cwd)) return ok({ ok: false as const, reason: "invalid-cwd" })
    if (!Array.isArray(body.rels)) return ok({ ok: false as const, reason: "invalid-target" })

    const rels = (body.rels as unknown[])
      .filter((r): r is string => typeof r === "string" && r.trim().length > 0)
      .map((r) => r.trim())
      .slice(0, MAX_PROBE_BATCH)

    // Unbounded, because each probe is a `stat` plus a header read and
    // `image-size` runs its own file-handle limiter underneath.
    const probed = yield* Effect.all(
      rels.map((rel) => probeOne(cwd, rel)),
      { concurrency: "unbounded" },
    )

    const sizes: Record<string, CachedSize> = {}
    for (const [rel, size] of probed) sizes[rel] = size

    return ok({ ok: true as const, sizes })
  }),
)
