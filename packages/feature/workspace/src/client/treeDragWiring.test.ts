import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * DRAGGING ROWS WITHIN THE TREE IS WIRED, AND IT DID NOT BREAK THE DRAG THAT WAS
 * ALREADY THERE.
 *
 * One gesture now serves two drops: the chat composer still inserts a path, and
 * a folder in this tree moves files. Source assertions, since jsdom has no drag
 * and drop worth the name — the rules are pure and covered in `treeDrag.test.ts`.
 */

const PANEL = readFileSync(join(__dirname, 'FileBrowserPanel.tsx'), 'utf8');

describe('the drag that already existed still works', () => {
  it('still carries the chat’s file reference', () => {
    // A row dragged onto the composer must insert exactly what it always did —
    // this is also where ⌘-click's old job went when selection took the gesture.
    expect(PANEL).toContain('e.dataTransfer.setData(FILE_REF_MIME, ref)');
    expect(PANEL).toContain("e.dataTransfer.setData('text/plain', ref)");
  });

  it('adds a type of its own rather than overloading that one', () => {
    // Two gestures, two types: dropping a row on the composer must not move a
    // file, and dropping one on a folder must not insert text.
    expect(PANEL).toContain('e.dataTransfer.setData(TREE_DRAG_MIME, rel)');
  });
});

describe('a dragged row carries the selection it belongs to', () => {
  it('goes through targetsFor', () => {
    // Selecting five files and dragging one of them must move five. A row
    // outside the selection drags only itself — the same rule the menu follows.
    expect(PANEL).toContain('beginTreeDrag(targetsFor(selectionOf(), rel))');
  });

  it('clears the payload when the gesture ends, drop or no drop', () => {
    // `dragend` fires on Escape too, which a drop-only cleanup would leave stale.
    expect(PANEL).toContain('const onDragEnd = useCallback(() => endTreeDrag(), [])');
    expect(PANEL).toContain('onDragEnd={onDragEnd}');
  });
});

describe('a target decides from what it is allowed to read', () => {
  it('recognises a tree drag by TYPE, not by reading the payload', () => {
    // Browsers block `getData` outside `drop` so a page cannot snoop on a
    // passing drag; only the types are visible there.
    expect(PANEL).toContain('Array.from(e.dataTransfer?.types ?? []).includes(TREE_DRAG_MIME)');
  });

  it('stays dark for a drop that would do nothing or cannot be done', () => {
    // Better feedback than an error after the user lets go.
    expect(PANEL).toContain('if (!hasTreeDrag(e) || !canDropInto(draggedRels(), rel)) return;');
  });

  it('says move or copy in the cursor while the pointer is still moving', () => {
    expect(PANEL).toMatch(/dropEffect = e\.altKey \? 'copy' : 'move'/);
  });
});

describe('the two kinds of drop do not fall through to each other', () => {
  it('handles a tree drop and returns, rather than reaching the OS-copy path', () => {
    // A tree drag carries no `files`, so a fall-through would silently do
    // nothing at all.
    const rowDrop = /const onDrop = useCallback\([\s\S]*?\n  \);/.exec(PANEL)?.[0];
    expect(rowDrop, 'the row drop handler changed shape').toBeDefined();
    expect(rowDrop).toContain('if (!hasOsFiles(e) && hasTreeDrag(e)) {');
    expect(rowDrop).toMatch(/applyDrop\(draggedRels\(\), rel, e\.altKey\);\s*\n\s*return;/);
  });

  it('keeps the OS drop doing what it did', () => {
    expect(PANEL).toContain("copyInto(cwd, rel, files)");
    expect(PANEL).toContain("copyInto(cwd, '', files)");
  });

  it('takes a drop on the empty body into the project root', () => {
    // The only way to move something OUT of a folder without scrolling to find a
    // target row.
    expect(PANEL).toContain("applyDrop(draggedRels(), '', e.altKey)");
  });
});

describe('a drop runs the same code a paste runs', () => {
  it('shares one executor', () => {
    // A drop IS a paste with an ephemeral clipboard. Two executors is how the
    // two gestures start behaving differently.
    expect(PANEL).toContain('const ops = dropOps(rels, destDir, copy);');
    expect(PANEL).toContain('await runFileOps(ops);');
    expect(PANEL).toMatch(/const moved = await runFileOps\(ops\);/);
  });

  it('does not spend the clipboard on a drop', () => {
    // A drag has nothing to do with what the user copied earlier.
    const drop = /const applyDrop = useCallback\([\s\S]*?\n  \);/.exec(PANEL)?.[0];
    expect(drop).not.toContain('afterPaste');
    expect(drop).not.toContain('setClipboard');
  });
});

describe('dragging out to the OS', () => {
  it('decides at DRAG START, because startDrag replaces the HTML drag', () => {
    // `webContents.startDrag` does not accompany the page's drag, it takes it
    // over — once the OS owns the gesture no in-page target sees it. So one drag
    // cannot serve both, and the user says which at the moment they start.
    expect(PANEL).toContain('if (e.altKey && bridge?.startDrag) {');
    expect(PANEL).toMatch(/e\.preventDefault\(\);\s*\n\s*void bridge\.startDrag\(/);
  });

  it('carries the whole selection out, like every other row operation', () => {
    expect(PANEL).toContain('rels: [...targetsFor(selectionOf(), rel)]');
  });

  it('leaves the in-app drag alone where the bridge is dark', () => {
    // A plain browser tab cannot hand files to the OS. Without the guard, Alt
    // would turn a working drag into a gesture that silently does nothing.
    expect(PANEL).toContain('const bridge = fsBridge();');
    expect(PANEL).toContain('startDrag?(target: { cwd: string; rels: string[] })');
  });

  it('runs before the in-app payloads are set, and returns', () => {
    // Setting them first would be harmless but misleading; returning is what
    // guarantees the two paths never both run for one gesture.
    const start = /const onDragStart = useCallback\([\s\S]*?\n  \);/.exec(PANEL)?.[0];
    expect(start, 'the dragstart handler changed shape').toBeDefined();
    expect(start!.indexOf('bridge.startDrag')).toBeLessThan(
      start!.indexOf('setData(FILE_REF_MIME'),
    );
  });
});
