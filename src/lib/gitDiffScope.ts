/**
 * gitDiffScope.ts — git's own unified diff, read into the rows a viewer draws.
 * Pure, no IO.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS PARSES AND DOES NOT COMPUTE
 *
 * The implementation this replaces computed the diff IN THE BROWSER, with an
 * LCS dynamic-programming table over the two files. That is wrong twice.
 *
 * It is wrong on cost: the table is old×new cells, so a five-thousand-line file
 * is twenty-five million entries built on the render thread, for an answer git
 * produces in milliseconds.
 *
 * It is wrong on correctness, which matters more. `git diff` is not a line LCS.
 * It detects renames and copies, honours `.gitattributes` diff drivers, knows
 * which files are binary, applies the user's own `diff.algorithm` (histogram,
 * patience) and their whitespace settings. A viewer that recomputed the diff
 * would disagree with the diff the user gets in every other tool they own — and
 * disagree silently, showing a plausible answer that is not the one git will
 * commit.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE PATHS DO NOT COME FROM THE DIFF HEADER
 *
 * `diff --git a/<old> b/<new>` IS AMBIGUOUS AND CANNOT BE PARSED. A file called
 * `a b.txt` produces
 *
 *     diff --git a/a b.txt b/a b.txt
 *
 * and there is no way to tell from that line where the first path ends: `a/a`
 * and `b.txt b/a b.txt` splits it exactly as well as the right answer does. git
 * quotes the paths only when they contain characters it considers unusual, and a
 * space is not one of them. Every parser that reads this line is holding a bug
 * for the first person with a space in a filename — and this project's tree has
 * Korean filenames and spaces in it.
 *
 * So the paths arrive SEPARATELY, from `--numstat -z`, where they are raw bytes
 * between NULs and cannot be misread. The diff text is then split on its file
 * boundaries and matched to those paths BY POSITION: both come from the same
 * diff queue in the same order, so the Nth chunk is the Nth path.
 */

// ─────────────────────────────────────────────────────────
// The shape a viewer draws
// ─────────────────────────────────────────────────────────

export interface DiffLine {
  kind: 'context' | 'add' | 'del';
  /** Line number in the old file. Absent on an added line. */
  oldNum?: number;
  /** Line number in the new file. Absent on a removed line. */
  newNum?: number;
  text: string;
}

export interface DiffHunk {
  /** git's own `@@ … @@` line, section heading and all. */
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  /** Where a rename came from. */
  oldPath?: string;
  additions: number;
  deletions: number;
  /**
   * A file git would not diff. `hunks` is empty and that is not a bug to be
   * investigated — showing "no changes" for a changed PNG would be a lie, so the
   * viewer says "binary" instead.
   */
  binary: boolean;
  hunks: DiffHunk[];
  /** Set when the file's diff was cut off by the line cap. */
  truncated?: boolean;
}

/**
 * How much of one file's diff is worth sending.
 *
 * A regenerated lockfile is a hundred thousand lines that nobody reads and that
 * would freeze the tab rendering them. Past this the file is reported as
 * truncated, which is a thing the reader can see and act on — unlike a viewer
 * that simply takes a minute to open.
 */
export const MAX_LINES_PER_FILE = 4000;
/** Same reasoning across files: a commit touching a whole vendored tree. */
export const MAX_FILES = 300;

// ─────────────────────────────────────────────────────────
// numstat — the paths and the counts
// ─────────────────────────────────────────────────────────

export interface NumstatEntry {
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

/**
 * Parse `git diff --numstat -z`.
 *
 * The `-z` format is `<adds>\t<dels>\t<path>\0`, and for a RENAME it is
 * `<adds>\t<dels>\t\0<oldpath>\0<newpath>\0` — the path field is EMPTY and two
 * more NUL-terminated records follow. Without `-z` the same rename arrives as
 * `{old => new}` braces inside one path, which has to be unwrapped by string
 * surgery and breaks on a path that legitimately contains a brace.
 *
 * `-` in place of a count means git treated the file as binary.
 */
export function parseNumstat(stdout: string): NumstatEntry[] {
  const records = stdout.split('\0');
  const out: NumstatEntry[] = [];

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec) continue;
    // Split on the FIRST TWO tabs only: a path may itself contain a tab.
    const firstTab = rec.indexOf('\t');
    if (firstTab === -1) continue;
    const secondTab = rec.indexOf('\t', firstTab + 1);
    if (secondTab === -1) continue;

    const addRaw = rec.slice(0, firstTab);
    const delRaw = rec.slice(firstTab + 1, secondTab);
    let path = rec.slice(secondTab + 1);
    let oldPath: string | undefined;

    // An empty path field is git announcing a rename: the two real paths are the
    // next two records.
    if (path === '') {
      oldPath = records[++i] ?? '';
      path = records[++i] ?? '';
      if (!path) continue;
    }

    const binary = addRaw === '-' || delRaw === '-';
    out.push({
      path,
      ...(oldPath ? { oldPath } : {}),
      additions: binary ? 0 : Number.parseInt(addRaw, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(delRaw, 10) || 0,
      binary,
    });
  }

