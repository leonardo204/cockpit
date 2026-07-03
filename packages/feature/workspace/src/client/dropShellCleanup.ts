import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';
import { ReplaceStep } from '@tiptap/pm/transform';
import type { Node as PMNode } from '@tiptap/pm/model';

// ============================================
// Drag-drop empty list-item shell cleanup
// ============================================
//
// Bug this fixes:
//   Dragging a selected todo (or bullet/ordered list item) moves the text but
//   leaves an empty item shell behind at the source. Root cause chain:
//
//   1. TaskItem/ListItem have no `draggable` node spec and the note editor has
//      no drag handle, so "select a line and drag it" is a native *text
//      selection* drag: prosemirror-view stores a TextSelection slice in
//      `view.dragging` with `dragging.node === undefined`.
//   2. On a move-drop, prosemirror-view's handleDrop runs
//      `tr.deleteSelection()` (the `dragging.node` branch is not taken), which
//      deletes only the *text* inside the item's paragraph — Transform's
//      deleteRange cover logic cannot expand to the item because taskItem /
//      listItem require at least one paragraph child.
//   3. The insertion side, however, rebuilds a full item at the drop point
//      from the slice's open depth. Net effect: complete item at the target,
//      empty `item > paragraph` shell left at the source.
//
//   The two existing defenses don't reach this: noteMarkdown.ts only strips
//   artifacts from the *persisted* markdown (the shell stays visible in the
//   live doc), and markdownTaskListFix.ts only runs in the markdown *parse*
//   pipeline (a drop is a pure in-editor transaction).
//
// Fix (source-anchored, NOT a whole-doc sweep):
//   In appendTransaction, react only to transactions tagged by prosemirror-view
//   with `uiEvent: 'drop'`. From that transaction's steps, take the *deletion*
//   steps (ReplaceStep with an empty slice), map their source positions to the
//   final doc, and remove the item shell at those positions — only if it is
//   verifiably empty. Anchoring to the drop's own deletion site is what makes
//   this safe: an empty todo the user just created elsewhere (and hasn't typed
//   into yet) is never touched, because it is not at a drop-deletion position.

/** Node type names that can be left behind as empty shells by a text-drag. */
const SHELL_ITEM_TYPES = new Set(['taskItem', 'listItem']);

/**
 * An "empty shell" is exactly the wreckage a move-drop deletion leaves:
 * a list item whose only child is an empty textblock. Items with any text,
 * extra blocks, or a nested sublist are NOT shells and are never removed.
 */
export function isEmptyShellItem(node: PMNode): boolean {
  return (
    SHELL_ITEM_TYPES.has(node.type.name) &&
    node.childCount === 1 &&
    node.firstChild !== null &&
    node.firstChild.isTextblock &&
    node.firstChild.content.size === 0
  );
}

/**
 * Given a position in `doc` (a mapped drop-deletion site), find the deletion
 * range that removes the empty shell item containing it, or null if the
 * position is not inside an empty shell.
 *
 * The range is widened while the shell is an only child, so removing the last
 * item of a list also removes the now-empty list (and any single-child chain
 * above it) instead of leaving invalid/empty wrappers behind.
 */
export function findShellDeletionRange(
  doc: PMNode,
  pos: number
): { from: number; to: number } | null {
  if (pos < 0 || pos > doc.content.size) return null;
  const $pos = doc.resolve(pos);

  for (let depth = $pos.depth; depth > 0; depth--) {
    if (!isEmptyShellItem($pos.node(depth))) continue;

    // Widen through ancestors for which the shell is the only child.
    let top = depth;
    while (top > 1 && $pos.node(top - 1).childCount === 1) top--;
    return { from: $pos.before(top), to: $pos.after(top) };
  }
  return null;
}

/**
 * Extract the source positions of a drop transaction's deletions, mapped to
 * the transaction's final doc. Deletion steps are ReplaceSteps with an empty
 * slice (that is what `tr.deleteSelection()` produces for a move-drop); the
 * insertion step has `from === to` and is skipped.
 */
export function collectDropDeletionPositions(tr: Transaction): number[] {
  const positions: number[] = [];
  tr.steps.forEach((step, i) => {
    if (!(step instanceof ReplaceStep)) return;
    if (step.slice.size !== 0 || step.from >= step.to) return;
    // step.from is where the deleted range collapsed to, in the doc *after*
    // this step; map it through the remaining steps to the final doc.
    positions.push(tr.mapping.slice(i + 1).map(step.from));
  });
  return positions;
}

export function createDropShellCleanupPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey('dropShellCleanup'),
    appendTransaction(transactions, _oldState, newState) {
      const positions: number[] = [];
      transactions.forEach((tr, i) => {
        if (tr.getMeta('uiEvent') !== 'drop' || !tr.docChanged) return;
        let ps = collectDropDeletionPositions(tr);
        // Map through any later transactions in this dispatch group.
        for (let j = i + 1; j < transactions.length; j++) {
          ps = ps.map((p) => transactions[j].mapping.map(p));
        }
        positions.push(...ps);
      });
      if (positions.length === 0) return null;

      const tr = newState.tr;
      let changed = false;
      for (const pos of positions) {
        // Re-map through deletions this cleanup already made.
        const range = findShellDeletionRange(tr.doc, tr.mapping.map(pos));
        if (!range) continue;
        try {
          tr.delete(range.from, range.to);
          changed = true;
        } catch {
          // A delete the schema cannot fit (e.g. sole child of a block+ doc)
          // is skipped; leaving the shell beats corrupting the dispatch.
        }
      }
      return changed ? tr : null;
    },
  });
}

/**
 * Tiptap extension registering the cleanup plugin. Carries no schema; pair it
 * with TaskList/TaskItem (and StarterKit's lists) in the note editor.
 */
export const DropShellCleanup = Extension.create({
  name: 'dropShellCleanup',
  addProseMirrorPlugins() {
    return [createDropShellCleanupPlugin()];
  },
});
