/**
 * Markdown link helpers shared by MarkdownRenderer and its host previews.
 *
 * No external dependency on purpose (avoids pulling in rehype-slug /
 * github-slugger): anchors are resolved by slugifying both the link target
 * and each rendered heading's text with the SAME function, so they stay
 * self-consistent for the common case where the author wrote the anchor as
 * the slug of the heading.
 */

/**
 * GitHub-ish heading slug: lowercase, spaces → '-', drop punctuation
 * (keep CJK / letters / digits / '-' / '_'). Approximate, but applied to
 * both sides of the comparison so it matches for typical headings.
 */
export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s]+/g, '-')
    // strip anything that isn't a word char, CJK, hyphen or underscore
    .replace(/[^\w一-鿿぀-ヿ가-힯-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Scroll the heading matching `rawAnchor` (the part after '#') into view,
 * searching only within `container`. Returns true if a heading was found.
 */
export function scrollToHeadingAnchor(
  container: HTMLElement | null,
  rawAnchor: string,
): boolean {
  if (!container) return false;
  let decoded = rawAnchor;
  try {
    decoded = decodeURIComponent(rawAnchor);
  } catch {
    /* keep raw on malformed escapes */
  }
  const want = slugifyHeading(decoded);
  if (!want) return false;
  const headings = container.querySelectorAll('h1, h2, h3, h4, h5, h6');
  for (const h of headings) {
    if (slugifyHeading(h.textContent || '') === want) {
      h.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return true;
    }
  }
  return false;
}
