/**
 * treeSelection.ts — what is selected in the file tree, and what a click does to
 * it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A MODULE
 *
 * Selection is three rules that everyone knows and nobody can state: a plain
 * click replaces, a toggle-click adds or removes, and a range-click extends from
 * an anchor that is NOT simply "the last thing clicked". Getting the anchor
 * wrong is the classic bug — shift-clicking twice should re-extend from the
 * original anchor, not walk the selection down the list one row per click — and
 * it is invisible until someone tries it.
 *
 * The panel has no render harness, so a rule written inside an event handler is
 * a rule no test can reach.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT A RANGE MEANS IN A TREE THAT IS NOT A LIST
 *
 * Range selection is defined over what the user can SEE, in the order they see
 * it. That is not the filesystem and it is not the tree — it is the flattened
 * sequence of currently-visible rows, which depends on which folders happen to
 * be expanded. A range from a row inside a collapsed folder is not expressible,
 * and does not need to be: the row is not on screen to be clicked.
 *
 * So the caller supplies `visible`, the rows in display order, and this module
 * never has to know how the tree is built. That also makes every rule here
 * testable against a plain array of strings.
 */

/** Which rows are selected, and where a range would extend FROM.
 *
 *  `anchor` is deliberately separate from "the most recently selected row": a
 *  shift-click moves the selection but must NOT move the anchor, or the second
 *  shift-click measures from the wrong end. */
export interface TreeSelection {
  selected: readonly string[];
  anchor: string | null;
}

export const EMPTY_SELECTION: TreeSelection = { selected: [], anchor: null };

/** What the pointer asked for, read off the event by the caller so this module
 *  never touches a DOM type. */
export interface ClickIntent {
  /** Cmd on macOS, Ctrl elsewhere — add or remove this one row. */
  toggle: boolean;
  /** Shift — extend from the anchor to here. */
  range: boolean;
}

/**
 * Apply a click to the selection.
 *
 * PRECEDENCE: range beats toggle. Holding both is ambiguous, and every file
 * manager resolves it the same way — the shift gesture is the more specific
 * request, and a user holding both is reaching for a range.
 */
export function applyClick(
  current: TreeSelection,
  rel: string,
  intent: ClickIntent,
  visible: readonly string[],
): TreeSelection {
  if (intent.range && current.anchor) {
    const from = visible.indexOf(current.anchor);
    const to = visible.indexOf(rel);
    // An anchor that has scrolled out of existence — its folder was collapsed,
    // or the file was deleted — cannot anchor a range. Falling back to a plain
    // selection is what the user gets anyway if they click again, and it beats
    // selecting a range measured from a row that is not there.
    if (from === -1 || to === -1) return { selected: [rel], anchor: rel };
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    return {
      selected: visible.slice(lo, hi + 1),
      // THE ANCHOR DOES NOT MOVE. This is the whole reason it is a separate
      // field: shift-clicking a second row must re-measure from where the user
      // started, not from wherever the last shift landed.
      anchor: current.anchor,
    };
  }

  if (intent.toggle) {
    const has = current.selected.includes(rel);
    const selected = has
      ? current.selected.filter((r) => r !== rel)
      : [...current.selected, rel];
    // Toggling DOES move the anchor, including when it removes: the row the
    // user just acted on is where they are, and a subsequent shift-click should
    // measure from there. Deselecting the last row leaves nothing to measure
    // from, so the anchor goes with it.
    return { selected, anchor: selected.length === 0 ? null : rel };
  }

  return { selected: [rel], anchor: rel };
}

/**
 * Drop rows that are no longer there.
 *
 * A selection is a set of paths, and paths stop existing — a folder collapses,
 * a file is deleted, a refresh brings back a different tree. A stale entry is
 * not harmless: it is what makes "delete the selection" reach for something that
 * moved, and what makes a count say 5 when 3 rows are highlighted.
 *
 * `known` is every path the tree currently has loaded, which is not the same as
 * every path in the project — a collapsed folder's children are unknown, not
 * gone. So collapsing a folder DOES clear the selection inside it, and that is
 * the honest behaviour: those rows are not on screen and cannot be acted on as a
 * group the user can see.
 */
export function pruneSelection(
  current: TreeSelection,
  known: readonly string[],
): TreeSelection {
  const set = new Set(known);
  const selected = current.selected.filter((r) => set.has(r));
  const anchor = current.anchor && set.has(current.anchor) ? current.anchor : null;
  // BOTH are checked before claiming nothing changed. An anchor can go stale
  // while every selected row survives — collapse the folder the anchor is in and
  // the selection is untouched — and returning early on the list alone would
  // leave a range measuring from a row that is no longer there.
  if (selected.length === current.selected.length && anchor === current.anchor) return current;
  return { selected, anchor };
}

/**
 * The rows an operation should act on, given the row it was invoked from.
 *
 * THE RIGHT-CLICK RULE, and it is the one people get wrong: a context menu
 * opened on a row INSIDE the selection acts on the whole selection; opened on a
 * row outside it, it acts on that row alone — and, in every file manager,
 * re-selects it. Without this, right-clicking a file while five others are
 * selected deletes six things, which is a data-loss bug rather than a UI wart.
 */
export function targetsFor(
  current: TreeSelection,
  invokedOn: string,
): readonly string[] {
  return current.selected.includes(invokedOn) ? current.selected : [invokedOn];
}

/** Whether a row should be drawn as selected. A function rather than a Set on
 *  the context so the value can stay referentially stable across renders that
 *  did not change the selection. */
export function isSelected(current: TreeSelection, rel: string): boolean {
  return current.selected.includes(rel);
}
