/**
 * gitStatusScope.ts — reading `git status --porcelain` into what the file tree
 * needs to colour a row.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR, AND WHAT IT DELIBERATELY IS NOT
 *
 * The sidebar wants one thing: is this file changed, and how. It does not stage,
 * diff, commit, or branch — a full git integration once lived in this app and
 * was deleted with the explorer package, and rebuilding it to tint some text
 * would be paying for a feature nobody asked for. So this reads ONE command and
 * answers ONE question.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE PARSING IS HERE AND NOT IN THE ROUTE
 *
 * Porcelain v1 is a fixed-column format with several ways to be misread, and
 * every one of them fails silently — a wrong colour, or a file that is quietly
 * never coloured at all:
 *
 *   - the path starts at column 3, and column 2 is a SPACE that is part of the
 *     format, not padding to be trimmed;
 *   - a rename is TWO paths in one entry, and with `-z` they are separate
 *     NUL-terminated records rather than an ` -> ` pair;
 *   - `??` is not a status letter in either column, it is its own thing;
 *   - a status has TWO columns, and a file can be staged AND modified again.
 *
 * None of that is visible from a colour, so it is parsed here, purely, and
 * pinned by tests.
 */

/**
 * What a row can say. Ordered by how much the reader needs to know, which is
 * also the precedence used when one path somehow appears twice.
 *
 * `conflicted` is first because it is the only one that is a PROBLEM rather than
 * a fact — a file needing resolution must not be shown as an ordinary edit.
 */
export type FileChangeState =
  | 'conflicted'
  | 'added'
  | 'modified'
  | 'deleted'
  | 'untracked'
  /**
   * CHANGED SINCE THE PROJECT WAS OPENED — the only state a project WITHOUT git
   * can honestly report, and the reason this type is no longer called
   * `GitFileState`.
   *
   * git's four states all mean "differs from the commit you made", a baseline
   * the user created deliberately. A project with no repository has no such
   * baseline, so one has to be chosen, and the only one that needs no history
   * and no configuration is the moment the project was opened.
   *
   * It is deliberately ONE state rather than an imitation of the other four.
   * mtime says a file was written; it cannot say whether that made it new,
   * edited or conflicted, and colouring a rewritten file "modified" would be
   * claiming a comparison that never happened.
   */
  | 'touched';

/** @deprecated The old name, kept so the git-only readers still compile. */
export type GitFileState = FileChangeState;

export interface GitStatusEntry {
  /** Path relative to the repository root, exactly as git prints it. */
  path: string;
  state: FileChangeState;
  /** Whether the change is (also) in the index. The tree does not colour by
   *  this today; it is here because the status columns carry it and dropping it
   *  at the parse step would mean re-running git to get it back. */
  staged: boolean;
}

/**
 * How many entries are worth returning.
 *
 * A repository mid-rebase, or one where someone deleted `node_modules` from the
 * index, can report tens of thousands of paths. The tree colours what is on
 * screen — a few dozen rows — so a larger answer is bytes nobody reads, and a
 * response big enough to stall the panel is worse than no colour at all. Past
 * this, the route reports the overflow instead (see `GitStatusResult`).
 */
export const MAX_STATUS_ENTRIES = 5000;

/** The two porcelain columns → one state.
 *
 *  X is the INDEX and Y is the WORKTREE. A file that was staged and then edited
 *  again reads `MM`, and the honest single answer is "modified". The columns are
 *  therefore folded in a fixed order rather than concatenated into a lookup of
 *  every pair, which would be 50-odd cases most of which never occur. */
