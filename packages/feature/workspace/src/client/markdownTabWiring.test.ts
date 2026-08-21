import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * How the markdown viewer is joined to the tab strip.
 *
 * SOURCE ASSERTIONS, for the same reason as markdownImageWiring.test.ts beside
 * it: there is no component-render harness here, and every rule below is a
 * property of the WIRING rather than of any function. Each one produces a build
 * that compiles, renders and looks right while doing the wrong thing — a tab
 * that opens a second copy of a document, a promotion that pins the file the
 * reader started from instead of the one they are on, a viewer that lost its
 * project and therefore its images.
 *
 * The rules that CAN be expressed as functions are in tabKinds.ts and asserted
 * on values in tabKinds.test.ts. Only the joins are here.
 */

const DIR = __dirname;
const read = (name: string) => readFileSync(join(DIR, name), 'utf8');

const MANAGER = read('TabManager.tsx');
const TAB_STATE = read('useTabState.ts');
const MODAL = read('MarkdownPreviewModal.tsx');
const DOCUMENT = read('MarkdownDocument.tsx');
const PANEL = read('FileBrowserPanel.tsx');
const TAB_BAR = read('TabBar.tsx');

describe('tab host — the tab list is no longer chats by construction', () => {
  it('dispatches on the tab KIND instead of rendering ChatPanel unconditionally', () => {
    // This map used to render <ChatPanel> for every tab, with no kind field and
    // nothing to branch on. Introducing the discrimination IS the feature.
    expect(MANAGER).toContain('isMarkdownTab(tab) ? (');
    expect(MANAGER).toContain('<MarkdownDocument');
    expect(MANAGER).toContain('<ChatPanel');
  });

  it('reads the kind through the shared predicate, not an inline field test', () => {
    // The host, the persistence effect, the close path and the menu must not be
    // able to disagree about what a tab is.
    expect(MANAGER).toContain("from './tabKinds'");
    expect(MANAGER).not.toMatch(/tab\.kind\s*===\s*'markdown'/);
  });

  it('hands the document tab a project cwd', () => {
    // Without it the viewer renders the prose and silently loses every image and
    // every relative link — the failure looks like a broken document, not like a
    // missing prop.
    const element = /<MarkdownDocument[\s\S]*?\/>/.exec(MANAGER)?.[0];
    expect(element, 'MarkdownDocument element not found — did the markup change?').toBeDefined();
    expect(element).toContain('cwd={tab.cwd || initialCwd');
    expect(element).toContain('rel={tab.rel');
  });

  it('keeps every tab mounted, document tabs included', () => {
    // Hidden with a class, never unmounted (shell/CLAUDE.md). A document that
    // re-fetched and lost its scroll on every switch would be a modal with extra
    // steps, which is the thing this feature exists to escape.
    expect(MANAGER).toContain("? 'block' : 'hidden'");
  });

  it('states where sendMessage goes while a document tab is active', () => {
    // The active-tab registry is last-writer-wins and only Chat writes it, so a
    // document tab leaves it pointing at the last chat. That is a decision — the
    // message lands in a live, still-open conversation — and it must stay a
    // written one: the next reader has to know it was chosen, not overlooked.
    expect(MANAGER).toContain('setActiveTab');
    expect(MANAGER).toContain('A DECISION, NOT AN ACCIDENT');
    // ...and the markdown branch must not quietly start claiming the registry.
    const branch = /isMarkdownTab\(tab\) \? \([\s\S]*?\) : \(/.exec(MANAGER)?.[0] ?? '';
    expect(branch).toBeTruthy();
    expect(branch).not.toContain('setActiveTab');
  });
});

describe('tab host — a document tab has no chat-only menu', () => {
  it('declines to open the tab context menu for a document', () => {
    // Every item in it keys off `sessionId`: pin, rename, temporary-session and
    // continue-in-a-new-tab. On a document they would be four dead controls,
    // which reads as a broken menu rather than as "not a thing you do here".
    expect(MANAGER).toMatch(
      /const openTabMenu = useCallback\([\s\S]*?if \(tab && isMarkdownTab\(tab\)\) return;/,
    );
  });

  it('still lets a document tab be closed', () => {
    // The ✕ on the tab and Cmd/Ctrl+W both bypass the menu, so refusing the menu
    // must not strand the tab.
    expect(MANAGER).toContain('onCloseTab={closeTab}');
  });
});

describe('tab state — a document tab cannot touch a session', () => {
  it('builds the persisted set through the kind-aware collector', () => {
    expect(TAB_STATE).toContain('openSessionIds(tabs)');
    // The old inline collector must be gone, or the rule has two answers.
    expect(TAB_STATE).not.toMatch(/tabs\s*\n?\s*\.map\(tab => tab\.sessionId\)/);
  });

  it('routes the close path through the kind-aware accessor', () => {
    expect(TAB_STATE).toContain('closableSessionId(closing)');
    expect(TAB_STATE).toContain('if (closingSessionId) pendingClosedRef.current.add(closingSessionId)');
  });

  it('refuses the chat state channel for a document tab', () => {
    // isLoading / sessionId / the derived title. The visible one is the title:
    // a chat tab re-derives its own on every turn, and a document's is its file
    // name.
    expect(TAB_STATE).toContain('if (oldTab && !acceptsChatState(oldTab)) return prev;');
  });

  it('leaves the session in the iframe URL alone while a document is active', () => {
    // The URL sync reads the active tab's sessionId; a document names none, so
    // without this the id would be stripped and an in-iframe reload would drop
    // the conversation the reader means to come back to.
    expect(TAB_STATE).toContain('if (activeTab && isMarkdownTab(activeTab)) return;');
  });
});

describe('tab state — opening the same document twice focuses the tab', () => {
  it('looks for an existing document tab before creating one', () => {
    // The same shape as handleSelectSession, which has done this for sessions
    // all along.
    expect(TAB_STATE).toMatch(
      /const openMarkdownTab = useCallback\(\(cwd: string, rel: string\) => \{[\s\S]*?findDocumentTab\(tabsRef\.current, cwd, rel\)[\s\S]*?setActiveTabId\(existing\.id\);\s*\n\s*return;/,
    );
  });

  it('creates the tab with the kind, the project and the document on it', () => {
    expect(TAB_STATE).toContain("kind: 'markdown'");
    expect(TAB_STATE).toContain('title: documentTabTitle(rel)');
  });

  it('takes the cwd as a REQUIRED argument', () => {
    // Optional would compile and then produce a viewer that cannot resolve an
    // image or a link.
    expect(TAB_STATE).toContain('(cwd: string, rel: string)');
  });

  it('reads the tab list through a ref, so the callback identity is stable', () => {
    // It is passed down into the file browser's always-mounted tree; a prop that
    // churns every render defeats the memo there (shell/CLAUDE.md).
    expect(TAB_STATE).toMatch(/findDocumentTab\(tabsRef\.current/);
  });
});

describe('promotion — the modal hands over the document actually on screen', () => {
  it('offers the control in the viewer header', () => {
    expect(MODAL).toContain("data-testid=\"markdown-preview-open-in-tab\"");
    expect(MODAL).toContain("t('markdownPreview.openInTab')");
  });

  it('promotes `current`, not the file the modal was opened with', () => {
    // A reader who followed two relative links and then asked to keep the
    // document means the one they are reading. `rel` is only where they started.
    expect(MODAL).toContain('onOpenInTab?.(current)');
    expect(MODAL).not.toMatch(/onOpenInTab\?\.\(rel\)/);
  });

  it('closes the modal once the tab holds the document', () => {
    // Leaving the overlay up would cover the tab it just created.
    expect(MODAL).toMatch(/onOpenInTab\?\.\(current\);\s*\n\s*onClose\(\);/);
  });

  it('hides the control where there is no tab host to promote into', () => {
    // A button that silently does nothing is worse than no button — the rule the
    // selection popup's promote control already follows.
    expect(MODAL).toContain('{onOpenInTab && promote(current)}');
  });

  it('takes `current` from the viewer rather than tracking it a second time', () => {
    // Two copies of "which document is on screen" means one of them is stale,
    // and it is the one the button reads.
    expect(DOCUMENT).toContain('renderActions?.(current)');
    expect(MODAL).not.toContain('useState');
  });

  it('reaches the tab host through the file browser that owns the modal', () => {
    expect(PANEL).toContain('onOpenInTab');
    expect(PANEL).toContain('onOpenInTab={onOpenInTab}');
    expect(MANAGER).toContain('onOpenInTab={handleOpenDocumentInTab}');
    expect(MANAGER).toContain('openMarkdownTab(initialCwd, rel)');
  });

  it('does not offer the promotion from inside a tab', () => {
    // It IS the tab. A control that re-opens what you are looking at is noise.
    // The PROP, not the word: the element carries a comment saying why it is
    // absent, and that comment is the thing a future reader needs most.
    const element = /<MarkdownDocument[\s\S]*?\/>/.exec(MANAGER)?.[0] ?? '';
    expect(element).not.toMatch(/onOpenInTab=/);
  });
});

describe('promotion — one viewer, two chromes', () => {
  it('gives the tab and the modal the same reading pane', () => {
    // Extract, never copy: the images, the outline seam and the link containment
    // are subtle enough that a second copy would be the broken one.
    expect(MODAL).toContain("from './MarkdownDocument'");
    expect(MANAGER).toContain("from './MarkdownDocument'");
  });

  it('leaves the window behaviour in the window', () => {
    // Escape closes a modal; there is nothing for it to close in a tab.
    expect(MODAL).toContain('useEscToClose');
    expect(DOCUMENT).not.toContain('useEscToClose');
    expect(DOCUMENT).not.toContain('<Portal>');
  });

  it('tells a document tab apart from a chat tab in the strip', () => {
    // A document tab and a chat tab behave differently in a way the user has to
    // know BEFORE clicking: closing a chat deletes its session, closing a
    // document only puts the file away. So the strip must not render them
    // identically. Gated on the shared predicate, never a local `tab.rel`
    // test, so the strip and the panel dispatch can never disagree.
    expect(TAB_BAR).toContain("from './tabKinds'");
    expect(TAB_BAR).toContain('isMarkdownTab(tab)');
    expect(TAB_BAR).toContain('border-violet-500');
  });

  it('marks an INACTIVE document tab on the top line only', () => {
    // An unfocused tab keeps the strip's ordinary colours; tinting the whole
    // thing made a row of inactive tabs read as two competing groups. So the
    // inactive document tab carries the same text and hover treatment as an
    // inactive chat tab, and differs only in the line above it.
    expect(TAB_BAR).toContain("'border-violet-500/50 text-muted-foreground hover:bg-secondary/50'");
    expect(TAB_BAR).not.toContain('hover:bg-violet-500/10');
  });

  it('does not make the distinction colour-only', () => {
    // Hue alone is not a signal for everyone. The glyph is the part that
    // survives a reader who cannot separate violet from teal, so it is pinned
    // separately from the colour above.
    expect(TAB_BAR).toContain('isDocument');
    expect(TAB_BAR).toMatch(/isMarkdownTab\(tab\) && \(\s*<svg/);
  });

  it('keeps the TOC, the images, the navigation and the status line shared', () => {
    // The four things the requirement names, all in the one component both
    // hosts render.
    expect(DOCUMENT).toContain('<TocSidebar');
    expect(DOCUMENT).toContain('rehypeMarkdownImages');
    expect(DOCUMENT).toContain('classifyMarkdownLink');
    expect(DOCUMENT).toContain("t('markdownPreview.words'");
    expect(DOCUMENT).toContain('readingTimeMinutes');
  });
});
