import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Two source assertions the file browser's right-click menu depends on, neither
 * of which any rendering test in this repo could catch.
 *
 * 1. THE MENU MUST ESCAPE THE PANEL. `FileBrowserPanel`'s root is
 *    `overflow-hidden`, and the three-panel shell wraps everything in a
 *    `translateX` container — which makes `position: fixed` resolve against
 *    that transformed ancestor, so the panel's clipping applies after all. An
 *    absolutely positioned or in-place menu is therefore invisible near the
 *    bottom of the panel. jsdom has no layout, so a mounted test would happily
 *    "see" a menu the browser hides; reading the source is the honest check
 *    (same reasoning as sidebarPopoverClipping.test.ts, and the same bug that
 *    erased three sidebar panels).
 *
 * 2. EVERY LABEL MUST EXIST IN BOTH LOCALES. A key added to en.json and
 *    forgotten in ko.json shows the raw key path to a Korean user — which is
 *    what half these menu items would have done.
 */

const DIR = __dirname;
const MENU = join(DIR, 'FileBrowserContextMenu.tsx');
const PANEL = join(DIR, 'FileBrowserPanel.tsx');
const LOCALES = join(DIR, '..', '..', '..', '..', 'shared', 'i18n', 'locales');

describe('file browser menu — it escapes the panel it opens from', () => {
  it('is portaled to document.body', () => {
    const src = readFileSync(MENU, 'utf8');
    expect(src).toContain('createPortal');
    expect(src).toContain('document.body');
  });

  it('is fixed-positioned, not absolute', () => {
    const src = readFileSync(MENU, 'utf8');
    const rootClass = /className="fixed z-\[\d+\][^"]*"/.exec(src)?.[0];
    expect(rootClass, 'menu root className not found — did the markup change?').toBeDefined();
    expect(rootClass).not.toContain('absolute');
  });

  it('still opens from a panel that clips — the premise of the rule above', () => {
    // If the panel ever stops clipping, this rule is free to relax. Asserting
    // the premise keeps the test honest instead of guarding nothing.
    const src = readFileSync(PANEL, 'utf8');
    expect(src).toContain('overflow-hidden');
  });

  it('offers Reveal without an Electron gate, with a per-platform label', () => {
    const src = readFileSync(MENU, 'utf8');
    // The bridge no longer gates the item — `/api/fs-op` covers the hosts
    // where the bridge is dark (a plain browser, and Windows builds where the
    // subframe bridge does not surface; gating there read as "Windows has no
    // Open"). The label must name the user's actual file manager: "Reveal in
    // Finder" on a Windows machine reads as someone else's menu.
    expect(src).not.toContain('hasOsBridge');
    expect(src).toContain("'fileBrowser.revealInFinder'");
    expect(src).toContain("'fileBrowser.revealInExplorer'");
    expect(src).toContain("'fileBrowser.revealInFileManager'");
  });

  it('renders "Open" only for a FILE', () => {
    const src = readFileSync(MENU, 'utf8');
    // Two conditions in one gate: not the project root, not a folder — opening
    // a directory would spring a file-manager window on someone who meant to
    // expand it. The server route refuses directories for the same reason.
    expect(src).toContain('{!isRoot && !state.isDir && (');
  });

  it('offers "Open With…" only where the OS has a chooser', () => {
    const src = readFileSync(MENU, 'utf8');
    // Inside the file-only gate above, further limited to macOS/Windows
    // clients: Linux has no standard open-with chooser, and an item that can
    // never work is worse than no item.
    expect(src).toContain('{(isMacClient() || isWindowsClient()) && (');
    expect(src).toContain("'fileBrowser.openWith'");
  });
});

describe('file browser rows — double-click opens a file with the OS', () => {
  const src = readFileSync(PANEL, 'utf8');

  it('wires onDoubleClick on the row', () => {
    expect(src).toContain('onDoubleClick={onDoubleClick}');
  });

  it('leaves folders and modifier-clicks to the existing handlers', () => {
    // A folder double-click is two toggles (ends where it started), and
    // ⌘/Ctrl-click means "insert @path" — pressing it twice must not also
    // launch an application.
    expect(src).toContain('if (entry.isDir || e.metaKey || e.ctrlKey) return;');
  });

  it('falls back to the server when there is no bridge', () => {
    // The bridge is preferred where it exists, but its absence must not eat
    // the action: the server runs on the same machine as the files, so
    // `/api/fs-op` can launch the OS handler itself. This is what makes Open
    // and Reveal work on hosts where the bridge is dark.
    expect(src).toContain("fsOp(cwd, 'open', target.rel)");
    expect(src).toContain("fsOp(cwd, 'reveal', target.rel)");
  });

  it('tells the truth about delete: trash when it can, permanent when it cannot', () => {
    const src = readFileSync(PANEL, 'utf8');
    expect(src).toContain('fileBrowser.confirmDeleteMessage');
    expect(src).toContain('fileBrowser.confirmDeletePermanent');
  });
});

describe('file browser menu — every label is translated in both locales', () => {
  const en = JSON.parse(readFileSync(join(LOCALES, 'en.json'), 'utf8')) as Record<string, unknown>;
  const ko = JSON.parse(readFileSync(join(LOCALES, 'ko.json'), 'utf8')) as Record<string, unknown>;

  const lookup = (dict: Record<string, unknown>, key: string): unknown =>
    key.split('.').reduce<unknown>((acc, part) => {
      if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[part];
      return undefined;
    }, dict);

  /** Every `fileBrowser.*` / `fileContextMenu.*` key mentioned in the source. */
  const keysIn = (file: string): string[] => {
    const src = readFileSync(file, 'utf8');
    const found = src.match(/'(?:fileBrowser|fileContextMenu|common|confirm)\.[A-Za-z0-9_]+'/g) ?? [];
    return [...new Set(found.map((s) => s.slice(1, -1)))];
  };

  const keys = [...new Set([...keysIn(MENU), ...keysIn(PANEL)])];

  it('finds the keys it is supposed to be checking', () => {
    // A regex that silently matches nothing would make every assertion below
    // pass vacuously.
    expect(keys.length).toBeGreaterThan(10);
    expect(keys).toContain('fileBrowser.revealInFinder');
    expect(keys).toContain('fileBrowser.open');
    expect(keys).toContain('fileBrowser.openError');
  });

  it.each(keys)('%s exists in en.json', (key) => {
    expect(typeof lookup(en, key)).toBe('string');
  });

  it.each(keys)('%s exists in ko.json', (key) => {
    expect(typeof lookup(ko, key)).toBe('string');
  });
});
