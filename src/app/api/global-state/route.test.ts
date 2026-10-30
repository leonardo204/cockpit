import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * /api/global-state POST — a RENAME also refreshes the sidebar's project tree.
 *
 * The recent-sessions snapshot the wrapper always pushed does not reach the
 * project tree: that one refetches a branch only on `project-state-changed`. So a
 * renamed tab kept its old name in the tree until something else touched the
 * project. The wrapper now broadcasts that event after a rename (a body with a
 * string `title` and a non-empty `cwd`), and only then.
 *
 * The feature handler and the broadcaster are mocked: the subject is the wrapper's
 * decision, not the store write behind it.
 */

const h = vi.hoisted(() => ({
  broadcasts: [] as unknown[],
  featureOk: true,
}));

vi.mock('@cockpit/feature-agent/server/api/global-state', () => ({
  GET: vi.fn(),
  POST: vi.fn(async () => new Response('{}', { status: h.featureOk ? 200 : 400 })),
  DELETE: vi.fn(async () => new Response('{}', { status: 200 })),
  runtime: 'nodejs',
  dynamic: 'force-dynamic',
}));

vi.mock('@cockpit/feature-agent/server/state/globalState', () => ({
  getGlobalSessionsSnapshot: vi.fn(async () => []),
  getPendingOrgUpdateSnapshot: vi.fn(() => null),
}));

vi.mock('../../../lib/globalStateBroadcast', () => ({
  broadcastToGlobalState: (msg: unknown) => h.broadcasts.push(msg),
}));

const { POST } = await import('./route');

const post = (body: unknown) =>
  POST(
    new Request('http://127.0.0.1/api/global-state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

const treeEvents = () =>
  h.broadcasts.filter((m) => (m as { type?: string }).type === 'project-state-changed');

beforeEach(() => {
  h.broadcasts.length = 0;
  h.featureOk = true;
});

describe('POST /api/global-state — rename refreshes the project tree', () => {
  it('broadcasts project-state-changed for the renamed session\'s project', async () => {
    const res = await post({ cwd: '/work/alpha', sessionId: 's-1', title: 'New name' });
    expect(res.ok).toBe(true);
    expect(treeEvents()).toEqual([
      { type: 'project-state-changed', cwd: '/work/alpha', closedSessionIds: [] },
    ]);
    // The recent-sessions snapshot still goes out as before.
    expect(h.broadcasts.some((m) => (m as { type?: string }).type === 'global-state')).toBe(true);
  });

  it('an empty title (back to automatic) is still a rename', async () => {
    await post({ cwd: '/work/alpha', sessionId: 's-1', title: '' });
    expect(treeEvents()).toHaveLength(1);
  });

  it('mark-read (no title) does not touch the tree', async () => {
    await post({ cwd: '/work/alpha', sessionId: 's-1' });
    expect(treeEvents()).toHaveLength(0);
  });

  it('a rename without a project does not broadcast', async () => {
    await post({ cwd: '', sessionId: 's-1', title: 'x' });
    await post({ sessionId: 's-1', title: 'x' });
    expect(treeEvents()).toHaveLength(0);
  });

  it('a refused rename does not broadcast', async () => {
    h.featureOk = false;
    const res = await post({ cwd: '/work/alpha', sessionId: 's-1', title: 'x' });
    expect(res.ok).toBe(false);
    expect(treeEvents()).toHaveLength(0);
  });

  it('a body that is not JSON does not throw or broadcast', async () => {
    await post('not json');
    expect(treeEvents()).toHaveLength(0);
  });
});
