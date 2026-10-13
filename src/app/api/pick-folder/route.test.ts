import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * /api/pick-folder and /api/pick-folder/start — the web fallback's half of the
 * project folder chooser.
 *
 *   1. `/start` answers default > parent of last > home from settings.json.
 *   2. `/api/pick-folder?defaultPath=` opens the dialog THERE only when it is an
 *      existing absolute directory; anything else opens at home, never an error.
 *   3. The dialog is launched without a shell, the start folder as one argv
 *      item — so a folder name with quotes cannot become a command.
 *
 * No real dialog is opened: `execFileSync` is mocked and records what it was
 * asked to run. The settings file lives under a throwaway COCKPIT_HOME, set
 * before the routes load because paths.ts reads it once, at import.
 */

const root = mkdtempSync(join(tmpdir(), 'naby-pick-folder-'));
process.env.COCKPIT_HOME = join(root, 'cockpit');
mkdirSync(process.env.COCKPIT_HOME, { recursive: true });
const settingsFile = join(process.env.COCKPIT_HOME, 'settings.json');

const work = join(root, `it's "work"`);
const acme = join(work, 'acme');
const aFile = join(root, 'file.txt');

const exec = vi.hoisted(() => ({
  calls: [] as Array<{ file: string; args: string[]; env?: NodeJS.ProcessEnv }>,
  answer: (() => '/picked/folder/\n') as (file: string) => string,
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFileSync = (file: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    exec.calls.push({ file, args, env: opts?.env });
    return exec.answer(file);
  };
  return { ...actual, default: { ...actual, execFileSync }, execFileSync };
});

let pick: typeof import('./route');
let start: typeof import('./start/route');
let favorites: typeof import('./favorites/route');

const get = (query = '') => pick.GET(new Request(`http://127.0.0.1/api/pick-folder${query}`));

/** The start folder the mocked dialog was opened at, whatever the platform. */
const openedAt = (): string | undefined => {
  const call = exec.calls.at(-1);
  if (!call) return undefined;
  if (call.file === 'osascript') return call.args.at(-1);
  if (call.file === 'powershell') return call.env?.NABY_PICK_START;
  if (call.file === 'zenity') {
    return call.args.find((a) => a.startsWith('--filename='))?.slice('--filename='.length).replace(/\/$/, '');
  }
  return call.args[1]; // kdialog --getexistingdirectory <dir>
};

beforeAll(async () => {
  mkdirSync(acme, { recursive: true });
  writeFileSync(aFile, 'x');
  pick = await import('./route');
  start = await import('./start/route');
  favorites = await import('./favorites/route');
});

afterEach(() => {
  exec.calls.length = 0;
  exec.answer = () => '/picked/folder/\n';
  rmSync(settingsFile, { force: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('/api/pick-folder — the start folder is validated', () => {
  it('opens at a valid defaultPath and returns the pick without the trailing slash', async () => {
    const res = await get(`?defaultPath=${encodeURIComponent(work)}`);
    expect(await res.json()).toEqual({ folder: '/picked/folder' });
    expect(openedAt()).toBe(work);
  });

  it('opens at home when defaultPath is missing, relative, a file or gone', async () => {
    for (const query of [
      '',
      '?defaultPath=',
      `?defaultPath=${encodeURIComponent('relative/dir')}`,
      `?defaultPath=${encodeURIComponent(aFile)}`,
      `?defaultPath=${encodeURIComponent(join(root, 'gone'))}`,
    ]) {
      const res = await get(query);
      expect(res.status, query).toBe(200);
      expect(openedAt(), query).toBe(homedir());
    }
  });

  it('runs the dialog without a shell — the path is one argument, not code', async () => {
    await get(`?defaultPath=${encodeURIComponent(work)}`);
    const call = exec.calls.at(-1)!;
    // No `sh -c` / `cmd /c` wrapper anywhere, and the quote-laden folder never
    // appears inside a script string — only as its own argv item (or env var).
    expect(['sh', 'bash', 'cmd', '/bin/sh']).not.toContain(call.file);
    const asCode = call.args.filter((a) => a !== work && a !== `--filename=${work}/`);
    for (const arg of asCode) expect(arg).not.toContain(work);
  });

  it('a cancelled or failed dialog is folder: null', async () => {
    exec.answer = () => {
      throw Object.assign(new Error('User canceled'), { status: 1 });
    };
    const res = await get(`?defaultPath=${encodeURIComponent(work)}`);
    expect(await res.json()).toEqual({ folder: null });
  });
});

describe('/api/pick-folder on Linux — zenity, then kdialog only when zenity is missing', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const asLinux = () => Object.defineProperty(process, 'platform', { value: 'linux' });
  afterEach(() => Object.defineProperty(process, 'platform', platform));

  it('opens zenity inside the start folder', async () => {
    asLinux();
    await get(`?defaultPath=${encodeURIComponent(work)}`);
    expect(exec.calls.map((c) => c.file)).toEqual(['zenity']);
    expect(exec.calls[0]!.args).toContain(`--filename=${work}/`);
  });

  it('falls back to kdialog when zenity is not installed', async () => {
    asLinux();
    exec.answer = (file) => {
      if (file === 'zenity') throw Object.assign(new Error('spawn zenity ENOENT'), { code: 'ENOENT' });
      return `${acme}\n`;
    };
    const res = await get(`?defaultPath=${encodeURIComponent(work)}`);
    expect(await res.json()).toEqual({ folder: acme });
    expect(exec.calls.map((c) => c.file)).toEqual(['zenity', 'kdialog']);
    expect(exec.calls[1]!.args[1]).toBe(work);
  });

  it('a cancelled zenity does NOT pop a second dialog', async () => {
    asLinux();
    exec.answer = () => {
      throw Object.assign(new Error('exit 1'), { status: 1 });
    };
    const res = await get();
    expect(await res.json()).toEqual({ folder: null });
    expect(exec.calls.map((c) => c.file)).toEqual(['zenity']);
  });
});

describe('/api/pick-folder/start — default > parent of last > home', () => {
  const startPath = async (settings?: Record<string, unknown>) => {
    if (settings) writeFileSync(settingsFile, JSON.stringify(settings));
    const res = await start.GET(new Request('http://127.0.0.1/api/pick-folder/start'));
    return ((await res.json()) as { startPath: string }).startPath;
  };

  it('answers the configured default', async () => {
    expect(await startPath({ projectFolderDefault: work, projectFolderLast: acme })).toBe(work);
  });

  it('answers the parent of the last folder when there is no default', async () => {
    expect(await startPath({ projectFolderLast: acme })).toBe(work);
  });

  it('skips a stale default', async () => {
    expect(
      await startPath({ projectFolderDefault: join(root, 'gone'), projectFolderLast: acme }),
    ).toBe(work);
  });

  it('answers home with no settings file at all', async () => {
    expect(await startPath()).toBe(homedir());
  });

  it('answers home when settings.json is not even JSON', async () => {
    writeFileSync(settingsFile, '{ nope');
    expect(await startPath()).toBe(homedir());
  });
});

describe('/api/pick-folder/start — the quick menu entries', () => {
  const choices = async (settings: Record<string, unknown>) => {
    writeFileSync(settingsFile, JSON.stringify(settings));
    const res = await start.GET(new Request('http://127.0.0.1/api/pick-folder/start'));
    return (await res.json()) as {
      startPath: string;
      favorites: string[];
      last: string | null;
      home: string;
    };
  };

  it('lists only favorites that exist, in stored order, and the existing last folder', async () => {
    const gone = join(root, 'unplugged');
    const r = await choices({
      projectFolderFavorites: [acme, gone, work, acme, 'relative', aFile, 42],
      projectFolderLast: acme,
    });
    expect(r.favorites).toEqual([acme, work]);
    expect(r.last).toBe(acme);
    expect(r.home).toBe(homedir());
  });

  it('a last folder that has gone is null — the menu cannot open it', async () => {
    const r = await choices({ projectFolderLast: join(work, 'deleted') });
    expect(r.last).toBeNull();
    // ...while the start still uses its parent, which exists.
    expect(r.startPath).toBe(work);
  });

  it('empty lists when nothing is stored', async () => {
    const r = await choices({});
    expect(r).toMatchObject({ favorites: [], last: null, startPath: homedir() });
  });
});

describe('/api/pick-folder/favorites — locked add / remove', () => {
  const post = async (body: unknown) => {
    const res = await favorites.POST(
      new Request('http://127.0.0.1/api/pick-folder/favorites', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    expect(res.status).toBe(200);
    return (await res.json()) as { ok: boolean; favorites?: string[]; reason?: string };
  };
  const stored = () => JSON.parse(readFileSync(settingsFile, 'utf8')) as Record<string, unknown>;

  it('adds in order, dedupes, and keeps the other settings', async () => {
    writeFileSync(settingsFile, JSON.stringify({ language: 'ko' }));
    expect(await post({ op: 'add', folder: work })).toEqual({ ok: true, favorites: [work] });
    expect(await post({ op: 'add', folder: acme })).toEqual({ ok: true, favorites: [work, acme] });
    expect(await post({ op: 'add', folder: work })).toEqual({ ok: true, favorites: [work, acme] });
    expect(stored()).toEqual({ language: 'ko', projectFolderFavorites: [work, acme] });
  });

  it('two adds at once both land (the write is locked)', async () => {
    await Promise.all([post({ op: 'add', folder: work }), post({ op: 'add', folder: acme })]);
    expect(new Set(stored().projectFolderFavorites as string[])).toEqual(new Set([work, acme]));
  });

  it('refuses to add a folder that is not an existing absolute directory', async () => {
    for (const folder of ['relative', aFile, join(root, 'gone')]) {
      expect(await post({ op: 'add', folder })).toEqual({ ok: false, reason: 'not-a-folder' });
    }
    expect(await post({ op: 'nope', folder: work })).toEqual({ ok: false, reason: 'invalid' });
    expect(await post({ op: 'add' })).toEqual({ ok: false, reason: 'invalid' });
  });

  it('removes — including a stale favorite whose folder has gone', async () => {
    const gone = join(root, 'unplugged');
    writeFileSync(settingsFile, JSON.stringify({ projectFolderFavorites: [work, gone, acme] }));
    expect(await post({ op: 'remove', folder: gone })).toEqual({ ok: true, favorites: [work, acme] });
  });

  it('a stale favorite stays stored when another one is added', async () => {
    const gone = join(root, 'unplugged');
    writeFileSync(settingsFile, JSON.stringify({ projectFolderFavorites: [gone] }));
    expect(await post({ op: 'add', folder: work })).toEqual({ ok: true, favorites: [gone, work] });
  });
});
