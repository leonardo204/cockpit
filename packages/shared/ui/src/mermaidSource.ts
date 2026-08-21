/**
 * mermaidSource.ts — everything the diagram renderer decides BEFORE a browser is
 * involved: how a diagram's source has to be doctored so mermaid 11 reads it the
 * way the author wrote it, and what configuration mermaid is initialised with.
 *
 * PURE AND DOM-FREE ON PURPOSE. The rendering half (`MermaidDiagram.tsx`) can
 * only be exercised in a browser, and this repo has no component-render harness
 * for that path (see the header of markdownPreviewOps.ts, the precedent this
 * file follows). The parts that can be silently WRONG — a Korean numbered label
 * that mermaid swallows, a security level that quietly permits click handlers —
 * are decided here and pinned by mermaidSource.test.ts.
 */

/**
 * U+200B. Occupies no width, breaks no glyph, and is invisible in an SVG label —
 * which is the entire reason it can be used to disarm a markdown marker without
 * changing what the reader sees.
 */
export const ZERO_WIDTH_SPACE = '\u200B';

/** The fence info string this renderer claims. */
export const MERMAID_LANGUAGE = 'mermaid';

/** Longest run of digits still treated as an ordered-list marker. Marked's own
 *  list rule stops at nine, and so does this: a ten-digit number followed by a
 *  dot is an id or a timestamp, not a list. */
const MAX_ORDERED_MARKER_DIGITS = 9;

/** Markers that only bite when whitespace follows them — the rule that lets
 *  `*emphasis*` and `-5°C` through untouched. */
const SPACE_DELIMITED_MARKERS = new Set(['-', '*', '+', '#']);

/** `<br>` in any of the spellings mermaid normalises before it lexes a label. */
const LINE_BREAK_TAG = /^<br\s*\/?>/i;

/** Mermaid's own delimiter for a markdown label. It is stripped before the text
 *  reaches marked, so it does not consume the start of the line either. */
const MARKDOWN_LABEL_TICK = '`';

