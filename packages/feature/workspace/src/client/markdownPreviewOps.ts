/**
 * markdownPreviewOps.ts — the decisions the markdown viewer makes, as pure
 * functions.
 *
 * Same reasoning as fileBrowserOps.ts, which this sits beside: this repo has no
 * component-render harness, so a rule expressed only inside JSX is untested by
 * construction. The things here that can be wrong in a way a user would
 * notice — where a relative link goes (and when it must NOT be followed), where
 * an image's bytes come from, how long the document claims to take to read, and
 * which of the two "open" verbs a double-click means — are decided here and
 * pinned by markdownPreviewOps.test.ts.
 */

import { imageMediaType, isMarkdownFile } from '@cockpit/shared-utils';

// ============================================
// Link classification
// ============================================

/**
 * What the viewer should do with an href the renderer handed back.
 *
 * `external` LEAVES the click alone, so MarkdownRenderer's default
 * `target="_blank" rel="noopener"` anchor takes it out of the app.
 * `unsupported` is CONSUMED and dropped — see `classifyMarkdownLink`.
 */
export type MarkdownLinkTarget =
  | { kind: 'external' }
  | { kind: 'markdown'; rel: string; anchor: string }
  | { kind: 'unsupported' };

const EXTERNAL = { kind: 'external' } as const;
const UNSUPPORTED = { kind: 'unsupported' } as const;

/** The directory part of a cwd-relative file path; '' at the project root. */
function dirOf(rel: string): string {
  const cut = rel.lastIndexOf('/');
  return cut <= 0 ? '' : rel.slice(0, cut);
}

/**
 * Walk `path` from `baseDir` with POSIX `.`/`..` semantics, returning the
 * cwd-relative result — or null when it climbs above the project root.
 *
 * The null is the containment check, and it is not decoration: the viewer turns
 * this string into a `rel` for /api/fs-op, and while that route refuses an
 * escape of its own accord, a UI that offers a link it knows leads out of the
 * project is a UI that produces an error toast for a link the user could see
 * was wrong.
 */
function walkRelative(baseDir: string, path: string): string | null {
  const segments = (baseDir ? baseDir.split('/') : []).concat(path.split(/[/\\]/));
  const out: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.length > 0 ? out.join('/') : null;
}

/** Percent-decode each segment on its own, so an encoded separator inside a
 *  segment cannot become a real one after decoding. Malformed escapes are left
 *  as typed rather than throwing. */
function decodeSegments(path: string): string {
  return path
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
}

/**
 * Decide what an href inside the document at `fromRel` refers to.
 *
 * THE DEFAULT IS "CONSUME AND DROP", NOT "LET IT THROUGH". Anything that is not
 * an absolute URL and not a markdown file inside the project comes back
 * `unsupported`, and the viewer must swallow the click. Letting a bare relative
 * href reach the browser would resolve it against the app's OWN origin and
 * navigate the single-page shell away from the running chat session — the whole
 * app disappears because someone clicked a footnote link.
 *
 * `#anchor`-only hrefs never arrive here: MarkdownRenderer resolves same-
 * document anchors internally before consulting `onLinkClick` (see its `a`
 * component). An anchor SUFFIX on a file link does arrive, and is preserved so
 * the viewer can scroll to it after the new document loads.
 */
export function classifyMarkdownLink(fromRel: string, href: string): MarkdownLinkTarget {
  const raw = href.trim();
  if (!raw) return UNSUPPORTED;
  // A scheme (`https:`, `mailto:`, `vscode:`) or a protocol-relative `//host`
  // is someone else's to open. The scheme must be at least TWO characters: a
  // one-letter prefix before a colon is a Windows drive (`C:/docs/x.md`), and
  // treating that as a URL would hand an absolute local path to the browser.
  if (/^[a-z][a-z0-9+.-]+:/i.test(raw) || raw.startsWith('//')) return EXTERNAL;
  if (raw.startsWith('#')) return UNSUPPORTED;

  const hash = raw.indexOf('#');
  const anchor = hash >= 0 ? raw.slice(hash + 1) : '';
  let path = hash >= 0 ? raw.slice(0, hash) : raw;
  const query = path.indexOf('?');
  if (query >= 0) path = path.slice(0, query);
  if (!path) return UNSUPPORTED;
  // A leading '/' means the filesystem root or the web root, never "the project
  // root" — markdown has no notion of the project, so it cannot have meant that.
  if (path.startsWith('/') || /^[a-z]:[/\\]/i.test(path)) return UNSUPPORTED;

  const rel = walkRelative(dirOf(fromRel), decodeSegments(path));
  if (rel === null) return UNSUPPORTED;
  // Non-markdown neighbours (an image, a .ts file) are inside the project but
  // outside what this viewer renders. v1 drops them rather than half-opening
  // them in a markdown renderer.
  if (!isMarkdownFile(rel)) return UNSUPPORTED;
  return { kind: 'markdown', rel, anchor };
}

