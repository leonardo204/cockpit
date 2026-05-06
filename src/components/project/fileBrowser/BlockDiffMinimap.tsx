'use client';

/**
 * BlockDiffMinimap — chip-diff sibling of `DiffMinimap` (the right-side
 * minimap used by `DiffView`). Shares DiffMinimap's visual language —
 * `w-4` track, `bg-secondary` fill, green change stripes, neutral
 * viewport thumb, always-on (no auto-hide) — so chip-diff and
 * file-diff feel like the same family of widgets.
 *
 * Where it differs from DiffMinimap is the click semantics. DiffMinimap
 * runs `container.scrollTo(fraction * scrollHeight)`, which is fine
 * when EVERY file line is in the DOM. Chip diff only renders the
 * blocks the projection touched, so most file lines have no
 * corresponding row to scroll to — a raw `scrollTo` would land on a
 * collapsed gap and the user would see nothing change. Instead, this
 * minimap maps the click → file line → containing rendered block, and
 * delegates to a `onJumpToLine(qname, line)` callback (BlockViewer
 * wires this to its existing line-level `flashTarget` mechanism, so
 * the chip scrolls into view AND pulses the precise changed line,
 * just like a tick-click on the old overview ruler).
 *
 * Click priority:
 *   1. Direct hit inside a change run → jump to the clicked line.
 *   2. Within ~5% of a run → snap to the run's nearest endpoint
 *      (forgiving fat-finger clicks on a 16px-wide bar).
 *   3. Inside a rendered block range → jump to the block's start
 *      line (scrollbar-style "click here to scroll to that chip").
 *   4. Outside any rendered block (file region the chip view filtered
 *      away) → silent no-op. There's nothing to scroll to.
 *
 * Caller is responsible for tracking `viewportRange` (which file
 * lines are currently visible in the chip viewport) and feeding it
 * back so the thumb stays in sync with the user's scroll position.
 */

import { useMemo, useRef } from 'react';

export interface RenderedBlockRange {
  qname: string;
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
}

interface BlockDiffMinimapProps {
  /** Added/changed line numbers (after-file, 1-based, absolute).
   *  Lines outside any rendered block are dropped — they'd render as
   *  unjumpable green ticks. */
  addedLines: ReadonlySet<number>;
  /** Total line count of the (after) file — the minimap's vertical
   *  scale. Every position is computed as a percentage of this. */
  totalLines: number;
  /** Line ranges of every block currently rendered in chip view —
   *  drives both (a) the click-to-block fallback (priority 3) and
   *  (b) the filter that keeps unrenderable green ticks off the
   *  minimap. */
  blockRanges: readonly RenderedBlockRange[];
  /** Currently-visible file-line range in the chip viewport — drives
   *  the viewport thumb. `null`/undefined hides the thumb (used
   *  before the first measurement so the thumb doesn't flash at
   *  line 1 on initial paint). */
  viewportRange?: { start: number; end: number } | null;
  /** Wired by the caller to a line-level flashTarget so the chip
   *  scrolls + pulses the precise row. */
  onJumpToLine: (qname: string, line: number) => void;
}

/** A run of consecutive added lines that share the same block.
 *  Visual collapse only — we render a 10-line change as ONE solid
 *  green stripe (matching DiffMinimap's "added line = colored
 *  stripe" feel) instead of 10 dashes with 1px gaps. Click handling
 *  still resolves to the precise line via Y-coordinate math, so the
 *  collapse is purely cosmetic. Two adjacent lines in DIFFERENT
 *  blocks aren't merged — a gap at the block boundary keeps the
 *  click → block mapping unambiguous. */
interface ChangeRun {
  start: number;
  end: number;
  qname: string;
}