function isSpaceOrTab(char: string | undefined): boolean {
  return char === ' ' || char === '\t';
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

/**
 * Disarm markdown block markers inside quoted mermaid labels.
 *
 * WHY THIS EXISTS. Mermaid 11 runs MARKDOWN labels through a markdown parser
 * (`marked.lexer`, see handle-markdown-text in the package) and renders any
 * token type it does not handle from that token's RAW source — logging
 * `Unsupported markdown: <type>` and dropping the paragraph handling that
 * produces the label's line breaks. A label like `1. 항목` lexes as a LIST, so
 * that is exactly what happens to it, and a Korean numbered label hits the case
 * on the first try.
 *
 * MEASURED IN 11.17, in Chromium, guarded against unguarded (the two forms a
 * label can take):
 *
 *     A["`1. 항목`"]              →  1. 항목                    (raw, no <p>)
 *     A["`<ZWSP>1. 항목`"]         →  <p><ZWSP>1. 항목</p>       (the text path)
 *     A["`1. 항목<br/>2. 다음`"]  →  1. 항목<br>2. 다음         (raw, no <p>)
 *     A["`**bold**`"]             →  <p><strong>bold</strong></p>  (both ways)
 *
 * A PLAIN quoted label — `A["1. 항목"]`, no backticks — is not markdown-lexed in
 * 11.17 at all, so there the guard changes nothing a reader can see: it inserts
 * an invisible character into text that was already going to render correctly.
 * It is applied to both forms anyway. Which labels mermaid treats as markdown is
 * a decision inside the package (it varies by diagram type and has changed
 * between minor versions), and the cost of guarding a label that did not need it
 * is a zero-width space; the cost of missing one is a mangled diagram.
 *
 * WHY A ZERO-WIDTH SPACE. Every block rule in marked is `^`-anchored, so one
 * invisible character in front of the marker takes the line out of the block
 * grammar entirely and leaves it a paragraph. Verified against the lexer marked
 * ships with mermaid 11.17:
 *
 *     "1. 항목"  → list        "<ZWSP>1. 항목"  → paragraph
 *     "- item"   → list        "<ZWSP>- item"   → paragraph
 *     "* bullet" → list        "<ZWSP>* bullet" → paragraph
 *     "# head"   → heading     "<ZWSP># head"   → paragraph
 *     "> quote"  → blockquote  "<ZWSP>> quote"  → paragraph
 *     "*emph*"   → paragraph   (untouched — no space after the marker)
 *
 * The space is inserted BEFORE the marker, never after: `><ZWSP> quote` still
 * lexes as a blockquote, because the rule matches the `>` itself.
 *
 * ONLY INSIDE QUOTES. Outside a quoted label, `-` is an edge (`A --> B`), `>` is
 * an arrowhead and `#` starts an entity code; rewriting those would corrupt the
 * diagram rather than protect it.
 *
 * AND ONLY AT THE START OF A LINE, which is a deviation from the reference
 * implementation and is not optional. Marked's block rules are `^`-anchored, so
 * a marker anywhere else was never going to open a block — while rewriting one
 * BREAKS text that was fine: the second asterisk of `**bold** and` is followed
 * by a space, so a position-blind rule inserts a zero-width space between the
 * two closing asterisks and the label renders as a literal `**bold*` plus a
 * stray `*`. The emphasis a markdown label exists for, destroyed by the guard
 * meant to protect it. A "line" here begins at the opening quote, after a
 * newline, or after a `<br/>` (mermaid rewrites those to newlines before it
 * lexes); leading whitespace and the backticks that mark a label as markdown do
 * not end it.
 *
 * AND NOTHING AT ALL WHEN THE QUOTES DO NOT BALANCE. An odd number of `"` means
 * we cannot tell a label from the syntax around it, and a guess would edit
 * arbitrary diagram source. Returning the input untouched leaves the author with
 * whatever mermaid makes of it — which is the honest outcome, since their source
 * is already malformed.
 *
 * Idempotent: a marker already preceded by a zero-width space is left alone, so
 * re-rendering the same document (a theme switch does exactly that) cannot
 * accumulate them.
 */
export function guardMermaidLabelMarkdown(source: string): string {
  if (!source.includes('"')) return source;
  // Bail out on unbalanced quoting — see the header.
  let quoteCount = 0;
  for (const char of source) if (char === '"') quoteCount++;
  if (quoteCount % 2 !== 0) return source;

  let out = '';
  let inQuotes = false;
  /** Whether the next character begins a LINE, as marked will see it. */
  let atLineStart = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i] as string;

    if (char === '"') {
      inQuotes = !inQuotes;
      // The opening quote begins the label, and a label begins a line.
      atLineStart = inQuotes;
      out += char;
      continue;
    }

    if (!inQuotes) {
      out += char;
      continue;
    }

    if (char === '\n') {
      out += char;
      atLineStart = true;
      continue;
    }

    // Mermaid rewrites `<br/>` to a newline before lexing, so a marker sitting
    // after one IS at the start of a line by the time marked sees it.
    const lineBreak = LINE_BREAK_TAG.exec(source.slice(i));
    if (lineBreak) {
      out += lineBreak[0];
      i += lineBreak[0].length - 1;
      atLineStart = true;
      continue;
    }

    // Leading whitespace does not end a line start — marked allows up to three
    // spaces of indent in front of every block marker. Neither does the
    // backtick that marks the label as markdown in the first place.
    if (isSpaceOrTab(char) || char === MARKDOWN_LABEL_TICK) {
      out += char;
      continue;
    }

    // Already guarded (this function ran before): leave it, and note that the
    // marker after it is no longer at a line start for our purposes.
    if (char === ZERO_WIDTH_SPACE) {
      out += char;
      atLineStart = false;
      continue;
    }

    if (!atLineStart) {
      out += char;
      continue;
    }
    atLineStart = false;

    // `1.` / `1)` — a bounded digit run, then the delimiter, then whitespace.
    if (isDigit(char)) {
      let end = i;
      while (end < source.length && isDigit(source[end])) end++;
      const digits = end - i;
      const delimiter = source[end];
      if (
        digits <= MAX_ORDERED_MARKER_DIGITS &&
        (delimiter === '.' || delimiter === ')') &&
        isSpaceOrTab(source[end + 1])
      ) {
        out += ZERO_WIDTH_SPACE + source.slice(i, end + 2);
        i = end + 1;
        continue;
      }
      // Not a marker: emit the whole run so a later digit cannot restart this
      // test in the middle of a number (`12. ` must not become `1` + `2. `).
      out += source.slice(i, end);
      i = end - 1;
      continue;
    }

    // `-` / `*` / `+` / `#` — markers only when whitespace follows, which is
    // what keeps `*emphasis*`, `A-B` and `#red` intact.
    if (SPACE_DELIMITED_MARKERS.has(char) && isSpaceOrTab(source[i + 1])) {
      out += ZERO_WIDTH_SPACE + char;
      continue;
    }

    // `>` — marked's blockquote rule needs no trailing space, so neither does
    // this. Inside a quoted label a `>` is punctuation; the arrowheads that
    // matter live outside the quotes and are never reached.
    if (char === '>') {
      out += ZERO_WIDTH_SPACE + char;
      continue;
    }

    out += char;
  }

  return out;
}

