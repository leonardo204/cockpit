'use client';

/**
 * One ```mermaid fence, drawn.
 *
 * MERMAID IS NEVER IMPORTED STATICALLY. The package is ~2.5 MB and this
 * component is reachable from `MarkdownRenderer`, which is also what draws every
 * chat message; a static import would put a diagram engine into the bundle of
 * every screen that renders markdown. `await import('mermaid')` inside the
 * effect below means the code is fetched the first time a diagram actually
 * mounts — which is the first time a document containing a mermaid fence is
 * opened, not when the app boots. (The pattern Workspace.tsx already uses.)
 *
 * THE SOURCE IS A REACT TEXT CHILD, NOT `dangerouslySetInnerHTML`. Mermaid reads
 * the element's `innerHTML` and entity-decodes it before parsing, so the source
 * has to reach the DOM with `&`, `<` and `>` escaped and NOTHING else escaped:
 * escaping quotes would break mermaid's own label quoting, and leaving the angle
 * brackets alone would let the HTML parser swallow a label like `a <b 5` or
 * `</div>`. A React text child (and the `textContent` assignment below, which is
 * the same transform performed by the DOM) is exactly that round trip, which is
 * why there is no hand-rolled escaper in this file.
 *
 * ONE `run()` PER BLOCK, so a broken diagram is contained. Mermaid's own sweep
 * (`run({ querySelector: '.mermaid' })`) collects one failure per node and
 * rethrows the FIRST after the loop, so in a document with several diagrams the
 * first bad one decides what the caller learns. A node list of one plus a local
 * try/catch makes every fence answer only for itself.
 *
 * A FAILURE KEEPS THE AUTHOR'S SOURCE ON SCREEN. `mermaid.render` empties the
 * container BEFORE it parses (verified in 11.17), so the reference behaviour is
 * a malformed diagram replaced by mermaid's bomb graphic — the one outcome the
 * author cannot debug from. Here the source is validated with
 * `parse({ suppressErrors: true })` before anything is cleared,
 * `suppressErrorRendering` stops the bomb for whatever still throws while
 * drawing, and both failure paths put the source text back under an error line.
 *
 * A THEME SWITCH RE-DRAWS, IT DOES NOT RELOAD. Mermaid 11 has no live re-theme
 * API, so each block is rendered again against the new theme — but the previous
 * SVG is left on screen until the new one is ready, so the document does not
 * collapse to placeholders and the reader keeps their scroll position. (The
 * reference app reloads the whole document instead.)
 */

import { memo, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { guardMermaidLabelMarkdown, mermaidInitConfig } from './mermaidSource';

type MermaidModule = typeof import('mermaid').default;

/**
 * The one in-flight/settled import, shared by every diagram on the page. Ten
 * fences in a document would otherwise each start their own; the bundler dedupes
 * the network fetch, but the promise bookkeeping is ours.
 */
let mermaidModule: Promise<MermaidModule> | null = null;

function loadMermaid(): Promise<MermaidModule> {
  if (!mermaidModule) {
    mermaidModule = import('mermaid').then((m) => m.default);
  }
  return mermaidModule;
}

/**
 * Vertical space held for a diagram that has not been drawn yet.
 *
 * Drawing is asynchronous — a dynamic import, a parse, then a layout — so
 * without a reserved box every diagram pops in and shoves the paragraph the
 * reader is on down the page. Same reason the viewer injects intrinsic
 * dimensions for images. A flat minimum is enough: nothing can know the real
 * height before mermaid has laid the graph out, and a per-diagram-type guess
 * would be pretend precision.
 */
const PLACEHOLDER_MIN_HEIGHT_PX = 120;

/** Mermaid stamps this on a node it has drawn and skips it ever after. Cleared
 *  before a re-draw (a theme switch), or the second render is a silent no-op. */
const PROCESSED_ATTR = 'data-processed';

export interface MermaidDiagramProps {
  /** The fence's contents, verbatim. */
  source: string;
  /** The resolved app theme. Passed down rather than read from context, so this
   *  component has exactly one input and the memo above it stays honest. */
  isDark: boolean;
}

export const MermaidDiagram = memo(function MermaidDiagram({ source, isDark }: MermaidDiagramProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<'pending' | 'rendered' | 'error'>('pending');
  const hostRef = useRef<HTMLDivElement>(null);
  /**
   * The source+theme pair that already failed, so the error state survives the
   * re-renders that follow it without the diagram being attempted again on each
   * one. Cleared implicitly: a different source or theme is a different key.
   */
  const failedRef = useRef<string | null>(null);
  /**
   * How tall this diagram was when it last drew. Used as the reserved height for
   * the NEXT attempt, so a re-draw after an edit does not collapse the document
   * to 120px on its way to the same size it already was.
   */
  const lastHeightRef = useRef(0);

  const guarded = guardMermaidLabelMarkdown(source);
  // What "this exact drawing" means: a source, and the theme it was drawn in.
  // The separator between them is a NUL written as an ESCAPE SEQUENCE and never
  // as a raw byte — a literal NUL makes every byte-oriented tool treat this file
  // as binary, Tailwind's class extractor and git and grep included.
  // MarkdownRenderer.tsx tells the whole story; fontSettings.test.ts fails the
  // suite if anyone forgets it.
  const key = `${isDark ? 'dark' : 'light'}\u0000${guarded}`;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (failedRef.current === key) return;

    let alive = true;
    setStatus((current) => (current === 'error' ? 'pending' : current));

    /** Put the fence back the way the author wrote it, and un-stamp the node so
     *  mermaid will consider it again. Assigning `textContent` is what React
     *  itself does for a single text child, so the two never disagree. */
    const restoreSource = () => {
      host.textContent = guarded;
      host.removeAttribute(PROCESSED_ATTR);
    };

    void (async () => {
      try {
        const mermaid = await loadMermaid();
        if (!alive) return;
        // Global configuration, re-asserted before each draw: every block on the
        // page draws against the same theme, and this is the line a theme switch
        // changes.
        mermaid.initialize(mermaidInitConfig(isDark));

        // VALIDATED FIRST, because `run` clears the container as its first act.
        // A syntax error discovered after that point has already taken the
        // author's source off the screen.
        const parsed = await mermaid.parse(guarded, { suppressErrors: true });
        if (!alive) return;
        if (!parsed) throw new Error('mermaid: the diagram source could not be parsed');

        // Only now is the previous drawing given up — on a re-theme the old SVG
        // has been on screen the whole time up to this line.
        restoreSource();
        await mermaid.run({ nodes: [host] });
        if (!alive) return;
        lastHeightRef.current = host.getBoundingClientRect().height;
        setStatus('rendered');
      } catch (error) {
        if (!alive) return;
        // The breadcrumb: the line in the UI says a diagram failed, this says
        // which rule mermaid tripped over.
        console.error('Mermaid diagram failed to render:', error);
        failedRef.current = key;
        restoreSource();
        setStatus('error');
      }
    })();

    return () => {
      alive = false;
    };
  }, [key, isDark, guarded]);

  return (
    <div className="md-mermaid" data-state={status} data-testid="mermaid-diagram">
      {status === 'error' && (
        <div className="md-mermaid-error">{t('markdownPreview.diagramError')}</div>
      )}
      <div
        ref={hostRef}
        className="mermaid"
        style={
          status === 'rendered'
            ? undefined
            : { minHeight: `${Math.max(lastHeightRef.current, PLACEHOLDER_MIN_HEIGHT_PX)}px` }
        }
      >
        {guarded}
      </div>
    </div>
  );
});
