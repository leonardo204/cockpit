import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * /api/changed-since against a REAL tree, because what is worth pinning is the
 * walk: what it skips, how deep it goes, and that it never reads a file.
 *
 * The comparison rule itself is pure and covered in gitStatusScope.test.ts.
 */

const root = mkdtempSync(join(tmpdir(), 'naby-changed-since-'));
const proj = join(root, 'proj');

let route: typeof import('./route');

interface Res {
  ok: boolean;
  reason?: string;
  repo?: boolean;
  changed?: Record<string, string>;
  truncated?: boolean;
}

const get = async (cwd: string, since: number | string): Promise<Res> => {
  const res = await route.GET(
    new Request(
      `http://127.0.0.1/api/changed-since?cwd=${encodeURIComponent(cwd)}&since=${since}`,
    ),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Res;
};

/** Stamp a file's mtime, in seconds since the epoch. */
const stamp = (abs: string, whenMs: number) => {
  const s = whenMs / 1000;
  utimesSync(abs, s, s);
};

const OPENED = Date.now() - 60 * 60 * 1000; // an hour ago
const BEFORE = OPENED - 60 * 60 * 1000;
const AFTER = OPENED + 30 * 60 * 1000;

beforeAll(async () => {
  route = await import('./route');

  mkdirSync(join(proj, 'src', 'deep'), { recursive: true });
  mkdirSync(join(proj, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(proj, 'dist'), { recursive: true });

  const write = (rel: string, when: number) => {
    const abs = join(proj, rel);
    writeFileSync(abs, 'x');
    stamp(abs, when);
  };

  write('old.txt', BEFORE);
  write('edited.txt', AFTER);
  write('src/deep/nested.txt', AFTER);
  write('src/untouched.txt', BEFORE);
  write('탐지성능 리포트.md', AFTER);
  write('node_modules/pkg/index.js', AFTER);
  write('dist/bundle.js', AFTER);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('what it reports', () => {
  it('names a file written after the baseline', async () => {
    const res = await get(proj, OPENED);
    expect(res.ok).toBe(true);
    expect(res.changed!['edited.txt']).toBe('touched');
  });

  it('leaves a file that was already there alone', async () => {
    const res = await get(proj, OPENED);
    expect(res.changed!['old.txt']).toBeUndefined();
    expect(res.changed!['src/untouched.txt']).toBeUndefined();
  });

  it('reaches into nested folders', async () => {
    const res = await get(proj, OPENED);
    expect(res.changed!['src/deep/nested.txt']).toBe('touched');
  });

  it('rolls the folders up, so a collapsed one still shows', async () => {
    // The same fold the git route uses — a closed folder is the only sign that
    // something inside it moved.
    const res = await get(proj, OPENED);
    expect(res.changed!['src']).toBe('touched');
    expect(res.changed!['src/deep']).toBe('touched');
  });

  it('never colours the project root', async () => {
    const res = await get(proj, OPENED);
    expect(res.changed!['']).toBeUndefined();
  });

  it('reads a path with a space and non-ASCII characters', async () => {
    const res = await get(proj, OPENED);
    expect(res.changed!['탐지성능 리포트.md']).toBe('touched');
  });

  it('says it is not a repository, so the tree knows which words to use', async () => {
    const res = await get(proj, OPENED);
    expect(res.repo).toBe(false);
    expect(res.truncated).toBe(false);
  });
});

describe('what it skips', () => {
  it('skips node_modules and build output', async () => {
    // A project with no git is exactly the project most likely to have an
    // uncommitted `node_modules` in it. The watcher's own list decides, so the
    // two agree about what counts as project content.
    const res = await get(proj, OPENED);
    expect(res.changed!['node_modules/pkg/index.js']).toBeUndefined();
    expect(res.changed!['node_modules']).toBeUndefined();
    expect(res.changed!['dist/bundle.js']).toBeUndefined();
    expect(res.changed!['dist']).toBeUndefined();
  });
});

describe('refusals', () => {
  it('rejects a missing or relative cwd', async () => {
    expect(await get('', OPENED)).toEqual({ ok: false, reason: 'invalid-cwd' });
    expect(await get('relative/path', OPENED)).toEqual({ ok: false, reason: 'invalid-cwd' });
  });

  it('rejects a baseline it cannot use', async () => {
    // A missing or nonsense `since` would mark either everything or nothing, and
    // both hide the caller's bug behind a confidently coloured tree.
    for (const bad of ['', 'abc', '0', '-1', 'NaN']) {
      expect(await get(proj, bad), bad).toEqual({ ok: false, reason: 'invalid-since' });
    }
  });

  it('answers empty for a directory that does not exist', async () => {
    // No colours rather than an error the reader cannot act on — the same
    // degradation the git route chose.
    const res = await get(join(root, 'nope'), OPENED);
    expect(res.ok).toBe(true);
    expect(res.changed).toEqual({});
  });
});

describe('it only ever looks', () => {
  it('reads no file contents', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./route.ts', import.meta.url), 'utf8'),
    );
    expect(src).not.toContain('readFile(');
    expect(src).toContain('stat(');
  });

  it('bounds the walk', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./route.ts', import.meta.url), 'utf8'),
    );
    expect(src).toContain('depth > MAX_WALK_DEPTH');
    expect(src).toContain('found.length >= MAX_STATUS_ENTRIES');
    expect(src).toContain('isIgnoredWatchPath(rel)');
  });
});
