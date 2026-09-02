/**
 * gitPanelTypes.ts — the wire shapes of `/api/git/*`, on the client side.
 *
 * DUPLICATED FROM `src/lib/gitPanelScope.ts` AND `src/lib/gitLogScope.ts` ON
 * PURPOSE, for the same reason `gitStatusTypes.ts` beside this file is: `src/`
 * is the boot tree and this is a package, and a package that imports out of the
 * app's own source directory inverts the dependency — the app would no longer be
 * something you can build the packages without.
 *
 * These are the only types crossing the wire, so keeping them in step is a
 * matter of the two files agreeing on eight field names, not of sharing code.
 */

// ─────────────────────────────────────────────────────────
// Working tree
// ─────────────────────────────────────────────────────────

export type GitChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'typechange';

export interface GitChange {
  path: string;
  kind: GitChangeKind;
  oldPath?: string;
}

export interface GitBranchRef {
  name: string;
  upstream?: string;
  current: boolean;
}

export interface GitHeadState {
  branch: string | null;
  detached: boolean;
}

/** What `GET /api/git/overview?cwd=…` answers. */
export type GitOverview =
  | { ok: false; reason: 'invalid-cwd' }
  | { ok: true; repo: false }
  | {
      ok: true;
      repo: true;
      root: string;
      head: GitHeadState;
      /** The remote-tracking branch of the current branch, or null when it
       *  tracks nothing. NOT guessed at — see the route. */
      upstream: string | null;
      aheadBehind: { ahead: number; behind: number } | null;
      branches: GitBranchRef[];
      remoteBranches: string[];
      remotes: string[];
      staged: GitChange[];
      unstaged: GitChange[];
      conflicted: GitChange[];
    };

// ─────────────────────────────────────────────────────────
// Graph
// ─────────────────────────────────────────────────────────

export interface GitRef {
  name: string;
  kind: 'head' | 'branch' | 'remote' | 'tag';
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  authorEmail: string;
  date: string;
  subject: string;
  refs: GitRef[];
}

export interface GraphEdge {
  fromLane: number;
  toLane: number;
  colour: number;
}

export interface GraphRow {
  commit: GitCommit;
  lane: number;
  colour: number;
  edges: GraphEdge[];
}

/** What `GET /api/git/log?cwd=…&limit=…&offset=…` answers. */
export type GitLogResponse =
  | { ok: false; reason: 'invalid-cwd' }
  | { ok: true; repo: boolean; rows: GraphRow[]; laneCount: number; hasMore: boolean };

// ─────────────────────────────────────────────────────────
// Diff
// ─────────────────────────────────────────────────────────

export interface DiffLine {
  kind: 'context' | 'add' | 'del';
  oldNum?: number;
  newNum?: number;
  text: string;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
  /** git would not diff it. `hunks` is empty and that is the honest answer, not
   *  a missing one. */
  binary: boolean;
  hunks: DiffHunk[];
  truncated?: boolean;
}

/** What `GET /api/git/diff?cwd=…` answers, for a `path` or a `commit`. */
export type DiffResponse =
  | { ok: false; reason: 'invalid-cwd' | 'bad-path' | 'bad-commit' | 'failed' }
  | { ok: true; files: DiffFile[]; truncated: boolean };

// ─────────────────────────────────────────────────────────
// There are no write types here, and that is the design
// ─────────────────────────────────────────────────────────
//
// An earlier draft of this panel had buttons — stage, commit, pull, push,
// discard — behind a `POST /api/git/op` with an argv allowlist. They were
// removed deliberately, along with the route.
//
// naby's user is not a person who knows git's command set; they are a person who
// asks naby for things in a sentence. Given that, a row of git buttons is the
// wrong shape twice over. It offers the shallow half of git (the operations with
// no decisions in them) while the half that actually needs judgement — a
// conflict, a rebase, a branch that should never have been pushed — still ends
// in "do this in a terminal", which is the one instruction this user cannot
// follow. And it splits the work in two: some of it done by clicking, some by
// asking, with nothing to say which is which.
//
// So the panel SHOWS and naby DOES. Every action lives in one place, expressed
// the way this user already expresses everything else, and the panel's job is to
// make the repository legible enough to ask a good question about.
