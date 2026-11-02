import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@cockpit/shared-i18n';
import { ProjectSidebar, type ProjectInfo } from './ProjectSidebar';
import { ProjectItem, ProjectItemMenuView } from './ProjectItem';
import { ProjectGroupHeader } from './ProjectGroupHeader';
import {
  PROJECT_TITLE_MAX,
  customProjectTitle,
  folderNameOf,
  projectDisplayName,
  withProjectTitle,
} from './projectTitle';

/**
 * Project rename (specs/project-groups.md §8.5). Same three-way split as the
 * group tests: the name rules as pure functions, each state's markup by static
 * render, and the double-click / right-click wiring as source assertions — the
 * shell has no DOM harness.
 */

const render = (node: ReactNode) =>
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
const noop = () => {};

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('name rules (projectTitle.ts)', () => {
  it('the folder name is the last path segment, either separator', () => {
    expect(folderNameOf('/w/naby')).toBe('naby');
    expect(folderNameOf('/w/naby/')).toBe('naby');
    expect(folderNameOf('C:\\w\\naby')).toBe('naby');
  });

  it('a rename is a trimmed, capped name that is not the folder name', () => {
    expect(customProjectTitle('/w/naby', '  Client  ')).toBe('Client');
    expect(customProjectTitle('/w/naby', '')).toBeUndefined();
    expect(customProjectTitle('/w/naby', '   ')).toBeUndefined();
    expect(customProjectTitle('/w/naby', undefined)).toBeUndefined();
    expect(customProjectTitle('/w/naby', null)).toBeUndefined();
    expect(customProjectTitle('/w/naby', ' naby ')).toBeUndefined();
    expect(customProjectTitle('/w/naby', 'y'.repeat(200))).toBe('y'.repeat(PROJECT_TITLE_MAX));
    expect(PROJECT_TITLE_MAX).toBe(80);
  });

  it('the display name is the rename, else the folder name', () => {
    expect(projectDisplayName({ cwd: '/w/naby', title: 'Client' })).toBe('Client');
    expect(projectDisplayName({ cwd: '/w/naby' })).toBe('naby');
    expect(projectDisplayName({ cwd: '/w/naby', title: 'naby' })).toBe('naby');
  });

  it('withProjectTitle sets, clears, and returns the same list when unchanged', () => {
    const list: ProjectInfo[] = [{ cwd: '/w/a', lastOpenedAt: 1 }, { cwd: '/w/b' }];
    const renamed = withProjectTitle(list, '/w/a', ' Alpha ');
    expect(renamed).toEqual([{ cwd: '/w/a', lastOpenedAt: 1, title: 'Alpha' }, { cwd: '/w/b' }]);
    expect(renamed[1]).toBe(list[1]);

    expect(withProjectTitle(renamed, '/w/a', 'Alpha')).toBe(renamed);
    expect(withProjectTitle(list, '/w/a', 'a')).toBe(list);
    expect(withProjectTitle(list, '/w/nowhere', 'X')).toBe(list);

    // Empty and folder-name both clear the field entirely.
    expect(withProjectTitle(renamed, '/w/a', '')[0]).toEqual({ cwd: '/w/a', lastOpenedAt: 1 });
    expect(withProjectTitle(renamed, '/w/a', 'a')[0]).not.toHaveProperty('title');
  });
});

describe('row states', () => {
  const item = (over: Partial<Parameters<typeof ProjectItem>[0]> = {}) =>
    render(
      <ProjectItem
        index={0}
        name="Client"
        cwd="/w/naby"
        isActive={false}
        collapsed={false}
        onClick={noop}
        onRemove={noop}
        onOpenNote={noop}
        onStartRename={noop}
        {...over}
      />,
    );

  it('editing swaps the name for an 80-char input holding it', () => {
    const html = item({ editing: true });
    expect(html).toContain('data-testid="sidebar-project-name-input"');
    expect(html).toContain('value="Client"');
    expect(html).toContain('maxLength="80"');
    expect(html).toContain('placeholder="Project name (empty for folder name)"');
    expect(html).not.toContain('data-testid="sidebar-project-name"');
  });

  it('not editing shows the name', () => {
    const html = item();
    expect(html).toContain('data-testid="sidebar-project-name"');
    expect(html).toContain('>Client<');
    expect(html).not.toContain('sidebar-project-name-input');
  });

  it('the group name input keeps its own limit', () => {
    const html = render(
      <ProjectGroupHeader
        id="g"
        name="G"
        collapsed={false}
        count={0}
        hasUnread={false}
        menuOpen={false}
        editing
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
      />,
    );
    expect(html).toContain('maxLength="60"');
  });
});

