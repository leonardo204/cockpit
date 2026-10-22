import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@cockpit/shared-i18n';
import { ProjectSidebar, type ProjectInfo } from './ProjectSidebar';
import {
  ProjectGroupHeader,
  ProjectGroupMenuView,
  type ProjectGroupHeaderProps,
} from './ProjectGroupHeader';
import { deleteGroup, renameGroup, reorderGroups, type ProjectGroup } from './projectGroups';

/**
 * Project groups in the sidebar (specs/project-groups.md §5).
 *
 * Rendered statically, like the other sidebar tests: the repo has no DOM
 * harness, so interaction is covered in three pieces — the markup for a given
 * state here, the state transitions in projectGroups.test.ts, and the wiring
 * between the two (which callback a menu item or a drop calls) as source
 * assertions below.
 */

const render = (node: ReactNode) =>
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
const noop = () => {};

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

const PROJECTS: ProjectInfo[] = [{ cwd: '/w/naby' }, { cwd: '/w/cockpit' }, { cwd: '/w/scratch' }];

const sidebar = (
  groups: ReadonlyArray<ProjectGroup> | undefined,
  over: { collapsed?: boolean; projects?: ProjectInfo[] } = {},
) =>
  render(
    <ProjectSidebar
      projects={over.projects ?? PROJECTS}
      activeIndex={0}
      collapsed={over.collapsed ?? false}
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

/** The project rows in document order, by their expand button's data-cwd. */
const rowCwds = (html: string) => [...html.matchAll(/data-testid="sidebar-project-expand" data-cwd="([^"]+)"/g)].map((m) => m[1]);
/** The cwds rendered inside one group's section: the indented rows that follow
 *  that group's header, before the next header or the first unindented row. */
const cwdsInGroup = (html: string, id: string) => {
  const tokens = [
    ...html.matchAll(
      /data-testid="sidebar-group-header" data-group-id="([^"]+)"|draggable="true" class="([^"]*)"><div class="flex items-center"><button data-testid="sidebar-project-expand" data-cwd="([^"]+)"/g,
    ),
  ];
  let current: string | null = null;
  const out: string[] = [];
  let found = false;
  for (const m of tokens) {
    if (m[1]) {
      current = m[1];
      if (current === id) found = true;
      continue;
    }
    if (!m[2].startsWith('ml-3 ')) current = null;
    if (current === id) out.push(m[3]);
  }
  return found ? out : null;
};

const CLIENT: ProjectGroup = { id: 'g_client', name: 'Client A', collapsed: false, cwds: ['/w/naby', '/w/cockpit'] };

describe('no groups — the sidebar is the flat list it always was (R6)', () => {
  it('renders the same markup for absent and empty groups, with no group chrome', () => {
    const absent = sidebar(undefined);
    expect(sidebar([])).toBe(absent);
    expect(absent).not.toContain('sidebar-group');
    expect(absent).not.toContain('sidebar-ungrouped-drop');
    expect(rowCwds(absent)).toEqual(['/w/naby', '/w/cockpit', '/w/scratch']);
    // The one addition: the `+` beside the "Projects" label (R1).
    expect(absent).toContain('data-testid="sidebar-new-group"');
  });

  it('the collapsed rail is unchanged too', () => {
    const html = sidebar([], { collapsed: true });
    expect(html).not.toContain('sidebar-group-divider');
    expect(html).not.toContain('sidebar-new-group');
  });
});