export function statusFromColumns(x: string, y: string): FileChangeState | null {
  // Untracked and ignored come as their own two-character codes, not as a
  // column pair — `??` has no index half to read.
  if (x === '?' && y === '?') return 'untracked';
  if (x === '!' && y === '!') return null;

  // UNMERGED, and it takes precedence over everything below. The pairs are
  // `DD`, `AU`, `UD`, `UA`, `DU`, `AA`, `UU` — every one of which contains a
  // `U`, except `DD` and `AA` which are both-sides cases.
  if (x === 'U' || y === 'U' || (x === 'D' && y === 'D') || (x === 'A' && y === 'A')) {
    return 'conflicted';
  }

  // A deletion in EITHER column: staged removal (`D `) or an unstaged one
  // (` D`). Checked before `added`/`modified` so a file staged-added and then
  // deleted from the worktree (`AD`) reads as gone rather than as new.
  if (x === 'D' || y === 'D') return 'deleted';

  if (x === 'A') return 'added';
  if (x === 'M' || y === 'M' || x === 'R' || y === 'R' || x === 'C' || y === 'C') {
    return 'modified';
  }
  // `T` (type change: file ↔ symlink) is a modification as far as a reader is
  // concerned.
  if (x === 'T' || y === 'T') return 'modified';
  return null;
}

/**
 * Parse the output of `git status --porcelain -z -uall`.
 *
 * `-z` IS NOT OPTIONAL and the reason is a correctness one, not a performance
 * one: without it git quotes paths containing spaces, quotes or non-ASCII bytes,
 * and this project's own tree has Korean filenames. Parsing quoted output means
 * reimplementing C-string unescaping; with `-z` the path is raw bytes between
 * NULs and there is nothing to unescape.
 *
 * A RENAME COSTS TWO RECORDS. With `-z`, `R` entries are followed by a bare
 * record holding the ORIGINAL path — no `->`, no quoting. It is consumed here
 * and reported as a modification of the new path, because that is the file that
 * now exists; the old one is gone and colouring a row that is not in the tree
 * would be colouring nothing.
 */
export function parsePorcelain(stdout: string): GitStatusEntry[] {
  const out: GitStatusEntry[] = [];

  for (const rec of parsePorcelainRecords(stdout)) {
    const state = statusFromColumns(rec.x, rec.y);
    if (!state) continue;
    out.push({ path: rec.path, state, staged: rec.x !== ' ' && rec.x !== '?' });
  }

  return out;
}

/**
 * ONE RECORD AS GIT WROTE IT — both columns kept apart, and the rename source
 * kept rather than skipped.
 *
 * `parsePorcelain` above folds the two columns into the single answer a tree row
 * needs, which is the right answer for a colour and the WRONG one for a staging
 * panel: `MM` means "staged, and edited again since", and a panel that shows the
 * file only once cannot offer to unstage half of it. So the scan lives here and
 * is projected two ways, rather than being written twice — a second porcelain
 * parser is exactly the kind of duplicate this file's own header warns about.
 */
export interface GitPorcelainRecord {
  /** Index column. `' '` for unmodified, `'?'` for untracked. */
  x: string;
  /** Worktree column. */
  y: string;
  /** Path relative to the repository root, raw bytes between NULs. */
  path: string;
  /** Where a rename or copy came from, when git said so. */
  oldPath?: string;
}

export function parsePorcelainRecords(stdout: string): GitPorcelainRecord[] {
  const records = stdout.split('\0');
  const out: GitPorcelainRecord[] = [];

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    // The final NUL leaves an empty tail; a blank record mid-stream is not a
    // format we should guess at either.
    if (!rec || rec.length < 4) continue;

    const x = rec[0]!;
    const y = rec[1]!;
    const path = rec.slice(3);
    if (!path) continue;

    // Consume the rename/copy source that follows, so it is never read as an
    // entry in its own right — its first two characters are part of a PATH and
    // would parse as an arbitrary status.
    let oldPath: string | undefined;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      i++;
      const src = records[i];
      if (src) oldPath = src;
    }

    out.push(oldPath === undefined ? { x, y, path } : { x, y, path, oldPath });
  }

  return out;
}

// ─────────────────────────────────────────────────────────
// From a flat list to something a tree row can ask
// ─────────────────────────────────────────────────────────

/**
 * Which state a FOLDER shows, given the states of everything beneath it.
 *
 * A closed folder is the only sign that something changed inside it, so it takes
 * the most urgent state below it — the same precedence `GitFileState` is ordered
 * in. A folder holding one conflict and forty edits is a folder with a conflict
 * in it.
 */