  return out;
}

// ─────────────────────────────────────────────────────────
// The diff text
// ─────────────────────────────────────────────────────────

/**
 * Split a combined diff into one chunk per file, WITHOUT reading any path.
 *
 * The boundary is a line beginning `diff --git `, which is unambiguous even
 * though the rest of that line is not — the marker is at the start of a line and
 * diff content is always prefixed with a space, `+`, `-` or `\`. The chunks come
 * back in git's order, which is the order `--numstat` used.
 */
export function splitDiffByFile(stdout: string): string[] {
  if (!stdout) return [];
  const chunks: string[] = [];
  let current: string[] | null = null;

  for (const line of stdout.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current) chunks.push(current.join('\n'));
      current = [line];
    } else if (current) {
      current.push(line);
    }
    // Anything before the first marker is not part of a file's diff.
  }
  if (current) chunks.push(current.join('\n'));
  return chunks;
}

/** `@@ -12,7 +12,9 @@ optional section heading` → the two start lines. */
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse one file's chunk into hunks.
 *
 * THE HEADER LINES ARE SKIPPED, NOT INTERPRETED. `index`, `old mode`,
 * `similarity index`, `rename from`, `--- a/…`, `+++ b/…` — every one of them
 * carries a path or a fact this parser is deliberately getting from numstat
 * instead. Reading only from the first `@@` onwards means there is no header
 * shape that can be misread, including the ones git adds in future versions.
 */
export function parseFileDiff(chunk: string): { hunks: DiffHunk[]; binary: boolean; truncated: boolean } {
  const hunks: DiffHunk[] = [];
  let binary = false;
  let truncated = false;
  let total = 0;

  let hunk: DiffHunk | null = null;
  let oldNum = 0;
  let newNum = 0;

  for (const line of chunk.split('\n')) {
    if (hunk === null && line.startsWith('Binary files ')) {
      binary = true;
      continue;
    }

    const m = HUNK_RE.exec(line);
    if (m) {
      oldNum = Number.parseInt(m[1]!, 10);
      newNum = Number.parseInt(m[3]!, 10);
      hunk = { header: line, oldStart: oldNum, newStart: newNum, lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    if (total >= MAX_LINES_PER_FILE) {
      truncated = true;
      break;
    }

    // `\ No newline at end of file` is a NOTE ABOUT the previous line, not a
    // line of the file. Counting it would shift every line number after it.
    if (line.startsWith('\\')) continue;

    const marker = line[0];
    const text = line.slice(1);
    if (marker === '+') {
      hunk.lines.push({ kind: 'add', newNum: newNum++, text });
      total++;
    } else if (marker === '-') {
      hunk.lines.push({ kind: 'del', oldNum: oldNum++, text });
      total++;
    } else if (marker === ' ') {
      hunk.lines.push({ kind: 'context', oldNum: oldNum++, newNum: newNum++, text });
      total++;
    }
    // An empty string is the trailing split artefact; anything else between
    // hunks is a header for the NEXT file, which cannot occur inside a chunk.
  }

  return { hunks, binary, truncated };
}

/**
 * Join the two reads into what the viewer receives.
 *
 * MATCHED BY POSITION, for the reason in this file's header: the path from the
 * diff text cannot be parsed, and the path from numstat cannot be wrong. When
 * the two lists disagree in length — which should not happen, and would mean git
 * changed something structural — the numstat side wins and the extra chunk is
 * dropped, so the reader gets a file with no hunks rather than a file labelled
 * with someone else's path.
 */
export function buildDiffFiles(numstat: string, diffText: string): DiffFile[] {
  const entries = parseNumstat(numstat).slice(0, MAX_FILES);
  const chunks = splitDiffByFile(diffText);

  return entries.map((entry, i): DiffFile => {
    const chunk = chunks[i];
    const parsed = chunk
      ? parseFileDiff(chunk)
      : { hunks: [], binary: entry.binary, truncated: false };
    return {
      path: entry.path,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      additions: entry.additions,
      deletions: entry.deletions,
      binary: entry.binary || parsed.binary,
      hunks: parsed.hunks,
      ...(parsed.truncated ? { truncated: true } : {}),
    };
  });
}

// ─────────────────────────────────────────────────────────
// Folding the unchanged middle
// ─────────────────────────────────────────────────────────

/**
 * The gap between two hunks, as a number of lines nobody asked to see.
 *
 * git already trims context to three lines either side, so the gap between hunk
 * N and hunk N+1 is everything the reader was not shown. Reporting it — "40
 * lines hidden" — is the difference between a diff that reads as the whole file
 * and one that honestly says it is an extract.
 */
export function gapBefore(previous: DiffHunk | undefined, next: DiffHunk): number {
  if (!previous) return next.oldStart - 1;
  const lastOld = previous.lines.reduce((n, l) => l.oldNum ?? n, previous.oldStart - 1);
  return next.oldStart - lastOld - 1;
}
