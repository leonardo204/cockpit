import { describe, it, expect } from 'vitest';
import {
  MERMAID_FONT_FAMILY,
  MERMAID_LANGUAGE,
  ZERO_WIDTH_SPACE,
  guardMermaidLabelMarkdown,
  mermaidInitConfig,
  mermaidThemeName,
} from './mermaidSource';

/**
 * The rules a mermaid diagram is put through before a browser sees it.
 *
 * Runs in vitest's NODE environment, with no DOM — which is the point of
 * keeping these rules out of the component. Everything asserted here is a
 * property of the SOURCE TEXT, and every one of them fails in a way that looks
 * like "mermaid is broken" rather than like a bug in this app.
 */

const Z = ZERO_WIDTH_SPACE;

describe('guardMermaidLabelMarkdown — ordered-list markers inside labels', () => {
  /**
   * THE CASE THIS EXISTS FOR. Mermaid 11 lexes labels as markdown, and marked
   * reads `1. 항목` as an ordered list rather than as text, so the label comes
   * out of the token's raw source instead of the text pipeline. A Korean
   * numbered label is the first thing a user of this app types.
   */
  it('disarms a Korean numbered label', () => {
    expect(guardMermaidLabelMarkdown('A["1. 항목"]')).toBe(`A["${Z}1. 항목"]`);
  });

  it('disarms `1)` as well as `1.`', () => {
    expect(guardMermaidLabelMarkdown('A["1) first"]')).toBe(`A["${Z}1) first"]`);
  });

  it('needs whitespace after the delimiter', () => {
    // `1.5` is a number, not a list.
    expect(guardMermaidLabelMarkdown('A["1.5 kg"]')).toBe('A["1.5 kg"]');
    expect(guardMermaidLabelMarkdown('A["v1.0"]')).toBe('A["v1.0"]');
  });

  it('stops at nine digits, the same bound marked uses', () => {
    expect(guardMermaidLabelMarkdown('A["123456789. x"]')).toBe(`A["${Z}123456789. x"]`);
    expect(guardMermaidLabelMarkdown('A["1234567890. x"]')).toBe('A["1234567890. x"]');
  });

  it('never restarts inside a number', () => {
    // A naive per-character scan would find `2. ` inside `12. ` and guard the
    // wrong character, leaving `1<ZWSP>2. ` — which marked still reads as a
    // list, so the bug would be invisible in the diff and visible on screen.
    expect(guardMermaidLabelMarkdown('A["12. x"]')).toBe(`A["${Z}12. x"]`);
  });
});

describe('guardMermaidLabelMarkdown — the markdown label form', () => {
  /**
   * THE FORM THAT ACTUALLY GETS LEXED. Mermaid treats a backtick-wrapped label
   * as markdown; measured in 11.17, `A["\`1. 항목\`"]` renders as bare
   * `1. 항목` (the raw token, no paragraph handling) and the guarded version
   * renders as `<p>​1. 항목</p>`. The guard has to reach INSIDE the backticks,
   * which it does because the backticks are inside the quotes.
   */
  it('guards a marker inside a backticked label', () => {
    const tick = String.fromCharCode(96);
    expect(guardMermaidLabelMarkdown(`A["${tick}1. 항목${tick}"]`)).toBe(
      `A["${tick}${Z}1. 항목${tick}"]`,
    );
  });

  it('leaves the emphasis those labels are written for alone', () => {
    const tick = String.fromCharCode(96);
    const src = `A["${tick}**bold** and *italic*${tick}"]`;
    expect(guardMermaidLabelMarkdown(src)).toBe(src);
  });
});

