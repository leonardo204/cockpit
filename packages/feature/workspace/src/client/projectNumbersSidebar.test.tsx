import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@cockpit/shared-i18n';
import { ProjectSidebar, type ProjectInfo } from './ProjectSidebar';
import { ProjectSessionRow } from './ProjectSessionRow';
import type { ProjectGroup } from './projectGroups';

/**
 * The numbers in front of each project (specs/project-groups.md §9): 1.. in
 * each section, the same with a group folded and on the 48px rail, while the
 * row keeps its global index for select / remove / drag (R34).
 */

const render = (node: ReactNode) => renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
const noop = () => {};

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

// Global order interleaves the sections, so index + 1 would read 2, 4, 6.
const PROJECTS: ProjectInfo[] = [
  { cwd: '/w/u1' },
  { cwd: '/w/server' },
  { cwd: '/w/u2' },
  { cwd: '/w/client' },
  { cwd: '/w/u3' },
  { cwd: '/w/dt' },
];
const GROUPS: ProjectGroup[] = [{ id: 'g_rms', name: 'RMS', collapsed: false, cwds: ['/w/dt', '/w/server', '/w/client'] }];

const sidebar = (groups: ReadonlyArray<ProjectGroup>, collapsed = false) =>
  render(
    <ProjectSidebar
      projects={PROJECTS}
      activeIndex={0}
      collapsed={collapsed}
      width={224}
      groups={groups}
      onChangeGroups={noop}
      onSelectProject={noop}
      onRemoveProject={noop}
      onReorderProjects={noop}
      onToggleCollapse={noop}
      onOpenSessionBrowser={noop}
      onBrowseAllSessions={noop}
      onOpenSettings={noop}
      onOpenNote={noop}
      onSwitchProject={noop}
      onAddProject={noop}
    />,
  );

/** Each row's number, in document order: the NumberIcon's text, keyed by the
 *  row's tooltip (the cwd on the expanded list, the name on the rail). */
const numbersOf = (html: string) =>
  [...html.matchAll(/data-tooltip="([^"]+)".*?<text[^>]*>(\d+)<\/text>/g)].map((m) => `${m[1]}=${m[2]}`);

describe('sidebar numbers restart in each section (R30)', () => {
  it('a group shows 1, 2, 3 and the ungrouped area starts again at 1', () => {
    expect(numbersOf(sidebar(GROUPS))).toEqual([
      '/w/server=1',
      '/w/client=2',
      '/w/dt=3',
      '/w/u1=1',
      '/w/u2=2',
      '/w/u3=3',
    ]);
  });

  it('with no groups the numbers are the list positions, as before', () => {
    expect(numbersOf(sidebar([]))).toEqual(PROJECTS.map((p, i) => `${p.cwd}=${i + 1}`));
  });

  it('the 48px rail shows the same numbers (R31)', () => {
    expect(numbersOf(sidebar(GROUPS, true))).toEqual(['server=1', 'client=2', 'dt=3', 'u1=1', 'u2=2', 'u3=3']);
  });

  it('a folded group hides its rows; the others keep their numbers (R31)', () => {
    const html = sidebar([{ ...GROUPS[0]!, collapsed: true }]);
    expect(numbersOf(html)).toEqual(['/w/u1=1', '/w/u2=2', '/w/u3=3']);
  });
});

describe('only the shown number changes (R33, R34)', () => {
  const src = readFileSync(join(__dirname, 'ProjectSidebar.tsx'), 'utf8');
  it('numbers come from the shared projectNumbers; select / remove keep the global index', () => {
    expect(src).toContain('projectNumbers(projects, groups)');
    expect(src).toMatch(/index=\{index\}\s*number=\{numbers\.get\(project\.cwd\)\?\.number \?\? index \+ 1\}/);
    expect(src).toContain('onClick={() => onSelectProject(index)}');
    expect(src).toContain('onRemove={() => onRemoveProject(index)}');
  });

  it('the feature-workspace helpers are the shared ones, not a copy', async () => {
    const local = await import('./projectGroups');
    const shared = await import('@cockpit/shared-utils');
    expect(local.projectNumbers).toBe(shared.projectNumbers);
    expect(local.buildSidebarModel).toBe(shared.buildSidebarModel);
  });
});

describe('a session row shows when a turn runs there (cross-project-context R7d)', () => {
  it('draws the running dot only while running', () => {
    const row = (isRunning: boolean) =>
      render(<ProjectSessionRow cwd="/w/server" sessionId="s1" title="Fix the API" isRunning={isRunning} onSelect={noop} onDelete={noop} />);
    expect(row(true)).toContain('data-testid="sidebar-session-running"');
    expect(row(false)).not.toContain('data-testid="sidebar-session-running"');
  });
});
