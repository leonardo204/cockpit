import { describe, it, expect } from 'vitest';
import {
  WATCH_BATCH_MAX,
  WATCH_COALESCE_MS,
  WATCH_IGNORED_DIRS,
  changedDirOf,
  coalesceChangedDirs,
  isIgnoredWatchPath,
  supportsRecursiveWatch,
  isGitStatusSignal,
  isGitRefsSignal,
  gitDirFromPointer,
  GIT_SIGNAL_COALESCE_MS,
} from './fsWatchScope';

/**
 * The watcher's judgement, pinned here rather than through the WebSocket that
 * uses it. Every case below is one a user would feel: a missed refresh, a
 * refresh of the wrong folder, a flood that makes the panel unusable, or a
 * crash on a platform that cannot watch recursively.
 */

describe('isIgnoredWatchPath — the list that makes this feature usable', () => {
  it('ignores the loud directories at any depth', () => {
    expect(isIgnoredWatchPath('node_modules')).toBe(true);
    expect(isIgnoredWatchPath('node_modules/react/index.js')).toBe(true);
    expect(isIgnoredWatchPath('packages/app/node_modules/react/index.js')).toBe(true);
    expect(isIgnoredWatchPath('.git')).toBe(true);
    expect(isIgnoredWatchPath('.git/refs/heads/main')).toBe(true);
    expect(isIgnoredWatchPath('sub/.git/index')).toBe(true);
    expect(isIgnoredWatchPath('dist/bundle.js')).toBe(true);
    expect(isIgnoredWatchPath('.next/static/chunk.js')).toBe(true);
    expect(isIgnoredWatchPath('.next-prod/server/page.js')).toBe(true);
    expect(isIgnoredWatchPath('coverage/lcov.info')).toBe(true);
  });

  it('does NOT ignore a file that merely CONTAINS an ignored name', () => {
    // This is the boundary the whole rule turns on: matching is per PATH
    // SEGMENT, so real documents with unlucky names survive.
    expect(isIgnoredWatchPath('my.git.md')).toBe(false);
    expect(isIgnoredWatchPath('node_modules_notes.md')).toBe(false);
    expect(isIgnoredWatchPath('docs/node_modules.md')).toBe(false);
    expect(isIgnoredWatchPath('src/dist-tags.json')).toBe(false);
    expect(isIgnoredWatchPath('src/gitignore-parser.ts')).toBe(false);
    expect(isIgnoredWatchPath('build-scripts/deploy.sh')).toBe(false);
  });

  it('ignores OS bookkeeping files by exact name only', () => {
    expect(isIgnoredWatchPath('.DS_Store')).toBe(true);
    expect(isIgnoredWatchPath('src/.DS_Store')).toBe(true);
    expect(isIgnoredWatchPath('src/.DS_Store.bak')).toBe(false);
  });

  it('reads Windows separators the same way', () => {
    expect(isIgnoredWatchPath('packages\\app\\node_modules\\react\\index.js')).toBe(true);
    expect(isIgnoredWatchPath('docs\\node_modules.md')).toBe(false);
  });

  it('names the directories the design constraint called out', () => {
    // A regression here is silent: dropping one entry does not fail anything,
    // it just floods the panel the next time someone runs a build.
    for (const dir of ['node_modules', '.git', 'dist', '.next', '.next-prod', 'coverage']) {
      expect(WATCH_IGNORED_DIRS.has(dir)).toBe(true);
    }
  });
});

describe('changedDirOf — which folder actually needs re-listing', () => {
  it('maps a nested file to its OWN parent, not the root', () => {
    expect(changedDirOf('src/a/b.ts')).toBe('src/a');
    expect(changedDirOf('src/a/b/c/d.ts')).toBe('src/a/b/c');
  });

  it('maps a top-level entry to the project root', () => {
    expect(changedDirOf('README.md')).toBe('');
    expect(changedDirOf('newfolder')).toBe('');
  });

  it('maps a new or deleted FOLDER to the parent that lists it', () => {
    // Creating `src/feature/` is a change to `src`'s listing; the new folder is
    // not on screen yet and has nothing to re-fetch.
    expect(changedDirOf('src/feature')).toBe('src');
  });

  it('reads Windows separators', () => {
    expect(changedDirOf('src\\a\\b.ts')).toBe('src/a');
    expect(changedDirOf('README.md')).toBe('');
    expect(changedDirOf('src\\feature')).toBe('src');
  });

  it('refuses anything that names a path outside the project', () => {
    // The watch root is the trust boundary. `fs.watch` reports names relative
    // to it, so any of these means an assumption broke — refuse, do not resolve.
    expect(changedDirOf('../sibling/file.ts')).toBe(null);
    expect(changedDirOf('..')).toBe(null);
    expect(changedDirOf('src/../../escape.ts')).toBe(null);
    expect(changedDirOf('/etc/passwd')).toBe(null);
    expect(changedDirOf('\\\\server\\share\\file.ts')).toBe(null);
    expect(changedDirOf('C:\\Windows\\system.ini')).toBe(null);
  });

  it('refuses an ignored path and a nameless event', () => {
    expect(changedDirOf('node_modules/react/index.js')).toBe(null);
    expect(changedDirOf('.git/index')).toBe(null);
    expect(changedDirOf(null)).toBe(null);
    expect(changedDirOf(undefined)).toBe(null);
    expect(changedDirOf('')).toBe(null);
  });

  it('still accepts a file whose name looks like a drive letter on POSIX', () => {
    // The absolute-path guard requires a separator after the colon, so this is
    // an ordinary (if unwise) file name rather than a rejected path.
    expect(changedDirOf('C:notes')).toBe('');
  });
});

