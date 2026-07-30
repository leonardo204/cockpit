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

  it('renders the Finder item only when the Electron bridge is there', () => {
    const src = readFileSync(MENU, 'utf8');
    // Gated by a boolean, not merely disabled: an action the host cannot
    // perform should not be advertised.
    expect(src).toContain('{hasOsBridge && (');
  });

  it('renders "Open" only for a FILE, and only in Electron', () => {
    const src = readFileSync(MENU, 'utf8');
    // Three conditions in one gate: the bridge, not the project root, not a
    // folder. `shell.openPath` on a directory would spring a Finder window on
    // someone who meant to expand it.
    expect(src).toContain('{hasOsBridge && !isRoot && !state.isDir && (');
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

  it('is silent rather than noisy when there is no bridge', () => {
    // A browser tab cannot launch a local app; saying so on every double-click
    // would be nagging about something the user cannot change.
    expect(src).toMatch(/const open = fsBridge\(\)\?\.open;\s*\n\s*if \(!open\) return;/);
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
