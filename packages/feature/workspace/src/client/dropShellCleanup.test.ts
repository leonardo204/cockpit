import { describe, it, expect } from 'vitest';
import { Schema, type Node as PMNode } from '@tiptap/pm/model';
import { EditorState, type Transaction } from '@tiptap/pm/state';
import {
  isEmptyShellItem,
  findShellDeletionRange,
  collectDropDeletionPositions,
  createDropShellCleanupPlugin,
} from './dropShellCleanup';

// Minimal schema mirroring the note editor's relevant nodes
// (tiptap StarterKit lists + TaskList/TaskItem content expressions).
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
    bulletList: { group: 'block', content: 'listItem+' },
    listItem: { content: 'paragraph block*' },
    taskList: { group: 'block', content: 'taskItem+' },
    taskItem: {
      content: 'paragraph block*',
      attrs: { checked: { default: false } },
    },
  },
});

const p = (text?: string) =>
  schema.nodes.paragraph.create(null, text ? schema.text(text) : null);
const task = (text?: string, checked = false) =>
  schema.nodes.taskItem.create({ checked }, p(text));
const taskWith = (text: string, ...blocks: PMNode[]) =>
  schema.nodes.taskItem.create(null, [p(text), ...blocks]);
const taskList = (...items: PMNode[]) => schema.nodes.taskList.create(null, items);
const li = (text?: string) => schema.nodes.listItem.create(null, p(text));
const ul = (...items: PMNode[]) => schema.nodes.bulletList.create(null, items);
const doc = (...blocks: PMNode[]) => schema.nodes.doc.create(null, blocks);

/** Position range of `text`'s characters inside the doc. */
function textRange(d: PMNode, text: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null;
  d.descendants((node, pos) => {
    if (node.isText && node.text === text) found = { from: pos, to: pos + text.length };
    return !found;
  });
  if (!found) throw new Error(`text not found: ${text}`);
  return found;
}

function countShells(d: PMNode): number {
  let n = 0;
  d.descendants((node) => {
    if (isEmptyShellItem(node)) n++;
    return true;
  });
  return n;
}

/** Apply a transaction against a state armed with the cleanup plugin. */
function applyWithPlugin(d: PMNode, build: (tr: Transaction) => Transaction): PMNode {
  const state = EditorState.create({ schema, doc: d, plugins: [createDropShellCleanupPlugin()] });
  return state.apply(build(state.tr)).doc;
}

// Simulate prosemirror-view's move-drop: delete the dragged text (what
// tr.deleteSelection() does for a TextSelection), optionally insert the
// dragged item at a target, and tag with uiEvent: 'drop'.
const asDrop = (tr: Transaction) => tr.setMeta('uiEvent', 'drop');

describe('isEmptyShellItem', () => {
  it('matches an empty taskItem and an empty listItem', () => {
    expect(isEmptyShellItem(task())).toBe(true);
    expect(isEmptyShellItem(li())).toBe(true);
  });

  it('rejects items with text, extra blocks, or a nested sublist', () => {
    expect(isEmptyShellItem(task('x'))).toBe(false);
    expect(isEmptyShellItem(taskWith('', taskList(task('child'))))).toBe(false);
    expect(isEmptyShellItem(p())).toBe(false);
  });
});

describe('findShellDeletionRange', () => {
  it('finds the shell containing an inner position', () => {
    const d = doc(taskList(task('aaa'), task()), p('tail'));
    // position inside the empty item's paragraph
    const shellPos = d.content.size - p('tail').nodeSize - 2;
    const range = findShellDeletionRange(d, shellPos);
    expect(range).not.toBeNull();
    const after = d.replace(range!.from, range!.to, schema.nodes.doc.create().slice(0));
    expect(countShells(after)).toBe(0);
    expect(after.textContent).toContain('aaa');
  });

  it('widens to the whole list when the shell is its only item', () => {
    const d = doc(p('head'), taskList(task()));
    const range = findShellDeletionRange(d, d.content.size - 3);
    expect(range).toEqual({ from: p('head').nodeSize, to: d.content.size });
  });

  it('returns null on a non-empty item and on out-of-range positions', () => {
    const d = doc(taskList(task('aaa')));
    expect(findShellDeletionRange(d, 3)).toBeNull();
    expect(findShellDeletionRange(d, 9999)).toBeNull();
  });
});