describe('coalesceChangedDirs — one bump per directory per window', () => {
  it('collapses the several events one save produces', () => {
    // write + rename-from-temp + attribute touch, all in one directory.
    expect(
      coalesceChangedDirs(['src/a/b.ts', 'src/a/b.ts.tmp', 'src/a/b.ts']),
    ).toEqual(['src/a']);
  });

  it('collapses two files in the same directory into one refresh', () => {
    expect(coalesceChangedDirs(['src/a.ts', 'src/b.ts'])).toEqual(['src']);
  });

  it('keeps distinct directories, in first-seen order', () => {
    expect(
      coalesceChangedDirs(['src/a/x.ts', 'README.md', 'src/b/y.ts', 'src/a/z.ts']),
    ).toEqual(['src/a', '', 'src/b']);
  });

  it('drops the noise before it reaches the client', () => {
    expect(
      coalesceChangedDirs([
        'node_modules/react/index.js',
        '.git/index',
        'src/.DS_Store',
        null,
        'src/real.ts',
      ]),
    ).toEqual(['src']);
  });

  it('returns nothing for a window that was all noise', () => {
    expect(coalesceChangedDirs(['node_modules/a', 'node_modules/b'])).toEqual([]);
    expect(coalesceChangedDirs([])).toEqual([]);
  });
});

describe('supportsRecursiveWatch — degrade, never crash', () => {
  it('says yes on macOS and Windows regardless of Node version', () => {
    expect(supportsRecursiveWatch('darwin', 'v20.0.0')).toBe(true);
    expect(supportsRecursiveWatch('win32', 'v20.0.0')).toBe(true);
  });

  it('says yes on Linux only from Node 20.13 / 22', () => {
    expect(supportsRecursiveWatch('linux', 'v20.13.0')).toBe(true);
    expect(supportsRecursiveWatch('linux', 'v20.19.4')).toBe(true);
    expect(supportsRecursiveWatch('linux', 'v22.0.0')).toBe(true);
    expect(supportsRecursiveWatch('linux', 'v24.4.1')).toBe(true);
  });

  it('says no on the Linux versions inside engines.node that lack it', () => {
    // `engines.node` is ">=20", so these hosts are supported and must degrade
    // rather than meet ERR_FEATURE_UNAVAILABLE_ON_PLATFORM.
    expect(supportsRecursiveWatch('linux', 'v20.0.0')).toBe(false);
    expect(supportsRecursiveWatch('linux', 'v20.12.2')).toBe(false);
    expect(supportsRecursiveWatch('linux', 'v21.7.3')).toBe(false);
  });

  it('says no for an unknown platform or an unreadable version', () => {
    expect(supportsRecursiveWatch('freebsd', 'v24.0.0')).toBe(false);
    expect(supportsRecursiveWatch('aix', 'v24.0.0')).toBe(false);
    expect(supportsRecursiveWatch('linux', 'not-a-version')).toBe(false);
  });

  it('agrees with the host this suite is running on', () => {
    // Cheap canary: if the predicate ever disagrees with reality here, the
    // developer machine stops auto-refreshing and nobody would know why.
    expect(supportsRecursiveWatch(process.platform, process.version)).toBe(
      process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux',
    );
  });
});

describe('window constants', () => {
  it('coalesces over a window wide enough for one save, short enough to feel live', () => {
    expect(WATCH_COALESCE_MS).toBeGreaterThanOrEqual(200);
    expect(WATCH_COALESCE_MS).toBeLessThanOrEqual(400);
  });

  it('bounds one window instead of letting it grow without limit', () => {
    expect(WATCH_BATCH_MAX).toBeGreaterThan(0);
  });
});

