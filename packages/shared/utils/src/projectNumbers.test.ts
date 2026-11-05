import { describe, it, expect } from 'vitest';
import {
  orderProjects,
  parseStoredProjectOrder,
  projectNumbers,
  serializeProjectOrder,
  type ProjectGroup,
} from './projectGroups';

/**
 * Sidebar project numbers (specs/project-groups.md §9, R30–R34) — the ONE
 * function the sidebar draws with and naby's tools resolve "3번" with.
 */

const P = (...cwds: string[]) => cwds.map((cwd) => ({ cwd }));
const G = (id: string, name: string, cwds: string[], collapsed = false): ProjectGroup => ({ id, name, collapsed, cwds });
const plain = (m: Map<string, { groupId: string | null; groupName: string | null; number: number }>) =>
  Object.fromEntries([...m].map(([cwd, n]) => [cwd, `${n.groupName ?? '-'}:${n.number}`]));

describe('projectNumbers (R30–R33)', () => {
  it('no groups: one section, numbered in list order — what the sidebar always showed', () => {
    expect(plain(projectNumbers(P('/a', '/b', '/c'), []))).toEqual({ '/a': '-:1', '/b': '-:2', '/c': '-:3' });
  });

  it('groups and the ungrouped area each restart at 1', () => {
    const groups = [G('g1', 'RMS', ['/b', '/d']), G('g2', 'Web', ['/a'])];
    const m = projectNumbers(P('/a', '/b', '/c', '/d', '/e'), groups);
    expect(plain(m)).toEqual({ '/b': 'RMS:1', '/d': 'RMS:2', '/a': 'Web:1', '/c': '-:1', '/e': '-:2' });
    expect(m.get('/b')).toEqual({ groupId: 'g1', groupName: 'RMS', number: 1 });
    expect(m.get('/c')).toEqual({ groupId: null, groupName: null, number: 1 });
  });

  it('an empty group takes no numbers and does not shift the others', () => {
    const groups = [G('g0', 'Empty', []), G('g1', 'RMS', ['/a', '/b'])];
    expect(plain(projectNumbers(P('/a', '/b', '/c'), groups))).toEqual({ '/a': 'RMS:1', '/b': 'RMS:2', '/c': '-:1' });
  });

  it('counts in display order, not global order: members far apart in the list are 1, 2, 3', () => {
    // Global positions 3, 5, 7 — the VOC: the old index+1 showed 3, 5, 7.
    const projects = P('/u1', '/u2', '/s', '/u3', '/c', '/u4', '/dt');
    const groups = [G('g', 'RMS', ['/dt', '/c', '/s'])]; // member order carries no meaning
    expect(plain(projectNumbers(projects, groups))).toEqual({
      '/s': 'RMS:1',
      '/c': 'RMS:2',
      '/dt': 'RMS:3',
      '/u1': '-:1',
      '/u2': '-:2',
      '/u3': '-:3',
      '/u4': '-:4',
    });
  });

  it('a collapsed group keeps its numbers (R31)', () => {
    const open = projectNumbers(P('/a', '/b', '/c'), [G('g', 'RMS', ['/b', '/c'])]);
    const shut = projectNumbers(P('/a', '/b', '/c'), [G('g', 'RMS', ['/b', '/c'], true)]);
    expect(plain(shut)).toEqual(plain(open));
  });

  it('reordering renumbers at once — nothing is stored (R32)', () => {
    const groups = [G('g', 'RMS', ['/a', '/b'])];
    expect(projectNumbers(P('/a', '/b'), groups).get('/b')!.number).toBe(2);
    expect(projectNumbers(P('/b', '/a'), groups).get('/b')!.number).toBe(1);
  });

  it('ignores group members that are not projects, and a cwd claimed twice counts for the first group', () => {
    const groups = [G('g1', 'A', ['/ghost', '/x']), G('g2', 'B', ['/x', '/y'])];
    expect(plain(projectNumbers(P('/x', '/y'), groups))).toEqual({ '/x': 'A:1', '/y': 'B:1' });
  });
});

describe('the stored sidebar order', () => {
  it('orders by the stored cwds, appends projects it does not name, never drops one', () => {
    const rows = P('/c', '/a', '/new', '/b');
    expect(orderProjects(rows, ['/a', '/b', '/gone', '/c']).map((p) => p.cwd)).toEqual(['/a', '/b', '/c', '/new']);
    expect(orderProjects(rows, [])).toBe(rows);
  });

  it('round-trips, and broken values read as no order', () => {
    expect(parseStoredProjectOrder(serializeProjectOrder(['/a', '/b', '/a', '']))).toEqual(['/a', '/b']);
    expect(parseStoredProjectOrder('{nope')).toEqual([]);
    expect(parseStoredProjectOrder('{"a":1}')).toEqual([]);
    expect(parseStoredProjectOrder(undefined)).toEqual([]);
  });
});
