/**
 * treeDrag.ts — dragging rows within the tree.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE DRAGGED ROWS ARE KEPT IN MEMORY RATHER THAN READ OFF THE EVENT
 *
 * A drop target has to decide, on every `dragover`, whether it can accept what
 * is coming — that is the whole of the feedback the user gets. But `dragover`
 * cannot READ the payload: every browser blocks `dataTransfer.getData` outside
 * `drop`, deliberately, so a page cannot snoop on a drag passing over it. Only
 * the MIME `types` are visible.
 *
 * So the types say "this is a tree drag" and the payload is kept here, in a
 * module-level slot, for the lifetime of the gesture. That is sound because the
 * drag never leaves this window: a drag that DID come from outside carries OS
 * files, which is a different path entirely (`/api/copy-into`) and is detected
 * from `types` alone.
 *
 * It is the same singleton idiom `fileRefBus.ts` uses next door, for the same
 * reason: a same-window channel that React state would only make slower and
 * noisier.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MOVE OR COPY
 *
 * Dragging within one tree MOVES, which is what every file manager does inside a
 * single volume, and holding Alt/Option COPIES — also theirs. The modifier is
 * read at DROP time rather than at drag start, because that is when the user has
 * decided; picking it up at `dragstart` would mean a copy could not be turned
 * into a move halfway across the panel.
 */

import { pasteOps, type PasteOp } from './treeClipboard';

/** The MIME that marks a drag as coming from this tree. Distinct from
 *  `FILE_REF_MIME` (which the chat composer reads to insert a path) so the two
 *  gestures cannot be mistaken for each other: dropping a row on the composer
 *  must still insert text, and dropping one on a folder must not. */
export const TREE_DRAG_MIME = 'application/x-naby-treedrag';

let draggedRows: readonly string[] = [];

/** Remember what this gesture is carrying. Called from `dragstart`. */
export function beginTreeDrag(rels: readonly string[]): void {
  draggedRows = [...rels];
}

/** Forget it. Called from `dragend`, which fires whether the drop happened or
 *  not — including when the user pressed Escape, which is the case a `drop`-only
 *  cleanup would leave stale. */
export function endTreeDrag(): void {
  draggedRows = [];
}

/** What this gesture is carrying, for the target to reason about. */
export function draggedRels(): readonly string[] {
  return draggedRows;
}

/**
 * Should `destDir` light up as a drop target?
 *
 * False for a drop that would do NOTHING — dropping rows back into the folder
 * they already live in — and for one that cannot be done at all: a folder onto
 * itself or into its own descendant. Both are refusals the user is better off
 * seeing as "no" while the pointer is still moving than as an error after they
 * let go.
 *
 * `pasteOps` decides, so the drag and the clipboard can never disagree about
 * what is legal: they are the same operation reached by two gestures, and two
 * copies of that rule is how a drag ends up allowing something a paste refuses.
 */
export function canDropInto(rels: readonly string[], destDir: string): boolean {
  if (rels.length === 0) return false;
  return pasteOps({ mode: 'cut', items: rels }, destDir).length > 0;
}

/**
 * What a drop should do.
 *
 * `copy` is the Alt/Option-held case. Everything else — self-nesting, a no-op
 * move, the ordering — is `pasteOps`', because a drop IS a paste with an
 * ephemeral clipboard, and saying so is cheaper than restating its rules.
 */
export function dropOps(
  rels: readonly string[],
  destDir: string,
  copy: boolean,
): readonly PasteOp[] {
  return pasteOps({ mode: copy ? 'copy' : 'cut', items: rels }, destDir);
}