/** Mermaid's two built-in themes, as this app's light/dark pair. */
export function mermaidThemeName(isDark: boolean): 'dark' | 'default' {
  return isDark ? 'dark' : 'default';
}

/**
 * The font every diagram is drawn in.
 *
 * NOT MERMAID'S DEFAULT, which is `"trebuchet ms", verdana, arial` — three
 * families, none of which carries Hangul. A Korean label falls through to
 * whatever the platform substitutes, at a different size and weight from the
 * prose beside it. `--app-font-sans` is the body stack the rest of the shell
 * uses (globals.css), and mermaid emits it into a `<style>` block inside the
 * SVG, so the custom property resolves against the document that hosts it.
 */
export const MERMAID_FONT_FAMILY = 'var(--app-font-sans)';

export interface MermaidInitConfig {
  startOnLoad: boolean;
  theme: 'dark' | 'default';
  securityLevel: 'strict';
  htmlLabels: boolean;
  suppressErrorRendering: boolean;
  fontFamily: string;
  flowchart: { useMaxWidth: boolean };
}

/**
 * What mermaid is initialised with, per render.
 *
 * `startOnLoad: false` — mermaid otherwise registers its OWN `window load`
 * handler and sweeps every `.mermaid` element in the page, which would race the
 * explicit per-block render below and process the same node twice.
 *
 * `securityLevel: 'strict'` — DELIBERATELY NOT the `'loose'` of the reference
 * implementation this port is based on. That app renders the user's own file in
 * a sandboxed web view; this viewer opens any markdown in the project, including
 * files that arrived with a dependency or from someone else, so a diagram is
 * untrusted input. `'loose'` would let a label carry raw HTML and let a `click`
 * directive bind a handler onto `window`.
 *
 * MEASURED IN 11.17, in Chromium, rather than taken on trust. A diagram with
 * `click A call fired()` binds nothing under `strict` (the handler does not run
 * when the node is clicked) and does run under `loose`; a label of
 * `<img src=x onerror=…>` comes back with the attribute stripped. And
 * `htmlLabels` still works: `A["line one<br/>line two"]` renders as
 * `<span class="nodeLabel"><p>line one<br>line two</p></span>` inside a
 * `<foreignObject>`, because mermaid sanitises label text and the serialised SVG
 * through DOMPurify instead of dropping the markup. What `strict` costs is the
 * click directives; the formatting survives.
 *
 * `htmlLabels` is the ROOT-LEVEL key, not `flowchart.htmlLabels`: mermaid 11.17
 * deprecated the per-diagram copy and logs a warning whenever it is set.
 *
 * `suppressErrorRendering: true` — without it mermaid paints its own bomb-icon
 * graphic into the container, replacing the source the author is trying to
 * debug. The caller keeps the source on screen and reports the failure itself.
 */
export function mermaidInitConfig(isDark: boolean): MermaidInitConfig {
  return {
    startOnLoad: false,
    theme: mermaidThemeName(isDark),
    securityLevel: 'strict',
    htmlLabels: true,
    suppressErrorRendering: true,
    fontFamily: MERMAID_FONT_FAMILY,
    flowchart: { useMaxWidth: true },
  };
}
