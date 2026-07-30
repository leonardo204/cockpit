import { describe, it, expect } from 'vitest';
import { withinCwd, isSafeSegment, copySiblingName } from './fsScope';

/**
 * The containment rule is the only thing standing between "a file browser" and
 * "an arbitrary-write endpoint", so it is pinned directly rather than only
 * through the routes that use it.
 */

describe('withinCwd', () => {
  it('accepts the root itself and anything under it', () => {
    expect(withinCwd('/work/proj', '/work/proj')).toBe(true);
    expect(withinCwd('/work/proj', '/work/proj/src')).toBe(true);
    expect(withinCwd('/work/proj', '/work/proj/src/deep/file.ts')).toBe(true);
  });

  it('refuses an ancestor and a `..` that walks out', () => {
    expect(withinCwd('/work/proj', '/work')).toBe(false);
    expect(withinCwd('/work/proj', '/work/proj/../other')).toBe(false);
    expect(withinCwd('/work/proj', '/')).toBe(false);
  });

  it('refuses a sibling whose name merely starts with the root name', () => {
    // The `+ sep` in the prefix test is the whole reason this passes.
    expect(withinCwd('/work/proj', '/work/proj-old')).toBe(false);
    expect(withinCwd('/work/proj', '/work/projX/file')).toBe(false);
  });
});

describe('isSafeSegment', () => {
  it('accepts an ordinary name', () => {
    expect(isSafeSegment('notes.md')).toBe(true);
    expect(isSafeSegment('.env')).toBe(true);
    expect(isSafeSegment('My Folder')).toBe(true);
  });

  it('refuses anything that is a path rather than a name', () => {
    expect(isSafeSegment('')).toBe(false);
    expect(isSafeSegment('  ')).toBe(false);
    expect(isSafeSegment('.')).toBe(false);
    expect(isSafeSegment('..')).toBe(false);
    expect(isSafeSegment('a/b')).toBe(false);
    expect(isSafeSegment('..\\evil')).toBe(false);
    expect(isSafeSegment('nul\0byte')).toBe(false);
  });

  it('refuses a name padded with whitespace, which reads as a different file', () => {
    expect(isSafeSegment(' notes.md')).toBe(false);
    expect(isSafeSegment('notes.md ')).toBe(false);
  });
});

describe('copySiblingName', () => {
  const none = () => false;

  it('keeps the extension so the duplicate still opens in the same app', () => {
    expect(copySiblingName('report.txt', false, none)).toBe('report copy.txt');
    expect(copySiblingName('a.b.tar.gz', false, none)).toBe('a.b.tar copy.gz');
  });

  it('treats a directory name as one stem', () => {
    expect(copySiblingName('node_modules.bak', true, none)).toBe('node_modules.bak copy');
    expect(copySiblingName('src', true, none)).toBe('src copy');
  });

  it('treats a dotfile as a stem, not as a bare extension', () => {
    expect(copySiblingName('.env', false, none)).toBe('.env copy');
  });

  it('numbers past every taken sibling instead of clobbering one', () => {
    const existing = new Set(['report copy.txt', 'report copy 2.txt']);
    expect(copySiblingName('report.txt', false, (c) => existing.has(c))).toBe('report copy 3.txt');
  });

  it('gives up rather than looping forever', () => {
    expect(copySiblingName('x', false, () => true)).toBeNull();
  });
});
