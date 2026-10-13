import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { Effect } from 'effect';
import i18n from '@cockpit/shared-i18n';
import {
  buildFolderMenu,
  nextMenuIndex,
  requestProjectFolder,
  type FolderMenuChoice,
} from './projectFolderFlow';
import { ProjectFolderMenuView } from './ProjectFolderMenu';
import {
  loadProjectFolderChoices,
  pickFolder,
  type ProjectFolderChoices,
} from './effect/workspaceClient';

/**
 * The quick folder menu: favorites and the last folder, offered before the
 * chooser opens.
 *
 * Three layers, tested where each can be seen without a DOM (the repo has no
 * DOM harness):
 *   - the FLOW (projectFolderFlow.ts) — which entries, when the menu is skipped,
 *     where the chooser opens for each choice — as plain functions, and once
 *     end-to-end through the real client and a fake Electron bridge;
 *   - the MARKUP (ProjectFolderMenuView) via renderToStaticMarkup;
 *   - the KEYBOARD and dismissal wiring, which needs a live DOM, via the pure
 *     roving-focus rule plus source assertions on the component.
 */

const choices = (over: Partial<ProjectFolderChoices> = {}): ProjectFolderChoices => ({
  startPath: '/Users/me/work',
  favorites: [],
  last: null,
  home: '/Users/me',
  ...over,
});

// ---------------------------------------------------------------------------
// the flow
// ---------------------------------------------------------------------------

describe('buildFolderMenu', () => {
  it('favorites in stored order, then the last folder', () => {
    expect(
      buildFolderMenu(choices({ favorites: ['/a', '/b'], last: '/c' })),
    ).toEqual([
      { kind: 'favorite', path: '/a' },
      { kind: 'favorite', path: '/b' },
      { kind: 'last', path: '/c' },
    ]);
  });

  it('omits the last folder when it is already a favorite', () => {
    expect(buildFolderMenu(choices({ favorites: ['/a', '/c'], last: '/c' }))).toEqual([
      { kind: 'favorite', path: '/a' },
      { kind: 'favorite', path: '/c' },
    ]);
  });

  it('drops duplicate and empty favorites', () => {
    expect(buildFolderMenu(choices({ favorites: ['/a', '', '/a'] }))).toEqual([
      { kind: 'favorite', path: '/a' },
    ]);
  });

  it('is empty with nothing to offer', () => {
    expect(buildFolderMenu(choices())).toEqual([]);
  });
});

/** Runs the flow with recorded effects; `menuAnswer` is what the "user" does. */
async function run(c: ProjectFolderChoices, menuAnswer: FolderMenuChoice | null) {
  const picks: Array<string | undefined> = [];
  let menuShown = 0;
  const folder = await requestProjectFolder({
    loadChoices: async () => c,
    showMenu: async () => {
      menuShown += 1;
      return menuAnswer;
    },
    pick: async (startAt) => {
      picks.push(startAt);
      return '/picked';
    },
  });
  return { folder, picks, menuShown };
}

describe('requestProjectFolder', () => {
  it('skips the menu when there is nothing to offer — straight to the chooser at the resolved start', async () => {
    const r = await run(choices({ startPath: '/Users/me/default' }), { kind: 'browse' });
    expect(r.menuShown).toBe(0);
    expect(r.picks).toEqual(['/Users/me/default']);
    expect(r.folder).toBe('/picked');
  });

  it('a favorite opens the chooser INSIDE that folder, not at its parent', async () => {
    const r = await run(choices({ favorites: ['/Users/me/work/acme'] }), {
      kind: 'folder',
      path: '/Users/me/work/acme',
    });
    expect(r.menuShown).toBe(1);
    expect(r.picks).toEqual(['/Users/me/work/acme']);
  });

  it('the last folder opens inside itself too', async () => {
    const r = await run(choices({ last: '/Users/me/work/b' }), { kind: 'folder', path: '/Users/me/work/b' });
    expect(r.picks).toEqual(['/Users/me/work/b']);
  });

  it('"Browse other folder…" opens at the resolved start', async () => {
    const r = await run(choices({ favorites: ['/a'], startPath: '/Users/me/default' }), { kind: 'browse' });
    expect(r.picks).toEqual(['/Users/me/default']);
  });

  it('dismissing the menu opens nothing', async () => {
    const r = await run(choices({ favorites: ['/a'] }), null);
    expect(r.picks).toEqual([]);
    expect(r.folder).toBeNull();
  });
});