describe('drop cleanup plugin', () => {
  it('removes the shell left by dragging a single todo line away', () => {
    const d = doc(taskList(task('aaa'), task('bbb'), task('ccc')));
    const { from, to } = textRange(d, 'bbb');
    const result = applyWithPlugin(d, (tr) => {
      tr.delete(from, to); // move-drop source deletion
      tr.insert(tr.mapping.map(d.content.size), taskList(task('bbb'))); // drop target insertion
      return asDrop(tr);
    });
    expect(countShells(result)).toBe(0);
    expect(result.textContent).toContain('aaa');
    expect(result.textContent).toContain('bbb');
    expect(result.textContent).toContain('ccc');
  });

  it('works for plain bullet list items too', () => {
    const d = doc(ul(li('one'), li('two')), p('tail'));
    const { from, to } = textRange(d, 'two');
    const result = applyWithPlugin(d, (tr) => asDrop(tr.delete(from, to)));
    expect(countShells(result)).toBe(0);
    expect(result.textContent).toContain('one');
  });

  it('removes the merged shell of a multi-item full-line drag', () => {
    const d = doc(taskList(task('aaa'), task('bbb'), task('ccc')), p('tail'));
    const a = textRange(d, 'aaa');
    const b = textRange(d, 'bbb');
    // Full-text selection across items aaa..bbb collapses them into one shell.
    const result = applyWithPlugin(d, (tr) => asDrop(tr.delete(a.from, b.to)));
    expect(countShells(result)).toBe(0);
    expect(result.textContent).toContain('ccc');
  });

  it('removes the whole list when its last item is dragged out', () => {
    const d = doc(taskList(task('solo')), p('tail'));
    const { from, to } = textRange(d, 'solo');
    const result = applyWithPlugin(d, (tr) => asDrop(tr.delete(from, to)));
    expect(countShells(result)).toBe(0);
    expect(result.firstChild!.type.name).toBe('paragraph'); // list is gone entirely
  });

  it('never touches a pre-existing empty todo elsewhere in the doc', () => {
    // User just created an empty todo (first item), then drags 'yyy' away.
    const d = doc(taskList(task(), task('xxx'), task('yyy')));
    const { from, to } = textRange(d, 'yyy');
    const result = applyWithPlugin(d, (tr) => asDrop(tr.delete(from, to)));
    // The drag shell is cleaned, the user's own empty todo survives.
    expect(countShells(result)).toBe(1);
    expect(result.firstChild!.firstChild!.textContent).toBe('');
    expect(result.textContent).toContain('xxx');
  });

  it('ignores copy-drops (no deletion step) and non-drop transactions', () => {
    const d = doc(taskList(task(), task('xxx')));
    // copy-drop: insertion only, uiEvent drop
    const copied = applyWithPlugin(d, (tr) =>
      asDrop(tr.insert(tr.doc.content.size, taskList(task('xxx'))))
    );
    expect(countShells(copied)).toBe(1);
    // ordinary edit that empties an item (e.g. select line + type over is NOT
    // a drop) — plugin must not interfere with normal editing
    const { from, to } = textRange(d, 'xxx');
    const edited = applyWithPlugin(d, (tr) => tr.delete(from, to));
    expect(countShells(edited)).toBe(2);
  });
});

describe('collectDropDeletionPositions', () => {
  it('maps the deletion site through later insertion steps', () => {
    const d = doc(taskList(task('aaa'), task('bbb')));
    const state = EditorState.create({ schema, doc: d });
    const { from, to } = textRange(d, 'aaa');
    const tr = state.tr.delete(from, to);
    tr.insert(0, p('inserted-before')); // shifts everything right
    const [pos] = collectDropDeletionPositions(tr);
    const range = findShellDeletionRange(tr.doc, pos);
    expect(range).not.toBeNull();
    const node = tr.doc.resolve(pos).node(2);
    expect(isEmptyShellItem(node)).toBe(true);
  });

  it('returns nothing for insert-only transactions', () => {
    const d = doc(p('x'));
    const state = EditorState.create({ schema, doc: d });
    const tr = state.tr.insert(0, p('y'));
    expect(collectDropDeletionPositions(tr)).toEqual([]);
  });
});