describe('with groups', () => {
  it('shows groups first, members indented in global order, then the ungrouped rest', () => {
    const html = sidebar([{ ...CLIENT, cwds: ['/w/cockpit', '/w/naby'] }]);
    expect(html).toContain('Client A');
    expect(html).toContain('(2)');
    expect(cwdsInGroup(html, 'g_client')).toEqual(['/w/naby', '/w/cockpit']);
    expect(rowCwds(html)).toEqual(['/w/naby', '/w/cockpit', '/w/scratch']);
    expect(html).toContain('data-testid="sidebar-ungrouped-drop"');
  });

  it('a collapsed group hides its members but keeps its header and count', () => {
    const html = sidebar([{ ...CLIENT, collapsed: true }]);
    expect(html).toContain('data-testid="sidebar-group-header"');
    expect(html).toContain('(2)');
    expect(rowCwds(html)).toEqual(['/w/scratch']);
    expect(html).toContain('aria-expanded="false"');
  });

  it('an empty group shows the drop hint', () => {
    const html = sidebar([{ id: 'g_e', name: 'Empty', collapsed: false, cwds: [] }]);
    expect(html).toContain('data-testid="sidebar-group-empty"');
    expect(html).toContain('Drag projects here');
    expect(html).toContain('(0)');
  });

  it('the collapsed rail lists icons flat in group order with a divider', () => {
    const html = sidebar([{ ...CLIENT, cwds: ['/w/scratch'] }], { collapsed: true });
    expect(html).not.toContain('sidebar-group-header');
    expect(html).toContain('data-testid="sidebar-group-divider"');
    // Group run first (scratch), then the ungrouped run. Rail rows carry the cwd
    // as their tooltip.
    const order = [...html.matchAll(/data-tooltip="([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(['scratch', 'naby', 'cockpit']);
  });

  it('groups render in the order of the groups array (R7)', () => {
    const groups: ProjectGroup[] = [
      { id: 'g_a', name: 'Alpha', collapsed: false, cwds: ['/w/naby'] },
      { id: 'g_b', name: 'Beta', collapsed: false, cwds: ['/w/scratch'] },
    ];
    const ids = (html: string) => [...html.matchAll(/data-testid="sidebar-group-header" data-group-id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids(sidebar(groups))).toEqual(['g_a', 'g_b']);
    const swapped = reorderGroups(groups, 'g_b', 'g_a', 'before');
    expect(ids(sidebar(swapped))).toEqual(['g_b', 'g_a']);
    // Reordering groups moves no project between them.
    expect(cwdsInGroup(sidebar(swapped), 'g_a')).toEqual(['/w/naby']);
  });
});

describe('header menu: rename and delete (R2, R3)', () => {
  const header = (over: Partial<ProjectGroupHeaderProps> = {}) =>
    render(
      <ProjectGroupHeader
        id="g_client"
        name="Client A"
        collapsed={false}
        count={2}
        hasUnread={false}
        menuOpen={false}
        editing={false}
        dropHint={null}
        isDragging={false}
        onToggle={noop}
        onSetMenu={noop}
        onStartRename={noop}
        onDelete={noop}
        onCommitName={noop}
        onCancelEdit={noop}
        onDragStart={noop}
        onDragOver={noop}
        onDrop={noop}
        onDragEnd={noop}
        {...over}
      />,
    );

  it('the menu offers rename and delete', () => {
    const html = render(<ProjectGroupMenuView onRename={noop} onDelete={noop} />);
    expect(html).toContain('data-testid="project-group-rename"');
    expect(html).toContain('>Rename<');
    expect(html).toContain('data-testid="project-group-delete"');
    expect(html).toContain('>Delete group<');
    // A fixed layer — never clipped by the scrolling list (shell CLAUDE.md).
    expect(html).toContain('class="fixed ');
  });

  it('rename mode swaps the name for an input holding it', () => {
    const html = header({ editing: true });
    expect(html).toContain('data-testid="sidebar-group-name-input"');
    expect(html).toContain('value="Client A"');
    expect(html).toContain('maxLength="60"');
    expect(html).not.toContain('sidebar-group-menu-button');
  });

  it('a renamed group shows its new name', () => {
    const html = sidebar(renameGroup([CLIENT], 'g_client', 'Client B'));
    expect(html).toContain('Client B');
    expect(html).not.toContain('Client A');
  });

  it('after delete the projects stay, ungrouped', () => {
    const html = sidebar(deleteGroup([CLIENT], 'g_client'));
    expect(html).not.toContain('data-testid="sidebar-group"');
    expect(rowCwds(html)).toEqual(['/w/naby', '/w/cockpit', '/w/scratch']);
  });

  it('folded with an unread member: a dot on the header', () => {
    expect(header({ collapsed: true, hasUnread: true })).toContain('sidebar-group-unread');
    expect(header({ collapsed: false, hasUnread: true })).not.toContain('sidebar-group-unread');
  });

  it('drop hints: into for a project, before/after for a group', () => {
    expect(header({ dropHint: 'into' })).toContain('ring-brand');
    expect(header({ dropHint: 'before' })).toContain('border-t-2 border-brand');
    expect(header({ dropHint: 'after' })).toContain('border-b-2 border-brand');
  });
});

describe('wiring (source assertions — jsdom-free)', () => {
  const header = readFileSync(join(__dirname, 'ProjectGroupHeader.tsx'), 'utf8');
  const side = readFileSync(join(__dirname, 'ProjectSidebar.tsx'), 'utf8');

  it('menu items call rename / delete for this group, and the menu is portaled', () => {
    expect(header).toMatch(/onRename=\{\(\) => \{\s*onSetMenu\(null\);\s*onStartRename\(id\);/);
    expect(header).toMatch(/onDelete=\{\(\) => \{\s*onSetMenu\(null\);\s*onDelete\(id\);/);
    expect(header).toContain('createPortal(');
    expect(side).toMatch(/handleDeleteGroup = useCallback\(\(id: string\) => \{\s*applyGroups\(deleteGroup\(/);
  });

  it('never asks for confirmation (no alert / confirm)', () => {
    for (const src of [header, side]) {
      expect(src).not.toMatch(/\b(window\.)?confirm\(/);
      expect(src).not.toMatch(/\balert\(/);
    }
  });

  it('a project row refuses a group drag before accepting the drop', () => {
    // The row's dragover returns WITHOUT preventDefault while a group is dragged,
    // so the row is not a drop target for it at all.
    expect(side).toMatch(/if \(dragGroupId !== null\) \{\s*setGroupDropHint\(null\);\s*return;\s*\}\s*e\.preventDefault\(\);/);
  });

  it('a header drop reorders for a group drag and joins for a project drag', () => {
    expect(side).toMatch(/if \(live\.dragGroupId !== null\) \{\s*applyGroups\(reorderGroups\(/);
    expect(side).toMatch(/else if \(live\.dragIndex !== null\) \{\s*applyProjectDrop\(\{ kind: 'group'/);
  });

  it('group header rows are memoized', () => {
    expect(header).toMatch(/export const ProjectGroupHeader = memo\(/);
  });
});
