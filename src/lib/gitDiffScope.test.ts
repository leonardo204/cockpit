/**
 * gitDiffScope.test.ts — reading git's diff without misreading it.
 *
 * The case this file exists for is a filename with a SPACE in it. `diff --git
 * a/a b.txt b/a b.txt` cannot be split correctly by any rule, and every parser
 * that tries is correct until the first such file — at which point it labels a
 * diff with the wrong path, silently. The tests below pin the design that avoids
 * the question: paths come from `-z` numstat, hunks come from the diff text, and
 * the two are matched by position.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_LINES_PER_FILE,
  buildDiffFiles,
  gapBefore,
  parseFileDiff,
  parseNumstat,
  splitDiffByFile,
} from './gitDiffScope';

/** Join numstat records the way `-z` does. */
const z = (...records: string[]) => `${records.join('\0')}\0`;

describe('reading numstat', () => {
  it('reads counts and a path', () => {
    expect(parseNumstat(z('3\t1\tsrc/a.ts'))).toEqual([
      { path: 'src/a.ts', additions: 3, deletions: 1, binary: false },
    ]);
  });

  it('reads a path containing a space, which is the whole point', () => {
    expect(parseNumstat(z('1\t0\ta b.txt'))[0]!.path).toBe('a b.txt');
  });

  it('reads a path containing a tab, splitting on the first two only', () => {
    // A tab is legal in a filename and the format puts no quoting around it.
    expect(parseNumstat(z('1\t0\tweird\tname.txt'))[0]!.path).toBe('weird\tname.txt');
  });

  it('reads non-ASCII paths raw', () => {
    expect(parseNumstat(z('2\t2\t탐지성능_리포트.md'))[0]!.path).toBe('탐지성능_리포트.md');
  });

  it('reads a rename as two extra records, not as brace surgery', () => {
    // With -z the path field is EMPTY and the two real paths follow. Without it
    // the same rename arrives as `{old => new}` inside one string.
    expect(parseNumstat(z('1\t1\t', 'old/name.ts', 'new/name.ts'))).toEqual([
      { path: 'new/name.ts', oldPath: 'old/name.ts', additions: 1, deletions: 1, binary: false },
    ]);
  });

  it('marks a binary file and does not invent counts for it', () => {
    expect(parseNumstat(z('-\t-\timage.png'))).toEqual([
      { path: 'image.png', additions: 0, deletions: 0, binary: true },
    ]);
  });

  it('handles empty and malformed output', () => {
    expect(parseNumstat('')).toEqual([]);
    expect(parseNumstat('\0')).toEqual([]);
    expect(parseNumstat(z('nonsense'))).toEqual([]);
  });
});

describe('splitting the diff into files', () => {
  const TWO = [
    'diff --git a/one.ts b/one.ts',
    'index 111..222 100644',
    '--- a/one.ts',
    '+++ b/one.ts',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git a/two.ts b/two.ts',
    '@@ -1 +1 @@',
    '-c',
    '+d',
  ].join('\n');

  it('splits on the file marker', () => {
    const chunks = splitDiffByFile(TWO);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain('one.ts');
    expect(chunks[1]).toContain('two.ts');
  });

  it('is not fooled by the marker text appearing inside a diff', () => {
    // A file whose CONTENT is a diff — a patch checked into the repo, or this
    // very test file. Content lines are always prefixed, so they never start
    // with the marker.
    const tricky = [
      'diff --git a/patch.txt b/patch.txt',
      '@@ -1,2 +1,2 @@',
      '-diff --git a/x b/x',
      '+diff --git a/y b/y',
    ].join('\n');
    expect(splitDiffByFile(tricky)).toHaveLength(1);
  });

  it('handles no diff at all', () => {
    expect(splitDiffByFile('')).toEqual([]);
    expect(splitDiffByFile('\n')).toEqual([]);
  });
});