describe('right-click menu', () => {
  const menu = (renamed: boolean, withNote = true) =>
    render(
      <ProjectItemMenuView
        renamed={renamed}
        onRename={noop}
        onResetName={noop}
        onOpenNote={withNote ? noop : undefined}
        onClose={noop}
      />,
    );
  const items = (html: string) => [...html.matchAll(/data-testid="(project-item-[a-z-]+)"/g)].map((m) => m[1]);

  it('a renamed project offers rename, folder name, notes, close — in that order', () => {
    const html = menu(true);
    expect(items(html)).toEqual([
      'project-item-menu',
      'project-item-rename',
      'project-item-reset-name',
      'project-item-notes',
      'project-item-close',
    ]);
    expect(html).toContain('>Rename<');
    expect(html).toContain('>Use folder name<');
    expect(html).toContain('>Project Notes<');
    expect(html).toContain('>Close project<');
    expect(html).toContain('class="fixed ');
  });

  it('"Use folder name" only when there is a rename', () => {
    expect(menu(false)).not.toContain('project-item-reset-name');
    expect(items(menu(false, false))).toEqual(['project-item-menu', 'project-item-rename', 'project-item-close']);
  });

  it('Korean labels', async () => {
    await i18n.changeLanguage('ko');
    try {
      const html = menu(true);
      expect(html).toContain('>이름 변경<');
      expect(html).toContain('>원래 이름으로<');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

describe('sidebar names', () => {
  const PROJECTS: ProjectInfo[] = [{ cwd: '/w/naby', title: 'Persona app' }, { cwd: '/w/cockpit' }];
  const sidebar = (collapsed: boolean) =>
    render(
      <ProjectSidebar
        projects={PROJECTS}
        activeIndex={0}
        collapsed={collapsed}
        width={224}
        onRenameProject={noop}
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

  it('expanded rows show the rename; the tooltip keeps the full path (R8.4)', () => {
    const html = sidebar(false);
    expect(html).toContain('>Persona app<');
    expect(html).toContain('>cockpit<');
    expect(html).not.toContain('>naby<');
    const tips = [...html.matchAll(/data-tooltip="([^"]+)"/g)].map((m) => m[1]);
    expect(tips).toEqual(['/w/naby', '/w/cockpit']);
  });

  it('the collapsed rail tooltip shows the rename', () => {
    const tips = [...sidebar(true).matchAll(/data-tooltip="([^"]+)"/g)].map((m) => m[1]);
    expect(tips).toEqual(['Persona app', 'cockpit']);
  });
});

describe('wiring (source assertions — jsdom-free)', () => {
  const itemSrc = readFileSync(join(__dirname, 'ProjectItem.tsx'), 'utf8');
  const side = readFileSync(join(__dirname, 'ProjectSidebar.tsx'), 'utf8');
  const ws = readFileSync(join(__dirname, 'Workspace.tsx'), 'utf8');
  const header = readFileSync(join(__dirname, 'ProjectGroupHeader.tsx'), 'utf8');
  const client = readFileSync(join(__dirname, 'effect', 'projectClient.ts'), 'utf8');

  it('double-clicking the name starts a rename', () => {
    expect(itemSrc).toMatch(/onDoubleClick=\{\(e\) => \{\s*if \(!canRename\) return;\s*e\.stopPropagation\(\);\s*onStartRename\?\.\(\);/);
  });

  it('right-click opens the menu at the pointer; its items call the right callbacks', () => {
    expect(itemSrc).toMatch(/onContextMenu=\{\(e\) => \{\s*if \(!canRename \|\| editing\) return;\s*e\.preventDefault\(\);/);
    expect(itemSrc).toContain('setMenuAt({ x: e.clientX, y: e.clientY });');
    expect(itemSrc).toMatch(/onRename=\{\(\) => \{\s*setMenuAt\(null\);\s*onStartRename\?\.\(\);/);
    expect(itemSrc).toMatch(/onResetName=\{\(\) => \{\s*setMenuAt\(null\);\s*onResetName\?\.\(\);/);
    expect(itemSrc).toMatch(/onClose=\{\(\) => \{\s*setMenuAt\(null\);\s*onRemove\(\);/);
    expect(itemSrc).toContain('createPortal(');
    // A click inside the portaled menu must not bubble to the row's select.
    expect(itemSrc).toMatch(/onClick=\{\(e\) => e\.stopPropagation\(\)\}\s*onContextMenu/);
  });

  it('the input commits empty as a reset, and the group input still cancels on empty', () => {
    expect(itemSrc).toMatch(/maxLength=\{PROJECT_TITLE_MAX\}\s*allowEmpty/);
    expect(header).toContain('if (commit && (name || allowEmpty)) onCommit(name);');
    expect(header).toContain('allowEmpty = false,');
  });

  it('the sidebar passes renames up, reset as an empty title', () => {
    expect(side).toContain("onResetName={() => onRenameProject?.(project.cwd, '')}");
    expect(side).toMatch(/const commitProjectName = \(cwd: string, title: string\) => \{\s*setEditingProjectCwd\(null\);\s*onRenameProject\?\.\(cwd, title\);/);
    expect(side).toContain('draggable={!editingName}');
  });

  it('Workspace updates state first, then saves the one field', () => {
    expect(ws).toMatch(/const next = withProjectTitle\(projects, cwd, title\);\s*if \(next === projects\) return;\s*setProjects\(next\);/);
    expect(ws).toContain('saveProjectTitleEffect(cwd, ');
    expect(ws).toContain('onRenameProject={handleRenameProject}');
    expect(client).toContain('savePref({ rename: { cwd, title } }, "project name")');
  });
});
