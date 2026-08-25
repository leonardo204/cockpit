/**
 * shellNote.ts — what naby is told about the surface it is answering into.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY PATHS MUST BE WRITTEN OUT IN FULL
 *
 * The chat linkifies a file path naby writes, so the reader can click it and
 * read the document without leaving the conversation. It can only do that for a
 * path it can RESOLVE, and `~/Downloads/report.md` is not one: the renderer runs
 * in the browser, where the home directory is not knowable.
 *
 * That leaves two places to fix it, and only one of them is honest.
 *
 *   In the CLIENT, by guessing.   The renderer would have to be told a home
 *                                 directory and splice it in. Every guess it got
 *                                 wrong would produce a link whose text says one
 *                                 file and whose target is another — which is the
 *                                 one property the whole linking design is built
 *                                 to preserve (filePathLinks.ts).
 *   At the SOURCE.                naby knows the absolute path; it is what the
 *                                 tool returned. `~` is a contraction it applied
 *                                 on the way out. Asking it not to contract costs
 *                                 nothing and the path is exact.
 *
 * So the rule is stated here. It is an INSTRUCTION, not a guarantee — a model can
 * still write a tilde — but the failure mode is the old one (a path that is not
 * clickable), never a link that points somewhere its text does not say.
 *
 * The note is unconditional. It used to exist only when a working directory was
 * known, because that was all it said; the path convention applies whether or not
 * a project is open, since a path can be reported from anywhere.
 */

/** How naby is told to write a path it reports back to the user. Exported so the
 *  test can assert the instruction is actually present rather than matching a
 *  sentence it copied. */
export const ABSOLUTE_PATH_RULE =
  'When you tell the user where a file is, write the path out in full from the ' +
  'filesystem root (for example /Users/name/Downloads/report.md). Never abbreviate ' +
  'the home directory as ~ — the app turns a full path into a link the user can ' +
  'click to open the file, and it cannot resolve ~.';

/**
 * The working-directory note plus the path convention.
 *
 * Returns a single system block. `cwd` is optional: without one the first
 * sentence is dropped and the convention stands on its own.
 */
export function shellSystemNote(cwd?: string): string {
  const lines = ['You are running inside the naby shell.'];
  if (cwd) lines.push(`Working directory: ${cwd}`);
  lines.push(ABSOLUTE_PATH_RULE);
  return lines.join('\n');
}
