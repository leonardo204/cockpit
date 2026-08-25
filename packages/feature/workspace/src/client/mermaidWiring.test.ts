import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * How the diagram renderer is joined to the markdown renderer — and, just as
 * importantly, how it is kept OUT of chat.
 *
 * SOURCE ASSERTIONS, the same instrument as markdownImageWiring.test.ts beside
 * this file and for the same reason: there is no component-render harness here,
 * and every rule below is a property of the WIRING rather than of a function.
 * Each one produces a build that looks fine — a chat bundle 2.5 MB heavier, a
 * diagram engine fetched on a screen that will never draw one, an unreadable
 * error where the author's source used to be — and none of them can be observed
 * any other way. The rules that CAN be expressed as a function are, and they are
 * tested directly in mermaidSource.test.ts.
 */

const DIR = __dirname;
const SHARED_UI = join(DIR, '..', '..', '..', '..', 'shared', 'ui', 'src');
const APP = join(DIR, '..', '..', '..', '..', '..', 'src', 'app');

const DIAGRAM = readFileSync(join(SHARED_UI, 'MermaidDiagram.tsx'), 'utf8');
const RENDERER = readFileSync(join(SHARED_UI, 'MarkdownRenderer.tsx'), 'utf8');
const VIEWER = readFileSync(join(DIR, 'MarkdownDocument.tsx'), 'utf8');
const BUBBLE = readFileSync(
  join(DIR, '..', '..', '..', 'agent', 'src', 'client', 'MessageBubble.tsx'),
  'utf8',
);
const CSS = readFileSync(join(APP, 'globals.css'), 'utf8');

/**
 * The file with its prose removed.
 *
 * Needed because the rules below are about what the code DOES, and the comments
 * in these files necessarily name the very things being forbidden — the header
 * of MermaidDiagram.tsx explains why it does not use `dangerouslySetInnerHTML`
 * and why it does not call `run({ querySelector })`. Matching the raw text would
 * fail on the explanation and pass on the mistake.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const DIAGRAM_CODE = withoutComments(DIAGRAM);
const RENDERER_CODE = withoutComments(RENDERER);
const VIEWER_CODE = withoutComments(VIEWER);

describe('mermaid — the engine is opt-in per host', () => {
  /**
   * `MarkdownRenderer` draws every chat message AND every document. Mermaid is
   * ~2.5 MB. A default of `true` here would be invisible in review and would
   * put a diagram engine behind every conversation.
   */
  it('defaults to off in the renderer', () => {
    expect(RENDERER).toContain('enableMermaid = false');
  });

  it('is asked for by the document viewer', () => {
    const element = /<MarkdownRenderer[\s\S]*?\/>/.exec(VIEWER)?.[0];
    expect(element, 'MarkdownRenderer element not found — did the markup change?').toBeDefined();
    expect(element).toContain('enableMermaid');
  });

  /** Chat's own precedent for this prop is `enableMath={false}`; mermaid needs
   *  no such line because the default is already off — but it must not acquire
   *  one either, in this pass or by accident later. */
  it('is not asked for by chat', () => {
    expect(BUBBLE).not.toContain('enableMermaid');
  });

  it('falls through to the code-block path when it is off', () => {
    // The branch is guarded by the flag, not just by the language: a fence in a
    // chat message stays a syntax-highlighted listing.
    expect(RENDERER).toMatch(/if \(enableMermaid && language === MERMAID_LANGUAGE\)/);
  });

  /** The components map is memoised on its inputs. A flag left out of the deps
   *  is a flag that only takes effect after some unrelated re-render. */
  it('rebuilds the component map when the flag changes', () => {
    // Stated as "the flag is BOTH passed and depended on" rather than as the
    // whole argument list: the map has since grown a second opt-in
    // (`enableFileLinks`) and its click callback, and pinning the exact
    // signature made an unrelated feature look like a regression here. What
    // matters is unchanged — a flag left out of the deps is a flag that only
    // takes effect after some other re-render.
    // `() =>` anchors this to the CALL inside the memo, not the function
    // definition of the same name further up the file.
    const call = /\(\)\s*=>\s*\n?\s*createMarkdownComponents\(([\s\S]*?)\),/.exec(RENDERER)?.[1];
    expect(call, 'the components factory call is gone — did the renderer change?').toBeDefined();
    expect(call).toContain('enableMermaid');
    const deps = /\[isDark, onLinkClick[^\]]*\]/.exec(RENDERER)?.[0];
    expect(deps, 'the components memo deps are gone').toBeDefined();
    expect(deps).toContain('enableMermaid');
  });
});

