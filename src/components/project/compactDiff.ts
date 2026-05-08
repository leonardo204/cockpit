/**
 * compactDiff — pure helpers for rendering DiffView in "compact" mode
 * (changes-only, GitHub-style with collapsed unchanged regions).
 *
 * Pipeline:
 *
 *   buildCompactRows(leftLines, rightLines, gapStates)
 *      → { rows, gaps }
 *
 *   `rows` is the flat list the virtualizer iterates: a sequence of
 *   `{ kind: 'diff', idx }` (a real diff row to render) and
 *   `{ kind: 'gap', gapId, hiddenCount }` (a bar to render in place
 *   of N consecutive hidden rows).
 *
 *   `gaps` is the canonical gap registry — used by the click handler
 *   to clamp `topRevealed + bottomRevealed` against `gap.size`.
 *
 * State model — bidirectional incremental, GitHub-style:
 *
 *   For each gap, the user maintains two counters:
 *     - `topRevealed`: rows revealed at gap.startIdx, extending the
 *       upper changed region's context downward into the gap.
 *     - `bottomRevealed`: rows revealed at gap.endIdx, extending the
 *       lower changed region's context upward.
 *
 *   The bar always sits at the residual hidden middle. As the user
 *   clicks ↑ or ↓, one counter grows by `COMPACT_EXPAND_STEP` (20
 *   rows; matches GitHub) and the bar moves / shrinks. When
 *   `topRevealed + bottomRevealed >= gap.size`, the residual is
 *   empty and the bar disappears.
 *
 * Why bidirectional incremental, not "expand-all" or "expand-to-
 * function-boundary":
 *
 *   - Predictable line count per click: the user knows what each
 *     click will reveal (always +20, clamped to remaining). Avoids
 *     "I clicked once and 200 lines appeared".
 *   - Scroll anchoring (handled in DiffView's render layer) keeps
 *     the user's viewport stable. With unbounded reveals the
 *     anchor is harder to keep meaningful.
 *   - Earlier prototypes used the AST to expand to enclosing-
 *     function boundaries; user feedback was that the line count
 *     was uncontrollable and big jumps disrupted reading. We
 *     deleted the AST path and aligned with GitHub's UX exactly.
 *
 * Coordinate systems:
 *   The diff is two columns of "visual rows" (`leftLines[i]` aligns
 *   with `rightLines[i]`). One visual row is one virtualizer index.
 *   A "gap" in this module's vocabulary is a consecutive run of
 *   visual-row indices that don't make it into any hunk's context
 *   window.
 */

/** Default unchanged-line context to keep around each changed run.
 *  GitHub uses 3; matches reader expectations. */
export const COMPACT_CONTEXT_LINES = 3;

/** Lines revealed per ↑ / ↓ click. GitHub uses 20. Hardcoded; if
 *  someone wants this configurable in future, it becomes a prop. */
export const COMPACT_EXPAND_STEP = 20;

/** A visual row's left + right columns — minimal type the helpers
 *  need. Matches `leftLines[i]` / `rightLines[i]` shape from
 *  DiffView's own row builder. */
export interface VisualLine {
  lineNum: number;
  type: 'unchanged' | 'removed' | 'added';
}

/** A function-like symbol — just enough for the gap bar to label
 *  itself with "this hidden region precedes a change inside foo()".
 *  Caller projects from `FunctionNode` (or any equivalent) and
 *  filters to function-like kinds; we don't care about the kind
 *  here.
 *
 *  Why caller-provides instead of fetched here: the source of truth
 *  is `useFileFunctions`, which lives in the React component tree
 *  with its own caching + mtime-aware refresh. Threading the array
 *  through as a prop keeps `compactDiff` pure. */
export interface SymbolInfo {
  name: string;
  startLine: number;
  endLine: number;
  /** Optional parameter names for callables (function | method).
   *  Undefined means "don't render parens"; empty array means
   *  "render `()`". Same convention as `FunctionNode.params`. */
  params?: readonly string[];
}

/** Per-gap user expansion state. Missing entries default to
 *  `{ topRevealed: 0, bottomRevealed: 0 }` (fully collapsed). */
