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
const PREVIEW = join(DIR, 'MarkdownPreviewModal.tsx');
const PREVIEW_OPS = join(DIR, 'markdownPreviewOps.ts');
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

  it('offers "Preview" only for markdown, above Open', () => {
    const src = readFileSync(MENU, 'utf8');
    // Gated on the SHARED predicate, not a local extension list: the item and
    // the row's double-click must never disagree about what markdown is.
    expect(src).toContain('isMarkdownFile');
    expect(src).toContain('isMarkdownFile(state.name) && (');
    expect(src).toContain("'fileBrowser.preview'");
    // Order matters — on a .md row Preview is the default action, so it names
    // itself first, the way Open does everywhere else.
    expect(src.indexOf("'fileBrowser.preview'")).toBeLessThan(src.indexOf("'fileBrowser.open'"));
  });

  it('keeps the OS hand-off available on markdown rows too', () => {
    const src = readFileSync(MENU, 'utf8');
    // The in-app viewer replaces no escape hatch: a user must still be able to
    // send a .md to their own editor. Both items live in the same file-only
    // gate as before, with no markdown exclusion around either.
    expect(src).not.toMatch(/!isMarkdownFile[^\n]*fileBrowser\.open/);
    expect(src).toContain("'fileBrowser.open'");
    expect(src).toContain("'fileBrowser.openWith'");
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

  it('routes the double-click through the shared activation rule', () => {
    // Not an inline extension check in the row: the menu item and the
    // double-click branch on the same predicate, via the same function.
    expect(src).toContain('rowActivation');
    expect(src).toContain("if (action === 'preview') previewFile(target);");
    expect(src).toContain("else if (action === 'os-open') openFile(target);");
  });

  it('no longer documents the policy the code stopped following', () => {
    // The header used to state the OPPOSITE rule ("Deliberately NOT an in-app
    // viewer"). A comment that contradicts the code is worse than none: it is
    // the thing the next reader trusts. This pins the retraction, since nothing
    // else in the build can see a stale sentence.
    expect(src).not.toContain('Deliberately\n *     NOT an in-app viewer');
    expect(src).not.toContain('NOT an in-app viewer');
    expect(src).toContain('MARKDOWN IS THE ONE EXTENSION THE APP OPENS ITSELF');
  });
});

describe('markdown preview modal — it is an assembly, not a second renderer', () => {
  const src = readFileSync(PREVIEW, 'utf8');

  it('escapes the panel that clips, like every other overlay here', () => {
    // Same rule as the context menu above: FileBrowserPanel is
    // `overflow-hidden` and the shell wraps it in a translateX container.
    expect(src).toContain('<Portal>');
    expect(src).toContain('fixed inset-0');
  });

  it('reuses the orphaned shared-ui pieces rather than rebuilding them', () => {
    // MarkdownRenderer + TocSidebar + rehypeSourceLines are one wired system:
    // the plugin stamps data-source-start, the sidebar looks headings up by it.
    // Re-implementing any of them is the duplication CLAUDE.md warns about.
    expect(src).toContain("from '@cockpit/shared-ui'");
    expect(src).toContain('<MarkdownRenderer');
    expect(src).toContain('<TocSidebar');
    expect(src).toContain('rehypePlugins={rehypePlugins}');
    // The pipeline is now TWO plugins: the outline seam plus the image
    // rewriter. Both must be in the same list — a second ReactMarkdown pass
    // for images would be the duplication this test exists to catch.
    expect(src).toMatch(
      /useMemo(?:<[^>]+>)?\(\s*\(\)\s*=>\s*\[rehypeSourceLines,\s*\[rehypeMarkdownImages/,
    );
  });

  it('memoises the plugin list instead of building it inline', () => {
    // A fresh array on every render makes ReactMarkdown rebuild its whole
    // pipeline and tear the DOM down with it (see the memo notes in
    // shell/CLAUDE.md). The list may change when the probed sizes arrive —
    // once per document — and at no other time.
    expect(src).toMatch(
      /const rehypePlugins = useMemo(?:<[^>]+>)?\([\s\S]*?\[imageOptions\],\s*\);/,
    );
  });

  it('turns math ON, unlike chat', () => {
    // In a conversation a `$` is nearly always money; in a document `$…$` is
    // what the author meant, and chat's MessageBubble opts out explicitly.
    // Read off the ELEMENT, not the whole file — the header comment names the
    // chat setting it is contrasting with.
    const element = /<MarkdownRenderer[\s\S]*?\/>/.exec(src)?.[0];
    expect(element, 'MarkdownRenderer element not found — did the markup change?').toBeDefined();
    expect(element).toContain('enableMath');
    expect(element).not.toContain('enableMath={false}');
  });

  it('closes on Escape through the shared hook', () => {
    expect(src).toContain('useEscToClose(onClose)');
  });

  it('never lets an unresolvable link navigate the app', () => {
    // The default is consume-and-drop. Returning false for a bare relative
    // href would resolve it against the app's own origin and navigate the
    // single-page shell away from the live chat session.
    expect(src).toContain('classifyMarkdownLink');
    expect(src).toContain("if (target.kind === 'external') return false;");
    expect(src).toContain('return true;');
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

  /** Every menu/viewer translation key mentioned in the source. */
  const keysIn = (file: string): string[] => {
    const src = readFileSync(file, 'utf8');
    const found =
      src.match(
        /'(?:fileBrowser|fileContextMenu|markdownPreview|common|confirm)\.[A-Za-z0-9_]+'/g,
      ) ?? [];
    return [...new Set(found.map((s) => s.slice(1, -1)))];
  };

  // The viewer's own strings are checked here too: it is opened from this menu,
  // and its status line and error sentences reach a Korean user the same way.
  const keys = [
    ...new Set([...keysIn(MENU), ...keysIn(PANEL), ...keysIn(PREVIEW), ...keysIn(PREVIEW_OPS)]),
  ];

  it('finds the keys it is supposed to be checking', () => {
    // A regex that silently matches nothing would make every assertion below
    // pass vacuously.
    expect(keys.length).toBeGreaterThan(10);
    expect(keys).toContain('fileBrowser.revealInFinder');
    expect(keys).toContain('fileBrowser.open');
    expect(keys).toContain('fileBrowser.openError');
    expect(keys).toContain('fileBrowser.preview');
    expect(keys).toContain('markdownPreview.readingTimeUnderMinute');
    expect(keys).toContain('markdownPreview.tooLarge');
  });

  it.each(keys)('%s exists in en.json', (key) => {
    expect(typeof lookup(en, key)).toBe('string');
  });

  it.each(keys)('%s exists in ko.json', (key) => {
    expect(typeof lookup(ko, key)).toBe('string');
  });
});
