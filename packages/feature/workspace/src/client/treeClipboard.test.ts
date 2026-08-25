import { describe, it, expect } from 'vitest';
import {
  afterPaste,
  isCutPending,
  parentOf,
  pasteOps,
  pasteTargetOf,
  putOnClipboard,
  type TreeClipboard,
} from './treeClipboard';

/**
 * COPY, CUT AND PASTE — the rules, not the requests.
 *
 * The one that matters most is that a CUT MOVES NOTHING until it is pasted. That
 * is what lets it be abandoned, and it is also why a paste is allowed to fail
 * per item: between the cut and the paste, the file can be renamed or deleted by
 * something else entirely.
 */

const clip = (mode: 'copy' | 'cut', items: string[]): TreeClipboard => ({ mode, items });

describe('putting something on the clipboard', () => {
  it('takes the selection, in order', () => {
    expect(putOnClipboard(null, 'copy', ['b.ts', 'a.ts'])).toEqual({
      mode: 'copy',
      items: ['b.ts', 'a.ts'],
    });
  });

  it('does not clear what is there when nothing is selected', () => {
    // ⌘C with an empty selection is a no-op, not a way to silently lose the
    // thing you copied a moment ago.
    const existing = clip('copy', ['a.ts']);
    expect(putOnClipboard(existing, 'copy', [])).toBe(existing);
    expect(putOnClipboard(existing, 'cut', [])).toBe(existing);
  });

  it('replaces a previous clipboard, including its mode', () => {
    // Cutting after copying must not leave a copy pending — the last gesture is
    // the one the user meant.
    expect(putOnClipboard(clip('copy', ['a.ts']), 'cut', ['b.ts'])).toEqual({
      mode: 'cut',
      items: ['b.ts'],
    });
  });

  it('snapshots the selection rather than aliasing it', () => {
    // The selection keeps changing after a copy; the clipboard must not.
    const selection = ['a.ts'];
    const board = putOnClipboard(null, 'copy', selection)!;
    selection.push('b.ts');
    expect(board.items).toEqual(['a.ts']);
  });
});

describe('what a paste asks for', () => {
  it('turns a copy into a copy and a cut into a MOVE', () => {
    // Resolved once, here. A `mode` in scope at the call site is one `if` away
    // from pasting a cut as a copy and leaving the original behind.
    expect(pasteOps(clip('copy', ['a.ts']), 'src')).toEqual([
      { action: 'copy', rel: 'a.ts', destRel: 'src' },
    ]);
    expect(pasteOps(clip('cut', ['a.ts']), 'src')).toEqual([
      { action: 'move', rel: 'a.ts', destRel: 'src' },
    ]);
  });

  it('produces one operation per item', () => {
    // One request each, so each comes back with its OWN reason — "three moved,
    // this one collided" — instead of one verdict over a batch.
    expect(pasteOps(clip('cut', ['a.ts', 'b.ts', 'c.ts']), 'src')).toHaveLength(3);
  });

  it('pastes into the project root', () => {
    expect(pasteOps(clip('copy', ['src/a.ts']), '')).toEqual([
      { action: 'copy', rel: 'src/a.ts', destRel: '' },
    ]);
  });

  it('asks for nothing when the clipboard is empty', () => {
    expect(pasteOps(null, 'src')).toEqual([]);
    expect(pasteOps(clip('copy', []), 'src')).toEqual([]);
  });
});

describe('what a paste refuses to even ask', () => {
  it('drops a folder pasted into itself or below itself', () => {
    // The server refuses this too — it must, being the last line before the
    // syscall — but not sending it means one refusal instead of a failed
    // request.
    expect(pasteOps(clip('cut', ['src']), 'src')).toEqual([]);
    expect(pasteOps(clip('cut', ['src']), 'src/nested')).toEqual([]);
    expect(pasteOps(clip('copy', ['src']), 'src/deep/deeper')).toEqual([]);
  });

  it('does not mistake a sibling whose name starts the same', () => {
    // `src-old` is not inside `src`, and dropping this would refuse a legal
    // paste — the same `+ '/'` trap the server's own guard documents.
    expect(pasteOps(clip('cut', ['src']), 'src-old')).toEqual([
      { action: 'move', rel: 'src', destRel: 'src-old' },
    ]);
  });

  it('drops a CUT into the folder it already lives in', () => {
    // "Move this to where it is" is nothing, not an error, and reporting it as a
    // failure would make a harmless paste look broken.
    expect(pasteOps(clip('cut', ['src/a.ts']), 'src')).toEqual([]);
    expect(pasteOps(clip('cut', ['a.ts']), '')).toEqual([]);
  });

  it('KEEPS a copy into the same folder, so the server can answer it', () => {
    // Unlike a cut, this is a real request — for a duplicate. The server says
    // `exists`, and the tree has a Duplicate action that knows how to name one.
    expect(pasteOps(clip('copy', ['src/a.ts']), 'src')).toEqual([
      { action: 'copy', rel: 'src/a.ts', destRel: 'src' },
    ]);
  });

  it('drops only the offending item, not the whole paste', () => {
    expect(pasteOps(clip('cut', ['src', 'other.ts']), 'src/nested')).toEqual([
      { action: 'move', rel: 'other.ts', destRel: 'src/nested' },
    ]);
  });
});

describe('what survives a paste', () => {
  it('spends a cut once it has actually moved something', () => {
    // Pasting a cut twice would ask to move a file that is no longer where the
    // clipboard says — `not-found` is a confusing way to say "already done".
    expect(afterPaste(clip('cut', ['a.ts']), 1)).toBeNull();
  });

  it('keeps a cut that moved nothing', () => {
    // Every item dropped or failed: the paths are still where they were, and the
    // user has not used their cut up.
    const board = clip('cut', ['a.ts']);
    expect(afterPaste(board, 0)).toBe(board);
  });

  it('keeps a copy, which is repeatable by nature', () => {
    const board = clip('copy', ['a.ts']);
    expect(afterPaste(board, 3)).toBe(board);
    expect(afterPaste(board, 0)).toBe(board);
  });

  it('survives having no clipboard at all', () => {
    expect(afterPaste(null, 0)).toBeNull();
  });
});

describe('marking a row', () => {
  it('dims a row waiting to be moved', () => {
    expect(isCutPending(clip('cut', ['a.ts']), 'a.ts')).toBe(true);
    expect(isCutPending(clip('cut', ['a.ts']), 'b.ts')).toBe(false);
  });

  it('does NOT mark a copied row', () => {
    // Nothing is going to happen to the original, so marking it would promise a
    // change that is not coming.
    expect(isCutPending(clip('copy', ['a.ts']), 'a.ts')).toBe(false);
  });

  it('marks nothing with an empty clipboard', () => {
    expect(isCutPending(null, 'a.ts')).toBe(false);
  });
});

describe('where a paste lands', () => {
  it('lands in a folder that was clicked', () => {
    expect(pasteTargetOf('src', true)).toBe('src');
  });

  it('lands in a FILE’s folder', () => {
    // A file is not a container, and refusing the paste would be pedantry about
    // a gesture whose intent is obvious. Same rule "New File" already follows.
    expect(pasteTargetOf('src/a.ts', false)).toBe('src');
    expect(pasteTargetOf('a.ts', false)).toBe('');
  });

  it('reads a parent the way the rest of the tree spells the root', () => {
    expect(parentOf('a.ts')).toBe('');
    expect(parentOf('src/a.ts')).toBe('src');
    expect(parentOf('src/deep/a.ts')).toBe('src/deep');
  });
});