describe('mermaid — the engine is loaded dynamically', () => {
  /**
   * The whole opt-in is worthless if the import is static: webpack would pull
   * mermaid into the chunk that owns MarkdownRenderer, and every screen that
   * renders markdown would pay for it whether or not `enableMermaid` is on.
   */
  it('imports mermaid with `await import`, never at module scope', () => {
    expect(DIAGRAM).toContain("import('mermaid')");
    // `import type` is fine — types are erased. A value import is not.
    expect(DIAGRAM).not.toMatch(/^import\s+[^;]*from\s+'mermaid'/m);
  });

  it('is the only file that names the package at all', () => {
    for (const [name, src] of [
      ['MarkdownRenderer', RENDERER],
      ['MarkdownDocument', VIEWER],
      ['MessageBubble', BUBBLE],
    ] as const) {
      expect(src, `${name} must not import mermaid`).not.toMatch(/from\s+'mermaid'/);
      expect(src, `${name} must not import mermaid`).not.toContain("import('mermaid')");
    }
  });

  /** One shared promise, so ten fences in a document do not each start their
   *  own import bookkeeping. */
  it('remembers the import instead of repeating it', () => {
    expect(DIAGRAM).toMatch(/let mermaidModule: Promise<MermaidModule> \| null = null;/);
    expect(DIAGRAM).toContain('if (!mermaidModule)');
  });
});

describe('mermaid — one bad diagram does not take the others down', () => {
  /**
   * `run({ querySelector: '.mermaid' })` — the reference call — sweeps every
   * diagram on the page, collects a failure per node and rethrows the FIRST one
   * after the loop. In a document with several diagrams that means the earliest
   * mistake decides what the caller learns, and the caller has no way to say
   * which node it was about.
   */
  it('renders one node at a time, not by selector sweep', () => {
    expect(DIAGRAM).toContain('mermaid.run({ nodes: [host] })');
    // The sweeping form takes a selector; this one must never be handed one.
    expect(DIAGRAM_CODE).not.toMatch(/querySelector/);
  });

  it('catches per block', () => {
    expect(DIAGRAM).toMatch(/try \{[\s\S]*mermaid\.run[\s\S]*\} catch \(error\) \{/);
  });
});

describe('mermaid — a failure leaves the source on screen', () => {
  /**
   * `mermaid.render` empties the container BEFORE it parses, so a syntax error
   * found afterwards has already taken the author's source away and replaced it
   * with mermaid's bomb icon. Validating first is what makes the common failure
   * — a typo — non-destructive.
   */
  it('validates before anything is cleared', () => {
    expect(DIAGRAM).toContain('mermaid.parse(guarded, { suppressErrors: true })');
    const order = DIAGRAM.indexOf('mermaid.parse(');
    const run = DIAGRAM.indexOf('mermaid.run(');
    expect(order).toBeGreaterThan(0);
    expect(order).toBeLessThan(run);
  });

  /** For the rest — a diagram that parses and then throws while drawing — the
   *  bomb is switched off in the config and the source is restored by hand. */
  it('restores the source text on both failure paths', () => {
    expect(DIAGRAM).toContain('host.textContent = guarded');
    expect(DIAGRAM).toMatch(/catch \(error\) \{[\s\S]*restoreSource\(\)/);
  });

  it('leaves a console breadcrumb', () => {
    expect(DIAGRAM).toContain("console.error('Mermaid diagram failed to render:', error)");
  });

  /**
   * The source reaches the DOM as a React text child / `textContent`, which
   * escapes `&`, `<` and `>` and nothing else — exactly the round trip mermaid's
   * `innerHTML` + entity-decode expects. Hand-escaping would either miss a case
   * or escape the quotes mermaid uses to delimit labels.
   */
  it('never injects HTML and never hand-escapes', () => {
    // `innerHTML` is DISCUSSED in this file — it is what mermaid reads — but it
    // is never written to, and neither is React's escape hatch: either one
    // would be markup injection with the document's own text as the payload.
    expect(DIAGRAM_CODE).not.toContain('dangerouslySetInnerHTML');
    expect(DIAGRAM_CODE).not.toContain('innerHTML');
    // Nor is anything escaped by hand — that is what the text child is for.
    expect(DIAGRAM_CODE).not.toContain('&lt;');
    expect(DIAGRAM_CODE).not.toContain('&amp;');
    expect(DIAGRAM_CODE).toContain('{guarded}');
  });

  /** Mermaid stamps a node it has drawn and skips it ever after; a re-draw that
   *  forgets to un-stamp it is a silent no-op. */
  it('un-stamps the node before drawing again', () => {
    expect(DIAGRAM).toContain('host.removeAttribute(PROCESSED_ATTR)');
    expect(DIAGRAM).toContain("const PROCESSED_ATTR = 'data-processed'");
  });
});

describe('mermaid — a theme switch re-draws, it does not reload', () => {
  /**
   * Mermaid 11 has no live re-theme API, so the diagrams have to be drawn
   * again. The reference app throws the whole document away and reloads, which
   * here would flash the shell and lose the reader's scroll position.
   */
  it('takes the theme as an input and re-runs on it', () => {
    expect(DIAGRAM).toContain('mermaid.initialize(mermaidInitConfig(isDark))');
    expect(DIAGRAM).toMatch(/\}, \[key, isDark, guarded\]\);/);
    expect(DIAGRAM).not.toContain('location.reload');
  });

  it('passes the resolved theme down from the renderer', () => {
    expect(RENDERER).toContain('<MermaidDiagram source={code} isDark={isDark} />');
  });
});

