import { describe, it, expect, afterEach, vi } from 'vitest';
import { Effect } from 'effect';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closedSessionIdsForViewer, deleteSession } from './projectSessionTree';

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

  const capturePosts = () => {
    const posts: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      posts.push({ url, init });
      return { ok: true, status: 200, json: async () => ({}) };
    });
    return posts;
  };

  it('goes out as closedSessionIds on /api/project-state, like a tab close', async () => {
    const posts = capturePosts();

    await Effect.runPromise(deleteSession(CWD, 's1'));

    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('/api/project-state');
    expect(JSON.parse(String(posts[0].init.body))).toEqual({
      cwd: CWD,
      sessions: [],
      closedSessionIds: ['s1'],
    });
  });

  it('A PROJECTLESS SESSION goes out through the SAME endpoint, in its own shape', async () => {
    // The defect: legacy rows carry `cwd === ''`, the only removal request had
    // to name a project, and so their × was disabled — a session the user could
    // not remove, forever. This is not a second channel: same endpoint, same
    // `closedSessionIds`, same server-side deletion loop and broadcast. What it
    // does not do is pretend to a project it does not have.
    const posts = capturePosts();

    await Effect.runPromise(deleteSession('', 's1'));

    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('/api/project-state');
    expect(JSON.parse(String(posts[0].init.body))).toEqual({
      scope: 'projectless',
      closedSessionIds: ['s1'],
    });
  });

  it('a cwd of only whitespace is projectless too, not a project named " "', async () => {
    const posts = capturePosts();
    await Effect.runPromise(deleteSession('   ', 's1'));
    expect(JSON.parse(String(posts[0].init.body))).toEqual({
      scope: 'projectless',
      closedSessionIds: ['s1'],
    });
  });

  it('the projectless shape is the ONLY thing that skips a cwd', () => {
    // A tab save must never take this door. `scope` is set by exactly one
    // function, and it carries no session list to lose.
    const src = code('effect/stateClient.ts');
    expect(src.match(/scope: "projectless"/g)).toHaveLength(1);
    const projectless =
      /export const closeProjectlessSessions = \([\s\S]*?\n  \}\)/.exec(src)?.[0];
    expect(projectless, 'closeProjectlessSessions was reshaped — re-point this guard').toBeDefined();
    expect(projectless).toContain('/api/project-state');
    expect(projectless).not.toContain('sessions:');
    // The ordinary save still sends its cwd, unconditionally.
    const save = /export const saveProjectState = \([\s\S]*?\n  \}\)/.exec(src)?.[0];
    expect(save).not.toContain('scope');
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
  it('the server broadcasts the closed ids after deleting — for BOTH shapes', () => {
    const route = readFileSync(join(APP, 'api', 'project-state', 'route.ts'), 'utf8');
    // The route no longer holds the removal loop; it delegates to the module
    // that owns what a POST means, and that module keeps ONE loop for both
    // shapes (asserted in state/projectState.test.ts).
    expect(route).toContain('applyProjectStateRequest(getStore(), request)');
    // The broadcast is unconditional — a projectless close announces cwd '',
    // which is what `broadcastCwdOf` returns for it.
    expect(route).toContain('const cwd = broadcastCwdOf(request)');
    expect(route).toContain('const closedIds = request.closedSessionIds');
    expect(route).toContain(
      'broadcastToGlobalState({ type: "project-state-changed", cwd, closedSessionIds: closedIds })',
    );
    const server = join(CLIENT, '..', '..', '..', 'agent', 'src', 'server');
    const projectState = readFileSync(join(server, 'state', 'projectState.ts'), 'utf8');
    expect(projectState).toContain('for (const sid of request.closedSessionIds) store.deleteSession(sid)');
    expect(stripComments(projectState).match(/store\.deleteSession\(/g)).toHaveLength(1);
  });

  it('the tab holding it closes itself on that broadcast', () => {
    // So the recent-list × needs no second close path: deleting a session that
    // is open reconciles the tab away through the channel that already exists,
    // and adding another one from the sidebar would race it.
    const src = read('useTabState.ts');
    expect(src).toContain('reconcileTabs(closedSessionIdsForViewer(raw, initialCwd));');
    const reconcile = /const reconcileTabs = useCallback\([\s\S]*?\}, \[initialCwd\]\);/.exec(src)?.[0];
    expect(reconcile, 'reconcileTabs was reshaped — re-point this guard').toBeDefined();
    // Removes exactly the closed sessions...
    expect(reconcile).toContain('const kept = prev.filter((t) => !t.sessionId || !closedSet.has(t.sessionId));');
    // ...never leaves an empty tab bar...
    // The seeded tab is named by the shared untitled-tab rule, not a literal —
    // what this guard cares about is that a tab IS seeded, so it pins the
    // branch rather than the name.
    expect(reconcile).toContain('kept.length === 0');
    expect(reconcile).toContain('untitledTabTitle(id, undefined, Date.now())');
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
    // NO ROW IS REFUSED any more either — the projectless one was the last, and
    // it is refused nowhere now (see recentSessionDelete.test.ts).
    const src = codeAgent('recentSessionDelete.ts');
    expect(src).not.toContain('running');
    expect(src).not.toContain('no-project');
  });

  it('a PROJECTLESS removal reaches every viewer, since it belongs to no project', () => {
    // The broadcast for one of these carries cwd '', which matches no project
    // iframe's own cwd — and it still has to close the tab holding it, because
    // such a session can be open in any project's tab. Reconciliation is by
    // session id, so applying it everywhere removes nothing it should not.
    expect(closedSessionIdsForViewer(
      { type: 'project-state-changed', cwd: '', closedSessionIds: ['s1'] },
      CWD,
    )).toEqual(['s1']);
    // A project's own removals still arrive as before...
    expect(closedSessionIdsForViewer(
      { type: 'project-state-changed', cwd: CWD, closedSessionIds: ['s1'] },
      CWD,
    )).toEqual(['s1']);
    // ...and another project's are still none of this viewer's business.
    expect(closedSessionIdsForViewer(
      { type: 'project-state-changed', cwd: '/other', closedSessionIds: ['s1'] },
      CWD,
    )).toEqual([]);
    // Anything else is not a removal at all.
    expect(closedSessionIdsForViewer({ type: 'task-fired', cwd: CWD }, CWD)).toEqual([]);
    expect(closedSessionIdsForViewer({ type: 'project-state-changed', cwd: CWD }, CWD)).toEqual([]);
    expect(closedSessionIdsForViewer(null, CWD)).toEqual([]);
  });
});
