/**
 * gitStatusTypes.ts — the wire shape of /api/git-status, on the client side.
 *
 * A HAND-WRITTEN COPY, DELIBERATELY. The server's definition lives in
 * `src/lib/gitStatusScope.ts`, and `src/` is the Next.js boot layer — nothing in
 * `packages/` may depend on it (MODULES.md: "Nothing depends on src/"). Importing
 * across that line to save six lines of type would invert the dependency graph
 * the whole package layout exists to keep acyclic.
 *
 * The two are kept honest by the route's own test, which asserts the states it
 * actually emits, and by this union being the only thing the tint function will
 * accept — a state added on one side and forgotten here fails the switch's
 * exhaustiveness, not silently at runtime.
 */

/** What a row can say about itself. See `src/lib/gitStatusScope.ts` for how the
 *  two porcelain columns are folded into one of these. */
export type FileChangeState =
  | 'conflicted'
  | 'added'
  | 'modified'
  | 'deleted'
  | 'untracked'
  /** Written since the project was opened — the one state a project WITHOUT git
   *  can honestly report, and why this type is no longer named for git. See
   *  `src/lib/gitStatusScope.ts` for why it is one state and not four. */
  | 'touched';

/** The old name. Kept so the readers that only ever see git states compile
 *  unchanged. */
export type GitFileState = FileChangeState;

/** What `GET /api/git-status?cwd=…` answers.
 *
 *  `repo: false` is not a failure — a project without version control is an
 *  ordinary project with nothing to colour. */
export interface GitStatusResponse {
  ok: boolean;
  reason?: string;
  repo?: boolean;
  /** Every path that should be coloured, cwd-relative, WITH the folders above
   *  each changed file already rolled in (the server does that fold, because the
   *  tree lazy-loads and no component can see what is collapsed beneath it). */
  changed?: Record<string, FileChangeState>;
  /** The answer was cut short. Stated rather than implied so an uncoloured tree
   *  in a repo mid-rebase is not mistaken for a clean one. */
  truncated?: boolean;
}
