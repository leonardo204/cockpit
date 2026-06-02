import type { ReactNode } from 'react';

/**
 * Single source of truth for heading anchors. Both the heading renderers in
 * `mdxComponents.tsx` (which set each heading's `id`) and the right-hand "On
 * this page" table of contents (`DocsToc`) derive their slugs from here, so a
 * TOC link and the heading it points at can never drift apart.
 *
 * Mirrors GitHub's Markdown slugging: lowercase, drop punctuation, collapse
 * whitespace to hyphens. Keep `\p{L}\p{N}` so non-Latin (e.g. Chinese)
 * headings still get a usable, stable anchor.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

/**
 * Flatten a heading's React children to plain text so its slug matches the one
 * the source-side TOC extractor produces. Walks into inline elements
 * (`<code>`, `<strong>`, links, …) and keeps their text — unlike a naive
 * string-only check, which would silently drop ``code`` / **bold** words and
 * yield mismatched anchors.
 */
export function nodeToText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join('');
  if (typeof node === 'object' && 'props' in node) {
    return nodeToText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return '';
}

/**
 * Strip the inline Markdown syntax that can appear inside a heading so we get
 * the same plain text `nodeToText` recovers from the rendered React tree.
 * Covers the constructs actually used in our docs headings: inline code,
 * bold/italic/strikethrough markers, links and images.
 */
function inlineMarkdownToText(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images  -> alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links   -> link text
    .replace(/`+([^`]*)`+/g, '$1') // inline code -> code text
    .replace(/(\*\*|__|\*|_|~~)/g, '') // bold/italic/strike markers
    .trim();
}

export interface TocHeading {
  text: string;
  id: string;
}

/**
 * Extract `##` headings from a Markdown source for the TOC. Tracks fenced code
 * blocks so that comment lines like `## not a heading` inside a code sample are
 * ignored. `#` (page title) and `###`+ are skipped — the page title is rendered
 * separately and deeper levels would make the TOC noisy; a flat list of `##`
 * section headings keeps it scannable.
 */
export function extractHeadings(markdown: string): TocHeading[] {
  const headings: TocHeading[] = [];
  let inFence = false;
  let fenceMarker = '';

  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trimEnd();

    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      const marker = fence[1][0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = '';
      }
      continue;
    }
    if (inFence) continue;

    const m = line.match(/^(#{2})\s+(.+?)\s*#*\s*$/);
    if (!m) continue;

    const text = inlineMarkdownToText(m[2]);
    if (!text) continue;

    headings.push({ text, id: slugify(text) });
  }

  return headings;
}
