import { describe, it, expect } from 'vitest';
import {
  PROJECT_GROUP_NAME_MAX,
  assignProject,
  buildSidebarModel,
  cleanGroupName,
  createGroup,
  deleteGroup,
  groupIdOf,
  moveProject,
  newGroupId,
  normalizeGroups,
  parseStoredGroups,
  renameGroup,
  reorderGroups,
  serializeGroups,
  toggleGroupCollapsed,
  type ProjectGroup,
} from './projectGroups';

/**
 * The pure half of project groups (specs/project-groups.md §3, §5): what a valid
 * stored group set is, the edits, a project drop, a group reorder, and the
 * display model whose indices must still be indices into `projects`.
 */

const g = (id: string, cwds: string[], over: Partial<ProjectGroup> = {}): ProjectGroup => ({
  id,
  name: id.toUpperCase(),
  collapsed: false,
  cwds,
  ...over,
});
const P = (...cwds: string[]) => cwds.map((cwd) => ({ cwd }));
const cwdsOf = (ps: ReadonlyArray<{ cwd: string }>) => ps.map((p) => p.cwd);

describe('normalizeGroups', () => {
  it('drops members that are not in the project list', () => {
    expect(normalizeGroups([g('a', ['/x', '/gone'])], ['/x'])).toEqual([g('a', ['/x'])]);
  });

  it('keeps a cwd only in the first group that claims it', () => {
    const out = normalizeGroups([g('a', ['/x', '/y']), g('b', ['/y', '/z'])], ['/x', '/y', '/z']);
    expect(out.map((x) => x.cwds)).toEqual([['/x', '/y'], ['/z']]);
  });

  it('trims names, cuts them to 60 chars and drops empty ones', () => {
    const long = 'n'.repeat(100);
    const out = normalizeGroups([
      { id: 'a', name: `  ${long}  `, cwds: [] },
      { id: 'b', name: '   ', cwds: [] },
      { id: 'c', name: '  Client A ', cwds: [] },
    ]);
    expect(out.map((x) => x.id)).toEqual(['a', 'c']);
    expect(out[0].name).toHaveLength(PROJECT_GROUP_NAME_MAX);
    expect(out[1].name).toBe('Client A');
  });

  it('accepts the stored envelope and a bare array alike', () => {
    expect(normalizeGroups({ groups: [g('a', [])] })).toEqual([g('a', [])]);
    expect(normalizeGroups([g('a', [])])).toEqual([g('a', [])]);
  });

  it('reads garbage as no groups, never throws', () => {
    for (const bad of [null, undefined, 42, 'x', {}, { groups: 'no' }, [null, 1, 'x', { name: 'no id' }]]) {
      expect(normalizeGroups(bad)).toEqual([]);
    }
  });

  it('drops duplicate ids and coerces collapsed / bad members', () => {
    const out = normalizeGroups([
      { id: 'a', name: 'A', collapsed: 'yes', cwds: ['/x', 3, '', null] },
      { id: 'a', name: 'dup', cwds: [] },
    ]);
    expect(out).toEqual([{ id: 'a', name: 'A', collapsed: false, cwds: ['/x'] }]);
  });
});

describe('parseStoredGroups / serializeGroups', () => {
  it('round-trips', () => {
    const groups = [g('a', ['/x'], { collapsed: true })];
    expect(parseStoredGroups(serializeGroups(groups), ['/x'])).toEqual(groups);
    expect(JSON.parse(serializeGroups(groups))).toEqual({ groups });
  });

  it('reads broken JSON and absent values as no groups', () => {
    expect(parseStoredGroups('{not json')).toEqual([]);
    expect(parseStoredGroups(undefined)).toEqual([]);
    expect(parseStoredGroups('')).toEqual([]);
  });
});

