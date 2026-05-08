'use client';

import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, memo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { useComments, type CodeComment } from '@/hooks/useComments';
import { fetchAllCommentsWithCode, clearAllComments, buildAIMessage, type CodeReference } from '@/hooks/useAllComments';
import { useMenuContainer } from './FileContextMenu';
import { useChatContextOptional } from './ChatContext';
import { AddCommentInput, SendToAIInput } from './CodeInputCards';
import { computeLineDiff } from './diffAlgorithm';
import {
  buildCompactRows,
  COMPACT_EXPAND_STEP,
  type GapState,
  type RenderRow,
  type SymbolInfo,
  type VisualLine,
} from './compactDiff';
import { toast } from '../shared/Toast';
import { useLineHighlight } from '@/hooks/useLineHighlight';
import { escapeHtml } from '@/lib/codeHighlighter';
import { DiffMinimap } from './DiffMinimap';
import { FloatingToolbar } from './FloatingToolbar';
import { ViewCommentCard } from './ViewCommentCard';

// Re-export for external consumers
export { computeLineDiff, type DiffLine } from './diffAlgorithm';

// ============================================
// Types
// ============================================

interface DiffViewProps {
  oldContent: string;
  newContent: string;
  filePath: string;
  isNew?: boolean;
  isDeleted?: boolean;
  // Comment support
  cwd?: string;
  enableComments?: boolean;
  // Preview callback (e.g. Markdown preview, JSON readable)
  onPreview?: () => void;
  previewLabel?: string;
  // Content search callback (selected text → project-wide search)
  onContentSearch?: (query: string) => void;
  /**
   * Programmatic scroll target. When provided (and `tick` changes), the
   * virtualizer scrolls so the matching row is near the top of the viewport.
   * - `side: 'after'` matches `rightLines[i].lineNum === line` (new file line).
   * - `side: 'before'` matches `leftLines[i].lineNum === line` (old file line).
   * The `tick` field MUST change on each new request — otherwise repeat clicks
   * on the same line wouldn't re-trigger the scroll.
   */
  targetLine?: { line: number; side: 'before' | 'after'; tick: number } | null;
  /**
   * GitHub-style compact view: only changed lines + 3-line context
   * are rendered; unchanged stretches collapse into clickable bars
   * with bidirectional ↑ / ↓ arrows that reveal +20 lines per
   * click (`COMPACT_EXPAND_STEP`).
   *
   * Default `false` so existing call sites (DiffViewerModal,
   * CommitDetailPanel, …) keep their full-file behaviour. Currently
   * only `StatusDiffPane` (file-mode of git changes) defaults this
   * on, with a Compact/Full toggle for the user.
   *
   * (An earlier prototype consumed AST symbols to AUTO-EXPAND a
   * gap to its enclosing-function boundaries on first click; user
   * feedback was that the line count was uncontrollable and big
   * jumps disrupted reading. We deleted the auto-expansion path
   * and aligned expansion with GitHub's bidirectional +N exactly.
   * See `compactDiff.ts` header.)
   */
  compact?: boolean;
  /**
   * Function-like symbols (post-edit / AFTER snapshot) used by
   * compact mode to label each gap bar with the enclosing function
   * of the next changed region — same convention as GitHub's
   * "@@ -X +Y @@ funcName" hunk header. Read-only / informational;
   * does NOT influence expansion behaviour. Omitted (or empty) for
   * files without AST coverage (.json, .css, etc.) — bars then
   * just show "N lines hidden".
   */
  symbols?: readonly SymbolInfo[];
}

// ============================================
// Row height constant
// ============================================
const ROW_HEIGHT = 20;

/** Render a function-like symbol as `name(p1, p2, …)` for the gap
 *  bar's hunk-header label. Mirrors the chip-header style used in
 *  Code Map, so users see the same shape in both views. Symbols
 *  without `params` (non-callable kinds — class / interface / type
 *  / etc) render as just `name`. */
function formatSignature(s: SymbolInfo): string {
  if (!s.params) return s.name;
  return `${s.name}(${s.params.join(', ')})`;
}

// ============================================
// ToolbarRenderer - independent state, avoids DiffView re-renders.
// Only toolbar's own show/hide triggers this component's re-render;
// DiffView's virtual list is completely unaffected → selection is preserved.
// ============================================
interface ToolbarRendererProps {
  floatingToolbarRef: React.RefObject<{ x: number; y: number; range: { start: number; end: number }; codeContent: string } | null>;
  bumpRef: React.MutableRefObject<() => void>;
  container: HTMLElement;
  onAddComment: () => void;
  onSendToAI: () => void;
  onSearch?: () => void;
  isChatLoading: boolean;
}

function ToolbarRendererInner({ floatingToolbarRef, bumpRef, container, onAddComment, onSendToAI, onSearch, isChatLoading }: ToolbarRendererProps) {
  const [version, forceRender] = useState(0);

  // Let parent (DiffView) trigger re-render via bumpRef
  // Placed in useEffect to comply with React Compiler rules (no ref writes during render)
  useEffect(() => {
    bumpRef.current = () => forceRender(v => v + 1);
  }, [bumpRef]);

   
  const toolbar = useMemo(() => floatingToolbarRef.current, [version]);

  return (
    <FloatingToolbar
      x={toolbar?.x ?? 0}
      y={toolbar?.y ?? 0}
      visible={!!toolbar}
      container={container}
      onAddComment={onAddComment}
      onSendToAI={onSendToAI}
      onSearch={onSearch}
      isChatLoading={isChatLoading}
    />
  );
}
const ToolbarRenderer = memo(ToolbarRendererInner);

