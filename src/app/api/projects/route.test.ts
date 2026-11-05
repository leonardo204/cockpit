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

describe('/api/projects — sidebar project groups (project-groups §3)', () => {
  const getGroups = async () => {
    const res = await route.GET(new Request('http://127.0.0.1/api/projects'));
    return ((await res.json()) as { groups?: Array<{ id: string; name: string; cwds: string[] }> }).groups;
  };

  it('stores normalized groups and returns them on GET', async () => {
    await post({ projects: [{ cwd: '/work/alpha' }, { cwd: '/work/beta' }, { cwd: '/work/gamma' }] });
    await post({
      groups: [
        { id: 'g_one', name: '  Client A  ', collapsed: true, cwds: ['/work/alpha', '/work/nowhere'] },
        { id: 'g_two', name: 'Personal', cwds: ['/work/alpha', '/work/beta'] },
        { id: 'g_bad', name: '   ', cwds: ['/work/gamma'] },
      ],
    });

    expect(await getGroups()).toEqual([
      { id: 'g_one', name: 'Client A', collapsed: true, cwds: ['/work/alpha'] },
      { id: 'g_two', name: 'Personal', collapsed: false, cwds: ['/work/beta'] },
    ]);
    expect(JSON.parse(store.getSetting('sidebar.projectGroups') ?? '{}').groups).toHaveLength(2);
  });

  it('a POST without `groups` leaves the stored groups alone', async () => {
    const before = store.getSetting('sidebar.projectGroups');
    await post({ sidebarWidth: 280 });
    await post({ activeIndex: 0, collapsed: false });
    await post({ projects: [{ cwd: '/work/alpha' }, { cwd: '/work/beta' }, { cwd: '/work/gamma' }] });
    expect(store.getSetting('sidebar.projectGroups')).toBe(before);
    expect((await getGroups())?.map((x) => x.id)).toEqual(['g_one', 'g_two']);
  });

  it('removing a project takes it out of its group, in storage too', async () => {
    await post({ projects: [{ cwd: '/work/beta' }, { cwd: '/work/gamma' }] });

    const groups = await getGroups();
    expect(groups?.find((x) => x.id === 'g_one')?.cwds).toEqual([]);
    expect(groups?.find((x) => x.id === 'g_two')?.cwds).toEqual(['/work/beta']);
    expect(store.getSetting('sidebar.projectGroups')).not.toContain('/work/alpha');

    // Reopening the project does not resurrect the old membership.
    await post({ projects: [{ cwd: '/work/alpha' }, { cwd: '/work/beta' }, { cwd: '/work/gamma' }] });
    expect((await getGroups())?.find((x) => x.id === 'g_one')?.cwds).toEqual([]);
  });

  it('an empty `groups` clears them; a broken stored value reads as none', async () => {
    await post({ groups: [] });
    expect(await getGroups()).toEqual([]);

    (store as unknown as { setSetting(k: string, v: string): void }).setSetting(
      'sidebar.projectGroups',
      '{not json',
    );
    const res = await route.GET(new Request('http://127.0.0.1/api/projects'));
    expect(res.ok).toBe(true);
    expect(((await res.json()) as { groups: unknown[] }).groups).toEqual([]);
  });

  it('keeps the group order it was given', async () => {
    await post({
      groups: [
        { id: 'g_b', name: 'B', cwds: [] },
        { id: 'g_a', name: 'A', cwds: [] },
      ],
    });
    expect((await getGroups())?.map((x) => x.id)).toEqual(['g_b', 'g_a']);
  });
});