describe('reading one file’s hunks', () => {
  const CHUNK = [
    'diff --git a/x.ts b/x.ts',
    'index 111..222 100644',
    '--- a/x.ts',
    '+++ b/x.ts',
    '@@ -10,4 +10,5 @@ function thing() {',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '+const c = 4;',
    ' return a;',
  ].join('\n');

  it('numbers the lines from the hunk header', () => {
    const { hunks } = parseFileDiff(CHUNK);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.lines).toEqual([
      { kind: 'context', oldNum: 10, newNum: 10, text: 'const a = 1;' },
      { kind: 'del', oldNum: 11, text: 'const b = 2;' },
      { kind: 'add', newNum: 11, text: 'const b = 3;' },
      { kind: 'add', newNum: 12, text: 'const c = 4;' },
      { kind: 'context', oldNum: 12, newNum: 13, text: 'return a;' },
    ]);
  });

  it('keeps the section heading git puts after the @@', () => {
    // "which function am I looking at" is most of the value of a hunk header.
    expect(parseFileDiff(CHUNK).hunks[0]!.header).toContain('function thing()');
  });

  it('ignores every header line, including ones it has never seen', () => {
    // Nothing before the first @@ is interpreted, so a new header git invents
    // later cannot be misparsed as content.
    const withOddHeaders = CHUNK.replace(
      'index 111..222 100644',
      'index 111..222 100644\nsimilarity index 91%\nsomething-new 42',
    );
    expect(parseFileDiff(withOddHeaders).hunks[0]!.lines).toHaveLength(5);
  });

  it('does not count the no-newline note as a line', () => {
    // `\ No newline at end of file` is a note ABOUT the line above it. Counting
    // it would shift every line number after it by one.
    const chunk = ['diff --git a/x b/x', '@@ -1 +1 @@', '-a', '\\ No newline at end of file', '+b'].join('\n');
    const lines = parseFileDiff(chunk).hunks[0]!.lines;
    expect(lines.map((l) => l.text)).toEqual(['a', 'b']);
    expect(lines[1]).toEqual({ kind: 'add', newNum: 1, text: 'b' });
  });

  it('reads several hunks with their own numbering', () => {
    const chunk = [
      'diff --git a/x b/x',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+A',
      '@@ -50,1 +50,1 @@',
      '-z',
      '+Z',
    ].join('\n');
    const { hunks } = parseFileDiff(chunk);
    expect(hunks).toHaveLength(2);
    expect(hunks[1]!.oldStart).toBe(50);
    expect(hunks[1]!.lines[0]).toEqual({ kind: 'del', oldNum: 50, text: 'z' });
  });

  it('recognises a binary file', () => {
    const chunk = ['diff --git a/i.png b/i.png', 'Binary files a/i.png and b/i.png differ'].join('\n');
    const parsed = parseFileDiff(chunk);
    expect(parsed.binary).toBe(true);
    expect(parsed.hunks).toEqual([]);
  });

  it('stops at the cap and says so, rather than returning a lockfile', () => {
    const big = ['diff --git a/lock b/lock', '@@ -1,99999 +1,99999 @@']
      .concat(Array.from({ length: MAX_LINES_PER_FILE + 500 }, (_, i) => `+line ${i}`))
      .join('\n');
    const parsed = parseFileDiff(big);
    expect(parsed.truncated).toBe(true);
    expect(parsed.hunks[0]!.lines.length).toBeLessThanOrEqual(MAX_LINES_PER_FILE);
  });
});

describe('matching paths to hunks by position', () => {
  it('labels each chunk with the numstat path, never the header path', () => {
    // Both files have a space in the name, so the `diff --git` line is
    // unparseable for both. The result must still be right.
    const numstat = z('1\t1\ta b.txt', '2\t0\tc d.txt');
    const diff = [
      'diff --git a/a b.txt b/a b.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/c d.txt b/c d.txt',
      '@@ -0,0 +1,2 @@',
      '+one',
      '+two',
    ].join('\n');

    const files = buildDiffFiles(numstat, diff);
    expect(files.map((f) => f.path)).toEqual(['a b.txt', 'c d.txt']);
    expect(files[0]!.hunks[0]!.lines).toHaveLength(2);
    expect(files[1]!.additions).toBe(2);
  });

  it('carries a rename through to the file', () => {
    const files = buildDiffFiles(z('0\t0\t', 'old.ts', 'new.ts'), 'diff --git a/old.ts b/new.ts');
    expect(files[0]).toMatchObject({ path: 'new.ts', oldPath: 'old.ts' });
  });

  it('gives a binary file no hunks and does not call that an error', () => {
    const files = buildDiffFiles(z('-\t-\ti.png'), 'diff --git a/i.png b/i.png\nBinary files differ');
    expect(files[0]).toMatchObject({ path: 'i.png', binary: true, hunks: [] });
  });

  it('trusts numstat when the two lists disagree', () => {
    // Rather than shifting every later file onto the wrong path.
    const files = buildDiffFiles(z('1\t0\tonly.ts'), '');
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: 'only.ts', hunks: [] });
  });

  it('handles a clean tree', () => {
    expect(buildDiffFiles('', '')).toEqual([]);
  });
});

describe('the gap between hunks', () => {
  const hunk = (oldStart: number, count: number) => ({
    header: '',
    oldStart,
    newStart: oldStart,
    lines: Array.from({ length: count }, (_, i) => ({
      kind: 'context' as const,
      oldNum: oldStart + i,
      newNum: oldStart + i,
      text: '',
    })),
  });

  it('counts the lines before the first hunk', () => {
    expect(gapBefore(undefined, hunk(10, 3))).toBe(9);
  });

  it('counts the lines between two hunks', () => {
    // First hunk covers old lines 1–3; the next starts at 50, so 46 are hidden.
    expect(gapBefore(hunk(1, 3), hunk(50, 3))).toBe(46);
  });

  it('is zero when the hunks are adjacent', () => {
    expect(gapBefore(hunk(1, 3), hunk(4, 3))).toBe(0);
  });

  it('is zero, not negative, at the top of a file', () => {
    expect(gapBefore(undefined, hunk(1, 3))).toBe(0);
  });
});