export function BlockDiffMinimap({
  addedLines,
  totalLines,
  blockRanges,
  viewportRange,
  onJumpToLine,
}: BlockDiffMinimapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Two-pass: filter addedLines to those inside a rendered block,
  // then fold consecutive same-block lines into runs for compact
  // rendering. Identical algorithm to the old BlockOverviewRuler
  // (and to DiffMinimap's per-line color logic, just collapsed).
  const runs = useMemo<ChangeRun[]>(() => {
    if (totalLines <= 0 || addedLines.size === 0) return [];
    const sortedRanges = [...blockRanges].sort(
      (a, b) => a.startLine - b.startLine,
    );
    const ticks: { line: number; qname: string }[] = [];
    for (const line of addedLines) {
      const range = sortedRanges.find(
        (r) => line >= r.startLine && line <= r.endLine,
      );
      if (range) ticks.push({ line, qname: range.qname });
    }
    ticks.sort((a, b) => a.line - b.line);

    const out: ChangeRun[] = [];
    let cur: ChangeRun | null = null;
    for (const t of ticks) {
      if (cur && t.line === cur.end + 1 && t.qname === cur.qname) {
        cur.end = t.line;
      } else {
        if (cur) out.push(cur);
        cur = { start: t.line, end: t.line, qname: t.qname };
      }
    }
    if (cur) out.push(cur);
    return out;
  }, [addedLines, blockRanges, totalLines]);

  if (totalLines <= 0 || blockRanges.length === 0) return null;

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.height <= 0) return;
    const fraction = (e.clientY - rect.top) / rect.height;
    const targetLine = Math.max(
      1,
      Math.min(totalLines, Math.round(fraction * totalLines)),
    );

    // 1. Direct hit on a change run → jump to the clicked line (not
    //    the run's start) so multi-line changes give per-line
    //    addressability — same UX as VSCode's overview ruler.
    const containingRun = runs.find(
      (r) => targetLine >= r.start && targetLine <= r.end,
    );
    if (containingRun) {
      onJumpToLine(containingRun.qname, targetLine);
      return;
    }

    // 2. Near-miss on a run within ~5% of the file → snap to the
    //    run's nearest endpoint. Forgives fat-finger clicks on a
    //    thin bar.
    if (runs.length > 0) {
      const tolerance = Math.max(2, Math.round(totalLines * 0.05));
      let best: ChangeRun | null = null;
      let bestDist = Infinity;
      for (const r of runs) {
        const d =
          targetLine < r.start
            ? r.start - targetLine
            : targetLine > r.end
              ? targetLine - r.end
              : 0;
        if (d < bestDist) {
          best = r;
          bestDist = d;
        }
      }
      if (best && bestDist <= tolerance) {
        const snapLine =
          targetLine < best.start
            ? best.start
            : targetLine > best.end
              ? best.end
              : targetLine;
        onJumpToLine(best.qname, snapLine);
        return;
      }
    }

    // 3. Inside a rendered block (no run hit) → jump to the block's
    //    start. Scrollbar-style fallback so clicking the minimap in
    //    a "covered but unchanged" region still scrolls SOMEWHERE
    //    sensible. Block start (rather than the interpolated line)
    //    keeps the chip's top in view; landing mid-block puts the
    //    chip header off-screen and disorients.
    const containingBlock = blockRanges.find(
      (r) => targetLine >= r.startLine && targetLine <= r.endLine,
    );
    if (containingBlock) {
      onJumpToLine(containingBlock.qname, containingBlock.startLine);
      return;
    }

    // 4. File region the chip view filtered out — there's nothing
    //    to scroll to. Silent no-op (no toast, no console spam).
  };

  return (
    <div
      ref={containerRef}
      onClick={handleClick}
      className="w-4 flex-shrink-0 bg-secondary border-l border-border relative cursor-pointer"
      title="Diff minimap — click to jump"
    >
      {/* Green change-run stripes — DiffMinimap-equivalent. Min 2px
          height (matching DiffMinimap's `minHeight: 2px`) so a
          single-line run in a 5000-line file doesn't collapse to a
          sub-pixel sliver and disappear. */}
      {runs.map((r) => {
        const top = ((r.start - 1) / totalLines) * 100;
        const heightPct = ((r.end - r.start + 1) / totalLines) * 100;
        return (
          <div
            key={`run:${r.qname}:${r.start}-${r.end}`}
            className="absolute left-0 right-0 bg-green-9 pointer-events-none"
            style={{
              top: `${top}%`,
              height: `${heightPct}%`,
              minHeight: '2px',
            }}
          />
        );
      })}

      {/* Viewport thumb — same neutral fill / border treatment as
          DiffMinimap's viewport indicator (`bg-muted/60 border-y
          border-border`). Always visible (no auto-hide), pinned on
          top of the change runs. Min 1.2% height so a tiny viewport
          (one fully-visible 3-line block in a 5000-line file) still
          renders as a visible block instead of a hairline. */}
      {viewportRange &&
        viewportRange.end >= viewportRange.start &&
        (() => {
          const top = ((viewportRange.start - 1) / totalLines) * 100;
          const heightPct =
            ((viewportRange.end - viewportRange.start + 1) / totalLines) * 100;
          return (
            <div
              className="absolute left-0 right-0 bg-muted/60 border-y border-border pointer-events-none"
              style={{
                top: `${top}%`,
                height: `${Math.max(1.2, heightPct)}%`,
              }}
            />
          );
        })()}
    </div>
  );
}
