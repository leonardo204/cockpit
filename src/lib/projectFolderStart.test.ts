import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pickerCommands,
  resolveProjectFolderStart,
  usableStartDir,
} from './projectFolderStart';

/**
 * Where the project folder chooser opens: default > parent of last > home.
 *
 * The fixture is a real directory tree, because "exists and is a directory" is
 * the whole rule and a mocked `stat` would only test the mock. The interesting
 * cases are the fall-throughs — a stale default, a deleted last folder whose
 * parent survives, a relative or non-string value from a hand-edited file —
 * since each one used to be (or could easily become) an error dialog instead
 * of a chooser.
 */

const root = mkdtempSync(join(tmpdir(), 'naby-project-folder-'));
const home = join(root, 'home');
const work = join(root, 'work');
const clients = join(work, 'clients');
const acme = join(clients, 'acme');
const aFile = join(work, 'notes.txt');
const gone = join(root, 'gone');

beforeAll(() => {
  mkdirSync(home, { recursive: true });
  mkdirSync(acme, { recursive: true });
  writeFileSync(aFile, 'not a folder');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('usableStartDir', () => {
  it('accepts an absolute path to an existing directory', () => {
    expect(usableStartDir(work)).toBe(work);
  });

  it('refuses everything else, quietly', () => {
    for (const bad of [
      undefined,
      null,
      42,
      {},
      '',
      'relative/path',
      './work',
      aFile, // a file, not a folder
      gone, // missing
      `${work}\0/etc`, // a NUL byte
    ]) {
      expect(usableStartDir(bad), String(bad)).toBeNull();
    }
  });
});

describe('resolveProjectFolderStart — default > last parent > home', () => {
  it('uses the configured default when it exists', () => {
    expect(
      resolveProjectFolderStart({ projectFolderDefault: work, projectFolderLast: acme }, home),
    ).toBe(work);
  });

  it('opens BESIDE the last folder — at its parent — when no default is set', () => {
    expect(resolveProjectFolderStart({ projectFolderLast: acme }, home)).toBe(clients);
  });

  it('skips a default that no longer exists and goes on to the last folder', () => {
    expect(
      resolveProjectFolderStart({ projectFolderDefault: gone, projectFolderLast: acme }, home),
    ).toBe(clients);
  });

  it('treats a cleared default (null) like an absent one', () => {
    expect(
      resolveProjectFolderStart({ projectFolderDefault: null, projectFolderLast: acme }, home),
    ).toBe(clients);
  });

  it('a deleted last folder still opens at its parent, while the parent exists', () => {
    expect(resolveProjectFolderStart({ projectFolderLast: join(clients, 'deleted') }, home)).toBe(
      clients,
    );
  });

  it('falls back to home when the last folder AND its parent are gone', () => {
    expect(resolveProjectFolderStart({ projectFolderLast: join(gone, 'x') }, home)).toBe(home);
  });

  it('falls back to home on a default that is a file, and no last folder', () => {
    expect(resolveProjectFolderStart({ projectFolderDefault: aFile }, home)).toBe(home);
  });

  it('ignores relative and non-string values from a hand-edited file', () => {
    expect(
      resolveProjectFolderStart(
        { projectFolderDefault: 'work', projectFolderLast: 'clients/acme' },
        home,
      ),
    ).toBe(home);
    expect(
      resolveProjectFolderStart({ projectFolderDefault: 7, projectFolderLast: [acme] }, home),
    ).toBe(home);
    // `dirname('')` is '.', which must never be stat-ed against the cwd.
    expect(resolveProjectFolderStart({ projectFolderLast: '' }, home)).toBe(home);
  });

  it('opens at home when nothing is configured', () => {
    expect(resolveProjectFolderStart({}, home)).toBe(home);
  });
});

describe('pickerCommands — values travel as data, never as code', () => {
  // The values a remembered folder can really contain. The old route spliced
  // them into a shell line inside an AppleScript string; any one of these broke
  // out of it.
  const nasty = `/Users/me/it's "quoted" $(touch /tmp/pwned) \`id\` & more`;
  const prompt = `Select "the" folder's name`;

  it('macOS: both values are argv items for an `on run argv` script', () => {
    const [cmd, ...rest] = pickerCommands('darwin', prompt, nasty);
    expect(rest).toEqual([]);
    expect(cmd!.file).toBe('osascript');
    // The script reads them by position; neither appears inside it.
    const script = cmd!.args.filter((_, i, a) => a[i - 1] === '-e').join('\n');
    expect(script).toContain('on run argv');
    expect(script).toContain('item 1 of argv');
    expect(script).toContain('item 2 of argv as POSIX file');
    expect(script).not.toContain(nasty);
    expect(script).not.toContain(prompt);
    expect(cmd!.args.slice(-2)).toEqual([prompt, nasty]);
  });

  it('Windows: both values arrive as environment variables', () => {
    const [cmd] = pickerCommands('win32', prompt, nasty);
    expect(cmd!.file).toBe('powershell');
    expect(cmd!.args.join(' ')).not.toContain(nasty);
    expect(cmd!.args.join(' ')).toContain('$d.SelectedPath = $env:NABY_PICK_START');
    expect(cmd!.env).toEqual({ NABY_PICK_PROMPT: prompt, NABY_PICK_START: nasty });
  });

  it('Linux: zenity opens INSIDE the start folder, kdialog is the fallback', () => {
    const [zenity, kdialog] = pickerCommands('linux', prompt, '/home/me/work');
    expect(zenity!.file).toBe('zenity');
    expect(zenity!.args).toContain('--filename=/home/me/work/');
    expect(zenity!.args).toContain(`--title=${prompt}`);
    expect(kdialog!.file).toBe('kdialog');
    expect(kdialog!.args).toEqual(['--getexistingdirectory', '/home/me/work', '--title', prompt]);
  });

  it('Linux: the root folder gets no doubled slash', () => {
    const [zenity] = pickerCommands('linux', prompt, '/');
    expect(zenity!.args).toContain('--filename=/');
  });
});
