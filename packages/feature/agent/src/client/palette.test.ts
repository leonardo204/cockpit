import { describe, it, expect } from 'vitest';
import {
  FILE_ROW_LIMIT,
  fileRows,
  findMentionQuery,
  mentionInsertion,
  paletteRows,
  partitionPaletteRows,
  splitMentionPath,
  type DirEntry,
  type PaletteRow,
} from './palette';

/**
 * The `/` and `@` palettes must not show each other's rows. This has been wrong
 * twice — agents under `/` first, then commands under `@` — so both directions are
 * pinned here rather than left to a component nobody can unit-test.
 */

const agent = (name: string, addressable = true): PaletteRow => ({
  name,
  agent: { stage: addressable ? 'butterfly' : 'egg', percent: addressable ? 100 : 0, addressable },
});
const command = (name: string): PaletteRow => ({ name });

const ROWS: PaletteRow[] = [
  command('/plan'),
  agent('@persona', false),
  command('/qa'),
  agent('@reviewer'),
  command('/fx'),
];

describe('palette rows — the two markers never share a list', () => {
  it('@ shows agents only, and never a command', () => {
    const { agents, commands } = partitionPaletteRows(ROWS, '@');
    expect(agents.map((r) => r.name)).toEqual(['@persona', '@reviewer']);
    expect(commands).toEqual([]);
    // The bug this exists for: `/plan` rendered as `@plan`, which the dispatcher
    // cannot read as anything.
    expect(paletteRows(ROWS, '@').map((r) => r.name)).toEqual(['@persona', '@reviewer']);
  });

  it('/ shows commands only, and never an agent', () => {
    const { agents, commands } = partitionPaletteRows(ROWS, '/');
    expect(agents).toEqual([]);
    expect(commands.map((r) => r.name)).toEqual(['/plan', '/qa', '/fx']);
    // Picking an agent under `/` would write `@name` into a line read as a
    // harness verb.
    expect(paletteRows(ROWS, '/').some((r) => r.agent)).toBe(false);
  });

  it('agents come first, so the headline feature is not buried', () => {
    // Order matters even though `@` currently yields only agents: the flat list
    // is what the keyboard cursor walks, and index 0 must be an agent.
    expect(paletteRows(ROWS, '@')[0]?.name).toBe('@persona');
  });

  it('a NON-ADDRESSABLE agent is still listed under @', () => {
    // Listed but greyed and unselectable (ChatInput's isSelectable) — hiding it
    // would leave the user with no way to see that the persona exists and is
    // still growing.
    expect(paletteRows([agent('@persona', false)], '@')).toHaveLength(1);
  });

  it('an empty match list stays empty rather than falling back to the other marker', () => {
    expect(paletteRows([], '@')).toEqual([]);
    expect(paletteRows([command('/qa')], '@')).toEqual([]);
    expect(paletteRows([agent('@persona')], '/')).toEqual([]);
  });
});

describe('file mentions — finding the @ token being typed', () => {
  it('finds it at the start of the input', () => {
    expect(findMentionQuery('@src', 4)).toEqual({ start: 0, end: 4, text: 'src' });
    // A bare `@` opens the menu with everything.
    expect(findMentionQuery('@', 1)).toEqual({ start: 0, end: 1, text: '' });
  });

  it('finds it MID-SENTENCE, which is where mentions actually get written', () => {
    const input = 'please review @src/par';
    expect(findMentionQuery(input, input.length)).toEqual({
      start: 14,
      end: 22,
      text: 'src/par',
    });
  });

  it('does not fire on an email address', () => {
    // The whole reason the `@` must follow whitespace: otherwise typing an address
    // opens a file picker over the message.
    expect(findMentionQuery('mail me at foo@bar.com', 22)).toBeNull();
    expect(findMentionQuery('a@b', 3)).toBeNull();
  });

  it('closes once the token ends', () => {
    // A space finishes the mention; the menu must not reopen for the words after it.
    expect(findMentionQuery('@src/foo.ts and then', 20)).toBeNull();
    expect(findMentionQuery('@src ', 5)).toBeNull();
  });

  it('reads the token at the CARET, not the last one in the input', () => {
    const input = '@one @two';
    // Caret just after `@one` — the menu belongs to that token.
    expect(findMentionQuery(input, 4)).toEqual({ start: 0, end: 4, text: 'one' });
    expect(findMentionQuery(input, 9)).toEqual({ start: 5, end: 9, text: 'two' });
  });

  it('handles a newline as whitespace on both sides', () => {
    expect(findMentionQuery('hello\n@src', 10)).toEqual({ start: 6, end: 10, text: 'src' });
    expect(findMentionQuery('@src\nmore', 9)).toBeNull();
  });
});

