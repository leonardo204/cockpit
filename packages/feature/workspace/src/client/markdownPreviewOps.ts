/**
 * markdownPreviewOps.ts — the decisions the markdown viewer makes, as pure
 * functions.
 *
 * Same reasoning as fileBrowserOps.ts, which this sits beside: this repo has no
 * component-render harness, so a rule expressed only inside JSX is untested by
 * construction. The three things here that can be wrong in a way a user would
 * notice — where a relative link goes (and when it must NOT be followed), how
 * long the document claims to take to read, and which of the two "open" verbs a
 * double-click means — are decided here and pinned by markdownPreviewOps.test.ts.
 */

import { isMarkdownFile } from '@cockpit/shared-utils';

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
