import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The model menu must fit on the screen, and must still escape the panel.
 *
 * Google's live catalog answers with 30+ Gemini models, and the menu rendered
 * every one of them at full height: the list ran off the bottom of the window,
 * so the models further down could not be reached at all. The fix caps the
 * OPTIONS box and scrolls it — and caps nothing else, because this menu is an
 * `absolute top-full` popover in the three-panel layout, where one
 * `overflow-hidden` on a wrapping element erases the whole thing (CLAUDE.md, UI
 * Layout — the sidebar shipped exactly that bug).
 *
 * Source assertions, deliberately: the failure is a height and a clipping
 * ancestor, and jsdom has no layout (this suite has no DOM environment at all —
 * see vitest.config.ts). A mounted test would happily "see" a 30-row menu that
 * the browser is drawing off-screen. Same reasoning as
 * sidebarPopoverClipping.test.ts.
 */

const SRC = join(__dirname, 'ModelSwitcher.tsx');
const src = readFileSync(SRC, 'utf8');
const CHAT = join(__dirname, 'Chat.tsx');
const chat = readFileSync(CHAT, 'utf8');

/** The className of the scrolling options box. */
const listClass = /data-testid="model-switcher-list"\s*\n\s*className="([^"]+)"/.exec(src)?.[1];
/** The className of the popover itself. */
const menuClass = /data-testid="model-switcher-menu"\s*\n\s*className="([^"]+)"/.exec(src)?.[1];

describe('the premise — this menu escapes the chip', () => {
  it('is still an absolutely positioned popover', () => {
    // If it ever becomes an in-flow element, the no-clipping rules below are
    // free to relax. Asserting the premise keeps them from guarding nothing.
    expect(menuClass, 'menu className not found — did the markup change?').toBeDefined();
    expect(menuClass).toContain('absolute top-full');
    expect(menuClass).toContain('z-50');
  });

  it('and the catalog it lists can genuinely be dozens of rows', () => {
    const catalog = readFileSync(join(__dirname, 'modelCatalog.ts'), 'utf8');
    // Gemini's list is whatever Google answers — no curated cap anywhere.
    expect(catalog).toMatch(/export function googleOptionsFrom\(live: readonly string\[\] \| null \| undefined\)/);
    expect(catalog).toMatch(/\.\.\.live\.map\(\(id\) => \(\{ value: id, label: id \}\)\)/);
  });
});

describe('the options list is the one box that scrolls', () => {
  it('caps its height and scrolls vertically', () => {
    expect(listClass, 'options list className not found — did the markup change?').toBeDefined();
    expect(listClass, 'the options list has no height cap').toMatch(/\bmax-h-\d+\b/);
    expect(listClass, 'the options list does not scroll').toContain('overflow-y-auto');
  });

  it('holds every option, so nothing is rendered outside the scroll area', () => {
    const listAt = src.indexOf('data-testid="model-switcher-list"');
    const mapAt = src.indexOf('{options.map((o) => {');
    expect(listAt).toBeGreaterThan(-1);
    expect(mapAt).toBeGreaterThan(listAt);
    // …and the rows keep their own height inside a flex column (a capped flex
    // container shrinks its children instead of scrolling otherwise).
    expect(src).toMatch(/className=\{`w-full flex-shrink-0 text-left px-2 py-1\.5/);
  });

  it('leaves the header outside the cap, so Refresh never scrolls away', () => {
    const headerAt = src.indexOf("t('modelSwitcher.refresh'");
    const listAt = src.indexOf('data-testid="model-switcher-list"');
    expect(headerAt).toBeGreaterThan(-1);
    expect(headerAt).toBeLessThan(listAt);
  });
});

describe('nothing clips the popover', () => {
  it('not the menu itself', () => {
    expect(menuClass).not.toContain('overflow-hidden');
    expect(menuClass).not.toContain('overflow-clip');
    // The cap belongs to the inner list, not to the popover.
    expect(menuClass).not.toMatch(/\bmax-h-/);
    expect(menuClass).not.toContain('overflow-y-auto');
  });

  it('not the chip that hosts it', () => {
    const rootClass = /<span ref=\{rootRef\} className="([^"]+)"/.exec(src)?.[1];
    expect(rootClass, 'chip root className not found — did the markup change?').toBeDefined();
    expect(rootClass).not.toContain('overflow-hidden');
    expect(rootClass).not.toContain('overflow-clip');
  });

  it('not the engine row in Chat that the chip sits in', () => {
    const row = /<div className="flex items-center gap-2 px-3 py-1\.5 border-b border-border bg-card\/50">/.exec(chat)?.[0];
    expect(row, 'engine row not found — did Chat.tsx change?').toBeDefined();
    expect(row).not.toContain('overflow-hidden');
    // And the switcher really is in that row.
    const rowAt = chat.indexOf('bg-card/50">');
    const switcherAt = chat.indexOf('<ModelSwitcher activeEngine=');
    expect(switcherAt).toBeGreaterThan(rowAt);
  });
});

describe('opening the menu shows what is already selected', () => {
  it('positions the list on the active row when it opens', () => {
    expect(src).toMatch(/const listRef = useRef<HTMLDivElement>\(null\)/);
    expect(src).toMatch(/list\.querySelector<HTMLElement>\('\[data-active="true"\]'\)/);
    expect(src).toMatch(/list\.scrollTop = Math\.max\(0, Math\.min\(centered, list\.scrollHeight - list\.clientHeight\)\)/);
    // Re-taken when a catalog lands while the menu is open.
    expect(src).toMatch(/\}, \[open, liveClaude, liveGoogle\]\)/);
  });

  it('marks the active row for that lookup', () => {
    expect(src).toMatch(/data-active=\{active \? 'true' : 'false'\}/);
  });

  it('NEVER uses scrollIntoView, which would drag the whole panel', () => {
    // scrollIntoView scrolls every scrollable ancestor; in the three-panel
    // layout the nearest ones are the chat panel and the swipe container, so it
    // would slide the panel to reveal a menu that is already on screen.
    // The CALL, not the word — the note explaining why it is avoided lives in
    // the source and would otherwise fail its own rule.
    expect(src).not.toMatch(/\.scrollIntoView\s*\(/);
  });
});
