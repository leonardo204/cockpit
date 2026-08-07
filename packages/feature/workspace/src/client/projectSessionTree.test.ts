import { describe, it, expect, afterEach, vi } from 'vitest';
import { Effect } from 'effect';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COLLAPSED_PROJECT_STATE,
  deleteSession,
  encodeProjectPath,
  loadProjectSessions,
  projectStateAt,
  projectStateChangedCwd,
  sessionIdOf,
  shouldRefetch,
  withExpanded,
  withLoadError,
  withLoading,
  withSessions,
  withoutSession,
  type ProjectSessionTree,
  type SidebarSessionInfo,
} from './projectSessionTree';

/**
 * The sidebar project TREE — projects unfold into their own sessions, and each
 * session row carries a delete ×.
 *
 * Two halves, for the same reason the neighbouring guards split that way. The
 * state machine and both IO effects are real units and are exercised as such
 * (a stubbed `fetch` proves the exact wire call, which is the part that has to
 * match the server contract). The rendering is asserted against the source:
 * this repo has no jsdom or testing-library, and the properties that matter
 * here — an indented list nested inside the scroller, a hover-revealed × — are
 * layout, which jsdom could not judge even if it were installed.
 */

const CLIENT = __dirname;
const read = (name: string) => readFileSync(join(CLIENT, name), 'utf8');

const session = (path: string, title: string): SidebarSessionInfo => ({
  path,
  title,
  modifiedAt: '2026-01-01T00:00:00.000Z',
});

const CWD = '/Users/me/work/naby';

describe('project tree state', () => {
  it('encodes a cwd the way the sessions route matches it', () => {
    // Must agree with encodePath in shared-utils (/ and . both become -),
    // because the server re-encodes every known cwd to find the project.
    expect(encodeProjectPath('/Users/me/work/naby')).toBe('-Users-me-work-naby');
    expect(encodeProjectPath('/Users/me/.config/app')).toBe('-Users-me--config-app');
  });

  it('reads a bare sessionId, and still strips a legacy .jsonl path', () => {
    expect(sessionIdOf(session('abc-123', 'Hi'))).toBe('abc-123');
    expect(sessionIdOf(session('/projects/p/abc-123.jsonl', 'Hi'))).toBe('abc-123');
  });

  it('an unknown project reads as collapsed instead of undefined', () => {
    expect(projectStateAt({}, CWD)).toEqual(COLLAPSED_PROJECT_STATE);
    expect(projectStateAt({}, CWD).isExpanded).toBe(false);
  });

  it('expanding loads, and the loaded sessions land on that branch', () => {
    let tree: ProjectSessionTree = {};
    tree = withLoading(tree, CWD);
    expect(tree[CWD].isExpanded).toBe(true);
    expect(tree[CWD].isLoading).toBe(true);

    tree = withSessions(tree, CWD, [session('s1', 'First'), session('s2', 'Second')]);
    expect(tree[CWD].isLoading).toBe(false);
    expect(tree[CWD].sessions.map((s) => s.title)).toEqual(['First', 'Second']);
    expect(tree[CWD].isExpanded).toBe(true);
  });

  it('collapsing keeps the loaded sessions so re-expanding does not flicker', () => {
    let tree = withSessions(withLoading({}, CWD), CWD, [session('s1', 'First')]);
    tree = withExpanded(tree, CWD, false);
    expect(tree[CWD].isExpanded).toBe(false);
    expect(tree[CWD].sessions).toHaveLength(1);
  });

  it('a failed load clears loading and records the error', () => {
    const tree = withLoadError(withLoading({}, CWD), CWD, 'load-failed');
    expect(tree[CWD].isLoading).toBe(false);
    expect(tree[CWD].error).toBe('load-failed');
  });

  it('withoutSession removes exactly the deleted row', () => {
    const tree = withSessions(withLoading({}, CWD), CWD, [
      session('s1', 'First'),
      session('s2', 'Second'),
    ]);
    const after = withoutSession(tree, CWD, 's1');
    expect(after[CWD].sessions.map(sessionIdOf)).toEqual(['s2']);
    // Other branches are untouched, and a no-op keeps the same reference so a
    // memo'd row is not re-rendered for nothing.
    expect(withoutSession(after, CWD, 'gone')).toBe(after);
    expect(withoutSession({}, CWD, 's1')).toEqual({});
  });

  it('recognises the project-state-changed push and ignores everything else', () => {
    expect(projectStateChangedCwd({ type: 'project-state-changed', cwd: CWD })).toBe(CWD);
    expect(projectStateChangedCwd({ type: 'task-fired' })).toBeNull();
    expect(projectStateChangedCwd({ type: 'project-state-changed' })).toBeNull();
    expect(projectStateChangedCwd(null)).toBeNull();
    expect(projectStateChangedCwd('project-state-changed')).toBeNull();
  });

  it('only an expanded branch costs a refetch', () => {
    const tree = withSessions(withLoading({}, CWD), CWD, []);
    expect(shouldRefetch(tree, CWD)).toBe(true);
    expect(shouldRefetch(withExpanded(tree, CWD, false), CWD)).toBe(false);
    expect(shouldRefetch({}, CWD)).toBe(false);
  });
});