const PRECEDENCE: readonly FileChangeState[] = [
  'conflicted',
  'added',
  'modified',
  'deleted',
  'untracked',
  // Last, because it is the weakest claim of the six — "something wrote to this"
  // rather than "this differs from a known baseline". It also never shares a
  // tree with the others: a project either has git or it does not.
  'touched',
];

export function mostUrgent(states: readonly FileChangeState[]): FileChangeState | null {
  for (const s of PRECEDENCE) {
    if (states.includes(s)) return s;
  }
  return null;
}

/**
 * The lookup the tree actually uses: every path that should be coloured, files
 * and the folders above them alike.
 *
 * FOLDERS ARE ROLLED UP HERE rather than computed in the component, because the
 * tree has no whole-tree data structure — each expanded directory holds its own
 * children and knows nothing about what is collapsed beneath it. A row asking
 * "am I changed?" can only be answered by a map that already accounts for
 * depth, and building that map is a fold over the flat list, which is exactly
 * the kind of thing that belongs beside its own tests.
 *
 * `src/a/b.ts` therefore contributes an entry for `src/a/b.ts`, `src/a` and
 * `src`.
 */
export function buildStatusMap(entries: readonly GitStatusEntry[]): Record<string, FileChangeState> {
  const byPath = new Map<string, FileChangeState[]>();

  const add = (path: string, state: FileChangeState) => {
    const list = byPath.get(path);
    if (list) list.push(state);
    else byPath.set(path, [state]);
  };

  for (const e of entries) {
    add(e.path, e.state);
    // Every ancestor, up to but NOT including the repository root: the root is
    // the panel itself and tinting it would say "something, somewhere, changed",
    // which the reader already knows.
    const parts = e.path.split('/');
    for (let i = parts.length - 1; i > 0; i--) {
      add(parts.slice(0, i).join('/'), e.state);
    }
  }

  const out: Record<string, FileChangeState> = {};
  for (const [path, states] of byPath) {
    const state = mostUrgent(states);
    if (state) out[path] = state;
  }
  return out;
}

// ─────────────────────────────────────────────────────────
// The baseline a project WITHOUT git gets
// ─────────────────────────────────────────────────────────

/**
 * How long the "just opened" grace period is.
 *
 * A file written in the same second the project opened is genuinely ambiguous —
 * clock granularity on some filesystems is one second, and `openedAt` is read
 * from a different clock than the one that stamped the file. Rather than colour
 * a project's worth of untouched files on a rounding error, anything at or
 * before the baseline is left alone.
 *
 * It cuts the other way too: a file the user edits immediately after opening is
 * missed for one second. That is the cheaper mistake by a wide margin — a tree
 * that lights up entirely on open is a tree nobody looks at again.
 */
export const TOUCHED_GRACE_MS = 1000;

/** Was this file written after the project was opened? */
export function isTouchedSince(mtimeMs: number, openedAt: number): boolean {
  return mtimeMs > openedAt + TOUCHED_GRACE_MS;
}

/**
 * How deep the walk goes.
 *
 * A project without git is also a project without `.gitignore`, so the walk is
 * bounded by the watcher's own ignore list plus this. Deep enough for any source
 * tree; shallow enough that a symlink loop or a mounted volume cannot hold the
 * request open. (`readdir` does not follow symlinked directories here, so the
 * loop case is theoretical — the bound is for the pathological real tree.)
 */
export const MAX_WALK_DEPTH = 12;

/** What the route answers. `truncated` is stated rather than silently implied:
 *  a tree with no colours because the answer was cut off must be
 *  distinguishable from a tree with nothing to colour. */
export interface GitStatusResult {
  ok: true;
  /** Absent when the directory is not a git repository at all — which is not an
   *  error, just a project without version control. */
  repo: boolean;
  changed: Record<string, FileChangeState>;
  truncated: boolean;
}