describe('mermaid — the layout does not jump', () => {
  /** Same reason the viewer injects intrinsic dimensions for images: without a
   *  reserved box each diagram pops in and shoves the page down. */
  it('reserves height until the drawing exists', () => {
    expect(DIAGRAM).toContain('const PLACEHOLDER_MIN_HEIGHT_PX = 120');
    expect(DIAGRAM).toContain('minHeight');
    expect(DIAGRAM).toContain('lastHeightRef.current');
  });

  /**
   * `pre-wrap` belongs to the two states that show the SOURCE. Inherited into a
   * drawn diagram it would reach the HTML labels inside `<foreignObject>` and
   * re-wrap them.
   */
  it('styles the source states only', () => {
    expect(CSS).toContain(".markdown-body .md-mermaid[data-state='pending'] .mermaid");
    expect(CSS).toContain(".markdown-body .md-mermaid[data-state='error'] .mermaid");
    const block = /\[data-state='pending'\][\s\S]*?\}/.exec(CSS)?.[0] ?? '';
    expect(block).toContain('white-space: pre-wrap');
  });
});

describe('mermaid — PlantUML stays out', () => {
  /**
   * The reference renderer draws PlantUML by deflating the source into a URL and
   * fetching an SVG from kroki.io — which puts the contents of the user's
   * documents into a third party's access logs. Incompatible with the premise of
   * this app, so it is excluded rather than "not done yet".
   */
  it('never sends a diagram anywhere', () => {
    // Naming the exclusion in a comment is the point; reaching for it is not.
    for (const src of [DIAGRAM_CODE, RENDERER_CODE, VIEWER_CODE]) {
      expect(src).not.toMatch(/kroki|plantuml/i);
    }
  });

  it('claims exactly one fence language', () => {
    const branch = /if \(enableMermaid && language === [A-Z_]+\)/.exec(RENDERER)?.[0];
    expect(branch).toBeDefined();
    expect(RENDERER).not.toMatch(/language === 'plantuml'/i);
  });
});