describe('project tree IO', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('expanding a project fetches that project sessions by encoded path', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => [session('s1', 'First'), session('s2', 'Second')],
      };
    });

    const sessions = await Effect.runPromise(loadProjectSessions(CWD));
    expect(calls).toEqual([
      `/api/sessions/projects/${encodeURIComponent('-Users-me-work-naby')}`,
    ]);
    expect(sessions.map(sessionIdOf)).toEqual(['s1', 's2']);
  });

  it('deleting a session posts closedSessionIds for exactly that session', async () => {
    const posts: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      posts.push({ url, init });
      return { ok: true, status: 200, json: async () => ({}) };
    });

    await Effect.runPromise(deleteSession(CWD, 's1'));

    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('/api/project-state');
    expect(posts[0].init.method).toBe('POST');
    const body = JSON.parse(String(posts[0].init.body));
    // closedSessionIds is the endpoint's ONLY removal channel; `sessions: []`
    // rides along harmlessly because saves are union-add.
    expect(body).toEqual({ cwd: CWD, sessions: [], closedSessionIds: ['s1'] });
  });

  it('a failed delete fails the effect, so the row is not removed optimistically', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const exit = await Effect.runPromiseExit(deleteSession(CWD, 's1'));
    expect(exit._tag).toBe('Failure');
  });
});

