'use client';

/**
 * The in-app markdown viewer: a full-screen, read-only rendering of one
 * markdown file from the project working tree.
 *
 * IT IS AN ASSEMBLY, NOT A RENDERER. Every rendering decision already existed
 * in @cockpit/shared-ui and is reused verbatim — `MarkdownRenderer` (GFM,
 * math, frontmatter, alerts, Prism code blocks), `TocSidebar` (outline,
 * scroll-spy, collapse) and `rehypeSourceLines`, which is the seam the two talk
 * through: the plugin stamps `data-source-start` on every heading and the
 * sidebar looks headings up by exactly that attribute. That wiring was built
 * and then left unplugged when the shell was trimmed to chat-only; this
 * component plugs it back in rather than growing a second copy of any of it.
 *
 * MATH IS ON HERE, unlike chat, which passes `enableMath={false}`. In a
 * conversation a `$` is nearly always money and turning it into math mangles
 * the message; in a document `$…$` is what the author meant.
 *
 * PORTALED, BECAUSE THE HOSTS CLIP. `FileBrowserPanel`'s root is
 * `overflow-hidden` and the three-panel shell wraps everything in a
 * `translateX` container, so an in-place overlay is cut off exactly the way
 * three sidebar panels once were (see shell/CLAUDE.md). `Portal` mounts into
 * the panel-portal target when there is one and `document.body` otherwise.
 *
 * OUT OF SCOPE FOR v1, deliberately and not half-built: mermaid diagrams (not a
 * dependency, and a diagram renderer is a feature of its own), PDF/HTML export,
 * editing, and editor↔preview scroll sync — there is no editor pane to sync
 * with, which is also why `rehypeSourceLines` is used only for the outline.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MarkdownRenderer,
  Portal,
  TocSidebar,
  rehypeSourceLines,
  scrollToHeadingAnchor,
  useEscToClose,
} from '@cockpit/shared-ui';
import {
  classifyMarkdownLink,
  countWords,
  previewErrorKey,
  readingTimeMinutes,
} from './markdownPreviewOps';

/** Module scope so the array identity never changes: a fresh array on every
 *  render would make ReactMarkdown rebuild its whole plugin pipeline and tear
 *  the DOM down with it (see the memo notes in shell/CLAUDE.md). */
const REHYPE_PLUGINS = [rehypeSourceLines];

interface Doc {
  content: string;
  /** The file exceeded the route's preview ceiling and only its head is here. */
  truncated: boolean;
  /** Real size on disk, in bytes — the number the truncation notice is about. */
  size: number;
}

type ReadResponse =
  | { ok: true; rel: string; content: string; truncated: boolean; size: number }
  | { ok: false; reason: string };

/** One `read` against the project tree. A transport failure is reported as
 *  `{ok:false, reason:'failed'}` so callers have one shape to branch on —
 *  the same contract `fsOp` in FileBrowserPanel uses. */
async function readFile(cwd: string, rel: string): Promise<ReadResponse> {
  try {
    const res = await fetch('/api/fs-op', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, action: 'read', rel }),
    });
    if (!res.ok) return { ok: false, reason: 'failed' };
    return (await res.json()) as ReadResponse;
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

