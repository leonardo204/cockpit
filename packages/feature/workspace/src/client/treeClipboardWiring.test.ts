import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import en from '../../../../shared/i18n/locales/en.json';
import ko from '../../../../shared/i18n/locales/ko.json';
import { failureKey } from './fileBrowserOps';

/**
 * COPY / CUT / PASTE IS WIRED, AND THE DANGEROUS PARTS ARE WHERE THEY BELONG.
 *
 * Source assertions, as everywhere in this panel: jsdom has no pointer and no
 * focus model worth the name. The RULES are pure and covered in
 * `treeClipboard.test.ts` and the route's own suite; what is at risk here is
 * that a shortcut reaches the whole window, that a right-click acts on the wrong
 * rows, or that a paste sends an operation it should have dropped.
 */

const PANEL = readFileSync(join(__dirname, 'FileBrowserPanel.tsx'), 'utf8');
const MENU = readFileSync(join(__dirname, 'FileBrowserContextMenu.tsx'), 'utf8');
const ROUTE = readFileSync(
  join(__dirname, '../../../../../src/app/api/fs-op/route.ts'),
  'utf8',
);
const files = (d: unknown) => (d as { fileBrowser: Record<string, string> }).fileBrowser;

describe('the shortcuts stay inside the panel', () => {
  it('listens on the panel element, not the window', () => {
    // A global ⌘C in a chat app would steal the copy the user meant for the
    // message they just selected. The app has no shortcut registry to arbitrate.
    expect(PANEL).toContain('onKeyDown={onPanelKeyDown}');
    expect(PANEL).not.toMatch(/window\.addEventListener\(['"]keydown/);
  });

  it('can hold focus at all, without joining the tab order', () => {
    expect(PANEL).toContain('tabIndex={-1}');
  });

  it('binds copy, cut and paste and nothing else', () => {
    expect(PANEL).toContain("if (key === 'c')");
    expect(PANEL).toContain("} else if (key === 'x')");
    expect(PANEL).toContain("} else if (key === 'v')");
    // Alt-modified chords belong to something else.
    expect(PANEL).toContain('if (!mod || e.altKey) return;');
  });
});

describe('what a right-click acts on', () => {
  it('goes through targetsFor', () => {
    // Without it, right-clicking one file while five are selected copies six —
    // and for a cut-then-paste that is five files moved by accident.
    expect(PANEL).toContain('targetsFor(selectionRef.current, target.rel)');
  });

  it('offers paste only when there is something to paste', () => {
    // A greyed item invites a click that explains nothing.
    expect(PANEL).toContain('canPaste={clipboard !== null}');
    expect(MENU).toContain('{canPaste && (');
  });

  it('pastes into a FILE row’s folder', () => {
    expect(PANEL).toContain("pasteTargetOf(target.rel, target.isDir)");
  });
});

describe('a paste is one request per item', () => {
  it('sends each op separately, so each has its own reason', () => {
    expect(PANEL).toContain('for (const op of ops) {');
    expect(PANEL).toContain('fsOp(cwd, op.action, op.rel, undefined, op.destRel)');
  });

  it('refreshes the source folder as well as the destination', () => {
    // A cut empties the folder it came from; refreshing only the destination
    // leaves the moved row still drawn where it no longer is.
    expect(PANEL).toContain('touched.add(parentOf(op.rel))');
    expect(PANEL).toContain('bumpMany([...touched])');
  });

  it('re-reads the git status after moving files', () => {
    expect(PANEL).toMatch(/bumpMany\(\[\.\.\.touched\]\);\s*\n\s*refreshGitStatus\(\);/);
  });

  it('reports the FIRST refusal only', () => {
    // Ten toasts for a ten-file paste is a wall the user dismisses unread; the
    // rows that did move are already visible in the tree.
    expect(PANEL).toContain('if (firstFailure) toast(');
  });

  it('spends the clipboard through the tested rule', () => {
    expect(PANEL).toContain('afterPaste(prev, moved)');
  });
});

describe('the refusals a user meets by accident have their own words', () => {
  it('names the two a paste adds', () => {
    // `nest-in-self` especially: the drag looked legal, both paths are in the
    // project, and without a sentence it reads as a bug.
    expect(failureKey('paste', 'nest-in-self')).toBe('fileBrowser.pasteIntoSelf');
    expect(failureKey('paste', 'dest-not-dir')).toBe('fileBrowser.pasteNotFolder');
    expect(failureKey('paste', 'exists')).toBe('fileBrowser.nameTaken');
    expect(failureKey('paste', 'failed')).toBe('fileBrowser.pasteError');
  });

  it('translates every one of them, in both locales', () => {
    for (const key of ['pasteError', 'pasteIntoSelf', 'pasteNotFolder', 'copyItems', 'cutItems', 'pasteItems']) {
      expect(files(en)[key], `en: ${key}`).toBeTruthy();
      expect(files(ko)[key], `ko: ${key}`).toBeTruthy();
      expect(files(ko)[key]).not.toBe(files(en)[key]);
    }
  });
});

describe('the server is the one that actually refuses', () => {
  it('checks self-nesting BEFORE touching anything', () => {
    // The failure it prevents is unbounded — `cp -r` into a descendant recurses
    // until the disk fills — so it cannot be left to the syscall.
    const block = /case "move":[\s\S]*?case "delete"/.exec(ROUTE)?.[0];
    expect(block, 'the move/copy block is gone').toBeDefined();
    expect(block!.indexOf('wouldNestInSelf')).toBeLessThan(block!.indexOf('rename(target, landing)'));
  });

  it('validates a copy exactly as it validates a move', () => {
    // One block, so a copy cannot reach somewhere a move could not.
    expect(ROUTE).toContain('case "move":\n      case "copy": {');
  });

  it('never clobbers what is already at the destination', () => {
    expect(ROUTE).toContain("if (yield* exists(landing)) return fail(\"exists\")");
    expect(ROUTE).toContain('errorOnExist: true, force: false');
  });

  it('does not silently turn a failed move into a copy-then-delete', () => {
    // A half-finished fallback is how a move loses a file.
    const block = /case "move":[\s\S]*?case "delete"/.exec(ROUTE)?.[0];
    expect(block).not.toContain('unlink');
    expect(block).not.toContain('rm(');
  });
});