describe('edits', () => {
  it('creates an expanded empty group at the end; an empty name is a no-op', () => {
    const before = [g('a', [])];
    const after = createGroup(before, '  New  ', 'g_new');
    expect(after).toEqual([g('a', []), { id: 'g_new', name: 'New', collapsed: false, cwds: [] }]);
    expect(createGroup(before, '   ')).toBe(before);
  });

  it('generates ids that do not collide', () => {
    const id = newGroupId([g('a', [])]);
    expect(id).toMatch(/^g_[0-9a-z]{8}$/);
    expect(cleanGroupName(` ${'x'.repeat(70)} `)).toHaveLength(60);
  });

  it('renames; an empty or unchanged name keeps the same array', () => {
    const before = [g('a', []), g('b', [])];
    expect(renameGroup(before, 'b', ' Bee ')[1].name).toBe('Bee');
    expect(renameGroup(before, 'b', '  ')).toBe(before);
    expect(renameGroup(before, 'b', 'B')).toBe(before);
    expect(renameGroup(before, 'zz', 'x')).toBe(before);
  });

  it('deletes the group only — its projects become ungrouped', () => {
    const before = [g('a', ['/x']), g('b', ['/y'])];
    const after = deleteGroup(before, 'a');
    expect(after).toEqual([g('b', ['/y'])]);
    expect(groupIdOf(after, '/x')).toBeNull();
    expect(deleteGroup(before, 'zz')).toBe(before);
  });

  it('toggles collapsed', () => {
    expect(toggleGroupCollapsed([g('a', [])], 'a')[0].collapsed).toBe(true);
  });

  it('assigns a project to at most one group', () => {
    const before = [g('a', ['/x']), g('b', [])];
    const after = assignProject(before, '/x', 'b');
    expect(after.map((x) => x.cwds)).toEqual([[], ['/x']]);
    expect(assignProject(after, '/x', null).map((x) => x.cwds)).toEqual([[], []]);
    expect(assignProject(before, '/x', 'a')).toBe(before);
  });
});

describe('reorderGroups (R7)', () => {
  const abc = [g('a', []), g('b', []), g('c', [])];
  const ids = (gs: ReadonlyArray<ProjectGroup>) => gs.map((x) => x.id);

  it('moves a group before or after another', () => {
    expect(ids(reorderGroups(abc, 'c', 'a', 'before'))).toEqual(['c', 'a', 'b']);
    expect(ids(reorderGroups(abc, 'a', 'c', 'after'))).toEqual(['b', 'c', 'a']);
    expect(ids(reorderGroups(abc, 'a', 'b', 'after'))).toEqual(['b', 'a', 'c']);
  });

  it('is a no-op (same array) onto itself, its own slot, or an unknown id', () => {
    expect(reorderGroups(abc, 'a', 'a', 'before')).toBe(abc);
    expect(reorderGroups(abc, 'a', 'b', 'before')).toBe(abc);
    expect(reorderGroups(abc, 'b', 'a', 'after')).toBe(abc);
    expect(reorderGroups(abc, 'zz', 'a', 'before')).toBe(abc);
  });

  it('never touches membership', () => {
    const withMembers = [g('a', ['/x']), g('b', ['/y'])];
    const out = reorderGroups(withMembers, 'b', 'a', 'before');
    expect(out.map((x) => [x.id, x.cwds])).toEqual([['b', ['/y']], ['a', ['/x']]]);
  });
});

