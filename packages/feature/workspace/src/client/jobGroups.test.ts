import { describe, it, expect } from 'vitest';
import type { JobRow } from '@cockpit/feature-agent';
import { groupJobsByProject, isJobInProject } from './jobGroups';

/**
 * The job registry is global; the window the reader is looking at is not.
 *
 * A flat list put another project's jobs under this project's heading, and the
 * reader believed it — in both directions. These cases pin the grouping that
 * replaced it, including the two things that made the flat list wrong in the
 * field: a job started in a SUB-DIRECTORY of the open project is still this
 * project's, and a trailing separator on either path is not a difference.
 */

let seq = 0;
function job(cwd: string, over: Partial<JobRow> = {}): JobRow {
  seq += 1;
  return {
    id: `job-${seq}`,
    command: 'npm test',
    cwd,
    status: 'running',
    startedAt: 1_000,
    ...over,
  };
}

describe('groupJobsByProject', () => {
  it('returns nothing for no jobs', () => {
    expect(groupJobsByProject([], '/work/naby')).toEqual([]);
    expect(groupJobsByProject([])).toEqual([]);
  });

  it('puts the current project first, whatever order the rows arrive in', () => {
    const groups = groupJobsByProject(
      [job('/work/other'), job('/work/naby'), job('/work/third')],
      '/work/naby'
    );
    expect(groups.map((g) => g.cwd)).toEqual(['/work/naby', '/work/other', '/work/third']);
    expect(groups[0].isCurrent).toBe(true);
    expect(groups.slice(1).every((g) => !g.isCurrent)).toBe(true);
  });

  it('counts a sub-directory as the current project, under the project heading', () => {
    const groups = groupJobsByProject(
      [job('/work/naby'), job('/work/naby/shell/packages/feature')],
      '/work/naby'
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].cwd).toBe('/work/naby');
    expect(groups[0].label).toBe('naby');
    expect(groups[0].jobs).toHaveLength(2);
  });

  it('does not mistake a sibling with a shared prefix for a sub-directory', () => {
    const groups = groupJobsByProject([job('/work/naby-old')], '/work/naby');
    expect(groups.map((g) => g.cwd)).toEqual(['/work/naby-old']);
    expect(groups[0].isCurrent).toBe(false);
  });

  it('tolerates trailing separators on either path', () => {
    const groups = groupJobsByProject([job('/work/naby/'), job('/work/naby')], '/work/naby/');
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ cwd: '/work/naby', isCurrent: true });
    expect(groups[0].jobs).toHaveLength(2);
    expect(groupJobsByProject([job('C:\\work\\naby\\')], 'C:\\work\\naby')[0]).toMatchObject({
      cwd: 'C:\\work\\naby',
      label: 'naby',
      isCurrent: true,
    });
  });

  it('keeps the other projects in first-seen order', () => {
    const groups = groupJobsByProject(
      [job('/work/b'), job('/work/a'), job('/work/b'), job('/work/c'), job('/work/a')],
      '/work/naby'
    );
    expect(groups.map((g) => g.cwd)).toEqual(['/work/b', '/work/a', '/work/c']);
    expect(groups.map((g) => g.jobs.length)).toEqual([2, 2, 1]);
  });

  it('labels a group with its basename, and falls back to the path at a root', () => {
    const groups = groupJobsByProject([job('/work/naby'), job('/')], '/work/naby');
    expect(groups.map((g) => g.label)).toEqual(['naby', '/']);
  });

  it('marks every group as not-current when no project is open', () => {
    const groups = groupJobsByProject([job('/work/naby'), job('/work/other')]);
    expect(groups.map((g) => g.cwd)).toEqual(['/work/naby', '/work/other']);
    expect(groups.some((g) => g.isCurrent)).toBe(false);
  });

  it('never invents an empty current-project section', () => {
    // The affirmative "nothing running here" would be a lie exactly when the
    // reader is waiting on a `Monitor` the registry never sees.
    const groups = groupJobsByProject([job('/work/other')], '/work/naby');
    expect(groups).toHaveLength(1);
    expect(groups[0].isCurrent).toBe(false);
  });
});

describe('isJobInProject', () => {
  it('answers the badge with the same rule the sections use', () => {
    expect(isJobInProject(job('/work/naby/shell'), '/work/naby')).toBe(true);
    expect(isJobInProject(job('/work/naby'), '/work/naby/')).toBe(true);
    expect(isJobInProject(job('/work/other'), '/work/naby')).toBe(false);
    expect(isJobInProject(job('/work/naby'), undefined)).toBe(false);
  });
});
