/**
 * treeClipboard.ts — copy, cut and paste in the file tree.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE CLIPBOARD IS NOT THE SYSTEM CLIPBOARD
 *
 * The obvious implementation is `navigator.clipboard`, and it is the wrong one.
 * The web clipboard carries text; a file manager's clipboard carries a set of
 * paths AND an intent — the same three files mean "leave them there" after a
 * copy and "remove them from here" after a cut, and nothing in a text payload
 * says which. Writing paths as text would also silently clobber whatever the
 * user had copied from their editor, on a keystroke they pressed inside a file
 * tree.
 *
 * So the tree keeps its own, in memory, for the lifetime of the panel. That also
 * makes the boundary honest: this pastes within a project, and does not pretend
 * to interoperate with Finder. (Dragging still does that.)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT A CUT IS BEFORE IT IS PASTED
 *
 * Nothing. It marks paths and moves no file — which is the behaviour every file
 * manager has and the reason a cut can be abandoned by pressing Escape or by
 * cutting something else. It is also why the marked rows must keep working
 * normally: a cut file is still readable, still openable, still there.
 *
 * The consequence worth stating: between the cut and the paste the file can be
 * deleted, renamed or moved by something else. The paste is therefore allowed to
 * fail per item, and the caller reports which — see `PasteOutcome`.
 */

export type ClipboardMode = 'copy' | 'cut';

export interface TreeClipboard {
  mode: ClipboardMode;
  /** Project-relative paths, in the order they were selected. */
  items: readonly string[];
}

export const EMPTY_CLIPBOARD: TreeClipboard | null = null;

/** Put a selection on the clipboard. An empty selection does NOT clear what is
 *  already there: pressing ⌘C with nothing selected is a no-op, not a way to
 *  silently lose the thing you copied a moment ago. */
export function putOnClipboard(
  current: TreeClipboard | null,
  mode: ClipboardMode,
  items: readonly string[],
): TreeClipboard | null {
  if (items.length === 0) return current;
  return { mode, items: [...items] };
}

/**
 * One item of a paste, as a request the fs-op route understands.
 *
 * A CUT BECOMES A MOVE AND A COPY BECOMES A COPY — the intent is resolved here,
 * once, rather than at the call site where a `mode` in scope is one `if` away
 * from pasting a cut as a copy and leaving the original behind.
 */
export interface PasteOp {
  action: 'move' | 'copy';
  rel: string;
  destRel: string;
}

/**
 * What a paste into `destDir` should do.
 *
 * REFUSALS THAT BELONG HERE RATHER THAN AT THE SERVER. The route already
 * refuses a folder pasted into itself — it must, since it is the last line
 * before the syscall — but repeating the check here means the tree never SENDS
 * an operation it knows is nonsense, and the user gets one refusal instead of a
 * request that fails.
 *
 * A CUT INTO ITS OWN PARENT IS DROPPED, NOT REFUSED. "Move this file to where it
 * already is" is not an error, it is nothing, and reporting it as a failure
 * would make a harmless paste look broken. A COPY into the same folder is a
 * different matter: it is a real request for a duplicate, and the server answers
 * it with `exists` because this tree has a separate Duplicate action that knows
 * how to name one.
 */
export function pasteOps(
  clipboard: TreeClipboard | null,
  destDir: string,
): readonly PasteOp[] {
  if (!clipboard || clipboard.items.length === 0) return [];
  const action = clipboard.mode === 'cut' ? 'move' : 'copy';

  const ops: PasteOp[] = [];
  for (const rel of clipboard.items) {
    if (isNestedIn(rel, destDir)) continue;
    if (action === 'move' && parentOf(rel) === destDir) continue;
    ops.push({ action, rel, destRel: destDir });
  }
  return ops;
}

/** Is `destDir` the item itself, or somewhere inside it? The client-side twin of
 *  `wouldNestInSelf` — the same `+ '/'` trick, in the relative-path world the
 *  tree lives in, so `src-old` is not read as being inside `src`. */
function isNestedIn(rel: string, destDir: string): boolean {
  return destDir === rel || destDir.startsWith(rel + '/');
}

/** The folder an item sits in; the empty string for a top-level item, which is
 *  exactly how the project root is spelled everywhere else here. */
export function parentOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

/**
 * What the clipboard becomes after a paste.
 *
 * A CUT IS SPENT; A COPY IS NOT. Pasting a cut twice would ask to move a file
 * that is no longer where the clipboard says it is, and the second paste would
 * fail with `not-found` — a confusing way to say "you already did that". A copy
 * is repeatable by nature, so it stays.
 *
 * A cut that moved NOTHING is not spent, though: if every item was dropped or
 * failed, the paths are still where they were and the user has not used their
 * cut up.
 */
export function afterPaste(
  clipboard: TreeClipboard | null,
  movedCount: number,
): TreeClipboard | null {
  if (!clipboard) return null;
  if (clipboard.mode === 'cut' && movedCount > 0) return null;
  return clipboard;
}

/** Whether a row should be drawn as cut — dimmed, the way every file manager
 *  shows a pending move. Copies are not marked: nothing is going to happen to
 *  the original, so marking it would promise a change that is not coming. */
export function isCutPending(clipboard: TreeClipboard | null, rel: string): boolean {
  return clipboard?.mode === 'cut' && clipboard.items.includes(rel);
}

/**
 * Which folder a paste lands in, given the row it was invoked on.
 *
 * PASTING ONTO A FILE MEANS ITS FOLDER, which is what every file manager does
 * and the only reading that is not surprising: a file is not a container, and
 * refusing the paste would be pedantry about a gesture whose intent is obvious.
 * The same rule the tree's own "New File" already follows (`createParentOf`).
 */
export function pasteTargetOf(rel: string, isDir: boolean): string {
  return isDir ? rel : parentOf(rel);
}
