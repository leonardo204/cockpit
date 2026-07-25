/**
 * What the `/` and `@` palettes offer (Phase 3, P3-M2/M5, and file mentions).
 *
 * Extracted from ChatInput because this exact rule has now been wrong twice: the
 * first version showed agents under `/`, and the fix for that left commands
 * showing under `@` — rendered with the typed marker, so `/plan` appeared as
 * `@plan` and picking it produced a line the dispatcher could not read. Inline in
 * a `useMemo` it was invisible to tests; here it is one function with one test.
 *
 * THE RULE, stated once:
 *
 *   `/`  the harness — commands, skills, the things that expand into a prompt.
 *        An agent row must never appear, or picking it writes `@name` into a line
 *        the dispatcher reads as a harness verb.
 *   `@`  the agent layer AND files/folders in the open project. Not commands: a
 *        command reached through `@` would be dispatched as something else
 *        entirely.
 *
 * NOTE ON WHAT THIS REMOVES. Cockpit upstream treated `@verb` as "run this
 * command in a subagent session", which is why the query was marker-agnostic. In
 * naby `@` belongs to the agent layer (P3-M2), and the command dispatcher already
 * declines to expand `@<registeredAgent>`; keeping both meanings on one marker is
 * what produced the bug.
 */

/** The palette row shape this cares about — a superset of `CommandInfo`. */
export type PaletteRow = {
  name: string;
  /** Present only on naby agent rows (the server adds it). */
  agent?: { stage: string; percent: number; addressable: boolean };
};

/**
 * Split matched rows into the groups the palette renders, in order, for one
 * marker. Returns `agents` first because `@` is how the product's headline
 * feature is invoked; `commands` is always empty under `@`.
 */
export function partitionPaletteRows<T extends PaletteRow>(
  rows: readonly T[],
  marker: '/' | '@',
): { agents: T[]; commands: T[] } {
  if (marker === '@') {
    return { agents: rows.filter((r) => r.agent), commands: [] };
  }
  return { agents: [], commands: rows.filter((r) => !r.agent) };
}

/** The flat, ordered list the palette iterates. */
export function paletteRows<T extends PaletteRow>(rows: readonly T[], marker: '/' | '@'): T[] {
  const { agents, commands } = partitionPaletteRows(rows, marker);
  return [...agents, ...commands];
}

// ---------------------------------------------------------------------------
// File / folder mentions
// ---------------------------------------------------------------------------
//
// `@` also names things in the open project, which is what people already expect
// it to do. The autocomplete walks ONE DIRECTORY LEVEL at a time (`/api/list-dir`)
// rather than searching the tree: it is the shape people type paths in, it stays
// cheap on a large repo, and that endpoint already refuses anything that escapes
// the project root — a recursive search would need that guard rebuilt.

/** The `@…` token being typed, with the absolute span it occupies in the input.
 *  The span matters: a mention is usually MID-SENTENCE, so replacing the whole
 *  line (what the command palette does) would delete the words around it. */
export type MentionQuery = {
  /** Index of the `@` itself. */
  start: number;
  /** Index just past the last typed character. */
  end: number;
  /** Everything after the `@`. May contain `/` and be empty. */
  text: string;
};

/**
 * Find the mention being typed at the caret, or null.
 *
 * The `@` must start the line or follow whitespace, and nothing between it and
 * the caret may be whitespace. That one rule is what keeps `foo@bar.com` from
 * opening a file picker while still allowing "look at @src/parser.ts and tell me".
 */
export function findMentionQuery(input: string, caret: number): MentionQuery | null {
  const upto = input.slice(0, caret);
  const at = upto.lastIndexOf('@');
  if (at === -1) return null;
  // Preceded by start-of-input or whitespace — never by a word character.
  if (at > 0 && !/\s/.test(input[at - 1]!)) return null;
  const text = upto.slice(at + 1);
  if (/\s/.test(text)) return null; // the token ended; the menu is done
  return { start: at, end: caret, text };
}

/** Split a mention into the directory to list and the prefix to filter by.
 *  `'src/par'` → list `src`, match `par`. `'src/'` → list `src`, match everything. */
export function splitMentionPath(text: string): { dir: string; leaf: string } {
  const cut = text.lastIndexOf('/');
  if (cut === -1) return { dir: '', leaf: text };
  return { dir: text.slice(0, cut), leaf: text.slice(cut + 1) };
}

/** A directory entry as `/api/list-dir` returns it. */
export type DirEntry = { name: string; isDir: boolean };

/** A palette row for a file or folder. `name` carries the `@` so it renders and
 *  keys like every other row. */
export type FileRow = {
  name: string;
  description: string;
  source: 'builtin';
  file: { rel: string; isDir: boolean };
};

/** How many file rows the palette shows. A directory with 400 entries would
 *  otherwise push the agents off the top of a scrolled list. */
export const FILE_ROW_LIMIT = 30;

/**
 * Turn one directory listing into palette rows, filtered by what has been typed.
 * Dot-files are shown only once the user types the dot — they are noise in a
 * project root and exactly what is wanted when someone types `@.env`.
 */
export function fileRows(
  entries: readonly DirEntry[],
  dir: string,
  leaf: string,
  limit: number = FILE_ROW_LIMIT,
): FileRow[] {
  const want = leaf.toLowerCase();
  const rows: FileRow[] = [];
  for (const e of entries) {
    if (!e.name.toLowerCase().startsWith(want)) continue;
    if (e.name.startsWith('.') && !leaf.startsWith('.')) continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    rows.push({
      name: `@${rel}`,
      description: '',
      source: 'builtin',
      file: { rel, isDir: e.isDir },
    });
    if (rows.length >= limit) break;
  }
  // Directories first so typing deeper is one keystroke away; `/api/list-dir`
  // already sorts within each group.
  return [...rows.filter((r) => r.file.isDir), ...rows.filter((r) => !r.file.isDir)];
}

/**
 * The text a picked row inserts. A FOLDER gets a trailing slash and NO space, so
 * the menu stays open and the next segment can be typed; a file gets a space,
 * because the mention is finished and the sentence continues.
 */
export function mentionInsertion(row: FileRow): string {
  return row.file.isDir ? `@${row.file.rel}/` : `@${row.file.rel} `;
}