// ============================================
// Images
// ============================================

/**
 * What the viewer should do with an image `src` the document supplied.
 *
 * `passthrough` LEAVES THE SRC ALONE — a remote or inline image is the
 * browser's problem, and proxying it would be both slower and a way to make the
 * app fetch arbitrary URLs on a document's say-so. `local` is served through
 * /api/fs-image. `missing` gets a diagnostic placeholder, never a broken-image
 * icon: the overwhelmingly common cause is a relative path written against a
 * different directory, and the user can only see that if we show them the path
 * we actually tried.
 */
export type MarkdownImagePlan =
  | { kind: 'passthrough' }
  | { kind: 'local'; rel: string }
  | { kind: 'missing'; label: string; attempted: string };

const PASSTHROUGH = { kind: 'passthrough' } as const;

/** The last segment of a path, for the placeholder's "which file" half. */
function baseNameOf(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : path;
}

/** How the attempted path READS to the user — project-root-relative, the same
 *  frame of reference as the title bar and the file tree. */
function displayPath(baseDir: string, path: string): string {
  return baseDir ? `${baseDir}/${path}` : path;
}

const missing = (label: string, attempted: string): MarkdownImagePlan => ({
  kind: 'missing',
  label,
  attempted,
});

/**
 * Decide where the image referenced by `src` inside the document at `fromRel`
 * comes from.
 *
 * RESOLVED AGAINST THE DOCUMENT, NOT THE PROJECT ROOT, and that is the whole
 * reason this lives beside `classifyMarkdownLink` and shares its
 * `walkRelative`: the viewer follows links between `.md` files, so the base
 * directory moves as the reader navigates, and a viewer whose links and images
 * disagreed about what "here" means would resolve `./diagram.png` from the
 * wrong folder the moment someone clicked through to a subdirectory. One
 * containment-checked walker answers both questions or neither.
 *
 * The `null` from `walkRelative` is a REFUSAL, not a fallback: a path that
 * climbs above the project root is reported as missing rather than fetched.
 * /api/fs-image would refuse it too, but a UI that emits a request it knows
 * will be denied is a UI that shows a broken image where it could have shown a
 * sentence.
 */
export function planMarkdownImage(fromRel: string, src: string): MarkdownImagePlan {
  const raw = (src ?? '').trim();
  const baseDir = dirOf(fromRel);
  if (!raw) return missing('', '');

  // Inline and remote sources go through untouched — no probing, no lazy
  // attributes, no proxy. Protocol-relative `//host/x.png` is remote too.
  if (/^(?:data|https?):/i.test(raw) || raw.startsWith('//')) return PASSTHROUGH;
  // Any OTHER scheme (`file:`, `vscode:`, `javascript:`) is not something this
  // route can serve and not something to hand the browser. The scheme must be
  // at least TWO characters, or `C:/img/x.png` would be read as one — the same
  // Windows-drive trap `classifyMarkdownLink` documents.
  if (/^[a-z][a-z0-9+.-]+:/i.test(raw)) return missing(baseNameOf(raw), raw);

  const hash = raw.indexOf('#');
  let path = hash >= 0 ? raw.slice(0, hash) : raw;
  const query = path.indexOf('?');
  if (query >= 0) path = path.slice(0, query);
  if (!path) return missing(baseNameOf(raw), raw);
  // A leading '/' means the filesystem or web root, never "the project root" —
  // markdown has no notion of the project, so it cannot have meant that.
  if (path.startsWith('/') || /^[a-z]:[/\\]/i.test(path)) return missing(baseNameOf(path), path);

  const decoded = decodeSegments(path);
  const rel = walkRelative(baseDir, decoded);
  if (rel === null) return missing(baseNameOf(decoded), displayPath(baseDir, decoded));
  // The SHARED whitelist — the same map /api/fs-image serves by. A format the
  // route would refuse must become a placeholder here rather than an `<img>`
  // that quietly fails; see imageFile.ts on why the two must never diverge.
  if (!imageMediaType(rel)) return missing(baseNameOf(rel), rel);
  return { kind: 'local', rel };
}

/**
 * The route URL for a contained, whitelisted `rel`.
 *
 * `encodeURIComponent` on both halves, because a project path may contain `&`,
 * `#`, `+` or a space and any of those would otherwise cut the query in two or
 * silently become a different path. (React assigns `src` as a DOM property
 * rather than parsing an HTML attribute, so the reference editor's
 * `&`-becomes-a-character-reference hazard cannot arise here — but a query
 * parameter still has to be a query parameter.)
 */
export function markdownImageUrl(cwd: string, rel: string): string {
  return `/api/fs-image?cwd=${encodeURIComponent(cwd)}&rel=${encodeURIComponent(rel)}`;
}

/**
 * The width a document image is capped to. NOT a resampling target — nothing in
 * this feature downscales, thumbnails or re-encodes the user's file; the cap is
 * pure CSS and the full-resolution bytes are what the browser receives. A
 * settings knob for it is deliberately out of scope for this pass.
 */