describe('file mentions — which directory to list', () => {
  it('splits the typed path into the level to list and the prefix to match', () => {
    expect(splitMentionPath('par')).toEqual({ dir: '', leaf: 'par' });
    expect(splitMentionPath('src/par')).toEqual({ dir: 'src', leaf: 'par' });
    // A trailing slash means "show me everything in here".
    expect(splitMentionPath('src/')).toEqual({ dir: 'src', leaf: '' });
    expect(splitMentionPath('a/b/c')).toEqual({ dir: 'a/b', leaf: 'c' });
    expect(splitMentionPath('')).toEqual({ dir: '', leaf: '' });
  });
});

describe('file mentions — the rows', () => {
  const entries: DirEntry[] = [
    { name: 'src', isDir: true },
    { name: 'scripts', isDir: true },
    { name: 'package.json', isDir: false },
    { name: 'server.mjs', isDir: false },
    { name: '.env', isDir: false },
    { name: 'README.md', isDir: false },
  ];

  it('filters by prefix, case-insensitively, folders first', () => {
    const rows = fileRows(entries, '', 's');
    expect(rows.map((r) => r.file.rel)).toEqual(['src', 'scripts', 'server.mjs']);
    expect(fileRows(entries, '', 'RE').map((r) => r.file.rel)).toEqual(['README.md']);
  });

  it('prefixes the directory so the inserted path is complete', () => {
    const rows = fileRows([{ name: 'parser.ts', isDir: false }], 'src/lib', 'par');
    expect(rows[0]!.name).toBe('@src/lib/parser.ts');
    expect(rows[0]!.file.rel).toBe('src/lib/parser.ts');
  });

  it('hides dot-files until the dot is typed', () => {
    // Noise in a project root; exactly what is wanted for `@.env`.
    expect(fileRows(entries, '', '').map((r) => r.file.rel)).not.toContain('.env');
    expect(fileRows(entries, '', '.').map((r) => r.file.rel)).toEqual(['.env']);
  });

  it('caps the list so a huge directory cannot bury the agents above it', () => {
    const many: DirEntry[] = Array.from({ length: 200 }, (_, i) => ({ name: `f${i}`, isDir: false }));
    expect(fileRows(many, '', 'f')).toHaveLength(FILE_ROW_LIMIT);
    expect(fileRows(many, '', 'f', 5)).toHaveLength(5);
  });

  it('a folder inserts a trailing slash and NO space; a file inserts a space', () => {
    const [dir] = fileRows(entries, '', 'src');
    const [file] = fileRows(entries, '', 'package');
    // The folder keeps the menu open for the next segment; the file ends the token.
    expect(mentionInsertion(dir!)).toBe('@src/');
    expect(mentionInsertion(file!)).toBe('@package.json ');
  });

  it('file rows are not agent rows, so the @ partition keeps both', () => {
    const rows = [...fileRows(entries, '', 's'), agent('@persona')];
    // partitionPaletteRows only knows about `agent`; a file row must fall through
    // it untouched rather than being filtered out as "a command".
    expect(partitionPaletteRows(rows, '@').agents.map((r) => r.name)).toEqual(['@persona']);
  });
});
