import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * /api/fs-op is the only route in the app that DELETES a user's file, so its
 * refusals matter more than its successes.
 *
 * Two properties are pinned here per action:
 *
 *   1. It does what it says on a well-formed request (the tree really changes).
 *   2. It refuses rather than damages — an escaping `rel` or `name` never
 *      touches anything outside the project, and a colliding name is reported
 *      instead of overwriting the file that is already there. The existing
 *      `~/.naby` habit of "skip, never clobber" (see /api/copy-into) is the
 *      contract; a file browser that eats a file on a typo is worse than one
 *      that says no.
 *
 * The fixture is a throwaway tree with a SIBLING directory next to it, so the
 * escape tests have a real target to fail to reach.
 */

const root = mkdtempSync(join(tmpdir(), 'naby-fs-op-'));
const cwd = join(root, 'proj');
const outside = join(root, 'outside');

let route: typeof import('./route');

type Res = {
  ok: boolean;
  reason?: string;
  rel?: string;
  content?: string;
  truncated?: boolean;
  size?: number;
};

const post = async (body: unknown): Promise<Res> => {
  const res = await route.POST(
    new Request('http://127.0.0.1/api/fs-op', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Res;
};

beforeAll(async () => {
  route = await import('./route');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

// A fresh tree per test: these mutate the filesystem, so shared state would
// make failures depend on ordering.
beforeEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(join(cwd, 'src', 'nested'), { recursive: true });
  writeFileSync(join(cwd, 'README.md'), 'hello');
  writeFileSync(join(cwd, 'src', 'a.ts'), 'export const a = 1;');
  writeFileSync(join(cwd, 'src', 'nested', 'deep.txt'), 'deep');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'do not touch');
});

describe('mkdir / mkfile', () => {
  it('creates a folder inside the named directory', async () => {
    const r = await post({ cwd, action: 'mkdir', rel: 'src', name: 'utils' });
    expect(r).toEqual({ ok: true, rel: 'src/utils' });
    expect(existsSync(join(cwd, 'src', 'utils'))).toBe(true);
  });

  it('creates an empty file at the project root', async () => {
    const r = await post({ cwd, action: 'mkfile', rel: '', name: 'notes.md' });
    expect(r).toEqual({ ok: true, rel: 'notes.md' });
    expect(readFileSync(join(cwd, 'notes.md'), 'utf8')).toBe('');
  });

  it('refuses a name that already exists, leaving the file untouched', async () => {
    const r = await post({ cwd, action: 'mkfile', rel: '', name: 'README.md' });
    expect(r).toEqual({ ok: false, reason: 'exists' });
    // The point of the refusal: the original content survives.
    expect(readFileSync(join(cwd, 'README.md'), 'utf8')).toBe('hello');
  });

  it('refuses a name that is really a path', async () => {
    expect(await post({ cwd, action: 'mkfile', rel: '', name: '../escaped.txt' })).toEqual({
      ok: false,
      reason: 'invalid-name',
    });
    expect(await post({ cwd, action: 'mkdir', rel: '', name: 'a/b' })).toEqual({
      ok: false,
      reason: 'invalid-name',
    });
    expect(existsSync(join(root, 'escaped.txt'))).toBe(false);
  });

  it('refuses a rel that walks out of the project', async () => {
    const r = await post({ cwd, action: 'mkfile', rel: '../outside', name: 'planted.txt' });
    expect(r).toEqual({ ok: false, reason: 'escape' });
    expect(existsSync(join(outside, 'planted.txt'))).toBe(false);
  });
});

describe('rename', () => {
  it('renames in place and answers with the new relative path', async () => {
    const r = await post({ cwd, action: 'rename', rel: 'src/a.ts', name: 'b.ts' });
    expect(r).toEqual({ ok: true, rel: 'src/b.ts' });
    expect(existsSync(join(cwd, 'src', 'a.ts'))).toBe(false);
    expect(readFileSync(join(cwd, 'src', 'b.ts'), 'utf8')).toBe('export const a = 1;');
  });

  it('renames a directory with its contents', async () => {
    const r = await post({ cwd, action: 'rename', rel: 'src/nested', name: 'moved' });
    expect(r.ok).toBe(true);
    expect(readFileSync(join(cwd, 'src', 'moved', 'deep.txt'), 'utf8')).toBe('deep');
  });

  it('refuses a collision instead of overwriting the sibling', async () => {
    writeFileSync(join(cwd, 'src', 'taken.ts'), 'original');
    const r = await post({ cwd, action: 'rename', rel: 'src/a.ts', name: 'taken.ts' });
    expect(r).toEqual({ ok: false, reason: 'exists' });
    expect(readFileSync(join(cwd, 'src', 'taken.ts'), 'utf8')).toBe('original');
    expect(existsSync(join(cwd, 'src', 'a.ts'))).toBe(true);
  });

  it('refuses to rename the project root itself', async () => {
    expect(await post({ cwd, action: 'rename', rel: '', name: 'whatever' })).toEqual({
      ok: false,
      reason: 'invalid-target',
    });
  });

  it('reports a target that is not there', async () => {
    expect(await post({ cwd, action: 'rename', rel: 'src/ghost.ts', name: 'x.ts' })).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('refuses a rel outside the project', async () => {
    const r = await post({ cwd, action: 'rename', rel: '../outside/secret.txt', name: 'gone.txt' });
    expect(r).toEqual({ ok: false, reason: 'escape' });
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('do not touch');
  });
});

describe('duplicate', () => {
  it('copies a file to a " copy" sibling that keeps the extension', async () => {
    const r = await post({ cwd, action: 'duplicate', rel: 'src/a.ts' });
    expect(r).toEqual({ ok: true, rel: 'src/a copy.ts' });
    expect(readFileSync(join(cwd, 'src', 'a copy.ts'), 'utf8')).toBe('export const a = 1;');
  });

  it('numbers past a duplicate that already exists', async () => {
    await post({ cwd, action: 'duplicate', rel: 'src/a.ts' });
    const r = await post({ cwd, action: 'duplicate', rel: 'src/a.ts' });
    expect(r).toEqual({ ok: true, rel: 'src/a copy 2.ts' });
    // The first duplicate is still the first duplicate.
    expect(readFileSync(join(cwd, 'src', 'a copy.ts'), 'utf8')).toBe('export const a = 1;');
  });

  it('copies a directory recursively', async () => {
    const r = await post({ cwd, action: 'duplicate', rel: 'src/nested' });
    expect(r).toEqual({ ok: true, rel: 'src/nested copy' });
    expect(readFileSync(join(cwd, 'src', 'nested copy', 'deep.txt'), 'utf8')).toBe('deep');
  });

  it('refuses a rel outside the project', async () => {
    const r = await post({ cwd, action: 'duplicate', rel: '../outside/secret.txt' });
    expect(r).toEqual({ ok: false, reason: 'escape' });
    expect(existsSync(join(outside, 'secret copy.txt'))).toBe(false);
  });

  it('refuses to duplicate the project root', async () => {
    expect(await post({ cwd, action: 'duplicate', rel: '' })).toEqual({
      ok: false,
      reason: 'invalid-target',
    });
  });
});

describe('delete', () => {
  it('removes a file', async () => {
    const r = await post({ cwd, action: 'delete', rel: 'README.md' });
    expect(r).toEqual({ ok: true, rel: 'README.md' });
    expect(existsSync(join(cwd, 'README.md'))).toBe(false);
  });

  it('removes a directory and its contents', async () => {
    const r = await post({ cwd, action: 'delete', rel: 'src/nested' });
    expect(r.ok).toBe(true);
    expect(existsSync(join(cwd, 'src', 'nested'))).toBe(false);
    // A sibling is untouched.
    expect(existsSync(join(cwd, 'src', 'a.ts'))).toBe(true);
  });

  it('refuses to delete the project root', async () => {
    expect(await post({ cwd, action: 'delete', rel: '' })).toEqual({
      ok: false,
      reason: 'invalid-target',
    });
    expect(existsSync(cwd)).toBe(true);
  });

  it('refuses to delete anything outside the project', async () => {
    const r = await post({ cwd, action: 'delete', rel: '../outside' });
    expect(r).toEqual({ ok: false, reason: 'escape' });
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('do not touch');
  });

  it('reports a target that is already gone', async () => {
    expect(await post({ cwd, action: 'delete', rel: 'ghost.md' })).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });
});

describe('open / reveal', () => {
  // ONLY THE REFUSALS. A passing success case would literally launch an
  // application (or spring a Finder window) on whoever runs the tests, so the
  // pinned behaviour is everything that must be refused BEFORE the OS is asked.

  it('refuses to open a directory — double-click there means expand', async () => {
    expect(await post({ cwd, action: 'open', rel: 'src' })).toEqual({
      ok: false,
      reason: 'invalid-target',
    });
    // A folder has no application association to re-pick either.
    expect(await post({ cwd, action: 'openWith', rel: 'src' })).toEqual({
      ok: false,
      reason: 'invalid-target',
    });
  });

  it('refuses to open the project root', async () => {
    expect(await post({ cwd, action: 'open', rel: '' })).toEqual({
      ok: false,
      reason: 'invalid-target',
    });
    expect(await post({ cwd, action: 'openWith', rel: '' })).toEqual({
      ok: false,
      reason: 'invalid-target',
    });
  });

  it('refuses to open or reveal anything outside the project', async () => {
    expect(await post({ cwd, action: 'open', rel: '../outside/secret.txt' })).toEqual({
      ok: false,
      reason: 'escape',
    });
    expect(await post({ cwd, action: 'openWith', rel: '../outside/secret.txt' })).toEqual({
      ok: false,
      reason: 'escape',
    });
    expect(await post({ cwd, action: 'reveal', rel: '../outside/secret.txt' })).toEqual({
      ok: false,
      reason: 'escape',
    });
  });

  it('reports a target that is not there', async () => {
    expect(await post({ cwd, action: 'open', rel: 'ghost.md' })).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(await post({ cwd, action: 'openWith', rel: 'ghost.md' })).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(await post({ cwd, action: 'reveal', rel: 'ghost.md' })).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });
});

describe('read', () => {
  // The only action that returns file CONTENT, so its refusals are the ones
  // that decide what the in-app viewer can be pointed at.

  it('returns the file text, untruncated', async () => {
    const r = await post({ cwd, action: 'read', rel: 'README.md' });
    expect(r).toEqual({ ok: true, rel: 'README.md', content: 'hello', truncated: false, size: 5 });
  });

  it('reads a nested file', async () => {
    const r = await post({ cwd, action: 'read', rel: 'src/nested/deep.txt' });
    expect(r.ok).toBe(true);
    expect(r.content).toBe('deep');
  });

  it('preserves multi-byte content byte-for-byte when it fits', async () => {
    // The truncation path trims a dangling U+FFFD; an intact file must not be
    // touched by that, or every Korean document would lose its last character
    // the day one legitimately ends in a replacement char.
    writeFileSync(join(cwd, 'ko.md'), '# 제목\n\n본문입니다.\n');
    const r = await post({ cwd, action: 'read', rel: 'ko.md' });
    expect(r.content).toBe('# 제목\n\n본문입니다.\n');
    expect(r.truncated).toBe(false);
  });

  it('refuses a directory — a folder has no text to show', async () => {
    expect(await post({ cwd, action: 'read', rel: 'src' })).toEqual({
      ok: false,
      reason: 'invalid-target',
    });
  });

  it('refuses the project root, which is a directory by definition', async () => {
    expect(await post({ cwd, action: 'read', rel: '' })).toEqual({
      ok: false,
      reason: 'invalid-target',
    });
  });

  it('refuses to read anything outside the project', async () => {
    // The containment guard is the point: `read` is the one action that could
    // otherwise EXFILTRATE a file rather than merely fail to touch it.
    expect(await post({ cwd, action: 'read', rel: '../outside/secret.txt' })).toEqual({
      ok: false,
      reason: 'escape',
    });
  });

  it('reports a target that is not there', async () => {
    expect(await post({ cwd, action: 'read', rel: 'ghost.md' })).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('refuses a file past the hard ceiling instead of returning a fragment', async () => {
    // 33 MiB — over MAX_READ_BYTES, where a leading slice stops being a usable
    // stand-in for the file. Written as a sparse-ish single write so the test
    // does not spend seconds on it.
    const huge = join(cwd, 'huge.md');
    writeFileSync(huge, Buffer.alloc(33 * 1024 * 1024, 0x61));
    expect(await post({ cwd, action: 'read', rel: 'huge.md' })).toEqual({
      ok: false,
      reason: 'too-large',
    });
    rmSync(huge, { force: true });
  });

  it('truncates honestly between the two ceilings', async () => {
    // 3 MiB — over PREVIEW_BYTES (2 MiB), under MAX_READ_BYTES. The response
    // says so and reports the REAL size, so the UI can tell the user it is
    // showing a head rather than quietly presenting a prefix as the document.
    const big = join(cwd, 'big.md');
    const size = 3 * 1024 * 1024;
    writeFileSync(big, Buffer.alloc(size, 0x62));
    const r = await post({ cwd, action: 'read', rel: 'big.md' });
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.size).toBe(size);
    expect(r.content?.length).toBe(2 * 1024 * 1024);
    rmSync(big, { force: true });
  });
});

describe('request validation', () => {
  it('refuses an unknown action before touching the disk', async () => {
    expect(await post({ cwd, action: 'chmod', rel: 'README.md' })).toEqual({
      ok: false,
      reason: 'invalid-action',
    });
  });

  it('refuses a relative or empty cwd', async () => {
    expect(await post({ cwd: '', action: 'mkdir', rel: '', name: 'x' })).toEqual({
      ok: false,
      reason: 'invalid-cwd',
    });
    expect(await post({ cwd: 'proj', action: 'mkdir', rel: '', name: 'x' })).toEqual({
      ok: false,
      reason: 'invalid-cwd',
    });
  });
});