export function MarkdownPreviewModal({
  cwd,
  rel,
  onClose,
}: {
  cwd: string;
  /** The document to open first. Callers key the element on this, so a second
   *  preview of a different file starts from a clean history. */
  rel: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState(rel);
  /** Documents visited before `current`, oldest first — the back affordance. */
  const [trail, setTrail] = useState<string[]>([]);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /**
   * The heading a link asked for, held until its document has rendered.
   *
   * A REF, NOT STATE, and that is the whole point: clearing it as state would
   * re-run the effect below with an empty anchor and send the reader straight
   * back to the top of the document they had just been scrolled into.
   */
  const anchorRef = useRef('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEscToClose(onClose);

  useEffect(() => {
    let alive = true;
    setDoc(null);
    setFailure(null);
    void readFile(cwd, current).then((res) => {
      if (!alive) return;
      if (res.ok) setDoc({ content: res.content, truncated: res.truncated, size: res.size });
      else setFailure(res.reason);
    });
    return () => {
      alive = false;
    };
  }, [cwd, current]);

  // A new document goes to the heading its link named, or to its own top when
  // there was none and when the named heading is not in the file after all.
  // Runs after the render that put the markdown in the DOM, which is what makes
  // the heading findable at all.
  useEffect(() => {
    if (!doc) return;
    const container = scrollRef.current;
    if (!container) return;
    const anchor = anchorRef.current;
    anchorRef.current = '';
    if (anchor && scrollToHeadingAnchor(container, anchor)) return;
    container.scrollTop = 0;
  }, [doc]);

  /**
   * ANYTHING NOT EXTERNAL IS CONSUMED. Returning false for an unresolvable
   * relative href would let the anchor's own `target="_blank"` resolve it
   * against the app's origin and navigate the shell away from the live chat
   * session. `classifyMarkdownLink` decides; this only acts on the verdict.
   */
  const onLinkClick = useCallback(
    (href: string): boolean => {
      const target = classifyMarkdownLink(current, href);
      if (target.kind === 'external') return false;
      if (target.kind === 'markdown') {
        setTrail((prev) => [...prev, current]);
        anchorRef.current = target.anchor;
        setCurrent(target.rel);
      }
      return true;
    },
    [current],
  );

  // Reads `trail` rather than driving the other two setters from inside its
  // updater: a state updater must stay pure, and React invokes it twice under
  // StrictMode — which would push the history back two documents per click.
  const goBack = useCallback(() => {
    const previous = trail[trail.length - 1];
    if (previous === undefined) return;
    setTrail((prev) => prev.slice(0, -1));
    // Going back lands at the top of the previous document rather than at the
    // link that was followed out of it — there is no scroll position kept, and
    // guessing one would be worse than a predictable top.
    anchorRef.current = '';
    setCurrent(previous);
  }, [trail]);

  // O(document) work, so never inline in JSX — this modal re-renders on every
  // scroll-spy tick inside TocSidebar's subtree.
  const words = useMemo(() => (doc ? countWords(doc.content) : 0), [doc]);
  const minutes = readingTimeMinutes(words);

  const body = (() => {
    if (failure !== null) {
      return (
        <div className="flex-1 flex items-center justify-center p-8 text-sm text-muted-foreground">
          {t(previewErrorKey(failure))}
        </div>
      );
    }
    if (!doc) {
      return (
        <div className="flex-1 flex items-center justify-center p-8 text-sm text-muted-foreground">
          {t('common.loading')}
        </div>
      );
    }
    return (
      <div className="flex-1 flex min-h-0">
        {/* Its own collapse toggle is the "toggleable" part of the outline —
            a second control outside it would be two switches for one state. */}
        <TocSidebar content={doc.content} containerRef={scrollRef} width="w-64" />
        <div
          ref={scrollRef}
          data-testid="markdown-preview-body"
          /* MarkdownRenderer sizes everything in `em`, against whatever
             font-size its host sets, so the document scale is set HERE and the
             headings and code blocks stay proportional to it. */
          className="flex-1 overflow-y-auto px-8 py-6 text-[0.9375rem] leading-relaxed text-foreground"
        >
          {doc.truncated && (
            <div className="mb-4 px-3 py-2 rounded border border-border bg-accent text-xs text-muted-foreground">
              {t('markdownPreview.truncated')}
            </div>
          )}
          <MarkdownRenderer
            content={doc.content}
            enableMath
            rehypePlugins={REHYPE_PLUGINS}
            onLinkClick={onLinkClick}
          />
        </div>
      </div>
    );
  })();

  return (
    <Portal>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-0 md:p-4"
        onClick={onClose}
      >
        <div
          data-testid="markdown-preview-modal"
          className="bg-card shadow-xl w-full max-w-[90%] h-full md:h-[90vh] rounded-none md:rounded-lg flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border flex-shrink-0">
            {trail.length > 0 && (
              <button
                type="button"
                data-testid="markdown-preview-back"
                onClick={goBack}
                title={t('markdownPreview.back')}
                className="p-1 rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
            )}
            <span className="flex-1 min-w-0 truncate text-sm font-medium text-foreground" title={current}>
              {current}
            </span>
            <button
              type="button"
              onClick={onClose}
              title={t('common.close')}
              className="p-1 rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {body}

          <div className="flex items-center gap-3 px-3 py-1.5 border-t border-border flex-shrink-0 text-[0.714rem] text-muted-foreground">
            <span>{t('markdownPreview.words', { count: words })}</span>
            <span>
              {minutes === 0
                ? t('markdownPreview.readingTimeUnderMinute')
                : t('markdownPreview.readingTime', { count: minutes })}
            </span>
          </div>
        </div>
      </div>
    </Portal>
  );
}
