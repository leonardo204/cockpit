import { describe, it, expect } from 'vitest';
import {
  EMPTY_SELECTION,
  applyClick,
  isSelected,
  pruneSelection,
  targetsFor,
  type TreeSelection,
} from './treeSelection';

/**
 * SELECTION IS THREE RULES EVERYONE KNOWS AND NOBODY CAN STATE.
 *
 * The one that actually breaks is the anchor: shift-clicking twice must
 * re-measure from where the user STARTED, not walk the selection down one row
 * per click. It is invisible until someone tries it, which is why it is pinned
 * here rather than left inside an event handler the panel has no harness to
 * render.
 */

/** The rows as the user sees them — display order, expanded folders inlined.
 *  Range selection is defined over this and nothing else. */
const VISIBLE = ['a.ts', 'src', 'src/one.ts', 'src/two.ts', 'src/three.ts', 'z.ts'];

const sel = (selected: string[], anchor: string | null = null): TreeSelection => ({
  selected,
  anchor,
});

const plain = { toggle: false, range: false };
const toggle = { toggle: true, range: false };
const range = { toggle: false, range: true };

describe('a plain click', () => {
  it('replaces whatever was selected', () => {
    expect(applyClick(sel(['a.ts', 'z.ts'], 'a.ts'), 'src', plain, VISIBLE)).toEqual({
      selected: ['src'],
      anchor: 'src',
    });
  });

  it('sets the anchor to where the user just clicked', () => {
    expect(applyClick(EMPTY_SELECTION, 'src/two.ts', plain, VISIBLE).anchor).toBe('src/two.ts');
  });
});

describe('a toggle click', () => {
  it('adds a row without losing the others', () => {
    expect(applyClick(sel(['a.ts'], 'a.ts'), 'z.ts', toggle, VISIBLE)).toEqual({
      selected: ['a.ts', 'z.ts'],
      anchor: 'z.ts',
    });
  });

  it('removes a row that was already selected', () => {
    expect(applyClick(sel(['a.ts', 'z.ts'], 'a.ts'), 'a.ts', toggle, VISIBLE)).toEqual({
      selected: ['z.ts'],
      anchor: 'a.ts',
    });
  });

  it('moves the anchor, because that is where the user now is', () => {
    // A shift-click after a cmd-click should measure from the cmd-clicked row.
    const after = applyClick(sel(['a.ts'], 'a.ts'), 'src/one.ts', toggle, VISIBLE);
    expect(after.anchor).toBe('src/one.ts');
  });

  it('clears the anchor when it deselects the last row', () => {
    // Nothing left to measure a range from.
    expect(applyClick(sel(['a.ts'], 'a.ts'), 'a.ts', toggle, VISIBLE)).toEqual({
      selected: [],
      anchor: null,
    });
  });

  it('starts a selection from nothing', () => {
    expect(applyClick(EMPTY_SELECTION, 'a.ts', toggle, VISIBLE).selected).toEqual(['a.ts']);
  });
});

