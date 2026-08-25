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
export type GitFileState = 'conflicted' | 'added' | 'modified' | 'deleted' | 'untracked';

export interface GitStatusEntry {
  /** Path relative to the repository root, exactly as git prints it. */
  path: string;
  state: GitFileState;
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
export function statusFromColumns(x: string, y: string): GitFileState | null {
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
  const records = stdout.split('\0');
  const out: GitStatusEntry[] = [];

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
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i++;

    const state = statusFromColumns(x, y);
    if (!state) continue;

    out.push({ path, state, staged: x !== ' ' && x !== '?' });
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
const PRECEDENCE: readonly GitFileState[] = [
  'conflicted',
  'added',
  'modified',
  'deleted',
  'untracked',
];

export function mostUrgent(states: readonly GitFileState[]): GitFileState | null {
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
export function buildStatusMap(entries: readonly GitStatusEntry[]): Record<string, GitFileState> {
  const byPath = new Map<string, GitFileState[]>();

  const add = (path: string, state: GitFileState) => {
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

  const out: Record<string, GitFileState> = {};
  for (const [path, states] of byPath) {
    const state = mostUrgent(states);
    if (state) out[path] = state;
  }
  return out;
}

/** What the route answers. `truncated` is stated rather than silently implied:
 *  a tree with no colours because the answer was cut off must be
 *  distinguishable from a tree with nothing to colour. */
export interface GitStatusResult {
  ok: true;
  /** Absent when the directory is not a git repository at all — which is not an
   *  error, just a project without version control. */
  repo: boolean;
  changed: Record<string, GitFileState>;
  truncated: boolean;
}
