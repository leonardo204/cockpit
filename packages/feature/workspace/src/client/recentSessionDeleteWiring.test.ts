import { describe, it, expect, afterEach, vi } from 'vitest';
import { Effect } from 'effect';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deleteSession } from './projectSessionTree';

/**
 * Deleting a session from the RECENT list — the sidebar popover's × and the
 * same × on the expanded modal's cards.
 *
 * The control itself is guarded next to it, in
 * feature/agent/src/client/recentSessionDelete.test.ts. What is asserted HERE is
 * the half that lives on this side of the dependency edge: the sidebar owns the
 * recents array and the deletion effect, and there must be exactly ONE way a
 * session is ever removed.
 */

const CLIENT = __dirname;
const read = (name: string) => readFileSync(join(CLIENT, name), 'utf8');
/**
 * Source with the prose taken out. The comments state the very rules these
 * guards check ("`deleteSession` → saveProjectState({closedSessionIds})"), so a
 * negative assertion has to look at the code alone.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const code = (name: string) => stripComments(read(name));
const AGENT_CLIENT = join(CLIENT, '..', '..', '..', 'agent', 'src', 'client');
const readAgent = (name: string) => readFileSync(join(AGENT_CLIENT, name), 'utf8');
const codeAgent = (name: string) => stripComments(readAgent(name));
const APP = join(CLIENT, '..', '..', '..', '..', '..', 'src', 'app');

const CWD = '/Users/me/work/naby';

describe('recent × — the single removal channel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('goes out as closedSessionIds on /api/project-state, like a tab close', async () => {
    const posts: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      posts.push({ url, init });
      return { ok: true, status: 200, json: async () => ({}) };
    });

    await Effect.runPromise(deleteSession(CWD, 's1'));

    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('/api/project-state');
    expect(JSON.parse(String(posts[0].init.body))).toEqual({
      cwd: CWD,
      sessions: [],
      closedSessionIds: ['s1'],
    });
  });

  it('the sidebar reuses that effect rather than adding a second call', () => {
    const src = read('ProjectSidebar.tsx');
    const handler =
      /const handleDeleteRecentSession = useCallback\(async \(cwd: string, sessionId: string\) => \{[\s\S]*?\n  \}, \[\]\);/.exec(src)?.[0];
    expect(handler, 'handleDeleteRecentSession was reshaped — re-point this guard').toBeDefined();
    expect(handler).toContain('deleteSession(cwd, sessionId)');
    // The same import the tree row already deletes through — one channel, and
    // it is the one the server calls the only removal path.
    expect(src).toMatch(/import \{[\s\S]*?\bdeleteSession,[\s\S]*?\} from '\.\/projectSessionTree';/);
    expect(code('ProjectSidebar.tsx')).not.toMatch(/[^a-zA-Z]fetch\(/);
    expect(code('ProjectSidebar.tsx')).not.toContain('closedSessionIds');
    // ...and neither recent view builds one of its own.
    expect(codeAgent('GlobalSessionMonitor.tsx')).not.toContain('closedSessionIds');
    expect(codeAgent('RecentSessionsModal.tsx')).not.toContain('closedSessionIds');
  });

  it('the row is dropped optimistically, in BOTH lists that show it', () => {
    const src = read('ProjectSidebar.tsx');
    const handler =
      /const handleDeleteRecentSession = useCallback\(async \(cwd: string, sessionId: string\) => \{[\s\S]*?\n  \}, \[\]\);/.exec(src)?.[0];
    // Only after the server accepted — a failed delete must leave the row.
    expect(handler).toContain("if (exit._tag !== 'Success') return false;");
    // The recents array this component owns and feeds to the popover...
    expect(handler).toContain('setSessions((prev) => withoutRecentSession(prev, cwd, sessionId));');
    // ...and the project branch, if that project happens to be unfolded — the
    // same `withoutSession` the tree row's own delete uses.
    expect(handler).toContain('setSessionTree((prev) => withoutSession(prev, cwd, sessionId));');
    expect(handler).toContain('return true;');
  });

  it('the popover is handed that handler', () => {
    const src = read('ProjectSidebar.tsx');
    expect(src).toMatch(/<GlobalSessionMonitor[\s\S]{0,400}onDeleteSession=\{handleDeleteRecentSession\}/);
  });
});

describe('recent × — a session that is open in a tab', () => {
  it('the server broadcasts the closed ids after deleting', () => {
    const route = readFileSync(join(APP, 'api', 'project-state', 'route.ts'), 'utf8');
    // Removal happens only here, and the broadcast carries exactly which
    // sessions went — that message is what a live tab reacts to.
    expect(route).toContain('for (const sid of closedIds) store.deleteSession(sid)');
    expect(route).toContain(
      'broadcastToGlobalState({ type: "project-state-changed", cwd, closedSessionIds: closedIds })',
    );
  });

  it('the tab holding it closes itself on that broadcast', () => {
    // So the recent-list × needs no second close path: deleting a session that
    // is open reconciles the tab away through the channel that already exists,
    // and adding another one from the sidebar would race it.
    const src = read('useTabState.ts');
    expect(src).toMatch(/if \(p\.type === 'project-state-changed' && p\.cwd === initialCwd\) \{\s*reconcileTabs\(p\.closedSessionIds \?\? \[\]\);/);
    const reconcile = /const reconcileTabs = useCallback\([\s\S]*?\}, \[initialCwd\]\);/.exec(src)?.[0];
    expect(reconcile, 'reconcileTabs was reshaped — re-point this guard').toBeDefined();
    // Removes exactly the closed sessions...
    expect(reconcile).toContain('const kept = prev.filter((t) => !t.sessionId || !closedSet.has(t.sessionId));');
    // ...never leaves an empty tab bar...
    expect(reconcile).toContain("? [{ id: `tab-${Date.now()}`, cwd: initialCwd, title: 'New Chat' }]");
    // ...and re-points the active tab when it was the one deleted.
    expect(reconcile).toContain('setActiveTabId(next[next.length - 1].id);');
  });

  it('the sidebar adds no close path of its own', () => {
    const src = read('ProjectSidebar.tsx');
    const handler =
      /const handleDeleteRecentSession = useCallback\(async \(cwd: string, sessionId: string\) => \{[\s\S]*?\n  \}, \[\]\);/.exec(src)?.[0];
    expect(handler).not.toContain('closeTab');
    expect(handler).not.toContain('postMessage');
    // The reasoning is written down where the next reader will look for it.
    expect(src).toContain('A SESSION OPEN IN A TAB NEEDS NOTHING EXTRA HERE');
  });

  it('a running session takes the same route, exactly as a tab close does', () => {
    // No special case: closing a tab already deletes a session mid-run through
    // this very channel, and the recent list must not invent a second rule.
    // The one row that IS refused is the projectless legacy one, because the
    // channel cannot address an empty cwd at all.
    const src = codeAgent('recentSessionDelete.ts');
    expect(src).not.toContain('running');
    expect(src).toContain("return session.cwd.trim().length === 0 ? 'no-project' : null");
  });
});
