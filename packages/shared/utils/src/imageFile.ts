/**
 * imageFile.ts — "may this file be shown as an image, and as what type?",
 * asked in exactly one place.
 *
 * WHY IT IS ITS OWN MODULE IN A SHARED PACKAGE, and why this is the one rule in
 * the image path that must never be duplicated. Two parties consult it and they
 * live on opposite sides of the wire: the markdown viewer's REWRITER (client)
 * decides whether `![](./x.png)` becomes a URL or a "cannot show this"
 * placeholder, and /api/fs-image (server) decides whether to hand the bytes
 * over and under which `Content-Type`. If those two lists ever drift, the
 * failure is SILENT in the worst direction — the rewriter emits an `<img>` for
 * a format the route then refuses, so the reader gets a broken-image icon with
 * no explanation, which is precisely the outcome the placeholder exists to
 * prevent. One exported map, both callers import it.
 *
 * HEIC AND HEIF ARE DELIBERATELY ABSENT. The reference editor this port follows
 * whitelists them because it renders through WebKit, which decodes HEIC.
 * Chromium does not, and this app is Electron. Whitelisting a format the
 * renderer cannot decode produces a blank frame where the image should be —
 * strictly worse than the placeholder, which at least names the file and says
 * what went wrong. Leaving them out routes them to the placeholder.
 */

/**
 * The extensions the viewer serves, mapped to the `Content-Type` the route
 * sends. Keys are lowercase and carry no leading dot.
 *
 * `jfif` is here because it is a plain JPEG that Windows tooling likes to emit;
 * `ico` is served as `image/x-icon` rather than the newer `image/vnd.microsoft.icon`
 * because every browser accepts the former and not every one accepts the latter.
 */
export const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  avif: 'image/avif',
  ico: 'image/x-icon',
});

/**
 * The MIME type this name or path should be served as, or null when it is not
 * a format the viewer shows.
 *
 * Takes a bare name or a path with either separator, for the same reason
 * `isMarkdownFile` does: callers hold `rel` strings, markdown sources and plain
 * entry names, and none of them should have to split the basename off first.
 * Case-insensitive (`DIAGRAM.PNG` is a file people really have), and a name
 * that is NOTHING but an extension (`.png`) is a dotfile rather than an image —
 * the same distinction drawn in markdownFile.ts and fsScope.ts.
 */
export function imageMediaType(nameOrPath: string): string | null {
  if (!nameOrPath) return null;
  const base = nameOrPath.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  // `dot <= 0` covers both "no extension at all" and the leading-dot dotfile.
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return IMAGE_MIME_TYPES[ext] ?? null;
}

/** Is this name or path something the viewer will show as an image? */
export function isImageFile(nameOrPath: string): boolean {
  return imageMediaType(nameOrPath) !== null;
}