describe('guardMermaidLabelMarkdown — the space-delimited markers', () => {
  it.each([
    ['-', 'A["- item"]', `A["${Z}- item"]`],
    ['*', 'A["* item"]', `A["${Z}* item"]`],
    ['+', 'A["+ item"]', `A["${Z}+ item"]`],
    ['#', 'A["# heading"]', `A["${Z}# heading"]`],
  ])('disarms a leading `%s`', (_marker, input, expected) => {
    expect(guardMermaidLabelMarkdown(input)).toBe(expected);
  });

  it('leaves *emphasis* alone', () => {
    // The whole reason the markers above require a following space: mermaid
    // supports emphasis in labels, and guarding `*` unconditionally would turn
    // every italic label into a literal asterisk.
    expect(guardMermaidLabelMarkdown('A["*emphasis*"]')).toBe('A["*emphasis*"]');
    expect(guardMermaidLabelMarkdown('A["**bold**"]')).toBe('A["**bold**"]');
  });

  it('leaves a hyphen inside a word alone', () => {
    expect(guardMermaidLabelMarkdown('A["build-server"]')).toBe('A["build-server"]');
  });

  /**
   * THE RULE THE REFERENCE GETS WRONG. A marker that is not at the start of a
   * line was never going to open a markdown block — marked's block rules are
   * all `^`-anchored — and rewriting one damages text that was fine.
   */
  it('ignores markers in the middle of a label', () => {
    expect(guardMermaidLabelMarkdown('A["a - b"]')).toBe('A["a - b"]');
    expect(guardMermaidLabelMarkdown('A["issue # 5"]')).toBe('A["issue # 5"]');
  });

  it('does not break the closing half of `**bold**`', () => {
    // The second `*` of `**` is followed by a space. A position-blind guard
    // splits the pair with a zero-width space, and the label renders as a
    // literal `**bold*` with a stray `*` after it.
    const src = 'A["**bold** and more"]';
    expect(guardMermaidLabelMarkdown(src)).toBe(src);
  });

  it('treats the text after a `<br/>` as a new line', () => {
    // Mermaid rewrites `<br/>` to a newline before it lexes the label, so a
    // marker sitting after one IS at the start of a line by then.
    expect(guardMermaidLabelMarkdown('A["first<br/>- second"]')).toBe(
      `A["first<br/>${Z}- second"]`,
    );
    expect(guardMermaidLabelMarkdown('A["first<BR>1. second"]')).toBe(
      `A["first<BR>${Z}1. second"]`,
    );
  });

  it('sees through the indentation marked allows', () => {
    expect(guardMermaidLabelMarkdown('A["  - item"]')).toBe(`A["  ${Z}- item"]`);
  });

  it('disarms `>` with no trailing space, because marked needs none', () => {
    expect(guardMermaidLabelMarkdown('A["> quoted"]')).toBe(`A["${Z}> quoted"]`);
    expect(guardMermaidLabelMarkdown('A[">quoted"]')).toBe(`A["${Z}>quoted"]`);
  });
});

describe('guardMermaidLabelMarkdown — only inside quotes', () => {
  /**
   * Outside a label, these characters ARE the diagram: `-->` is an edge, `>` an
   * arrowhead, `#` an entity code. Rewriting them would break syntax that was
   * never in danger.
   */
  it('leaves the diagram syntax untouched', () => {
    const src = 'graph TD\n  A --> B\n  B --- C\n  C -.-> D';
    expect(guardMermaidLabelMarkdown(src)).toBe(src);
  });

  it('guards the label but not the arrow on the same line', () => {
    expect(guardMermaidLabelMarkdown('A --> B["1. 항목"]')).toBe(`A --> B["${Z}1. 항목"]`);
  });

  it('handles several labels in one document', () => {
    expect(guardMermaidLabelMarkdown('A["1. a"] --> B["- b"]')).toBe(
      `A["${Z}1. a"] --> B["${Z}- b"]`,
    );
  });
});

describe('guardMermaidLabelMarkdown — the bail-out', () => {
  /**
   * An odd number of quotes means we cannot tell a label from the syntax around
   * it. Every character after the stray quote would be treated as label text,
   * so a guess would rewrite the diagram itself — and the source is already
   * malformed, so mermaid's own error is the honest outcome.
   */
  it('returns unbalanced source completely unchanged', () => {
    const src = 'graph TD\n  A["1. 항목] --> B\n  B --> C["- x"]';
    expect(guardMermaidLabelMarkdown(src)).toBe(src);
  });

  it('does nothing at all to a diagram with no quotes', () => {
    const src = 'sequenceDiagram\n  Alice->>Bob: hello';
    expect(guardMermaidLabelMarkdown(src)).toBe(src);
  });
});

