import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import en from '../../../../shared/i18n/locales/en.json';
import ko from '../../../../shared/i18n/locales/ko.json';

/**
 * THE TREE GOES THROUGH `treeSelection`, AND THE GESTURE IT TOOK IS ACCOUNTED FOR.
 *
 * Source assertions, like the rest of this panel's guards (`fileBrowserMenuClipping`,
 * `fileWatchWiring`): jsdom has no layout and no pointer, so a click on a row is
 * not something a test can perform here. The RULES are pure and covered in
 * `treeSelection.test.ts`; what is at risk is the wiring — a range with no
 * sequence to measure over, or the reference gesture disappearing without its
 * replacement being documented.
 */

const PANEL = readFileSync(join(__dirname, 'FileBrowserPanel.tsx'), 'utf8');
const files = (d: unknown) => (d as { fileBrowser: Record<string, string> }).fileBrowser;

describe('clicks go through the tested rules', () => {
  it('does not decide selection inside the event handler', () => {
    expect(PANEL).toContain("from './treeSelection'");
    expect(PANEL).toContain('applyClick(pruneSelection(prev, visible), rel, intent, visible)');
  });

  it('reads the modifiers the rules expect', () => {
    expect(PANEL).toContain('{ toggle: e.metaKey || e.ctrlKey, range: e.shiftKey }');
  });

  it('prunes against the CURRENT rows before applying the click', () => {
    // A folder collapsed since the last click leaves selected paths behind, and
    // a range measured from one of them would run from a row not on screen.
    expect(PANEL).toMatch(/const visible = visibleRows\(\);[\s\S]{0,300}?pruneSelection\(prev, visible\)/);
  });
});

describe('a range has a sequence to measure over', () => {
  it('collects the visible rows from the levels that are mounted', () => {
    // The tree has this order nowhere: each level is fetched and mounted
    // separately, and a collapsed folder's children are unmounted rather than
    // hidden. So each level registers itself.
    expect(PANEL).toContain('registerRows(parentRel, entries.map((e) => childRel(parentRel, e.name)))');
    expect(PANEL).toContain('return () => unregisterRows(parentRel)');
  });

  it('flattens depth-first, following only EXPANDED folders', () => {
    // A folder contributes its children only if its level registered — which is
    // the same thing as being expanded.
    expect(PANEL).toContain('if (rowsRef.current.has(rel)) walk(rel, seen);');
  });

  it('keeps the registry out of React state', () => {
    // A folder expanding must not re-render the whole tree to record a fact only
    // a click ever reads.
    expect(PANEL).toContain('const rowsRef = useRef<Map<string, readonly string[]>>(new Map())');
    expect(PANEL).not.toContain('setRowsRegistry');
  });

  it('cannot loop on a registry that names itself', () => {
    // The walk follows registry keys, and a malformed one could point back up.
    expect(PANEL).toContain('walk(\'\', new Set())');
    expect(PANEL).toContain('if (seen.has(parentRel)) return;');
  });
});

describe('the gesture that was taken over', () => {
  it('no longer inserts an @path on ⌘/Ctrl-click', () => {
    // It now extends the selection, because in a file tree that is what the
    // gesture means to everybody.
    expect(PANEL).not.toContain('insertFileRef(`@${ref}`)');
    expect(PANEL).not.toContain('insertFileRef');
  });

  it('keeps the drag that does the same job', () => {
    // The reference is not lost — dragging a row into the composer still
    // inserts it, which is why taking the click was affordable.
    expect(PANEL).toContain('FILE_REF_MIME');
  });

  it('says so in the panel’s own hint, in both languages', () => {
    // The old hint advertised ⌘-click for @path. A hint that describes a
    // gesture the panel no longer has is worse than no hint.
    for (const dict of [en, ko]) {
      expect(files(dict).hint).not.toContain('@path');
      expect(files(dict).hint).toContain('⌘/Ctrl');
    }
    expect(files(en).hint).toContain('range');
    expect(files(ko).hint).toContain('범위');
  });
});

describe('drawing a selected row', () => {
  it('marks it with a background, not by changing the text', () => {
    // A selected modified file must still LOOK modified: the git tint lives on
    // the text, so selection cannot be allowed to take that channel.
    const cls = /className=\{`flex items-center gap-1 py-0\.5 pr-2 text-xs[\s\S]*?`\}/.exec(PANEL)?.[0];
    expect(cls, 'the row class changed shape').toBeDefined();
    expect(cls).toContain('gitTintClass(');
    expect(cls).toContain("selected");
    expect(cls).toContain("'bg-accent'");
  });

  it('lets a drop target still outrank it', () => {
    // Mid-drag, what matters is where the files will land.
    expect(PANEL).toMatch(/dropOver\s*\n?\s*\?\s*'bg-brand\/20/);
  });
});

describe('a modified click does not also expand', () => {
  it('expands only on a plain click', () => {
    // Folders opening under the user while they build a selection is the tree
    // fighting the gesture.
    expect(PANEL).toContain(
      'if (entry.isDir && !e.metaKey && !e.ctrlKey && !e.shiftKey) setOpen((v) => !v);',
    );
  });
});