export interface GapState {
  /** Rows revealed at the gap's TOP (extending the upper changed
   *  region's context downward). Always 0 ≤ topRevealed ≤ gap.size. */
  topRevealed: number;
  /** Rows revealed at the gap's BOTTOM (extending the lower changed
   *  region's context upward). Always 0 ≤ bottomRevealed ≤ gap.size,
   *  AND topRevealed + bottomRevealed ≤ gap.size. */
  bottomRevealed: number;
}

/** A run of consecutive HIDDEN visual rows — the thing we render as
 *  a gap bar. `id` is stable across renders (assigned by source
 *  order). */
export interface Gap {
  id: number;
  startIdx: number;
  endIdx: number;
}

/** Output row types for the virtualizer. `diff` rows index into
 *  `leftLines` / `rightLines`; `gap` rows render the expandable
 *  bar with two arrow buttons. */
export type RenderRow =
  | { kind: 'diff'; idx: number }
  | {
      kind: 'gap';
      /** Stable id of the parent gap. Used by the click handler to
       *  look up size for clamping, and by the scroll-anchor effect
       *  to find the bar's DOM element via `data-gap-id`. */
      gapId: number;
      /** How many rows the bar still hides. Shown in the bar's
       *  text ("47 lines hidden"). */
      hiddenCount: number;
      /** True iff `topRevealed === 0` — drives the up-arrow's
       *  enabled/disabled state. With nothing more to reveal at
       *  the top (fully revealed from top to current bar position),
       *  ↑ would be a no-op; we visually disable it. */
      canExpandUp: boolean;
      /** Symmetric — true iff `bottomRevealed === 0` … wait, no:
       *  ↓ extends the BOTTOM context UP into the gap. The button
       *  is meaningful as long as the bar still has hidden rows
       *  on its bottom side; since the residual range IS the bar,
       *  the button is always meaningful when the bar exists. The
       *  `canExpand{Up,Down}` flags exist to handle clamping at
       *  the boundary where one side has fully consumed the gap. */
      canExpandDown: boolean;
      /** Function-like symbol enclosing the FIRST changed line BELOW
       *  the bar (i.e. the next changed region the user will see
       *  when scrolling down). Mirrors GitHub's "@@ -X +Y @@ funcName"
       *  hunk-header convention — answers "what function is the
       *  next change in?" without making the user expand or scroll
       *  to find out.
       *
       *  Undefined when:
       *    - The next changed region's line is in top-level code
       *      (no enclosing function-like symbol).
       *    - The file has no symbols available (caller passed no
       *      `symbols`, or the file isn't in the codeMap index —
       *      .json / .md / .css / etc).
       *    - The next visible row's `lineNum` is 0 (pure-removed
       *      / padding row — has no new-file line to look up). */
      enclosingFn?: SymbolInfo;
    };

/** Find the smallest (innermost) symbol whose range contains
 *  `line`. Linear over symbols — fine for ≤ 200 symbols/file. */
function innerEnclosing(
  symbols: readonly SymbolInfo[],
  line: number,
): SymbolInfo | null {
  let best: SymbolInfo | null = null;
  for (const s of symbols) {
    if (s.startLine <= line && line <= s.endLine) {
      if (!best || s.endLine - s.startLine < best.endLine - best.startLine) {
        best = s;
      }
    }
  }
  return best;
}

/**
 * Build compact-mode render rows + the gap registry from a pair of
 * (already-aligned) visual line arrays + per-gap user state +
 * (optional) function-like symbol ranges for the AFTER snapshot.
 *
 * `symbols` is read-only and informational — it does NOT influence
 * gap expansion (that's bidirectional +N rows on each click). Its
 * only job is to label each gap bar with the enclosing function of
 * the next changed region. Pass `[]` (or omit) for files without
 * AST data.
 *
 * Time: O(rows + gaps × symbols). Both factors are tiny in practice
 * (gaps cap at maybe 50 for huge files; symbols cap at file size);
 * recomputed only when leftLines / rightLines / gapStates / symbols
 * change.
 */