describe('end to end — menu choice → Electron bridge', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    vi.unstubAllGlobals();
  });

  /** The real client against a fake server and a fake bridge. */
  function install(server: Record<string, unknown>) {
    const bridgeCalls: Array<string | undefined> = [];
    const requests: string[] = [];
    (globalThis as { window?: unknown }).window = {
      naby: {
        fsOps: {
          pickFolder: async (_m?: string, defaultPath?: string) => {
            bridgeCalls.push(defaultPath);
            return '/picked';
          },
        },
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        requests.push(String(input));
        return { ok: true, status: 200, json: async () => (String(input) === '/api/pick-folder/start' ? server : {}) };
      }),
    );
    const flow = (answer: (c: ProjectFolderChoices) => FolderMenuChoice | null) =>
      requestProjectFolder({
        loadChoices: () => Effect.runPromise(loadProjectFolderChoices()),
        showMenu: async (c) => answer(c),
        pick: async (startAt) => (await Effect.runPromise(pickFolder(undefined, { startAt }))).folder ?? null,
      });
    return { bridgeCalls, requests, flow };
  }

  it('a favorite reaches the bridge as defaultPath, with ONE lookup', async () => {
    const { bridgeCalls, requests, flow } = install({
      startPath: '/Users/me',
      favorites: ['/Users/me/work/acme'],
      last: null,
      home: '/Users/me',
    });
    await flow((c) => ({ kind: 'folder', path: c.favorites[0]! }));
    expect(bridgeCalls).toEqual(['/Users/me/work/acme']);
    expect(requests.filter((u) => u === '/api/pick-folder/start')).toHaveLength(1);
  });

  it('browse reaches the bridge with the resolved start', async () => {
    const { bridgeCalls, flow } = install({
      startPath: '/Users/me/default',
      favorites: ['/Users/me/work/acme'],
      last: null,
    });
    await flow(() => ({ kind: 'browse' }));
    expect(bridgeCalls).toEqual(['/Users/me/default']);
  });

  it('nothing to offer → the bridge opens at the resolved start without a menu', async () => {
    const { bridgeCalls, flow } = install({ startPath: '/Users/me/default', favorites: [], last: null });
    const shown = vi.fn(() => null);
    await flow(shown);
    expect(shown).not.toHaveBeenCalled();
    expect(bridgeCalls).toEqual(['/Users/me/default']);
  });

  it('a server that answers junk is "no choices", not a crash', async () => {
    const { bridgeCalls, flow } = install({ startPath: 7, favorites: 'nope', last: ['x'] });
    await flow(() => null);
    expect(bridgeCalls).toEqual([undefined]);
  });
});