describe('sidebar tree — wiring', () => {
  it('each project row carries an expand chevron that only toggles the branch', () => {
    const src = read('ProjectSidebar.tsx');
    const chevron = /<button\s+data-testid="sidebar-project-expand"[\s\S]*?<\/button>/.exec(src)?.[0];
    expect(chevron, 'the expand chevron was renamed — re-point this guard').toBeDefined();
    expect(chevron).toContain('aria-expanded={branch.isExpanded}');
    expect(chevron).toContain('rotate-90');
    // Unfolding must never also switch project: the chevron is its own control
    // and swallows the click before ProjectItem's row handler sees it.
    expect(chevron).toContain('e.stopPropagation()');
    expect(chevron).toContain('handleToggleProject(project.cwd)');
  });

  it('expanding refetches rather than trusting a cached list', () => {
    const src = read('ProjectSidebar.tsx');
    const toggle = /const handleToggleProject = useCallback[\s\S]*?\n  \}, \[\]\);/.exec(src)?.[0];
    expect(toggle, 'handleToggleProject was reshaped — re-point this guard').toBeDefined();
    expect(toggle).toContain('withExpanded(prev, cwd, false)');
    expect(toggle).toContain('refreshProjectSessionsRef.current(cwd)');
  });

  it('the active project starts expanded, once, without fighting a collapse', () => {
    const src = read('ProjectSidebar.tsx');
    expect(src).toContain('const activeCwd = projects[activeIndex]?.cwd;');
    const effect = /autoExpandedRef[\s\S]*?\}, \[activeCwd, collapsed\]\);/.exec(src)?.[0];
    expect(effect, 'the auto-expand effect was reshaped — re-point this guard').toBeDefined();
    expect(effect).toContain('if (autoExpandedRef.current.has(activeCwd)) return;');
    expect(effect).toContain('refreshProjectSessionsRef.current(activeCwd)');
  });

  it('clicking a session switches to it via onSwitchProject(cwd, sessionId)', () => {
    const src = read('ProjectSidebar.tsx');
    // The row calls onSelect(cwd, sessionId); the sidebar forwards that to the
    // prop through a ref, so the callback identity never churns.
    expect(src).toContain('handleSwitchProjectRef.current(cwd, sessionId)');
    expect(src).toMatch(/<ProjectSessionRow[\s\S]{0,400}onSelect=\{handleSelectSession\}/);
    const row = read('ProjectSessionRow.tsx');
    expect(row).toContain('onClick={() => onSelect(cwd, sessionId)}');
  });

  it('the × deletes through saveProjectState and drops the row optimistically', () => {
    const src = read('ProjectSidebar.tsx');
    const handler = /const handleDeleteSession = useCallback[\s\S]*?\n  \}, \[\]\);/.exec(src)?.[0];
    expect(handler, 'handleDeleteSession was reshaped — re-point this guard').toBeDefined();
    expect(handler).toContain('deleteSession(cwd, sessionId)');
    expect(handler).toContain("exit._tag === 'Success'");
    expect(handler).toContain('withoutSession(prev, cwd, sessionId)');
    expect(src).toMatch(/<ProjectSessionRow[\s\S]{0,400}onDelete=\{handleDeleteSession\}/);

    const row = read('ProjectSessionRow.tsx');
    const button = /<button\s+data-testid="sidebar-session-delete"[\s\S]*?<\/button>/.exec(row)?.[0];
    expect(button, 'the delete button was renamed — re-point this guard').toBeDefined();
    // Same × as the tab close and the project close: same glyph, same red hover.
    expect(button).toContain('hover:bg-red-500/20');
    expect(button).toContain('hover:text-red-500');
    expect(button).toContain('M6 18L18 6M6 6l12 12');
    // Never also opens the session it is deleting.
    expect(button).toContain('e.stopPropagation()');
    // Hover-revealed, but reachable by keyboard and always shown on touch.
    expect(button).toContain('opacity-0 group-hover:opacity-100');
    expect(button).toContain('[@media(hover:none)]:opacity-100');
    // No confirmation: closing a tab already deletes the session this way.
    expect(row).not.toContain('confirm(');
  });

  it('the row is memo`d and fed stable callbacks', () => {
    const row = read('ProjectSessionRow.tsx');
    expect(row).toContain('export const ProjectSessionRow = memo(');
    const src = read('ProjectSidebar.tsx');
    // Both handlers close over refs only, so their identity survives every
    // global-state push — otherwise the memo above buys nothing.
    expect(src).toMatch(/const handleSelectSession = useCallback\([\s\S]*?\}, \[\]\);/);
    expect(src).toMatch(/const handleDeleteSession = useCallback\([\s\S]*?\}, \[\]\);/);
  });

  it('the collapsed rail renders no session rows', () => {
    const src = read('ProjectSidebar.tsx');
    expect(src).toContain('const showBranch = !collapsed && branch.isExpanded;');
    // The branch — chevron included — is gated on that flag, so 48px mode stays
    // an icon strip.
    expect(src).toContain('{showBranch && (');
    expect(src).toMatch(/\{!collapsed && \(\s*<button\s+data-testid="sidebar-project-expand"/);
  });

  it('a project-state-changed push refetches the expanded branch', () => {
    const src = read('ProjectSidebar.tsx');
    const handler =
      /const handleGlobalStateMessage = useCallback[\s\S]*?\n  \}, \[\]\);/.exec(src)?.[0];
    expect(handler, 'the global-state handler was reshaped — re-point this guard').toBeDefined();
    expect(handler).toContain('projectStateChangedCwd(msg)');
    expect(handler).toContain('shouldRefetch(sessionTreeRef.current, changedCwd)');
    expect(handler).toContain('refreshProjectSessionsRef.current(changedCwd)');
    // Still one stable listener over the shared per-URL connection.
    expect(src).toMatch(/useWebSocket\(\{\s*url: '\/ws\/global-state',\s*onMessage: handleGlobalStateMessage,/);
  });

  it('the tree nests inside the scroller, never behind a new clipping root', () => {
    // Companion to sidebarPopoverClipping.test.ts: the session rows were added
    // under the existing `flex-1 overflow-y-auto` list, not by wrapping the
    // panel in something that would erase the three bottom popovers.
    const src = read('ProjectSidebar.tsx');
    expect(src).toContain('<div className="flex-1 overflow-y-auto p-2 space-y-1">');
    const rootClass = /className=\{`h-full bg-card flex flex-col[^`]*`/.exec(src)?.[0];
    expect(rootClass).not.toContain('overflow-hidden');
  });

  it('the delete tooltip is translated in both shipped locales', () => {
    const row = read('ProjectSessionRow.tsx');
    expect(row).toContain("t('sessions.deleteSession')");
    const locales = join(CLIENT, '..', '..', '..', '..', 'shared', 'i18n', 'locales');
    const en = JSON.parse(readFileSync(join(locales, 'en.json'), 'utf8'));
    const ko = JSON.parse(readFileSync(join(locales, 'ko.json'), 'utf8'));
    expect(en.sessions.deleteSession).toBe('Delete session');
    expect(ko.sessions.deleteSession).toBe('세션 삭제');
  });
});