describe('/api/projects — project rename (project-groups §8)', () => {
  type Row = { cwd: string; title?: string };
  const titleOf = (cwd: string) =>
    (store.listProjects() as Row[]).find((p) => p.cwd === cwd)?.title;
  const getProjects = async () => {
    const res = await route.GET(new Request('http://127.0.0.1/api/projects'));
    return ((await res.json()) as { projects: Row[] }).projects;
  };
  const LIST = [{ cwd: '/work/alpha' }, { cwd: '/work/beta' }, { cwd: '/work/gamma' }];

  beforeAll(async () => {
    await post({ projects: LIST });
  });

  it('a rename changes only that row', async () => {
    await post({ rename: { cwd: '/work/alpha', title: '  Client dashboard  ' } });
    expect(titleOf('/work/alpha')).toBe('Client dashboard');
    expect(titleOf('/work/beta')).toBe('beta');
    expect(titleOf('/work/gamma')).toBe('gamma');
  });

  it('a list save keeps the rename; a new row gets its folder name', async () => {
    // Reorder, and open a new project — the two saves that used to erase it.
    await post({ projects: [{ cwd: '/work/gamma' }, ...LIST.slice(0, 2), { cwd: '/work/delta/' }] });
    expect(titleOf('/work/alpha')).toBe('Client dashboard');
    expect(titleOf('/work/delta/')).toBe('delta');

    // A title smuggled into the list is ignored: renames travel in `rename`.
    await post({ projects: [{ cwd: '/work/alpha', title: 'Sneaky' }, { cwd: '/work/beta' }, { cwd: '/work/gamma' }] });
    expect(titleOf('/work/alpha')).toBe('Client dashboard');
  });

  it('GET carries only real renames', async () => {
    const projects = await getProjects();
    expect(projects.find((p) => p.cwd === '/work/alpha')?.title).toBe('Client dashboard');
    // beta's stored title is its folder name — that is not a rename.
    expect(projects.find((p) => p.cwd === '/work/beta')).not.toHaveProperty('title');
    expect(projects.find((p) => p.cwd === '/work/gamma')).not.toHaveProperty('title');
  });

  it('an empty title, or the folder name, puts the folder name back', async () => {
    await post({ rename: { cwd: '/work/alpha', title: '   ' } });
    expect(titleOf('/work/alpha')).toBe('alpha');
    expect((await getProjects()).find((p) => p.cwd === '/work/alpha')).not.toHaveProperty('title');

    await post({ rename: { cwd: '/work/beta', title: 'Renamed' } });
    await post({ rename: { cwd: '/work/beta', title: ' beta ' } });
    expect(titleOf('/work/beta')).toBe('beta');
    expect((await getProjects()).find((p) => p.cwd === '/work/beta')).not.toHaveProperty('title');
  });

  it('caps the name at 80 characters', async () => {
    await post({ rename: { cwd: '/work/gamma', title: 'x'.repeat(200) } });
    expect(titleOf('/work/gamma')).toBe('x'.repeat(80));
  });

  it('an unknown cwd is ignored, never created', async () => {
    const before = store.listProjects().map((p) => p.cwd).sort();
    await post({ rename: { cwd: '/work/nowhere', title: 'Ghost' } });
    expect(store.listProjects().map((p) => p.cwd).sort()).toEqual(before);
  });

  it('a rename leaves the list, groups and prefs alone', async () => {
    const groups = store.getSetting('sidebar.projectGroups');
    const collapsed = store.getSetting('ui.collapsed');
    const order = store.listProjects().map((p) => p.cwd);
    await post({ rename: { cwd: '/work/beta', title: 'Personal' } });
    expect(store.listProjects().map((p) => p.cwd)).toEqual(order);
    expect(store.getSetting('sidebar.projectGroups')).toBe(groups);
    expect(store.getSetting('ui.collapsed')).toBe(collapsed);
  });
});

describe('the sidebar order is the order the list save sent (project-groups §9)', () => {
  const getProjects = async () => {
    const res = await route.GET(new Request('http://127.0.0.1/api/projects'));
    const json = (await res.json()) as { data?: { projects: { cwd: string }[] }; projects?: { cwd: string }[] };
    return (json.data ?? json).projects!.map((p) => p.cwd);
  };

  it('GET returns the saved order even when the last-opened stamps disagree', async () => {
    await post({
      projects: [
        { cwd: '/order/c', lastOpenedAt: 1 },
        { cwd: '/order/a', lastOpenedAt: 3 },
        { cwd: '/order/b', lastOpenedAt: 2 },
      ],
    });
    expect(JSON.parse(store.getSetting('sidebar.projectOrder')!)).toEqual(['/order/c', '/order/a', '/order/b']);
    expect(await getProjects()).toEqual(['/order/c', '/order/a', '/order/b']);
  });

  it('a save without `projects` leaves the order alone', async () => {
    await post({ sidebarWidth: 250 });
    expect(await getProjects()).toEqual(['/order/c', '/order/a', '/order/b']);
  });
});