describe('nextMenuIndex — roving focus', () => {
  it('arrows move and wrap', () => {
    expect(nextMenuIndex('ArrowDown', 0, 3)).toBe(1);
    expect(nextMenuIndex('ArrowDown', 2, 3)).toBe(0);
    expect(nextMenuIndex('ArrowUp', 0, 3)).toBe(2);
    expect(nextMenuIndex('ArrowUp', 2, 3)).toBe(1);
  });

  it('enters from the matching end when nothing is focused', () => {
    expect(nextMenuIndex('ArrowDown', -1, 3)).toBe(0);
    expect(nextMenuIndex('ArrowUp', -1, 3)).toBe(2);
  });

  it('Home / End jump', () => {
    expect(nextMenuIndex('Home', 2, 3)).toBe(0);
    expect(nextMenuIndex('End', 0, 3)).toBe(2);
  });

  it('ignores every other key and an empty menu', () => {
    expect(nextMenuIndex('a', 0, 3)).toBeNull();
    expect(nextMenuIndex('Enter', 0, 3)).toBeNull();
    expect(nextMenuIndex('ArrowDown', -1, 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// the markup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

const render = (c: ProjectFolderChoices) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ProjectFolderMenuView choices={c} onChoose={() => {}} onStar={() => {}} />
    </I18nextProvider>,
  );

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('ProjectFolderMenuView', () => {
  it('lists favorites, then the last folder labelled as such with a star action, then browse', () => {
    const html = render(
      choices({ favorites: ['/Users/me/work/acme', '/srv/shared'], last: '/Users/me/work/b' }),
    );
    expect(html).toContain('role="menu"');
    expect(count(html, 'data-testid="project-folder-menu-favorite"')).toBe(2);
    expect(count(html, 'data-testid="project-folder-menu-last"')).toBe(1);
    expect(count(html, 'data-testid="project-folder-menu-star"')).toBe(1);
    expect(html).toContain('Last opened');
    expect(html).toContain('aria-label="Add to favorites"');
    expect(html).toContain('Browse other folder…');
    // Order: favorites, last, separator, browse.
    const order = [
      html.indexOf('/Users/me/work/acme'),
      html.indexOf('/srv/shared'),
      html.indexOf('project-folder-menu-last'),
      html.indexOf('role="separator"'),
      html.indexOf('project-folder-menu-browse'),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('shows home as ~ and keeps the full path in the tooltip', () => {
    const html = render(choices({ favorites: ['/Users/me/work/acme'] }));
    expect(html).toContain('>~/work/acme<');
    expect(html).toContain('title="/Users/me/work/acme"');
  });

  it('a last folder that is also a favorite appears once, as a favorite, with no star', () => {
    const html = render(choices({ favorites: ['/Users/me/a'], last: '/Users/me/a' }));
    expect(count(html, 'data-testid="project-folder-menu-favorite"')).toBe(1);
    expect(html).not.toContain('project-folder-menu-last');
    expect(html).not.toContain('project-folder-menu-star');
  });

  it('every action is a menuitem with managed focus (tabIndex -1)', () => {
    const html = render(choices({ favorites: ['/a'], last: '/b' }));
    const items = html.match(/<button[^>]*role="menuitem"[^>]*>/g) ?? [];
    // favorite, last, star, browse
    expect(items).toHaveLength(4);
    for (const tag of items) expect(tag).toContain('tabindex="-1"');
  });

  it('uses the shell popover surface, as the tab menu does', () => {
    const html = render(choices({ favorites: ['/a'] }));
    expect(html).toContain('bg-popover border border-border rounded-md shadow-lg');
    expect(html).toContain('hover:bg-accent focus:bg-accent');
  });

  it('renders the Korean copy', async () => {
    await i18n.changeLanguage('ko');
    try {
      const html = render(choices({ favorites: ['/a'], last: '/b' }));
      expect(html).toContain('마지막으로 연 폴더');
      expect(html).toContain('다른 폴더 찾아보기…');
      expect(html).toContain('즐겨찾기에 추가');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

// ---------------------------------------------------------------------------
// keyboard and dismissal wiring (needs a live DOM — asserted on the source)
// ---------------------------------------------------------------------------

describe('ProjectFolderMenu wiring', () => {
  const src = readFileSync(join(__dirname, 'ProjectFolderMenu.tsx'), 'utf8');

  it('moves focus with the roving rule and enters on the first item', () => {
    expect(src).toContain('nextMenuIndex(e.key,');
    expect(src).toMatch(/items\(\)\[0\]\?\.focus\(\)/);
  });

  it('Escape and Tab close without reaching the modal underneath', () => {
    expect(src).toMatch(/e\.key === 'Escape' \|\| e\.key === 'Tab'/);
    expect(src).toContain('e.stopPropagation()');
  });

  it('closes on an outside mousedown and on window blur, but not on its own trigger', () => {
    expect(src).toContain("window.addEventListener('mousedown', onDown)");
    expect(src).toContain("window.addEventListener('blur', onBlur)");
    expect(src).toContain('trigger?.contains(target)');
  });

  it('hands focus back to the trigger however it closes', () => {
    const close = /const close = useCallback\([^]*?\}, \[\]\);/.exec(src)?.[0] ?? '';
    expect(close).toContain('current.trigger?.focus()');
  });

  it('is portaled, so a clipping container cannot hide it', () => {
    expect(src).toContain('<Portal>');
  });

  it('every entry point renders the hook menu', () => {
    for (const file of ['Workspace.tsx', 'EmptyState.tsx', 'SessionBrowser.tsx']) {
      const s = readFileSync(join(__dirname, file), 'utf8');
      expect(s, file).toMatch(/\{(?:folderMenu\.menu|projectFolderMenu)\}/);
    }
  });
});