describe('a range click', () => {
  it('selects everything between the anchor and here, in display order', () => {
    expect(applyClick(sel(['src'], 'src'), 'src/three.ts', range, VISIBLE).selected).toEqual([
      'src',
      'src/one.ts',
      'src/two.ts',
      'src/three.ts',
    ]);
  });

  it('works upwards as well as downwards', () => {
    expect(applyClick(sel(['z.ts'], 'z.ts'), 'src/two.ts', range, VISIBLE).selected).toEqual([
      'src/two.ts',
      'src/three.ts',
      'z.ts',
    ]);
  });

  it('DOES NOT MOVE THE ANCHOR — the bug this module exists to prevent', () => {
    // Shift-click one row, then another. The second range must be measured from
    // the ORIGINAL anchor, so it grows and shrinks around it rather than
    // crawling down the list one row per click.
    const first = applyClick(sel(['src'], 'src'), 'src/three.ts', range, VISIBLE);
    expect(first.anchor).toBe('src');
    const second = applyClick(first, 'src/one.ts', range, VISIBLE);
    expect(second.selected).toEqual(['src', 'src/one.ts']);
    expect(second.anchor).toBe('src');
  });

  it('is a plain selection when there is no anchor yet', () => {
    expect(applyClick(EMPTY_SELECTION, 'src/two.ts', range, VISIBLE)).toEqual({
      selected: ['src/two.ts'],
      anchor: 'src/two.ts',
    });
  });

  it('falls back to a plain selection when the anchor is gone', () => {
    // Its folder was collapsed, or the file was deleted. A range measured from a
    // row that is not on screen would select something the user cannot see.
    const stale = sel(['ghost.ts'], 'ghost.ts');
    expect(applyClick(stale, 'z.ts', range, VISIBLE)).toEqual({
      selected: ['z.ts'],
      anchor: 'z.ts',
    });
  });

  it('selects the one row when anchor and target are the same', () => {
    expect(applyClick(sel(['src'], 'src'), 'src', range, VISIBLE).selected).toEqual(['src']);
  });

  it('beats toggle when both modifiers are held', () => {
    // Ambiguous, and every file manager resolves it the same way: shift is the
    // more specific request.
    const both = { toggle: true, range: true };
    expect(applyClick(sel(['a.ts'], 'a.ts'), 'src/one.ts', both, VISIBLE).selected).toEqual([
      'a.ts',
      'src',
      'src/one.ts',
    ]);
  });
});

describe('rows that stop existing', () => {
  it('drops a selected row the tree no longer has', () => {
    // A stale entry is what makes "delete the selection" reach for something
    // that moved, and a count say 5 while 3 rows are highlighted.
    expect(pruneSelection(sel(['a.ts', 'gone.ts'], 'a.ts'), VISIBLE)).toEqual({
      selected: ['a.ts'],
      anchor: 'a.ts',
    });
  });

  it('drops the anchor with it', () => {
    expect(pruneSelection(sel(['a.ts'], 'gone.ts'), VISIBLE).anchor).toBeNull();
  });

  it('returns the SAME object when nothing changed', () => {
    // Identity matters: this runs on every tree refresh, and a fresh object each
    // time would re-render every row that reads the selection.
    const before = sel(['a.ts'], 'a.ts');
    expect(pruneSelection(before, VISIBLE)).toBe(before);
  });

  it('clears a selection inside a folder that collapsed', () => {
    // Those rows are not on screen and cannot be acted on as a group the user
    // can see — which is the honest behaviour, not a limitation.
    const collapsed = ['a.ts', 'src', 'z.ts'];
    expect(pruneSelection(sel(['src/one.ts', 'a.ts'], 'src/one.ts'), collapsed)).toEqual({
      selected: ['a.ts'],
      anchor: null,
    });
  });
});

describe('what a right-click acts on', () => {
  it('acts on the whole selection when invoked from inside it', () => {
    expect(targetsFor(sel(['a.ts', 'z.ts'], 'a.ts'), 'z.ts')).toEqual(['a.ts', 'z.ts']);
  });

  it('acts on ONE row when invoked from outside it', () => {
    // The rule that stops right-clicking a file while five others are selected
    // deleting six things. That is data loss, not a UI wart.
    expect(targetsFor(sel(['a.ts', 'z.ts'], 'a.ts'), 'src/one.ts')).toEqual(['src/one.ts']);
  });

  it('acts on the row when nothing is selected at all', () => {
    expect(targetsFor(EMPTY_SELECTION, 'a.ts')).toEqual(['a.ts']);
  });
});

describe('drawing a row', () => {
  it('knows which rows are selected', () => {
    const s = sel(['a.ts', 'z.ts'], 'a.ts');
    expect(isSelected(s, 'a.ts')).toBe(true);
    expect(isSelected(s, 'src')).toBe(false);
    expect(isSelected(EMPTY_SELECTION, 'a.ts')).toBe(false);
  });
});
