import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * /api/git-status against REAL repositories, because the thing worth pinning is
 * the handshake with git itself — the flags, the exit code that means "not a
 * repo", and the shape porcelain actually arrives in. The parsing is pure and
 * covered on its own (lib/gitStatusScope.test.ts); duplicating it here would
 * test the fixture rather than the route.
 *
 * Three trees: a repo with every kind of change in it, a directory that is not a
 * repo at all, and a path that does not exist.
 */

const root = mkdtempSync(join(tmpdir(), 'naby-git-status-'));
const repo = join(root, 'repo');
const plain = join(root, 'plain');

let route: typeof import('./route');

interface Res {
  ok: boolean;
  reason?: string;
  repo?: boolean;
  changed?: Record<string, string>;
  truncated?: boolean;
}

const get = async (cwd: string): Promise<Res> => {
  const res = await route.GET(
    new Request(`http://127.0.0.1/api/git-status?cwd=${encodeURIComponent(cwd)}`),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Res;
};

const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' });

beforeAll(async () => {
  route = await import('./route');

  mkdirSync(repo, { recursive: true });
  mkdirSync(plain, { recursive: true });

  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');

  // A committed baseline, so there is something to be modified and deleted.
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'kept.ts'), 'export const kept = 1;\n');
  writeFileSync(join(repo, 'src', 'edited.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'src', 'gone.ts'), 'export const gone = 1;\n');
  writeFileSync(join(repo, '.gitignore'), 'ignored/\n');
  git('add', '-A');
  git('commit', '-qm', 'base');

  // ...then one of each state the tree can colour.
  writeFileSync(join(repo, 'src', 'edited.ts'), 'export const a = 2;\n');
  rmSync(join(repo, 'src', 'gone.ts'));
  mkdirSync(join(repo, 'src', 'fresh'), { recursive: true });
  writeFileSync(join(repo, 'src', 'fresh', 'new.ts'), 'export const n = 1;\n');
  writeFileSync(join(repo, '탐지성능 리포트.md'), '# 리포트\n');
  mkdirSync(join(repo, 'ignored'), { recursive: true });
  writeFileSync(join(repo, 'ignored', 'junk.log'), 'noise\n');
  writeFileSync(join(repo, 'staged.ts'), 'export const s = 1;\n');
  git('add', 'staged.ts');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('a repository with changes in it', () => {
  it('reports each file under the state a reader would name it', async () => {
    const res = await get(repo);
    expect(res.ok).toBe(true);
    expect(res.repo).toBe(true);
    expect(res.changed!['src/edited.ts']).toBe('modified');
    expect(res.changed!['src/gone.ts']).toBe('deleted');
    expect(res.changed!['staged.ts']).toBe('added');
    expect(res.changed!['src/fresh/new.ts']).toBe('untracked');
  });

  it('leaves an unchanged file with no colour at all', async () => {
    const res = await get(repo);
    expect(res.changed!['src/kept.ts']).toBeUndefined();
  });

  it('lists files INSIDE an untracked folder, not just the folder', async () => {
    // `-uall`. Without it git reports `src/fresh/` and the tree could not colour
    // anything under it — including the file the user just made.
    const res = await get(repo);
    expect(res.changed!['src/fresh/new.ts']).toBe('untracked');
    expect(res.changed!['src/fresh']).toBe('untracked');
  });

  it('does not colour ignored files', async () => {
    // They are not changes, and this is what stops node_modules being tinted.
    const res = await get(repo);
    expect(res.changed!['ignored/junk.log']).toBeUndefined();
    expect(res.changed!['ignored']).toBeUndefined();
  });

  it('reads a path with a space and non-ASCII characters', async () => {
    // `-z`. Without it git quotes this path and it would arrive unusable.
    const res = await get(repo);
    expect(res.changed!['탐지성능 리포트.md']).toBe('untracked');
  });

  it('colours the folders above a changed file', async () => {
    // A collapsed folder is the only sign that something inside it changed.
    const res = await get(repo);
    expect(res.changed!['src']).toBeDefined();
  });

  it('never colours the repository root', async () => {
    const res = await get(repo);
    expect(res.changed!['']).toBeUndefined();
  });

  it('says it was not truncated', async () => {
    const res = await get(repo);
    expect(res.truncated).toBe(false);
  });
});

describe('somewhere that is not a repository', () => {
  it('answers "no repo" rather than an error', async () => {
    // A project without version control is an ordinary project. It simply has
    // nothing to colour, and the panel must not show the reader an error they
    // cannot act on.
    const res = await get(plain);
    expect(res).toEqual({ ok: true, repo: false, changed: {}, truncated: false });
  });

  it('answers the same way for a directory that does not exist', async () => {
    const res = await get(join(root, 'nope'));
    expect(res.ok).toBe(true);
    expect(res.repo).toBe(false);
  });
});

describe('refusals', () => {
  it('rejects a missing or relative cwd', async () => {
    expect(await get('')).toEqual({ ok: false, reason: 'invalid-cwd' });
    expect(await get('relative/path')).toEqual({ ok: false, reason: 'invalid-cwd' });
  });
});

describe('it does not disturb the user’s own git', () => {
  it('takes no index lock', async () => {
    // `--no-optional-locks`. This runs on every panel refresh; contending with
    // the terminal the user is working in would be a bug they could never
    // attribute to a file tree.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./route.ts', import.meta.url), 'utf8'),
    );
    expect(src).toContain('--no-optional-locks');
    // And it never writes: the only git subcommand here is a read.
    expect(src).toContain('"status"');
    for (const write of ['"add"', '"commit"', '"checkout"', '"reset"', '"clean"']) {
      expect(src).not.toContain(write);
    }
  });

  it('bounds what one call can cost', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./route.ts', import.meta.url), 'utf8'),
    );
    expect(src).toContain('timeout: TIMEOUT_MS');
    expect(src).toContain('maxBuffer: MAX_BUFFER');
  });
});