describe('moveProject', () => {
  it('without groups is exactly the old splice reorder', () => {
    const projects = P('/a', '/b', '/c', '/d');
    const groups: ProjectGroup[] = [];
    // The pre-groups handleDrop: remove at `from`, insert at the target index.
    const expected = (from: number, to: number) => {
      const next = [...projects];
      const [m] = next.splice(from, 1);
      next.splice(to, 0, m);
      return cwdsOf(next);
    };
    for (const [from, to] of [[0, 2], [3, 0], [1, 3]]) {
      const r = moveProject(projects, groups, from, { kind: 'project', index: to });
      expect(cwdsOf(r.projects)).toEqual(expected(from, to));
      expect(r.groups).toBe(groups);
    }
  });

  it('reorders inside one group without touching membership', () => {
    const projects = P('/a', '/b', '/c');
    const groups = [g('G', ['/a', '/c'])];
    const r = moveProject(projects, groups, 2, { kind: 'project', index: 0 });
    expect(cwdsOf(r.projects)).toEqual(['/c', '/a', '/b']);
    expect(r.groups).toBe(groups);
  });

  it('dropped on a row of another group: joins it, lands right before that row', () => {
    const projects = P('/a', '/b', '/c', '/d');
    const groups = [g('G', ['/c', '/d'])];
    const r = moveProject(projects, groups, 0, { kind: 'project', index: 3 });
    expect(cwdsOf(r.projects)).toEqual(['/b', '/c', '/a', '/d']);
    expect(groupIdOf(r.groups, '/a')).toBe('G');
  });

  it('dropped on an ungrouped row: leaves its group', () => {
    const projects = P('/a', '/b', '/c');
    const groups = [g('G', ['/a'])];
    const r = moveProject(projects, groups, 0, { kind: 'project', index: 2 });
    expect(cwdsOf(r.projects)).toEqual(['/b', '/a', '/c']);
    expect(groupIdOf(r.groups, '/a')).toBeNull();
  });

  it('dropped on a group header: joins, placed after the last member', () => {
    const projects = P('/a', '/b', '/c', '/d');
    const groups = [g('G', ['/b', '/c'])];
    const r = moveProject(projects, groups, 3, { kind: 'group', groupId: 'G' });
    expect(cwdsOf(r.projects)).toEqual(['/a', '/b', '/c', '/d']);
    expect(r.projects).toBe(projects); // already in place
    expect(groupIdOf(r.groups, '/d')).toBe('G');

    const r2 = moveProject(projects, groups, 0, { kind: 'group', groupId: 'G' });
    expect(cwdsOf(r2.projects)).toEqual(['/b', '/c', '/a', '/d']);
  });

  it('dropped on an empty group: joins, order unchanged', () => {
    const projects = P('/a', '/b');
    const groups = [g('E', [])];
    const r = moveProject(projects, groups, 1, { kind: 'group', groupId: 'E' });
    expect(r.projects).toBe(projects);
    expect(r.groups[0].cwds).toEqual(['/b']);
  });

  it('dropped on its own group header: nothing changes', () => {
    const projects = P('/a', '/b');
    const groups = [g('G', ['/a'])];
    const r = moveProject(projects, groups, 0, { kind: 'group', groupId: 'G' });
    expect(r.projects).toBe(projects);
    expect(r.groups).toBe(groups);
  });

  it('dropped on the end area: leaves its group, moves to the end', () => {
    const projects = P('/a', '/b', '/c');
    const groups = [g('G', ['/a'])];
    const r = moveProject(projects, groups, 0, { kind: 'ungrouped-end' });
    expect(cwdsOf(r.projects)).toEqual(['/b', '/c', '/a']);
    expect(groupIdOf(r.groups, '/a')).toBeNull();
  });
});

describe('buildSidebarModel', () => {
  it('without groups: one ungrouped run in original order', () => {
    const projects = P('/a', '/b');
    const m = buildSidebarModel(projects, []);
    expect(m.groups).toEqual([]);
    expect(m.ungrouped.map((e) => [e.project.cwd, e.index])).toEqual([['/a', 0], ['/b', 1]]);
  });

  it('indices always point back into the original projects array', () => {
    const projects = P('/a', '/b', '/c', '/d', '/e');
    const groups = [g('Y', ['/e', '/b']), g('X', ['/c'])];
    const m = buildSidebarModel(projects, groups);
    expect(m.groups.map((s) => s.group.id)).toEqual(['Y', 'X']);
    // Inside a group: global order, not the `cwds` order.
    expect(m.groups[0].items.map((e) => e.project.cwd)).toEqual(['/b', '/e']);
    for (const entry of [...m.groups.flatMap((s) => s.items), ...m.ungrouped]) {
      expect(projects[entry.index]).toBe(entry.project);
    }
    expect(m.ungrouped.map((e) => e.index)).toEqual([0, 3]);
  });

  it('ignores members that are not projects and keeps empty groups', () => {
    const m = buildSidebarModel(P('/a'), [g('G', ['/gone']), g('H', ['/a'])]);
    expect(m.groups.map((s) => s.items.length)).toEqual([0, 1]);
    expect(m.ungrouped).toEqual([]);
  });
});
