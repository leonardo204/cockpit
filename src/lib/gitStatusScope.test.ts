import { describe, it, expect } from 'vitest';
import {
  buildStatusMap,
  mostUrgent,
  parsePorcelain,
  statusFromColumns,
  type GitStatusEntry,
} from './gitStatusScope';

/**
 * PORCELAIN IS A FIXED-COLUMN FORMAT WITH SEVERAL SILENT WAYS TO BE MISREAD.
 *
 * Every failure here shows up as a wrong colour or as a file that is quietly
 * never coloured — never as an error — which is why the parsing is pure and
 * pinned rather than written inline in a route.
 *
 * The records below are written as they actually arrive: `-z`, so entries are
 * NUL-separated and paths are raw bytes with no quoting.
 */

const z = (...records: string[]) => records.join('\0') + '\0';

describe('one entry', () => {
  it('reads the path from column 3, keeping the space that is part of the format', () => {
    // ` M src/a.ts` — column 2 is a SPACE belonging to the format, not padding.
    // Trimming the record would eat the first character of a path.
    expect(parsePorcelain(z(' M src/a.ts'))).toEqual([
      { path: 'src/a.ts', state: 'modified', staged: false },
    ]);
  });

  it('reads a path containing spaces without any unquoting', () => {
    // The reason `-z` is not optional: without it git would emit
    // `"my docs/a file.md"` and this would have to unescape C strings.
    expect(parsePorcelain(z(' M my docs/a file.md'))[0]!.path).toBe('my docs/a file.md');
  });

  it('reads a non-ASCII path — this project has them', () => {
    expect(parsePorcelain(z('?? 탐지성능_리포트.md'))).toEqual([
      { path: '탐지성능_리포트.md', state: 'untracked', staged: false },
    ]);
  });

  it('says whether the change is in the index', () => {
    expect(parsePorcelain(z('M  a.ts'))[0]!.staged).toBe(true);
    expect(parsePorcelain(z(' M a.ts'))[0]!.staged).toBe(false);
    // `??` has no index half at all, so it is never "staged".
    expect(parsePorcelain(z('?? a.ts'))[0]!.staged).toBe(false);
  });
});

describe('folding two columns into one answer', () => {
  it('calls a staged-then-edited file modified', () => {
    // `MM` is the common case a naive lookup table forgets. There is one honest
    // single answer and it is "modified".
    expect(statusFromColumns('M', 'M')).toBe('modified');
  });

  it('treats untracked as its own thing, not as a column pair', () => {
    expect(statusFromColumns('?', '?')).toBe('untracked');
  });

  it('drops ignored files entirely', () => {
    // They are not changes, and colouring them would tint node_modules.
    expect(statusFromColumns('!', '!')).toBeNull();
    expect(parsePorcelain(z('!! node_modules/x.js'))).toEqual([]);
  });

  it('puts a conflict above everything else', () => {
    // The only state that is a PROBLEM rather than a fact. A file needing
    // resolution must never be shown as an ordinary edit.
    for (const [x, y] of [
      ['U', 'U'],
      ['A', 'U'],
      ['U', 'D'],
      ['D', 'U'],
      ['U', 'A'],
      ['D', 'D'],
      ['A', 'A'],
    ]) {
      expect(statusFromColumns(x!, y!), `${x}${y}`).toBe('conflicted');
    }
  });

  it('reads a deletion in either column', () => {
    expect(statusFromColumns('D', ' ')).toBe('deleted');
    expect(statusFromColumns(' ', 'D')).toBe('deleted');
  });

  it('calls a staged-added-then-deleted file gone, not new', () => {
    // `AD`: git knows about it, the worktree does not have it. Colouring it as
    // "added" would point at a file that is not there.
    expect(statusFromColumns('A', 'D')).toBe('deleted');
  });

  it('treats a type change as a modification', () => {
    // file ↔ symlink. Nothing a reader needs a fifth colour for.
    expect(statusFromColumns('T', ' ')).toBe('modified');
  });

  it('returns nothing for a clean pair', () => {
    expect(statusFromColumns(' ', ' ')).toBeNull();
  });
});

describe('a rename costs two records', () => {
  it('consumes the source path instead of parsing it as an entry', () => {
    // With `-z` the original path arrives as its own bare record. Read as an
    // entry, its first two characters would be interpreted as a status — so
    // `old/name.ts` would parse as `'ol'` and colour something at random.
    const out = parsePorcelain(z('R  new/name.ts', 'old/name.ts', ' M other.ts'));
    expect(out).toEqual([
      { path: 'new/name.ts', state: 'modified', staged: true },
      { path: 'other.ts', state: 'modified', staged: false },
    ]);
  });

  it('reports the NEW path, because that is the file that exists', () => {
    const out = parsePorcelain(z('R  new/name.ts', 'old/name.ts'));
    expect(out.map((e) => e.path)).toEqual(['new/name.ts']);
  });

  it('consumes a copy source the same way', () => {
    const out = parsePorcelain(z('C  copy.ts', 'origin.ts', '?? third.ts'));
    expect(out.map((e) => e.path)).toEqual(['copy.ts', 'third.ts']);
  });
});

describe('malformed or empty output', () => {
  it('reads nothing from a clean repository', () => {
    expect(parsePorcelain('')).toEqual([]);
    expect(parsePorcelain('\0')).toEqual([]);
  });

  it('skips a record too short to be an entry rather than inventing one', () => {
    expect(parsePorcelain(z('M', ' M ok.ts'))).toEqual([
      { path: 'ok.ts', state: 'modified', staged: false },
    ]);
  });

  it('skips an entry with a status but no path', () => {
    expect(parsePorcelain(z(' M  '))).toEqual([{ path: ' ', state: 'modified', staged: false }]);
    expect(parsePorcelain(z(' M '))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────
// Rolling up to folders
// ─────────────────────────────────────────────────────────

const entry = (path: string, state: GitStatusEntry['state']): GitStatusEntry => ({
  path,
  state,
  staged: false,
});

describe('a folder wears the most urgent thing inside it', () => {
  it('colours every ancestor of a changed file', () => {
    // The tree lazy-loads each level and knows nothing about what is collapsed
    // beneath a folder, so a closed folder is the ONLY sign that something in
    // there changed.
    expect(buildStatusMap([entry('src/a/b.ts', 'modified')])).toEqual({
      'src/a/b.ts': 'modified',
      'src/a': 'modified',
      src: 'modified',
    });
  });

  it('never colours the repository root', () => {
    // The root is the panel itself; tinting it says "something somewhere
    // changed", which the reader already knows.
    const map = buildStatusMap([entry('a.ts', 'modified')]);
    expect(map).toEqual({ 'a.ts': 'modified' });
    expect(map['']).toBeUndefined();
  });

  it('shows a conflict through forty edits', () => {
    const map = buildStatusMap([
      entry('src/one.ts', 'modified'),
      entry('src/two.ts', 'untracked'),
      entry('src/deep/bad.ts', 'conflicted'),
    ]);
    expect(map['src']).toBe('conflicted');
    expect(map['src/deep']).toBe('conflicted');
    // The files themselves keep their own state.
    expect(map['src/one.ts']).toBe('modified');
  });

  it('orders the rest the way a reader would rank them', () => {
    expect(mostUrgent(['untracked', 'modified'])).toBe('modified');
    expect(mostUrgent(['untracked', 'deleted'])).toBe('deleted');
    expect(mostUrgent(['modified', 'added'])).toBe('added');
    expect(mostUrgent([])).toBeNull();
  });

  it('is empty for a clean tree', () => {
    expect(buildStatusMap([])).toEqual({});
  });
});
