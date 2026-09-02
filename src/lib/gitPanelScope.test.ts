/**
 * gitPanelScope.test.ts — the projections the panel draws.
 *
 * The case that carries this file is `MM`: one file that is both staged and
 * edited again. The file tree folds it to one row on purpose; the panel must
 * not, or "commit" quietly records a different thing than the reader sees.
 */
import { describe, expect, it } from 'vitest';
import {
  parseAheadBehind,
  parseBranchRefs,
  parseHead,
  parseRemoteRefs,
  splitWorkingTree,
} from './gitPanelScope';

/** Join porcelain records the way `-z` does. */
const z = (...records: string[]) => `${records.join('\0')}\0`;

describe('splitting the working tree', () => {
  it('files a staged-only change under staged', () => {
    const { staged, unstaged } = splitWorkingTree(z('M  src/a.ts'));
    expect(staged).toEqual([{ path: 'src/a.ts', kind: 'modified' }]);
    expect(unstaged).toEqual([]);
  });

  it('files a worktree-only change under unstaged', () => {
    const { staged, unstaged } = splitWorkingTree(z(' M src/a.ts'));
    expect(staged).toEqual([]);
    expect(unstaged).toEqual([{ path: 'src/a.ts', kind: 'modified' }]);
  });

  it('shows a file that is BOTH staged and edited again in both lists', () => {
    // The reason this module exists. `gitStatusScope` folds this to one
    // "modified"; a staging panel that did the same could not offer to unstage
    // the half that is in the index.
    const { staged, unstaged } = splitWorkingTree(z('MM src/a.ts'));
    expect(staged).toEqual([{ path: 'src/a.ts', kind: 'modified' }]);
    expect(unstaged).toEqual([{ path: 'src/a.ts', kind: 'modified' }]);
  });

  it('reads an untracked file as unstaged, not as a staged addition', () => {
    // `??` fills BOTH columns; reading the first would file a brand-new file
    // under "staged" and offer to unstage something the index never had.
    const { staged, unstaged } = splitWorkingTree(z('?? new.ts'));
    expect(staged).toEqual([]);
    expect(unstaged).toEqual([{ path: 'new.ts', kind: 'untracked' }]);
  });

  it('keeps a conflict out of both lists', () => {
    const { staged, unstaged, conflicted } = splitWorkingTree(z('UU merged.ts'));
    expect(conflicted).toEqual([{ path: 'merged.ts', kind: 'modified' }]);
    expect(staged).toEqual([]);
    expect(unstaged).toEqual([]);
  });

  it('recognises the both-sides conflicts that carry no U', () => {
    expect(splitWorkingTree(z('AA both-added.ts')).conflicted).toHaveLength(1);
    expect(splitWorkingTree(z('DD both-deleted.ts')).conflicted).toHaveLength(1);
  });

  it('keeps where a rename came from', () => {
    // With -z the source is its own record following the entry.
    const { staged } = splitWorkingTree(z('R  new/name.ts', 'old/name.ts'));
    expect(staged).toEqual([
      { path: 'new/name.ts', kind: 'renamed', oldPath: 'old/name.ts' },
    ]);
  });

  it('never reads a rename source as an entry of its own', () => {
    const { staged, unstaged } = splitWorkingTree(z('R  new.ts', 'old.ts', ' M other.ts'));
    expect(staged.map((c) => c.path)).toEqual(['new.ts']);
    expect(unstaged.map((c) => c.path)).toEqual(['other.ts']);
  });

  it('tells a staged deletion from an unstaged one', () => {
    expect(splitWorkingTree(z('D  gone.ts')).staged).toEqual([
      { path: 'gone.ts', kind: 'deleted' },
    ]);
    expect(splitWorkingTree(z(' D gone.ts')).unstaged).toEqual([
      { path: 'gone.ts', kind: 'deleted' },
    ]);
  });

  it('handles a clean tree and malformed output', () => {
    expect(splitWorkingTree('')).toEqual({ staged: [], unstaged: [], conflicted: [] });
    expect(splitWorkingTree('\0')).toEqual({ staged: [], unstaged: [], conflicted: [] });
  });

  it('does not list ignored files as changes', () => {
    expect(splitWorkingTree(z('!! node_modules/x.js'))).toEqual({
      staged: [],
      unstaged: [],
      conflicted: [],
    });
  });
});

describe('ahead and behind', () => {
  it('reads the upstream count first, as --left-right prints it', () => {
    // THE ORDER IS THE WHOLE TEST. Swapping these turns "pull 3" into "push 3".
    expect(parseAheadBehind('3\t7\n')).toEqual({ behind: 3, ahead: 7 });
  });

  it('reads a branch in step with its upstream', () => {
    expect(parseAheadBehind('0\t0\n')).toEqual({ behind: 0, ahead: 0 });
  });

  it('answers null when there was no upstream to compare against', () => {
    // git prints nothing and exits non-zero; the panel shows "no upstream"
    // rather than guessing origin/main.
    expect(parseAheadBehind('')).toBeNull();
    expect(parseAheadBehind('fatal: no upstream')).toBeNull();
  });
});

describe('reading the branches', () => {
  it('marks the checked-out branch and its upstream', () => {
    const refs = parseBranchRefs(['main\0origin/main\0*', 'feat/x\0\0'].join('\n'));
    expect(refs).toEqual([
      { name: 'main', upstream: 'origin/main', current: true },
      { name: 'feat/x', current: false },
    ]);
  });

  it('ignores blank lines', () => {
    expect(parseBranchRefs('\n\n')).toEqual([]);
  });

  it('drops the symbolic origin/HEAD from the remote list', () => {
    // It is a pointer at another entry in the same list, not a branch.
    expect(parseRemoteRefs('origin/main\norigin/HEAD\norigin/feat/x\n')).toEqual([
      'origin/main',
      'origin/feat/x',
    ]);
  });
});

describe('reading HEAD', () => {
  it('reads a branch', () => {
    expect(parseHead('main\n')).toEqual({ branch: 'main', detached: false });
  });

  it('reports a detached HEAD as detached, not as a branch called HEAD', () => {
    // `rev-parse --abbrev-ref HEAD` literally prints "HEAD" when detached, and
    // a panel that trusted it would offer to push a branch of that name.
    expect(parseHead('HEAD\n')).toEqual({ branch: null, detached: true });
    expect(parseHead('')).toEqual({ branch: null, detached: true });
  });
});