describe('the git-status signal', () => {
  it('reacts to the four files that move the answer', () => {
    for (const f of ['index', 'HEAD', 'MERGE_HEAD', 'ORIG_HEAD']) {
      expect(isGitStatusSignal(f), f).toBe(true);
    }
  });

  it('IGNORES index.lock', () => {
    // Created and deleted around every one of those operations. Reacting to it
    // would mean reading the status mid-write — the one moment git's own answer
    // is not to be trusted.
    expect(isGitStatusSignal('index.lock')).toBe(false);
  });

  it('ignores the churn that made watching .git wholesale impossible', () => {
    for (const f of [
      'objects/ab/cdef',
      'logs/HEAD',
      'COMMIT_EDITMSG',
      'refs/heads/main',
      'FETCH_HEAD',
      'config',
    ]) {
      expect(isGitStatusSignal(f), f).toBe(false);
    }
  });

  it('coalesces for longer than the tree does', () => {
    // One `git commit` touches index, HEAD and ORIG_HEAD within milliseconds; a
    // rebase does it once per replayed commit.
    expect(GIT_SIGNAL_COALESCE_MS).toBeGreaterThan(WATCH_COALESCE_MS);
  });
});

describe('finding the git directory', () => {
  it('reads a submodule pointer — this repo’s own shell is one', () => {
    // `shell/.git` is a FILE. Watching it would see nothing, because git updates
    // the real directory and never the pointer.
    expect(gitDirFromPointer('gitdir: ../.git/modules/shell\n')).toBe('../.git/modules/shell');
  });

  it('reads a linked worktree pointer', () => {
    expect(gitDirFromPointer('gitdir: /repo/.git/worktrees/feature')).toBe(
      '/repo/.git/worktrees/feature',
    );
  });

  it('tolerates trailing whitespace and CRLF', () => {
    expect(gitDirFromPointer('gitdir: ../x  \r\n')).toBe('../x');
  });

  it('refuses what it does not recognise rather than guessing', () => {
    // A watch on the wrong directory is a feature that reports someone else's
    // commits. No watch is the better answer; the refresh button still works.
    expect(gitDirFromPointer('')).toBeNull();
    expect(gitDirFromPointer('gitdir:')).toBeNull();
    expect(gitDirFromPointer('gitdir:   ')).toBeNull();
    expect(gitDirFromPointer('ref: refs/heads/main')).toBeNull();
  });
});

/**
 * The refs signal, pinned against a measurement.
 *
 * Each command below was run against a real repository with a recursive watch
 * on `.git` recording what it touched. The point of the suite is the FIRST
 * group: five ordinary git commands that write neither `index` nor `HEAD`, and
 * were therefore invisible to this app until this predicate existed.
 */
describe('what says the branches or counters moved', () => {
  it('catches a fetch — which writes FETCH_HEAD and nothing else flat', () => {
    expect(isGitRefsSignal('FETCH_HEAD')).toBe(true);
    expect(isGitStatusSignal('FETCH_HEAD')).toBe(false);
  });

  it('catches a branch created or deleted', () => {
    // `git branch feature-x` touches ONE path, and it is nested.
    expect(isGitRefsSignal('refs/heads/feature-x')).toBe(true);
    // The refs watcher reports paths relative to refs/, so both shapes count.
    expect(isGitRefsSignal('heads/feature-x')).toBe(true);
  });

  it('catches a push, which only moves a remote-tracking ref', () => {
    expect(isGitRefsSignal('refs/remotes/origin/main')).toBe(true);
    expect(isGitRefsSignal('remotes/origin/main')).toBe(true);
  });

  it('catches a tag', () => {
    expect(isGitRefsSignal('refs/tags/v1.0')).toBe(true);
    expect(isGitRefsSignal('tags/v1.0')).toBe(true);
  });

  it('catches a remote being added, which writes only config', () => {
    expect(isGitRefsSignal('config')).toBe(true);
  });

  it('catches gc folding every loose ref into one file', () => {
    expect(isGitRefsSignal('packed-refs')).toBe(true);
  });

  it('ignores the half-written temporaries', () => {
    // Same reasoning as `index.lock` for the status signal: reacting to these
    // means reading refs in the middle of being rewritten.
    expect(isGitRefsSignal('packed-refs.new')).toBe(false);
    expect(isGitRefsSignal('refs/heads/main.lock')).toBe(false);
    expect(isGitRefsSignal('config.lock')).toBe(false);
  });

  it('ignores the churn the narrow watch exists to avoid', () => {
    expect(isGitRefsSignal('objects/ab/cdef')).toBe(false);
    expect(isGitRefsSignal('logs/HEAD')).toBe(false);
    expect(isGitRefsSignal('COMMIT_EDITMSG')).toBe(false);
    expect(isGitRefsSignal('index')).toBe(false);
  });

  it('leaves the status signal exactly as it was', () => {
    // The file tree's contract must not widen: these four and no more.
    for (const f of ['index', 'HEAD', 'MERGE_HEAD', 'ORIG_HEAD']) {
      expect(isGitStatusSignal(f), f).toBe(true);
    }
    for (const f of ['FETCH_HEAD', 'packed-refs', 'config', 'refs/heads/main']) {
      expect(isGitStatusSignal(f), f).toBe(false);
    }
  });
});