export function buildCompactRows(
  leftLines: readonly VisualLine[],
  rightLines: readonly VisualLine[],
  gapStates: ReadonlyMap<number, GapState>,
  symbols: readonly SymbolInfo[] = [],
): { rows: RenderRow[]; gaps: Gap[] } {
  const n = leftLines.length;

  // Step 1 — classify each visual row as changed (anything but
  // `unchanged | unchanged`) or unchanged.
  const isChanged = (i: number) =>
    leftLines[i].type !== 'unchanged' || rightLines[i].type !== 'unchanged';

  // Step 2 — find the visible set: every changed row + 3 lines of
  // context on each side. Context windows around adjacent runs may
  // overlap; the Set dedupes.
  const visible = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (!isChanged(i)) continue;
    const lo = Math.max(0, i - COMPACT_CONTEXT_LINES);
    const hi = Math.min(n - 1, i + COMPACT_CONTEXT_LINES);
    for (let j = lo; j <= hi; j++) visible.add(j);
  }

  // Step 3 — derive gaps from the complement (consecutive runs of
  // hidden indices). Gap ids are positional — stable across renders
  // for the same diff but invalidated if leftLines / rightLines
  // change (e.g. user navigated to a different file). Caller resets
  // `gapStates` on that transition.
  const gaps: Gap[] = [];
  for (let i = 0; i < n; i++) {
    if (visible.has(i)) continue;
    const startIdx = i;
    while (i < n && !visible.has(i)) i++;
    gaps.push({ id: gaps.length, startIdx, endIdx: i - 1 });
    i--; // outer loop increments
  }

  // Step 4 — augment `visible` with per-gap revealed top/bottom
  // ranges. Anything still-hidden after this becomes a gap bar.
  for (const g of gaps) {
    const state = gapStates.get(g.id) ?? { topRevealed: 0, bottomRevealed: 0 };
    const size = g.endIdx - g.startIdx + 1;
    // Clamp defensively. Caller is supposed to keep states valid,
    // but state could be stale from a previous file with a larger
    // gap at the same id. Better to under-reveal than over-reveal
    // (which would index past the gap into the next hunk).
    const topRevealed = Math.max(0, Math.min(state.topRevealed, size));
    const bottomRevealed = Math.max(
      0,
      Math.min(state.bottomRevealed, size - topRevealed),
    );
    for (let k = g.startIdx; k < g.startIdx + topRevealed; k++) visible.add(k);
    for (let k = g.endIdx - bottomRevealed + 1; k <= g.endIdx; k++) visible.add(k);
  }

  // Step 5 — build the row list. Walk `n` visual rows; emit a diff
  // row for every visible index; collapse runs of hidden indices
  // into one gap bar each. Each hidden run belongs to exactly one
  // gap (top + bottom reveals leave a SINGLE residual middle range,
  // never two), so no parent-gap lookup is needed during the walk.
  const rows: RenderRow[] = [];
  for (let i = 0; i < n; i++) {
    if (visible.has(i)) {
      rows.push({ kind: 'diff', idx: i });
      continue;
    }
    const subStart = i;
    while (i < n && !visible.has(i)) i++;
    const subEnd = i - 1;
    i--; // outer loop increments

    const parent = gaps.find(
      (g) => g.startIdx <= subStart && subEnd <= g.endIdx,
    );
    if (!parent) continue; // defensive — shouldn't happen
    const state =
      gapStates.get(parent.id) ?? { topRevealed: 0, bottomRevealed: 0 };
    const size = parent.endIdx - parent.startIdx + 1;

    // Look up the function enclosing the FIRST changed line below
    // this hidden run (i.e. the next thing the user will see). For
    // a partially-expanded gap this is the row at `subEnd + 1`,
    // which is by definition visible (otherwise we'd still be in
    // the hidden run). For an end-of-file gap (`subEnd + 1 >= n`)
    // there's nothing below — leave `enclosingFn` undefined.
    let enclosingFn: SymbolInfo | undefined;
    if (symbols.length > 0 && subEnd + 1 < n) {
      // Walk forward to skip pure-removed / padding rows whose
      // `rightLine.lineNum` is 0 (no new-file line to look up).
      for (let j = subEnd + 1; j < n; j++) {
        const ln = rightLines[j].lineNum;
        if (ln <= 0) continue;
        enclosingFn = innerEnclosing(symbols, ln) ?? undefined;
        break;
      }
    }

    rows.push({
      kind: 'gap',
      gapId: parent.id,
      hiddenCount: subEnd - subStart + 1,
      canExpandUp: state.topRevealed < size,
      canExpandDown: state.bottomRevealed < size - state.topRevealed,
      enclosingFn,
    });
  }

  return { rows, gaps };
}
