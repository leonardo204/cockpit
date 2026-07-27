import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * /api/projects is a PATCH, not a replace, and the difference is destructive.
 *
 * A body without `projects` used to be read as an empty project list, and the
 * reconcile step removes every project the body does not list — CASCADING away
 * each project's sessions and their messages. So a save that only meant to
 * record a UI preference (the sidebar width, dragged by the user) would have
 * taken the entire workspace with it. These tests pin the rule that an absent
 * field means "leave it alone".
 */

const dir = mkdtempSync(join(tmpdir(), 'naby-projects-route-'));
let route: typeof import('./route');
let store: { listProjects(): Array<{ cwd: string }>; getSetting(k: string): string | undefined };

const post = async (body: unknown) => {
  const res = await route.POST(
    new Request('http://127.0.0.1/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  expect(res.ok).toBe(true);
  return res;
};

beforeAll(async () => {
  // Point the store at a throwaway database BEFORE anything opens it — getStore
  // resolves the path once and caches the handle for the process.
  process.env.NABY_DB_PATH = join(dir, 'app.db');
  route = await import('./route');
  const naby = await import('@cockpit/feature-agent/server/engines/naby');
  store = naby.getStore() as unknown as typeof store;

  await post({
    projects: [{ cwd: '/work/alpha' }, { cwd: '/work/beta' }],
    activeIndex: 1,
    collapsed: true,
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('POST /api/projects — an absent field means "leave it alone"', () => {
  it('keeps every project when the body carries only a sidebar width', async () => {
    expect(store.listProjects().map((p) => p.cwd).sort()).toEqual(['/work/alpha', '/work/beta']);

    await post({ sidebarWidth: 300 });

    // The workspace survives. Before the fix this list was empty and the
    // sessions underneath it were gone with it.
    expect(store.listProjects().map((p) => p.cwd).sort()).toEqual(['/work/alpha', '/work/beta']);
    expect(store.getSetting('ui.sidebarWidth')).toBe('300');
  });

  it('leaves the other UI prefs untouched by a width-only save', async () => {
    expect(store.getSetting('ui.activeIndex')).toBe('1');
    expect(store.getSetting('ui.collapsed')).toBe('true');

    await post({ sidebarWidth: 260 });

    expect(store.getSetting('ui.activeIndex')).toBe('1');
    expect(store.getSetting('ui.collapsed')).toBe('true');
  });

  it('clamps a width that would leave a panel unusable', async () => {
    await post({ sidebarWidth: 5 });
    expect(store.getSetting('ui.sidebarWidth')).toBe('160');

    await post({ sidebarWidth: 99999 });
    expect(store.getSetting('ui.sidebarWidth')).toBe('480');

    // The file browser has its own bounds, and its own key.
    await post({ filesWidth: 5 });
    expect(store.getSetting('ui.filesWidth')).toBe('200');

    await post({ filesWidth: 99999 });
    expect(store.getSetting('ui.filesWidth')).toBe('640');
  });

  it('keeps the two panel widths independent', async () => {
    await post({ sidebarWidth: 300 });
    await post({ filesWidth: 420 });

    // The file browser lives in the project iframe and saves on its own; that
    // save must not disturb the width the outer window is showing.
    expect(store.getSetting('ui.sidebarWidth')).toBe('300');
    expect(store.getSetting('ui.filesWidth')).toBe('420');
    expect(store.listProjects().map((p) => p.cwd).sort()).toEqual(['/work/alpha', '/work/beta']);
  });

  it('still reconciles the project list when the body does carry one', async () => {
    const widthBefore = store.getSetting('ui.sidebarWidth');

    await post({ projects: [{ cwd: '/work/alpha' }], activeIndex: 0, collapsed: false });

    expect(store.listProjects().map((p) => p.cwd)).toEqual(['/work/alpha']);
    expect(store.getSetting('ui.collapsed')).toBe('false');
    // …and the widths it never mentioned are still there.
    expect(store.getSetting('ui.sidebarWidth')).toBe(widthBefore);
  });

  it('returns both stored widths on GET, as numbers', async () => {
    await post({ sidebarWidth: 250, filesWidth: 350 });

    const res = await route.GET(new Request('http://127.0.0.1/api/projects'));
    const data = (await res.json()) as {
      sidebarWidth?: number;
      filesWidth?: number;
      projects: unknown[];
    };
    expect(data.sidebarWidth).toBe(250);
    expect(data.filesWidth).toBe(350);
    expect(data.projects).toHaveLength(1);
  });
});
