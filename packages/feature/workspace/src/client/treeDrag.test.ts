import { describe, it, expect, beforeEach } from 'vitest';
import {
  TREE_DRAG_MIME,
  beginTreeDrag,
  canDropInto,
  draggedRels,
  dropOps,
  endTreeDrag,
} from './treeDrag';

/**
 * DRAGGING ROWS WITHIN THE TREE.
 *
 * The part that has to be right is the FEEDBACK: a target decides whether to
 * light up on every `dragover`, and it cannot read the payload there — browsers
 * block `getData` outside `drop` so a page cannot snoop on a passing drag. Hence
 * the in-memory slot, and hence these tests, which are the only place the slot's
 * lifecycle is stated.
 */

beforeEach(() => endTreeDrag());

describe('the payload the target cannot read off the event', () => {
  it('remembers what the gesture is carrying', () => {
    beginTreeDrag(['a.ts', 'src/b.ts']);
    expect(draggedRels()).toEqual(['a.ts', 'src/b.ts']);
  });

  it('snapshots rather than aliasing the selection', () => {
    // The selection can change under a drag; what is being dragged cannot.
    const rows = ['a.ts'];
    beginTreeDrag(rows);
    rows.push('b.ts');
    expect(draggedRels()).toEqual(['a.ts']);
  });

  it('is cleared when the gesture ends', () => {
    // `dragend` fires whether the drop happened or not — Escape included, which
    // is exactly the case a drop-only cleanup would leave stale.
    beginTreeDrag(['a.ts']);
    endTreeDrag();
    expect(draggedRels()).toEqual([]);
  });

  it('is a MIME of its own, distinct from the chat file reference', () => {
    // Dropping a row on the composer must still insert text, and dropping one on
    // a folder must not. Two gestures, two types.
    expect(TREE_DRAG_MIME).toBe('application/x-naby-treedrag');
    expect(TREE_DRAG_MIME).not.toBe('application/x-naby-fileref');
  });
});

describe('whether a folder lights up', () => {
  it('accepts a move into another folder', () => {
    expect(canDropInto(['a.ts'], 'src')).toBe(true);
  });

  it('accepts a move into the project root', () => {
    expect(canDropInto(['src/a.ts'], '')).toBe(true);
  });

  it('refuses rows dropped back where they already are', () => {
    // Better seen as "no" while the pointer is still moving than as an error
    // after the user lets go.
    expect(canDropInto(['src/a.ts'], 'src')).toBe(false);
    expect(canDropInto(['a.ts'], '')).toBe(false);
  });

  it('refuses a folder onto itself or into its own descendant', () => {
    expect(canDropInto(['src'], 'src')).toBe(false);
    expect(canDropInto(['src'], 'src/nested')).toBe(false);
  });

  it('accepts a mixed drag where at least one row can move', () => {
    // Dropping five rows where four are already home should still move the
    // fifth, so the target has to light up.
    expect(canDropInto(['src/a.ts', 'other.ts'], 'src')).toBe(true);
  });

  it('refuses an empty drag', () => {
    expect(canDropInto([], 'src')).toBe(false);
  });
});

describe('what a drop does', () => {
  it('moves by default', () => {
    // What every file manager does inside a single volume.
    expect(dropOps(['a.ts'], 'src', false)).toEqual([
      { action: 'move', rel: 'a.ts', destRel: 'src' },
    ]);
  });

  it('copies when Alt is held', () => {
    expect(dropOps(['a.ts'], 'src', true)).toEqual([
      { action: 'copy', rel: 'a.ts', destRel: 'src' },
    ]);
  });

  it('drops the rows that would do nothing, keeping the rest', () => {
    expect(dropOps(['src/a.ts', 'other.ts'], 'src', false)).toEqual([
      { action: 'move', rel: 'other.ts', destRel: 'src' },
    ]);
  });

  it('cannot do what a paste refuses', () => {
    // The drag and the clipboard are the same operation reached two ways; two
    // copies of the rule is how a drag ends up allowing what a paste will not.
    expect(dropOps(['src'], 'src/nested', false)).toEqual([]);
    expect(dropOps(['src'], 'src/nested', true)).toEqual([]);
  });
});
