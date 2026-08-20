// What an outbound message calls a project (telegram-chat §0).

import { describe, it, expect } from 'vitest';
import { projectDisplayName, projectDisplayNames, type ProjectReader } from './projectDisplayName';

function reader(rows: Array<{ cwd: string; title?: string }>, calls?: { n: number }): ProjectReader {
  return {
    listProjects: () => {
      if (calls) calls.n += 1;
      return rows;
    },
  };
}

describe('projectDisplayName', () => {
  it('prefers the user-set title over the folder name', () => {
    const store = reader([{ cwd: '/x/dash-v2', title: '고객 대시보드' }]);
    expect(projectDisplayName(store, '/x/dash-v2')).toBe('고객 대시보드');
  });

  it('trims the title', () => {
    const store = reader([{ cwd: '/x/p', title: '  이름  ' }]);
    expect(projectDisplayName(store, '/x/p')).toBe('이름');
  });

  it('falls back to the folder name for a blank or missing title', () => {
    expect(projectDisplayName(reader([{ cwd: '/x/proj', title: '   ' }]), '/x/proj')).toBe('proj');
    expect(projectDisplayName(reader([{ cwd: '/x/proj' }]), '/x/proj')).toBe('proj');
  });

  it('falls back to the folder name for a project that is not in the table', () => {
    expect(projectDisplayName(reader([{ cwd: '/other', title: 'Other' }]), '/x/proj')).toBe('proj');
  });

  it('is empty when the session has no directory', () => {
    expect(projectDisplayName(reader([]), undefined)).toBe('');
    expect(projectDisplayName(reader([]), '')).toBe('');
  });

  it('survives a store that cannot answer', () => {
    expect(projectDisplayName(undefined, '/x/proj')).toBe('proj');
    expect(projectDisplayName({}, '/x/proj')).toBe('proj');
    const throwing: ProjectReader = {
      listProjects: () => {
        throw new Error('db is gone');
      },
    };
    expect(projectDisplayName(throwing, '/x/proj')).toBe('proj');
  });
});

describe('projectDisplayNames', () => {
  it('answers for many cwds off a single projects read', () => {
    const calls = { n: 0 };
    const labelFor = projectDisplayNames(
      reader([{ cwd: '/x/a', title: '가나다' }, { cwd: '/x/b' }], calls),
    );
    expect(labelFor('/x/a')).toBe('가나다');
    expect(labelFor('/x/b')).toBe('b');
    expect(labelFor('/x/never-opened')).toBe('never-opened');
    expect(labelFor(undefined)).toBe('');
    expect(calls.n).toBe(1);
  });

  it('survives a store that cannot answer', () => {
    const labelFor = projectDisplayNames({
      listProjects: () => {
        throw new Error('db is gone');
      },
    });
    expect(labelFor('/x/proj')).toBe('proj');
  });
});