// ============================================
// Main DiffView Component (Split View)
// ============================================

export function DiffView({ oldContent, newContent, filePath, isNew = false, isDeleted = false, cwd, enableComments = false, onPreview, previewLabel, onContentSearch, targetLine, compact = false, symbols }: DiffViewProps) {
  const { t } = useTranslation();
  const resolvedPreviewLabel = previewLabel ?? t('common.preview');
  const diffLines = useMemo(() => computeLineDiff(oldContent, newContent), [oldContent, newContent]);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const leftPanelRef = useRef<HTMLDivElement>(null);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const isSyncingHScrollRef = useRef(false);
  const [isMounted, setIsMounted] = useState(false);

  // Menu container for portal mounting (keeps floating elements within second screen)
  const menuContainer = useMenuContainer();

  // Chat context for "Send to AI" feature
  const chatContext = useChatContextOptional();

  // Comment state
  const commentsEnabled = enableComments && !!cwd;
  const { comments, addComment, updateComment, deleteComment, refresh: refreshComments } = useComments({
    cwd: cwd || '',
    filePath,
  });

  const [viewingComment, setViewingComment] = useState<{
    comment: CodeComment;
    x: number;
    y: number;
  } | null>(null);

  // Floating toolbar - ref stores data + bumpToolbarRef triggers ToolbarRenderer re-render
  // Key: don't hold state on DiffView to avoid virtual list reconciliation losing selection
  const floatingToolbarRef = useRef<{
    x: number;
    y: number;
    range: { start: number; end: number };
    codeContent: string;
  } | null>(null);
  const bumpToolbarRef = useRef<() => void>(() => {});

  const [addCommentInput, setAddCommentInput] = useState<{
    x: number;
    y: number;
    range: { start: number; end: number };
    codeContent: string;
  } | null>(null);

  const [sendToAIInput, setSendToAIInput] = useState<{
    x: number;
    y: number;
    range: { start: number; end: number };
    codeContent: string;
  } | null>(null);

  // Track mount state for Portal
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Lines with comments (based on new file line numbers)
  const linesWithComments = useMemo(() => {
    const set = new Set<number>();
    for (const comment of comments) {
      for (let i = comment.startLine; i <= comment.endLine; i++) {
        set.add(i);
      }
    }
    return set;
  }, [comments]);

  // Comments grouped by end line
  const commentsByEndLine = useMemo(() => {
    const map = new Map<number, CodeComment[]>();
    for (const comment of comments) {
      const line = comment.endLine;
      if (!map.has(line)) map.set(line, []);
      map.get(line)!.push(comment);
    }
    return map;
  }, [comments]);

  // Handle text selection in right panel
  // Three-phase event flow (aligned with useCodeViewerLogic): mousedown / mouseup / selectionchange
  useEffect(() => {
    if (!commentsEnabled) return;

    const codeArea = rightPanelRef.current;
    let isDragging = false;
    let downX = 0, downY = 0;

    // mousedown: mark drag-select start, clear old toolbar
    const handleMouseDown = (e: MouseEvent) => {
      isDragging = true;
      downX = e.clientX;
      downY = e.clientY;
      if (floatingToolbarRef.current) {
        floatingToolbarRef.current = null;
        bumpToolbarRef.current();
      }
    };

    // mouseup: mark drag-select end, compute selection and show toolbar
    const handleMouseUp = (e: MouseEvent) => {
      isDragging = false;

      // When clicking a FloatingToolbar button, don't clear toolbar so onClick fires normally
      const target = e.target as HTMLElement;
      if (target.closest?.('.floating-toolbar')) return;

      // Movement ≤ 5px is treated as click (including double/triple click), don't show toolbar
      const moved = Math.abs(e.clientX - downX) > 5 || Math.abs(e.clientY - downY) > 5;

      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.toString().trim() || !moved) {
        if (floatingToolbarRef.current) {
          floatingToolbarRef.current = null;
          bumpToolbarRef.current();
        }
        return;
      }

      const range = selection.getRangeAt(0);
      const container = rightPanelRef.current;
      if (!container || !container.contains(range.commonAncestorContainer)) return;

      // Find line numbers from DOM
      const getLineFromNode = (node: Node): number | null => {
        if (!document.contains(node)) return null;
        let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element;
        while (el && el !== container) {
          const lineRow = el.closest('[data-new-line]');
          if (lineRow) {
            return parseInt(lineRow.getAttribute('data-new-line') || '0', 10);
          }
          el = el.parentElement;
        }
        return null;
      };

      const startLine = getLineFromNode(range.startContainer);
      const endLine = getLineFromNode(range.endContainer);

      if (startLine && endLine) {
        const minLine = Math.min(startLine, endLine);
        const maxLine = Math.max(startLine, endLine);

        // Extract code content from new file lines in diffLines
        const codeLines: string[] = [];
        let lineNum = 0;
        for (const dl of diffLines) {
          if (dl.type === 'unchanged' || dl.type === 'added') {
            lineNum++;
            if (lineNum >= minLine && lineNum <= maxLine) {
              codeLines.push(dl.content);
            }
          }
        }
        const codeContent = codeLines.join('\n');

        floatingToolbarRef.current = {
          x: e.clientX,
          y: e.clientY,
          range: { start: minLine, end: maxLine },
          codeContent,
        };
        bumpToolbarRef.current();
      }
    };

    // selectionchange: hide toolbar when selection disappears
    // Skip during drag-select to avoid high-frequency unnecessary re-renders
    const handleSelectionChange = () => {
      if (isDragging) return;
      if (!floatingToolbarRef.current) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        floatingToolbarRef.current = null;
        bumpToolbarRef.current();
      }
    };

    codeArea?.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      codeArea?.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('selectionchange', handleSelectionChange);
    };
  }, [commentsEnabled, diffLines]);

  const handleCommentBubbleClick = useCallback((comment: CodeComment, e: React.MouseEvent) => {
    e.stopPropagation();
    setViewingComment({ comment, x: e.clientX, y: e.clientY });
    floatingToolbarRef.current = null;
    bumpToolbarRef.current();
    setAddCommentInput(null);
    setSendToAIInput(null);
  }, []);

  const handleToolbarAddComment = useCallback(() => {
    const toolbar = floatingToolbarRef.current;
    if (!toolbar) return;
    setAddCommentInput({
      x: toolbar.x,
      y: toolbar.y,
      range: toolbar.range,
      codeContent: toolbar.codeContent,
    });
    floatingToolbarRef.current = null;
    bumpToolbarRef.current();
  }, []);

  const handleToolbarSendToAI = useCallback(() => {
    const toolbar = floatingToolbarRef.current;
    if (!toolbar) return;
    setSendToAIInput({
      x: toolbar.x,
      y: toolbar.y,
      range: toolbar.range,
      codeContent: toolbar.codeContent,
    });
    floatingToolbarRef.current = null;
    bumpToolbarRef.current();
  }, []);

  const handleToolbarSearch = useCallback(() => {
    const toolbar = floatingToolbarRef.current;
    if (!toolbar || !onContentSearch) return;
    const query = toolbar.codeContent.trim();
    floatingToolbarRef.current = null;
    bumpToolbarRef.current();
    if (query) onContentSearch(query);
  }, [onContentSearch]);

  const handleSendToAISubmit = useCallback(async (question: string) => {
    if (!sendToAIInput || !chatContext || !cwd) return;

    try {
      const allComments = await fetchAllCommentsWithCode(cwd);
      const references: CodeReference[] = [];

      for (const comment of allComments) {
        references.push({
          filePath: comment.filePath,
          startLine: comment.startLine,
          endLine: comment.endLine,
          codeContent: comment.codeContent,
          note: comment.content || undefined,
        });
      }

      references.push({
        filePath,
        startLine: sendToAIInput.range.start,
        endLine: sendToAIInput.range.end,
        codeContent: sendToAIInput.codeContent,
      });

      const message = buildAIMessage(references, question);
      chatContext.sendMessage(message);

      await clearAllComments(cwd);
      refreshComments();
      setSendToAIInput(null);
    } catch (err) {
      console.error('Failed to send to AI:', err);
    }
  }, [sendToAIInput, chatContext, filePath, cwd, refreshComments]);

  const handleCommentSubmit = useCallback(async (content: string) => {
    if (!addCommentInput) return;
    await addComment(addCommentInput.range.start, addCommentInput.range.end, content);
    setAddCommentInput(null);
  }, [addCommentInput, addComment]);

  // Sync horizontal scroll between left and right panels
  useEffect(() => {
    const leftPanel = leftPanelRef.current;
    const rightPanel = rightPanelRef.current;
    if (!leftPanel || !rightPanel) return;

    const syncHScroll = (source: HTMLDivElement, target: HTMLDivElement) => {
      if (isSyncingHScrollRef.current) return;
      isSyncingHScrollRef.current = true;
      target.scrollLeft = source.scrollLeft;
      requestAnimationFrame(() => {
        isSyncingHScrollRef.current = false;
      });
    };

    const handleLeftScroll = () => syncHScroll(leftPanel, rightPanel);
    const handleRightScroll = () => syncHScroll(rightPanel, leftPanel);

    leftPanel.addEventListener('scroll', handleLeftScroll);
    rightPanel.addEventListener('scroll', handleRightScroll);

    return () => {
      leftPanel.removeEventListener('scroll', handleLeftScroll);
      rightPanel.removeEventListener('scroll', handleRightScroll);
    };
  }, []);

  // Split into left and right columns
  const { leftLines, rightLines } = useMemo(() => {
    const left: { lineNum: number; content: string; type: 'unchanged' | 'removed'; originalIdx: number }[] = [];
    const right: { lineNum: number; content: string; type: 'unchanged' | 'added'; originalIdx: number }[] = [];

    let leftIdx = 0;
    let rightIdx = 0;

    for (let i = 0; i < diffLines.length; i++) {
      const line = diffLines[i];
      if (line.type === 'unchanged') {
        // Align: pad with empty lines if needed
        while (left.length < right.length) {
          left.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });
        }
        while (right.length < left.length) {
          right.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });
        }
        leftIdx++;
        rightIdx++;
        left.push({ lineNum: leftIdx, content: line.content, type: 'unchanged', originalIdx: i });
        right.push({ lineNum: rightIdx, content: line.content, type: 'unchanged', originalIdx: i });
      } else if (line.type === 'removed') {
        leftIdx++;
        left.push({ lineNum: leftIdx, content: line.content, type: 'removed', originalIdx: i });
      } else if (line.type === 'added') {
        rightIdx++;
        right.push({ lineNum: rightIdx, content: line.content, type: 'added', originalIdx: i });
      }
    }

    // Final alignment
    while (left.length < right.length) {
      left.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });
    }
    while (right.length < left.length) {
      right.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });
    }

    return { leftLines: left, rightLines: right };
  }, [diffLines]);

  const allLines = useMemo(() => diffLines.map(line => line.content), [diffLines]);
  const highlightedLines = useLineHighlight(allLines, filePath);

  // ============================================
  // Compact mode — gap state + render-row pipeline.
  // When `compact === false` the pipeline degenerates to one diff
  // row per visual row (i.e. the original behaviour, just routed
  // through `renderRows`). Keeping a single virtualizer code path
  // for both modes avoids forking the JSX below.
  // ============================================

  const [gapStates, setGapStates] = useState<Map<number, GapState>>(
    () => new Map(),
  );

  // Reset gap states when the underlying diff changes (different file
  // or a fresh diff for the same file). Without this, an "expanded"
  // gap from file A would persist into file B as if its gap-id
  // referred to the same logical region — which it doesn't (gap ids
  // are positional, recomputed every build).
  useEffect(() => {
    setGapStates(new Map());
  }, [leftLines, rightLines]);

  // Cast away the `originalIdx` field that DiffView's internal row
  // builder added — `compactDiff` only needs `lineNum + type`.
  const visualLeft = leftLines as readonly VisualLine[];
  const visualRight = rightLines as readonly VisualLine[];

  // Stable identity for the optional `symbols` array — `buildCompactRows`
  // only re-runs when the data actually changes, not on every render
  // where the parent re-creates an inline literal. Cheap fallback for
  // the unset case keeps the dep stable too.
  const symbolsKey = useMemo(() => symbols ?? [], [symbols]);

  const { rows: renderRows, gaps: compactGaps } = useMemo(() => {
    if (!compact) {
      // Fast path: one diff row per visual row, no gaps.
      const rows: RenderRow[] = leftLines.map((_, i) => ({
        kind: 'diff' as const,
        idx: i,
      }));
      return { rows, gaps: [] };
    }
    return buildCompactRows(visualLeft, visualRight, gapStates, symbolsKey);
  }, [compact, leftLines, visualLeft, visualRight, gapStates, symbolsKey]);

  // Pending scroll-anchor adjustment. When the user clicks a gap
  // arrow, we capture the bar's viewport-Y BEFORE state changes;
  // a layout effect (running before paint, after DOM commit) then
  // measures the bar's NEW viewport-Y and adjusts scrollTop so the
  // bar stays visually pinned. Net effect: the user clicks and
  // sees new lines appear above/below the bar, but the bar itself
  // (and everything in their viewport) doesn't jump.
  //
  // Stored in a ref so consecutive clicks before the layout effect
  // runs collapse to the latest one — the second click's "before"
  // measurement supersedes the first.
  const pendingAnchorRef = useRef<{
    gapId: number;
    /** Bar's `getBoundingClientRect().top` BEFORE the state update.
     *  Viewport-relative; the layout effect compares this with the
     *  bar's NEW viewport-relative top to derive the scroll delta. */
    oldViewportY: number;
    /** Fallback anchor: visual idx of the first row AFTER the gap.
     *  Used when the click closes the gap completely (bar element
     *  disappears, can't query by gap id any more). The first-
     *  after-gap diff row is stable across the close transition. */
    fallbackVisualIdx: number;
    /** Same fallback row's viewport-Y BEFORE the state update. */
    fallbackOldViewportY: number | null;
  } | null>(null);

  /** Click handler for a gap arrow. `direction === 'up'` extends
   *  the upper changed region's context downward into the gap;
   *  `'down'` extends the lower changed region's context upward.
   *  Each click reveals at most `COMPACT_EXPAND_STEP` rows, clamped
   *  to whatever's still hidden. No-op clicks (gap already fully
   *  closed) bail without setting state.
   *
   *  Capture the bar's viewport position FIRST so the layout effect
   *  can pin it after re-render. */
  const handleGapExpand = useCallback(
    (gapId: number, direction: 'up' | 'down') => {
      const container = scrollContainerRef.current;
      const barEl = container?.querySelector(
        `[data-gap-id="${gapId}"]`,
      ) as HTMLElement | null;
      const oldViewportY = barEl?.getBoundingClientRect().top ?? null;

      // Compute fallback anchor (first row after the gap). Used
      // when the click closes the gap entirely — bar disappears, we
      // anchor on the next-row instead.
      const gap = compactGaps.find((g) => g.id === gapId);
      const fallbackVisualIdx = gap ? gap.endIdx + 1 : -1;
      const fallbackEl =
        fallbackVisualIdx >= 0
          ? (container?.querySelector(
              `[data-row-idx="${fallbackVisualIdx}"]`,
            ) as HTMLElement | null)
          : null;
      const fallbackOldViewportY =
        fallbackEl?.getBoundingClientRect().top ?? null;

      let stateChanged = false;
      setGapStates((prev) => {
        if (!gap) return prev;
        const cur = prev.get(gapId) ?? { topRevealed: 0, bottomRevealed: 0 };
        const size = gap.endIdx - gap.startIdx + 1;
        const remaining = size - cur.topRevealed - cur.bottomRevealed;
        if (remaining <= 0) return prev;
        const step = Math.min(COMPACT_EXPAND_STEP, remaining);
        const next: GapState =
          direction === 'up'
            ? { ...cur, topRevealed: cur.topRevealed + step }
            : { ...cur, bottomRevealed: cur.bottomRevealed + step };
        stateChanged = true;
        return new Map(prev).set(gapId, next);
      });

      if (stateChanged && oldViewportY !== null) {
        pendingAnchorRef.current = {
          gapId,
          oldViewportY,
          fallbackVisualIdx,
          fallbackOldViewportY,
        };
      }
    },
    [compactGaps],
  );

  // Apply the scroll-anchor adjustment AFTER React commits the new
  // renderRows but BEFORE the browser paints. `useLayoutEffect`
  // gives us that window — without it, the new rows would paint at
  // their new positions and a follow-up scroll adjustment would
  // visually flash.
  useLayoutEffect(() => {
    const pending = pendingAnchorRef.current;
    if (!pending) return;
    pendingAnchorRef.current = null;

    const container = scrollContainerRef.current;
    if (!container) return;

    // Try the bar itself first — most common case. The bar still
    // exists at a different DOM position because the gap shrunk
    // but didn't close.
    const newBarEl = container.querySelector(
      `[data-gap-id="${pending.gapId}"]`,
    ) as HTMLElement | null;
    if (newBarEl) {
      const newViewportY = newBarEl.getBoundingClientRect().top;
      const delta = newViewportY - pending.oldViewportY;
      container.scrollTop += delta;
      return;
    }

    // Bar gone (gap fully closed). Fall back to the first row AFTER
    // the gap — it's a stable hunk row that exists across the
    // transition. If even that's not measurable (gap was at the very
    // end of the file), accept the visual jump.
    if (pending.fallbackOldViewportY === null) return;
    const fallbackEl = container.querySelector(
      `[data-row-idx="${pending.fallbackVisualIdx}"]`,
    ) as HTMLElement | null;
    if (fallbackEl) {
      const newViewportY = fallbackEl.getBoundingClientRect().top;
      const delta = newViewportY - pending.fallbackOldViewportY;
      container.scrollTop += delta;
    }
  }, [gapStates]);

  // Helper for the targetLine effect: when the user wants to scroll
  // to a line that's currently inside a collapsed gap, look up the
  // gap id by visual index so we can expand it.
  const findGapIdForVisualIdx = useCallback(
    (visualIdx: number): number | null => {
      for (const g of compactGaps) {
        if (visualIdx >= g.startIdx && visualIdx <= g.endIdx) return g.id;
      }
      return null;
    },
    [compactGaps],
  );

  // Row-height estimator for the variable-size virtualizer. Diff
  // rows reuse the original 20 px constant so the visual rhythm of
  // the unchanged code is preserved; gap bars get a bit more
  // breathing room (28 px) so the click target is comfortable.
  const GAP_ROW_HEIGHT = 28;
  const estimateRowSize = useCallback(
    (i: number) => (renderRows[i]?.kind === 'gap' ? GAP_ROW_HEIGHT : ROW_HEIGHT),
    [renderRows],
  );

  // Virtual scrolling
  const virtualizer = useVirtualizer({
    count: renderRows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: estimateRowSize,
    overscan: 20,
  });

  // Adjust left/right width based on file status: new file 25%/75%, deleted 75%/25%, otherwise 50%/50%
  const leftWidth = isNew ? 'w-1/4' : isDeleted ? 'w-3/4' : 'w-1/2';
  const rightWidth = isNew ? 'w-3/4' : isDeleted ? 'w-1/4' : 'w-1/2';

  // Prepare minimap line types — projected from `renderRows` so the
  // minimap's vertical scale matches the scroll container's. In
  // compact mode collapsed gaps don't contribute to the scrollable
  // height, so they shouldn't contribute to the minimap either.
  // Gap rows render as `unchanged` strips — the user reads the
  // proportions of the actually-visible content, not what's hidden.
  const minimapLines = useMemo(
    () =>
      renderRows.map((row) => {
        if (row.kind === 'gap') return { type: 'unchanged' as const };
        const leftLine = leftLines[row.idx];
        const rightLine = rightLines[row.idx];
        if (leftLine.type === 'removed') return { type: 'removed' as const };
        if (rightLine?.type === 'added') return { type: 'added' as const };
        return { type: 'unchanged' as const };
      }),
    [renderRows, leftLines, rightLines],
  );

  const totalSize = virtualizer.getTotalSize();
  const virtualItems = virtualizer.getVirtualItems();

  // Programmatic scroll: when the `targetLine` object reference changes, find
  // the virtualizer index whose left/right lineNum matches and scroll there.
  // The parent supplies a fresh object (with new `tick`) on every request, so
  // ref-equality changes are sufficient to retrigger this effect — including
  // when the user clicks the same symbol twice.
  //
  // Compact mode: the target visual row may be hidden inside a
  // collapsed gap. In that case we first auto-expand the containing
  // gap to level 2 (full reveal) so the target has a render row, then
  // do the scroll on the next tick — `renderRows` recomputes via the
  // memo dep on `gapStates`, the second-tick effect catches the now-
  // visible target.
  useEffect(() => {
    if (!targetLine) return;
    const arr = targetLine.side === 'after' ? rightLines : leftLines;
    const visualIdx = arr.findIndex((l) => l.lineNum === targetLine.line);
    if (visualIdx === -1) return;

    // Map the visual index → renderRow index (compact mode reorders
    // and may skip rows). Linear scan; renderRows is small relative
    // to a typical UI scroll.
    const renderIdx = renderRows.findIndex(
      (r) => r.kind === 'diff' && r.idx === visualIdx,
    );
    if (renderIdx === -1) {
      // Target is inside a still-hidden gap. Auto-expand the
      // containing gap so the target has a render row, then let
      // the next effect tick (`renderRows` change re-fires this
      // effect) do the actual scroll.
      const gapId = findGapIdForVisualIdx(visualIdx);
      if (gapId !== null) {
        const gap = compactGaps.find((g) => g.id === gapId);
        if (!gap) return;
        const size = gap.endIdx - gap.startIdx + 1;
        setGapStates((prev) => {
          const cur = prev.get(gapId) ?? { topRevealed: 0, bottomRevealed: 0 };
          if (cur.topRevealed + cur.bottomRevealed >= size) return prev;
          // Fully reveal — split arbitrarily into top side; the
          // resulting visible state is the same regardless of the
          // split because top + bottom === size.
          const next = new Map(prev);
          next.set(gapId, { topRevealed: size, bottomRevealed: 0 });
          return next;
        });
      }
      return;
    }

    // Defer one frame so layout is settled when DiffView just mounted with a
    // new file (e.g. user clicked a symbol in a different file).
    const raf = requestAnimationFrame(() => {
      virtualizer.scrollToIndex(renderIdx, { align: 'start' });
    });
    return () => cancelAnimationFrame(raf);
    // virtualizer is a fresh instance every render; including it would loop.

  }, [targetLine, leftLines, rightLines, renderRows]);

  return (
    <div className="font-mono flex flex-col h-full text-sm">
      {/* Header row - fixed */}
      <div className="flex flex-shrink-0 border-b border-border">
        <div className={`${leftWidth} min-w-0 px-2 py-1 bg-accent text-muted-foreground text-center text-xs font-medium border-r border-border`}>
          {isNew ? '(New File)' : isDeleted ? 'Deleted' : 'Old'}
        </div>
        <div className={`${rightWidth} min-w-0 px-2 py-1 bg-accent text-muted-foreground text-xs font-medium relative`}>
          <span className="block text-center">{isDeleted ? '(Deleted)' : 'New'}</span>
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2">
            {onPreview && (
              <button
                onClick={onPreview}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                {resolvedPreviewLabel}
              </button>
            )}
            {!isDeleted && newContent && (
              <button
                onClick={() => { navigator.clipboard.writeText(newContent); toast(t('diffViewer.copiedAll')); }}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                {t('common.copy')}
              </button>
            )}
          </div>
        </div>
        <div className="w-4 flex-shrink-0 bg-accent" />
      </div>
      {/* Content row - flex-1 with min-h-0 to prevent flex stretch */}
      <div className="flex-1 min-h-0 flex">
        {/* Scroll wrapper - single vertical scroll container for virtualized rendering */}
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden">
          <div className="flex" style={{ height: `${totalSize}px` }}>
            {/* Left Panel - Old (horizontal scroll only) */}
            <div
              ref={leftPanelRef}
              className={`${leftWidth} overflow-x-auto border-r border-border`}
            >
              <div className="min-w-max h-full" style={{ position: 'relative' }}>
                {virtualItems.map((virtualItem) => {
                  const row = renderRows[virtualItem.index];
                  if (row.kind === 'gap') {
                    // Left half of the gap bar. Decorative — the
                    // ↑ / ↓ controls + the label live on the right
                    // half. Same bg/border/height as the right half
                    // so the two columns visually read as ONE bar.
                    // `data-gap-id` is on the right half; this side
                    // is just a passive backdrop.
                    return (
                      <div
                        key={virtualItem.key}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          height: `${virtualItem.size}px`,
                          transform: `translateY(${virtualItem.start}px)`,
                        }}
                        className="bg-accent border-y border-border"
                      />
                    );
                  }
                  const line = leftLines[row.idx];
                  return (
                    <div
                      key={virtualItem.key}
                      data-row-idx={row.idx}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        minWidth: '100%',
                        width: 'max-content',
                        height: `${virtualItem.size}px`,
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                      className={`flex ${line.type === 'removed' ? 'bg-red-9/15 dark:bg-red-9/25' : ''}`}
                    >
                      <span className="w-10 flex-shrink-0 text-right pr-2 text-slate-9 select-none border-r border-border">
                        {line.lineNum || ''}
                      </span>
                      <span
                        className="whitespace-pre pl-2"
                        dangerouslySetInnerHTML={{ __html: (line.originalIdx >= 0 && highlightedLines[line.originalIdx]) || escapeHtml(line.content || ' ') }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
            {/* Right Panel - New (horizontal scroll only) */}
            <div
              ref={rightPanelRef}
              className={`${rightWidth} overflow-x-auto`}
            >
              <div className="min-w-max h-full" style={{ position: 'relative' }}>
                {virtualItems.map((virtualItem) => {
                  const row = renderRows[virtualItem.index];
                  if (row.kind === 'gap') {
                    // Right half of the bar — carries:
                    //   - ↑ / ↓ arrow buttons (each click reveals
                    //     COMPACT_EXPAND_STEP rows on its side)
                    //   - the residual hidden-line count
                    // The whole bar carries `data-gap-id` so the
                    // scroll-anchor effect can find it before /
                    // after the state update.
                    return (
                      <div
                        key={virtualItem.key}
                        data-gap-id={row.gapId}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          height: `${virtualItem.size}px`,
                          transform: `translateY(${virtualItem.start}px)`,
                        }}
                        className="flex items-center justify-center gap-3 text-[11px] text-muted-foreground bg-accent border-y border-border min-w-0"
                      >
                        <button
                          type="button"
                          disabled={!row.canExpandUp}
                          onClick={() => handleGapExpand(row.gapId, 'up')}
                          // Visible button affordance:
                          //   default → muted icon at 80 % so it
                          //     doesn't blend with surrounding text
                          //   hover   → bg-secondary + brand teal
                          //     icon (fill style — most prominent;
                          //     a darker shade than `accent` since
                          //     the bar bg is already `accent`)
                          //   active  → brand-teal flash bg + brief
                          //     scale-95 squish so the user gets
                          //     tactile "pressed" feedback
                          //   disabled → 30 % opacity, no hover/
                          //     active reaction, no-drop cursor
                          className="flex-shrink-0 flex items-center justify-center w-7 h-5 rounded text-foreground/80 hover:bg-secondary hover:text-brand active:bg-brand/15 active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-foreground/80 disabled:active:scale-100 disabled:active:bg-transparent transition-all"
                          title={t('diffViewer.gap.expandUp', {
                            count: COMPACT_EXPAND_STEP,
                          })}
                          aria-label={t('diffViewer.gap.expandUp', {
                            count: COMPACT_EXPAND_STEP,
                          })}
                        >
                          <ChevronUp className="w-4 h-4" />
                        </button>
                        <span className="opacity-80 select-none flex-shrink-0">
                          {t('diffViewer.gap.hidden', { count: row.hiddenCount })}
                        </span>
                        {/* Function-context suffix — answers
                            "what's the next change inside?" without
                            the user having to expand. Truncates with
                            `min-w-0` + `truncate` because long TS
                            generics + many params can blow past the
                            bar width. */}
                        {row.enclosingFn && (
                          <>
                            <span className="opacity-50 select-none flex-shrink-0">·</span>
                            <span
                              className="opacity-90 truncate min-w-0 font-medium"
                              title={formatSignature(row.enclosingFn)}
                            >
                              {formatSignature(row.enclosingFn)}
                            </span>
                          </>
                        )}
                        <button
                          type="button"
                          disabled={!row.canExpandDown}
                          onClick={() => handleGapExpand(row.gapId, 'down')}
                          className="flex-shrink-0 flex items-center justify-center w-7 h-5 rounded text-foreground/80 hover:bg-secondary hover:text-brand active:bg-brand/15 active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-foreground/80 disabled:active:scale-100 disabled:active:bg-transparent transition-all"
                          title={t('diffViewer.gap.expandDown', {
                            count: COMPACT_EXPAND_STEP,
                          })}
                          aria-label={t('diffViewer.gap.expandDown', {
                            count: COMPACT_EXPAND_STEP,
                          })}
                        >
                          <ChevronDown className="w-4 h-4" />
                        </button>
                      </div>
                    );
                  }
                  const line = rightLines[row.idx];
                  const lineNum = line?.lineNum || 0;
                  const hasComments = lineNum > 0 && linesWithComments.has(lineNum);
                  const lineComments = commentsByEndLine.get(lineNum);
                  const firstComment = lineComments?.[0];
                  const isInCommentRange = addCommentInput && lineNum >= addCommentInput.range.start && lineNum <= addCommentInput.range.end;
                  const isInAIRange = sendToAIInput && lineNum >= sendToAIInput.range.start && lineNum <= sendToAIInput.range.end;
                  const isInRange = isInCommentRange || isInAIRange;

                  return (
                    <div
                      key={virtualItem.key}
                      data-new-line={lineNum || undefined}
                      data-row-idx={row.idx}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        minWidth: '100%',
                        width: 'max-content',
                        height: `${virtualItem.size}px`,
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                      className={`flex ${
                        isInRange ? 'bg-blue-9/20' :
                        hasComments ? 'bg-amber-9/10' :
                        line?.type === 'added' ? 'bg-green-9/15 dark:bg-green-9/25' : ''
                      }`}
                    >
                      <span className={`flex-shrink-0 flex items-center gap-0.5 pr-1 text-slate-9 select-none border-r border-border ${
                        isInRange ? 'bg-blue-9/30' : ''
                      }`} style={{ width: commentsEnabled ? '52px' : '40px' }}>
                        {/* Comment bubble */}
                        {commentsEnabled && lineNum > 0 && hasComments && firstComment && (
                          <button
                            onClick={(e) => handleCommentBubbleClick(firstComment, e)}
                            className="w-4 h-4 flex items-center justify-center rounded hover:bg-accent text-amber-9"
                            title={t('codeViewer.nComments', { count: lineComments?.length })}
                          >
                            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z" clipRule="evenodd" />
                            </svg>
                          </button>
                        )}
                        {commentsEnabled && lineNum > 0 && !hasComments && <span className="w-4" />}
                        <span className="flex-1 text-right pr-1">{lineNum || ''}</span>
                      </span>
                      <span
                        className="whitespace-pre pl-2"
                        dangerouslySetInnerHTML={{ __html: (line?.originalIdx >= 0 && highlightedLines[line.originalIdx]) || escapeHtml(line?.content || ' ') }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
        {/* Minimap - outside scroll container, fixed height */}
        <DiffMinimap
          lines={minimapLines}
          containerRef={scrollContainerRef}
        />
      </div>

      {/* Floating elements via Portal to menu container (keeps within second screen) */}
      {isMounted && menuContainer && createPortal(
        <>
          <ToolbarRenderer
            floatingToolbarRef={floatingToolbarRef}
            bumpRef={bumpToolbarRef}
            container={menuContainer}
            onAddComment={handleToolbarAddComment}
            onSendToAI={handleToolbarSendToAI}
            onSearch={onContentSearch ? handleToolbarSearch : undefined}
            isChatLoading={chatContext?.isLoading ?? false}
          />
          {addCommentInput && (
            <AddCommentInput
              x={addCommentInput.x}
              y={addCommentInput.y}
              range={addCommentInput.range}
              codeContent={addCommentInput.codeContent}
              container={menuContainer}
              onSubmit={handleCommentSubmit}
              onClose={() => setAddCommentInput(null)}
            />
          )}
          {sendToAIInput && (
            <SendToAIInput
              x={sendToAIInput.x}
              y={sendToAIInput.y}
              range={sendToAIInput.range}
              container={menuContainer}
              onSubmit={handleSendToAISubmit}
              onClose={() => setSendToAIInput(null)}
            />
          )}
          {viewingComment && (
            <ViewCommentCard
              x={viewingComment.x}
              y={viewingComment.y}
              comment={viewingComment.comment}
              container={menuContainer}
              onClose={() => setViewingComment(null)}
              onUpdateComment={updateComment}
              onDeleteComment={deleteComment}
            />
          )}
        </>,
        menuContainer
      )}
    </div>
  );
}

// ============================================
// Unified Diff View Component (with virtual scrolling)
// ============================================

export function DiffUnifiedView({ oldContent, newContent, filePath }: Omit<DiffViewProps, 'isNew' | 'isDeleted'>) {
  const diffLines = useMemo(() => computeLineDiff(oldContent, newContent), [oldContent, newContent]);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const allLines = useMemo(() => diffLines.map(line => line.content), [diffLines]);
  const highlightedLines = useLineHighlight(allLines, filePath);

  const virtualizer = useVirtualizer({
    count: diffLines.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  return (
    <div ref={scrollContainerRef} className="font-mono text-sm overflow-auto h-full">
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const line = diffLines[virtualItem.index];
          return (
            <div
              key={virtualItem.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                minWidth: '100%',
                width: 'max-content',
                height: `${virtualItem.size}px`,
                transform: `translateY(${virtualItem.start}px)`,
              }}
              className={`flex ${
                line.type === 'removed'
                  ? 'bg-red-9/15 dark:bg-red-9/25'
                  : line.type === 'added'
                  ? 'bg-green-9/15 dark:bg-green-9/25'
                  : ''
              }`}
            >
              {/* Line numbers */}
              <span className="w-10 flex-shrink-0 text-right pr-2 text-slate-9 select-none border-r border-border">
                {line.type !== 'added' ? line.oldLineNum : ''}
              </span>
              <span className="w-10 flex-shrink-0 text-right pr-2 text-slate-9 select-none border-r border-border">
                {line.type !== 'removed' ? line.newLineNum : ''}
              </span>
              {/* Symbol */}
              <span
                className={`w-6 flex-shrink-0 text-center select-none ${
                  line.type === 'removed'
                    ? 'text-red-11'
                    : line.type === 'added'
                    ? 'text-green-11'
                    : 'text-slate-9'
                }`}
              >
                {line.type === 'removed' ? '-' : line.type === 'added' ? '+' : ' '}
              </span>
              {/* Content with syntax highlighting */}
              <span
                className="flex-1 whitespace-pre pl-1"
                dangerouslySetInnerHTML={{ __html: highlightedLines[virtualItem.index] || escapeHtml(line.content || ' ') }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Default export is the split view
export default DiffView;
