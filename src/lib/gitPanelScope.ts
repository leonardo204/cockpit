/**
 * gitPanelScope.ts — turning git's plumbing output into the three lists and two
 * numbers the git panel draws. Pure, no IO, so every one of these is pinned by
 * a test instead of by running a repository.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT IN `gitStatusScope.ts`
 *
 * That file answers ONE question for the file tree: is this path changed, and
 * how. It folds git's two status columns into a single state on purpose, since a
 * row has one colour. A staging panel needs the opposite: the columns held
 * APART, because `MM` is a file that is both staged and edited again, and it has
 * to appear in both lists with a different button beside each.
 *
 * So the porcelain SCAN stays there — shared, single-copy, already pinned — and
 * only the projection the panel needs lives here.
 */
import { parsePorcelainRecords } from './gitStatusScope';

// ─────────────────────────────────────────────────────────
// Working tree
// ─────────────────────────────────────────────────────────

/** What one row of the Changes list says. */
export interface GitChange {
  /** Path relative to the repository root. */
  path: string;
  /** git's letter for this side, lowercased into something readable. */
  kind: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'typechange';
  /** Where a rename came from, when git said so. */
  oldPath?: string;
}

export interface WorkingTree {
  /** Changes in the index — what `git commit` would record right now. */
  staged: GitChange[];
  /** Changes in the worktree only — what commit would leave behind. */
  unstaged: GitChange[];
  /**
   * Files needing resolution. Kept SEPARATE from the two lists above rather than
   * shown as ordinary edits: a conflicted file is a problem, and offering
   * "stage" beside it as though it were a normal change is how a half-resolved
   * merge gets committed.
   */
  conflicted: GitChange[];
}

/** One status letter → the word the panel shows. `null` for a column that says
 *  nothing happened on this side. */
function kindFromColumn(code: string): GitChange['kind'] | null {
  switch (code) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'typechange';
    case '?':
      return 'untracked';
    default:
      return null;
  }
}

/**
 * IS THIS PAIR A CONFLICT? The unmerged pairs are `DD AU UD UA DU AA UU` —
 * every one holds a `U`, except `DD` and `AA` which are the both-sides cases.
 *
 * This mirrors `statusFromColumns` in `gitStatusScope.ts` deliberately: that one
 * returns a colour and this one routes a row into a different list, and pointing
 * the second at the first would mean asking "what colour is it" to decide "can
 * it be staged".
 */
function isConflict(x: string, y: string): boolean {
  return x === 'U' || y === 'U' || (x === 'D' && y === 'D') || (x === 'A' && y === 'A');
}

/**
 * Split `git status --porcelain -z` into the panel's three lists.
 *
 * A file appears in BOTH `staged` and `unstaged` when both columns are set, and
 * that is not a bug to be deduplicated — it is the one thing the panel exists to
 * show that a colour cannot.
 */
export function splitWorkingTree(stdout: string): WorkingTree {
  const staged: GitChange[] = [];
  const unstaged: GitChange[] = [];
  const conflicted: GitChange[] = [];

  for (const rec of parsePorcelainRecords(stdout)) {
    const { x, y, path, oldPath } = rec;

    if (isConflict(x, y)) {
      conflicted.push({ path, kind: 'modified' });
      continue;
    }

    // UNTRACKED IS NOT AN INDEX STATE. `??` fills both columns, and reading the
    // first one would file a brand-new file under "staged".
    if (x === '?' && y === '?') {
      unstaged.push({ path, kind: 'untracked' });
      continue;
    }

    // Ignored files reach here only if the caller dropped `--ignored=no`. They
    // are not changes.
    if (x === '!' && y === '!') continue;

    const stagedKind = kindFromColumn(x);
    if (stagedKind) {
      staged.push(oldPath ? { path, kind: stagedKind, oldPath } : { path, kind: stagedKind });
    }

    const unstagedKind = kindFromColumn(y);
    if (unstagedKind) unstaged.push({ path, kind: unstagedKind });
  }

  return { staged, unstaged, conflicted };
}

// ─────────────────────────────────────────────────────────
// Branch and upstream
// ─────────────────────────────────────────────────────────

export interface AheadBehind {
  ahead: number;
  behind: number;
}

/**
 * Parse `git rev-list --left-right --count <upstream>...HEAD`, which prints two
 * numbers separated by a tab: BEHIND first, then AHEAD.
 *
 * The order is the part worth pinning. `--left-right` counts the left side of
 * the range first, and the left side here is the upstream — so the first number
 * is commits they have that we do not. Swapping them silently turns "pull 3"
 * into "push 3".
 */
export function parseAheadBehind(stdout: string): AheadBehind | null {
  const parts = stdout.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const behind = Number.parseInt(parts[0]!, 10);
  const ahead = Number.parseInt(parts[1]!, 10);
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return null;
  return { ahead, behind };
}

/**
 * Parse `git for-each-ref --format=%(refname:short)%00%(upstream:short)%00%(HEAD)`.
 *
 * Read from for-each-ref rather than `git branch`, because `git branch` decorates
 * its output for humans (a `* ` marker, `(HEAD detached at …)`, colour when it
 * thinks it is a terminal) and every one of those has to be stripped back off.
 */
export interface BranchRef {
  name: string;
  /** The remote-tracking branch, when one is configured. */
  upstream?: string;
  /** Whether HEAD is on this branch. */
  current: boolean;
}

export function parseBranchRefs(stdout: string): BranchRef[] {
  const out: BranchRef[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [name, upstream, head] = line.split('\0');
    if (!name) continue;
    out.push({
      name,
      ...(upstream ? { upstream } : {}),
      current: head?.trim() === '*',
    });
  }
  return out;
}

/**
 * Remote-tracking branches, minus the symbolic `origin/HEAD`.
 *
 * `origin/HEAD` is a pointer at another entry in the same list, not a branch
 * anybody checks out, and leaving it in means offering the reader a duplicate of
 * `origin/main` under a name that will not survive a default-branch change.
 */
export function parseRemoteRefs(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((name) => !name.endsWith('/HEAD'));
}

/**
 * What HEAD is, in the two ways it can be.
 *
 * A DETACHED HEAD IS REPORTED AS SUCH rather than as a branch called "HEAD",
 * which is what `rev-parse --abbrev-ref HEAD` prints for it. The panel disables
 * push and branch-relative actions in that state, and it can only do that if the
 * state reaches it.
 */
export interface HeadState {
  branch: string | null;
  detached: boolean;
}

export function parseHead(stdout: string): HeadState {
  const name = stdout.trim();
  if (!name || name === 'HEAD') return { branch: null, detached: true };
  return { branch: name, detached: false };
}
