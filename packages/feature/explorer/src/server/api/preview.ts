/**
 * /api/preview/[...path] — static-server style local file preview
 *
 * Serves an absolute local file path with a Content-Type derived from its
 * extension, so the console browser bubble can render local HTML files in
 * its iframe. Relative asset references inside the page (./style.css,
 * ./app.js, images) resolve back under the same /api/preview prefix, making
 * a report directory behave like a real static site.
 *
 * Known limitation (by design): root-relative references (/assets/x.css)
 * escape the /api/preview prefix and 404 against the app itself.
 */
import { createReadStream } from "fs"
import { Readable } from "stream"
import path from "path"
import { Effect } from "effect"
import { handler } from "@cockpit/effect-runtime/server"
import {
  NotFoundError,
  PermissionError,
  ValidationError,
} from "@cockpit/effect-core"
import {
  statWithSymlink,
  getMimeType,
} from "@cockpit/feature-explorer/server/files/shared"

const PREFIX = "/api/preview/"

/** Text/asset types the shared image/pdf MIME table doesn't cover */
const PREVIEW_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
}

export const GET = handler((req) =>
  Effect.gen(function* () {
    const pathname = new URL(req.url).pathname
    if (!pathname.startsWith(PREFIX)) {
      return yield* Effect.fail(
        new ValidationError({ field: "path", reason: "missing" })
      )
    }

    // "/api/preview/Users/ka/x/index.html" → "/Users/ka/x/index.html"
    const raw = decodeURIComponent(pathname.slice(PREFIX.length - 1))

    // Traversal guard on the decoded segments (catches %2e%2e as well)
    if (raw.includes("\0") || raw.split("/").includes("..")) {
      return yield* Effect.fail(
        new PermissionError({ action: "read", resource: raw })
      )
    }
    const fullPath = path.normalize(raw)

    const info = yield* Effect.tryPromise({
      try: () => statWithSymlink(fullPath),
      catch: (cause) => {
        const code = (cause as NodeJS.ErrnoException)?.code
        return code === "ENOENT"
          ? new NotFoundError({ resource: "file", id: fullPath })
          : new ValidationError({ field: "path", reason: String(cause) })
      },
    })
    if (info.isDirectory) {
      return yield* Effect.fail(
        new ValidationError({ field: "path", reason: "is a directory" })
      )
    }

    const ext = path.extname(fullPath).toLowerCase()
    const contentType = PREVIEW_MIME[ext] ?? getMimeType(ext)

    const stream = createReadStream(fullPath)
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(info.size),
        // Purely local app — no caching (see CLAUDE.md), always serve fresh bytes
        "Cache-Control": "no-store",
      },
    })
  })
)