export const IMAGE_MAX_WIDTH_PX = 680;

/** Intrinsic width beyond this multiple of the cap is promoted, not shrunk. */
export const IMAGE_WIDE_FACTOR = 2;

/**
 * Should this image be promoted to the full width of the reading pane?
 *
 * An image more than twice the cap is a screenshot or an architecture diagram,
 * and squeezing one of those into 680px does not make it smaller, it makes it
 * unreadable. Below that, the cap is doing its job.
 *
 * DECIDED HERE, FROM THE PROBED WIDTH, AT RENDER TIME — a deliberate departure
 * from the reference editor, which evaluates the same rule client-side in the
 * image's `load` handler. Deciding on load means the promotion happens AFTER
 * the picture has been laid out at the capped width, which reflows the document
 * exactly the way the injected dimensions exist to prevent. We already know the
 * intrinsic width before the first byte is requested, so there is no reason to
 * wait for it.
 *
 * An unknown width is not wide: an image we could not probe still renders, and
 * it renders under the ordinary cap.
 */
export function isWideImage(intrinsicWidth: number | null | undefined): boolean {
  if (typeof intrinsicWidth !== 'number' || !Number.isFinite(intrinsicWidth)) return false;
  return intrinsicWidth > IMAGE_MAX_WIDTH_PX * IMAGE_WIDE_FACTOR;
}

/**
 * The sentence the placeholder shows: what was named, and what was looked for.
 *
 * BOTH HALVES MATTER. The filename alone reads as "your file is broken"; the
 * attempted path is what reveals that `./img/x.png` was resolved from `docs/`
 * and the file is really at the project root. The result is plain TEXT — the
 * plugin puts it in a text node, so the DOM escapes it and a filename
 * containing `<script>` is shown, not run.
 */
export function formatMissingImage(prefix: string, label: string, attempted: string): string {
  const name = label || attempted;
  if (!name) return prefix;
  return attempted && attempted !== name
    ? `${prefix}: ${name} (${attempted})`
    : `${prefix}: ${name}`;
}

// ============================================
// Word count / reading time
// ============================================

/**
 * Han and kana, which are written WITHOUT spaces and so have to be counted per
 * character. Hangul is deliberately excluded: Korean is spaced into eojeol, so
 * counting it per syllable would triple the count and turn a two-minute
 * document into a six-minute one.
 */
const UNSPACED_CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/g;

/**
 * How many words a reader actually faces.
 *
 * Fenced blocks, inline code and raw HTML tags are removed first — a config
 * dump is not reading time, and counting it makes the estimate a measure of the
 * file rather than of the prose. Link syntax keeps its label and loses its URL
 * for the same reason. Tokens with no letter or digit (`---`, `|`, `>`) are
 * markdown punctuation, not words.
 */
export function countWords(markdown: string): number {
  const prose = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]+`/g, ' ')
    .replace(/<[^>\n]+>/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)\s]*(?:\s[^)]*)?\)/g, '$1');

  const cjk = prose.match(UNSPACED_CJK)?.length ?? 0;
  const spaced = prose.replace(UNSPACED_CJK, ' ');
  const tokens = spaced.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
  return cjk + tokens;
}

/** The prose rate the reference editor used, kept so the two apps agree. */
export const WORDS_PER_MINUTE = 200;

/**
 * Minutes of reading, where 0 means "less than a minute" and the caller is
 * expected to say so in words.
 *
 * Returning 0 rather than rounding up to 1 is the honest answer for a
 * three-line note, and it is the distinction the status line is built on: a
 * viewer that claims "1 minute" for every stub is telling the user nothing.
 */
export function readingTimeMinutes(words: number): number {
  if (words < WORDS_PER_MINUTE) return 0;
  return Math.round(words / WORDS_PER_MINUTE);
}

// ============================================
// Failure reporting
// ============================================

/**
 * Which i18n key explains a refused `read`.
 *
 * `too-large` gets its own sentence for the same reason `exists` does in
 * fileBrowserOps.failureKey: it is a real property of the user's file, not a
 * malfunction, and "could not read this file" would send them looking for a bug.
 */
export function previewErrorKey(reason: string | undefined): string {
  if (reason === 'too-large') return 'markdownPreview.tooLarge';
  return 'markdownPreview.loadError';
}

// ============================================
// Row activation
// ============================================

/** What a double-click on a file-browser row should do. */
export type RowActivation = 'preview' | 'os-open' | 'none';

/**
 * Which "open" a double-click means.
 *
 * Markdown is the ONE extension the app renders better than a hand-off would:
 * everything else goes to the tool the user already chose for it. A folder
 * double-click is two expand toggles and must stay one.
 */
export function rowActivation(entry: { name: string; isDir: boolean }): RowActivation {
  if (entry.isDir) return 'none';
  return isMarkdownFile(entry.name) ? 'preview' : 'os-open';
}
