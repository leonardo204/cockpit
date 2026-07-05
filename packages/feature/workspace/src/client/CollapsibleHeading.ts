import Heading from '@tiptap/extension-heading';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

// ============================================================================
// CollapsibleHeading
//
// Extends the StarterKit Heading with an outline-fold capability:
//  - Each heading carries an independent `collapsed` boolean attribute.
//  - Collapsing a level-N heading visually hides every following block until
//    the next heading of level <= N (so folding an H1 also hides the H2/H3
//    under it). Hiding is derived on the fly from the attributes — folding a
//    parent never mutates a child's own `collapsed` flag, so expanding the
//    parent restores each child to its own state.
//  - The `collapsed` flag round-trips through Markdown as a trailing
//    `<!-- fold -->` comment on the heading line, so the state is persisted in
//    note.md and shows up identically on reopen / in another tab. External
//    Markdown editors render the comment as nothing, keeping the file clean.
// ============================================================================

/** Minimal surface of tiptap-markdown's serializer state that we call. */
interface MarkdownSerializeState {
  write(content: string): void;
  repeat(str: string, n: number): string;
  renderInline(node: PMNode, fromBlockStart?: boolean): void;
  closeBlock(node: PMNode): void;
}

const foldPluginKey = new PluginKey('headingFold');

/** Build the toggle arrow shown in the left gutter of a heading. */
function createToggle(view: EditorView, getPos: () => number | undefined, collapsed: boolean): HTMLElement {
  const btn = document.createElement('span');
  btn.className = 'note-fold-toggle';
  btn.contentEditable = 'false';
  btn.setAttribute('data-collapsed', collapsed ? 'true' : 'false');
  // mousedown (not click) so we can preventDefault before the editor moves the
  // selection / steals focus.
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const widgetPos = getPos();
    if (widgetPos == null) return;
    const headingPos = widgetPos - 1; // widget sits at the heading's content start
    const node = view.state.doc.nodeAt(headingPos);
    if (!node || node.type.name !== 'heading') return;
    view.dispatch(
      view.state.tr.setNodeMarkup(headingPos, undefined, {
        ...node.attrs,
        collapsed: !node.attrs.collapsed,
      })
    );
  });
  return btn;
}

/** Recompute fold decorations (toggle widgets + hidden ranges) for the doc. */
function buildDecorations(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  // Levels of collapsed headings whose fold region is still open.
  const openLevels: number[] = [];

  doc.forEach((node, offset) => {
    const from = offset;
    const to = offset + node.nodeSize;

    if (node.type.name === 'heading') {
      const level = node.attrs.level as number;
      // A heading closes the fold region of any heading with level >= its own.
      while (openLevels.length && openLevels[openLevels.length - 1] >= level) {
        openLevels.pop();
      }
      const hiddenByAncestor = openLevels.length > 0;

      const classes = ['note-heading'];
      if (node.attrs.collapsed) classes.push('is-collapsed');
      if (hiddenByAncestor) classes.push('note-folded-hidden');
      decos.push(Decoration.node(from, to, { class: classes.join(' ') }));

      // Toggle arrow, placed at the heading's content start.
      decos.push(
        Decoration.widget(from + 1, (view, getPos) => createToggle(view, getPos, node.attrs.collapsed), {
          side: -1,
          key: `fold-${from}-${node.attrs.collapsed ? 1 : 0}`,
        })
      );

      if (node.attrs.collapsed) openLevels.push(level);
    } else if (openLevels.length > 0) {
      decos.push(Decoration.node(from, to, { class: 'note-folded-hidden' }));
    }
  });

  return DecorationSet.create(doc, decos);
}

export const CollapsibleHeading = Heading.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      collapsed: {
        default: false,
        keepOnSplit: false,
        parseHTML: (element) => element.getAttribute('data-collapsed') === 'true',
        renderHTML: (attributes) =>
          attributes.collapsed ? { 'data-collapsed': 'true' } : {},
      },
    };
  },

  addStorage() {
    return {
      markdown: {
        // Serialize: append the fold marker on collapsed headings.
        serialize(state: MarkdownSerializeState, node: PMNode) {
          state.write(state.repeat('#', node.attrs.level) + ' ');
          state.renderInline(node, false);
          if (node.attrs.collapsed) {
            state.write(' <!-- fold -->');
          }
          state.closeBlock(node);
        },
        parse: {
          // Parse: markdown-it has rendered `## Title <!-- fold -->` into an
          // <h*> whose trailing child is an HTML comment. Lift it into the
          // data-collapsed attribute (read back by parseHTML above) and drop
          // the comment + any trailing whitespace so the heading text is clean.
          updateDOM(element: HTMLElement) {
            element.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => {
              let node: ChildNode | null = h.lastChild;
              while (node && node.nodeType === 3 && !(node.textContent || '').trim()) {
                const prev = node.previousSibling;
                h.removeChild(node);
                node = prev;
              }
              if (node && node.nodeType === 8 && /^\s*fold\s*$/.test(node.textContent || '')) {
                const prev = node.previousSibling;
                h.removeChild(node);
                if (prev && prev.nodeType === 3) {
                  prev.textContent = (prev.textContent || '').replace(/\s+$/, '');
                }
                h.setAttribute('data-collapsed', 'true');
              }
            });
          },
        },
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: foldPluginKey,
        state: {
          init: (_config, { doc }) => buildDecorations(doc),
          apply: (tr, old) => (tr.docChanged ? buildDecorations(tr.doc) : old),
        },
        props: {
          decorations(state) {
            return foldPluginKey.getState(state);
          },
        },
      }),
    ];
  },
});