describe('guardMermaidLabelMarkdown — idempotence', () => {
  /**
   * A theme switch re-renders every block from the same source, and the guard
   * runs again each time. Accumulating one zero-width space per render would
   * grow the label's text (and its measured width) on every toggle.
   */
  it('does not stack zero-width spaces', () => {
    const once = guardMermaidLabelMarkdown('A["1. 항목"] --> B["- b"]');
    expect(guardMermaidLabelMarkdown(once)).toBe(once);
    expect(guardMermaidLabelMarkdown(guardMermaidLabelMarkdown(once))).toBe(once);
  });
});

describe('guardMermaidLabelMarkdown — what the reader sees', () => {
  it('changes nothing but the invisible characters', () => {
    const src = 'A["1. 항목"] --> B["- b"] --> C["# c"]';
    const guarded = guardMermaidLabelMarkdown(src);
    expect(guarded).not.toBe(src);
    expect(guarded.split(Z).join('')).toBe(src);
  });
});

describe('mermaidInitConfig', () => {
  /**
   * `strict`, NOT the reference implementation's `loose`. This viewer opens any
   * markdown in the project — including files that arrived with a dependency —
   * so a diagram is untrusted input, and `loose` is what enables `click`
   * directives and raw HTML in labels. Verified in a browser against mermaid
   * 11.17: with `strict` a `click A call fired()` directive binds nothing (the
   * handler does not run when the node is clicked) while `loose` runs it, and an
   * `onerror` attribute in a label is stripped.
   */
  it('is strict, and says so as a literal type', () => {
    expect(mermaidInitConfig(true).securityLevel).toBe('strict');
    expect(mermaidInitConfig(false).securityLevel).toBe('strict');
  });

  /**
   * HTML labels still work under `strict` — mermaid runs label text and the
   * serialised SVG through DOMPurify (with `foreignobject` as an HTML
   * integration point) instead of dropping the markup. Measured: a label of
   * `line one<br/>line two` comes out as
   * `<span class="nodeLabel"><p>line one<br>line two</p></span>`. Line breaks
   * and emphasis survive; only the click bindings are lost.
   */
  it('keeps HTML labels on, through the ROOT key mermaid 11 wants', () => {
    const config = mermaidInitConfig(true);
    expect(config.htmlLabels).toBe(true);
    // `flowchart.htmlLabels` is deprecated in 11.17 and logs a warning on every
    // initialize; the root-level key is the replacement.
    expect(config.flowchart).toEqual({ useMaxWidth: true });
  });

  /** Mermaid registers its own `window load` sweep otherwise, which would race
   *  the explicit per-block render and process each node twice. */
  it('never starts itself on load', () => {
    expect(mermaidInitConfig(false).startOnLoad).toBe(false);
  });

  /** Without this, a diagram that throws while drawing is replaced by mermaid's
   *  bomb graphic — and the author loses the source they were debugging. */
  it('suppresses mermaid’s own error rendering', () => {
    expect(mermaidInitConfig(false).suppressErrorRendering).toBe(true);
  });

  /** Mermaid's default stack is `"trebuchet ms", verdana, arial` — not one of
   *  which carries Hangul. */
  it('draws in the app body font', () => {
    expect(mermaidInitConfig(false).fontFamily).toBe(MERMAID_FONT_FAMILY);
    expect(MERMAID_FONT_FAMILY).toBe('var(--app-font-sans)');
  });

  it('follows the app theme', () => {
    expect(mermaidThemeName(true)).toBe('dark');
    expect(mermaidThemeName(false)).toBe('default');
    expect(mermaidInitConfig(true).theme).toBe('dark');
    expect(mermaidInitConfig(false).theme).toBe('default');
  });
});

describe('the fence this renderer claims', () => {
  it('is exactly ```mermaid', () => {
    expect(MERMAID_LANGUAGE).toBe('mermaid');
  });
});
