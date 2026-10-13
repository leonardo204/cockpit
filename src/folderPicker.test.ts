// The folder picker goes through Electron when Electron is there.
//
// THE BUG THIS GUARDS. `/api/pick-folder` shells out to `osascript` (and to
// powershell / zenity elsewhere). The native panel it opens is owned by that
// HELPER process, which has no menu bar — and on macOS cmd+C / cmd+V are
// dispatched through the owning app's Edit menu. So in the panel's "New Folder"
// name field, copy and paste silently did nothing: no error, no beep, just a
// field that refuses the one gesture every user tries when naming or locating a
// project. Every entry point was affected (Workspace "Open Project",
// SessionBrowser, EmptyState's Open and Create).
//
// THE FIX is to let the app open its own panel: `dialog.showOpenDialog(win, …)`
// in the main process, parented to the BrowserWindow, so the panel is ours and
// the app's Edit menu applies. The HTTP route stays as the fallback for the
// cockpit standalone dev server, where there is no Electron at all.
//
// Three things have to hold, and none of them is visible to typecheck:
//   (a) the client PREFERS the bridge and only falls back to the route,
//   (b) the shell never imports `electron` (Next would bundle it — the bridge
//       is reached through `window.naby`, which the preload put there),
//   (c) main actually registers `fs:pickFolder`, with the panel properties that
//       make it a folder chooser with a "New Folder" button.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { Effect } from 'effect';
// Imported by path, not through the package: `@cockpit/feature-workspace`
// exports its client BARREL, which pulls the whole React surface in with it.
// The module under test is a plain data client and loads on its own.
import {
  pickFolder,
  saveProjectFolderDefault,
} from '../packages/feature/workspace/src/client/effect/workspaceClient';
import {
  PROJECT_FOLDER_DEFAULT_KEY,
  PROJECT_FOLDER_LAST_KEY,
} from '../packages/shared/utils/src/projectFolder';

// This file lives at <shellRoot>/src/folderPicker.test.ts
const shellRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p: string[]) => resolve(shellRoot, ...p);

// ---------------------------------------------------------------------------
// (a) the client prefers the bridge
// ---------------------------------------------------------------------------

type Bridge = { pickFolder: (message?: string, defaultPath?: string) => Promise<string | null> };

/** Install a fake `window` carrying the preload bridge, or one carrying no
 *  `naby` at all (the plain-browser case). */
function installWindow(bridge: Bridge | null): void {
  (globalThis as { window?: unknown }).window = bridge ? { naby: { fsOps: bridge } } : {};
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.unstubAllGlobals();
});

/** One recorded request: the URL, the method, and the parsed JSON body. */
type Seen = { url: string; method: string; body?: unknown };

/**
 * A fake server for everything the picker client talks to.
 *
 * `/api/pick-folder/start` answers `start` (or fails when it is an Error), the
 * settings PUT records the remembered folder, and `/api/pick-folder` (the
 * dialog route) answers `routeFolder` — or throws when `routeFolder` is
 * undefined, so a test that must not reach the route fails loudly.
 */
function installServer(opts: {
  start?: string | Error;
  routeFolder?: string | null;
  settingsFails?: boolean;
}): Seen[] {
  const seen: Seen[] = [];
  const respond = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      seen.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/pick-folder/start') {
        if (opts.start instanceof Error) throw opts.start;
        return respond({ startPath: opts.start });
      }
      if (url === '/api/settings' && method === 'PUT') {
        if (opts.settingsFails) return { ok: false, status: 500, json: async () => ({}) };
        return respond({});
      }
      if (url === '/api/pick-folder' || url.startsWith('/api/pick-folder?')) {
        if (opts.routeFolder === undefined) {
          throw new Error('the dialog route must not be called when the bridge is present');
        }
        return respond({ folder: opts.routeFolder });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    }),
  );
  return seen;
}

/** The dialog-route requests among `seen` (not the start lookup). */
const dialogRequests = (seen: Seen[]) =>
  seen.filter((r) => r.url === '/api/pick-folder' || r.url.startsWith('/api/pick-folder?'));

/** The settings writes among `seen`. */
const settingsWrites = (seen: Seen[]) =>
  seen.filter((r) => r.url === '/api/settings' && r.method === 'PUT');

describe('pickFolder — Electron first, route as fallback', () => {
  it('uses the bridge and never touches the dialog route', async () => {
    const bridgeCalls: Array<[string | undefined, string | undefined]> = [];
    installWindow({
      pickFolder: async (message, defaultPath) => {
        bridgeCalls.push([message, defaultPath]);
        return '/Users/someone/projects/naby';
      },
    });
    // No `routeFolder`: any request to /api/pick-folder itself throws, which is
    // the failure this test exists to catch.
    const seen = installServer({ start: '/Users/someone/projects' });

    const result = await Effect.runPromise(pickFolder());

    expect(result).toEqual({ folder: '/Users/someone/projects/naby' });
    expect(bridgeCalls).toHaveLength(1);
    expect(dialogRequests(seen)).toEqual([]);
  });

  it('reports a cancelled bridge dialog as folder: null, not as an error', async () => {
    // Cancelling is what a user does half the time. It must reach the call
    // sites as "no folder", never as a failed Effect (which would surface as an
    // error toast for an ordinary Escape key).
    installWindow({ pickFolder: async () => null });
    installServer({ start: '/Users/someone' });

    await expect(Effect.runPromise(pickFolder())).resolves.toEqual({ folder: null });
  });

  it('falls back to /api/pick-folder when there is no bridge', async () => {
    // The cockpit standalone dev server: `window.naby` is simply absent.
    installWindow(null);
    const seen = installServer({ start: '/Users/someone', routeFolder: '/from/the/route' });

    const result = await Effect.runPromise(pickFolder());

    expect(result).toEqual({ folder: '/from/the/route' });
    expect(dialogRequests(seen)).toHaveLength(1);
  });

  it('falls back when naby exists but the bridge predates pickFolder', async () => {
    // An older preload (or a future one that drops the method) must degrade to
    // the route rather than throwing "pickFolder is not a function".
    (globalThis as { window?: unknown }).window = { naby: { fsOps: { trash: () => {} } } };
    const seen = installServer({ start: '/Users/someone', routeFolder: '/from/the/route' });

    await expect(Effect.runPromise(pickFolder())).resolves.toEqual({
      folder: '/from/the/route',
    });
    expect(dialogRequests(seen)).toHaveLength(1);
  });

  it('still works with a preload whose pickFolder predates defaultPath', async () => {
    // The old one-argument bridge: the extra argument is simply ignored and the
    // panel opens at home, as it always did.
    const messages: Array<string | undefined> = [];
    installWindow({
      pickFolder: async (message?: string) => {
        messages.push(message);
        return '/picked';
      },
    });
    installServer({ start: '/Users/someone' });

    await expect(Effect.runPromise(pickFolder('Prompt'))).resolves.toEqual({ folder: '/picked' });
    expect(messages).toEqual(['Prompt']);
  });
});

// ---------------------------------------------------------------------------
// where it opens, and what it remembers
// ---------------------------------------------------------------------------

describe('pickFolder — start folder and last-folder memory', () => {
  it('hands the resolved start folder to the bridge', async () => {
    const calls: Array<[string | undefined, string | undefined]> = [];
    installWindow({
      pickFolder: async (message, defaultPath) => {
        calls.push([message, defaultPath]);
        return '/work/clients/acme';
      },
    });
    installServer({ start: '/work/clients' });

    await Effect.runPromise(pickFolder('Pick one'));

    expect(calls).toEqual([['Pick one', '/work/clients']]);
  });

  it('hands it to the route as an encoded defaultPath query', async () => {
    installWindow(null);
    const start = `/Users/me/it's a "dir" & more`;
    const seen = installServer({ start, routeFolder: '/x' });

    await Effect.runPromise(pickFolder());

    const [req] = dialogRequests(seen);
    expect(req?.url).toBe(`/api/pick-folder?defaultPath=${encodeURIComponent(start)}`);
    expect(new URL(req!.url, 'http://h').searchParams.get('defaultPath')).toBe(start);
  });

  it('still opens the dialog when the start lookup fails — at the default', async () => {
    const calls: Array<string | undefined> = [];
    installWindow({
      pickFolder: async (_message, defaultPath) => {
        calls.push(defaultPath);
        return '/picked';
      },
    });
    installServer({ start: new Error('server down') });

    await expect(Effect.runPromise(pickFolder())).resolves.toEqual({ folder: '/picked' });
    expect(calls).toEqual([undefined]);

    // And the route path asks with no query at all, i.e. the old request.
    installWindow(null);
    const seen = installServer({ start: new Error('server down'), routeFolder: '/r' });
    await Effect.runPromise(pickFolder());
    expect(dialogRequests(seen).map((r) => r.url)).toEqual(['/api/pick-folder']);
  });

  it('startAt opens exactly there and skips the start lookup', async () => {
    // What the quick menu uses: it has already fetched the choices, and a
    // favorite opens the chooser INSIDE that folder.
    const calls: Array<string | undefined> = [];
    installWindow({
      pickFolder: async (_message, defaultPath) => {
        calls.push(defaultPath);
        return '/work/fav/proj';
      },
    });
    const seen = installServer({ start: '/somewhere/else' });

    await Effect.runPromise(pickFolder(undefined, { startAt: '/work/fav' }));

    expect(calls).toEqual(['/work/fav']);
    expect(seen.filter((r) => r.url === '/api/pick-folder/start')).toEqual([]);
  });

  it('remembers a successful pick as the last folder', async () => {
    installWindow({ pickFolder: async () => '/work/clients/acme' });
    const seen = installServer({ start: '/work' });

    await Effect.runPromise(pickFolder());

    expect(settingsWrites(seen).map((r) => r.body)).toEqual([
      { [PROJECT_FOLDER_LAST_KEY]: '/work/clients/acme' },
    ]);
  });

  it('remembers a pick that came through the route as well', async () => {
    installWindow(null);
    const seen = installServer({ start: '/work', routeFolder: '/work/b' });

    await Effect.runPromise(pickFolder());

    expect(settingsWrites(seen).map((r) => r.body)).toEqual([
      { [PROJECT_FOLDER_LAST_KEY]: '/work/b' },
    ]);
  });

  it('remembers nothing when the user cancels', async () => {
    installWindow({ pickFolder: async () => null });
    const bridgeSeen = installServer({ start: '/work' });
    await Effect.runPromise(pickFolder());
    expect(settingsWrites(bridgeSeen)).toEqual([]);

    installWindow(null);
    const routeSeen = installServer({ start: '/work', routeFolder: null });
    await Effect.runPromise(pickFolder());
    expect(settingsWrites(routeSeen)).toEqual([]);
  });

  it('remembers nothing when the caller opts out', async () => {
    // Settings choosing the default folder, and Create (which remembers the
    // folder it made, not the parent picked here).
    installWindow({ pickFolder: async () => '/work/default' });
    const seen = installServer({ start: '/work' });

    await expect(
      Effect.runPromise(pickFolder(undefined, { remember: false })),
    ).resolves.toEqual({ folder: '/work/default' });
    expect(settingsWrites(seen)).toEqual([]);
  });

  it('a failed write loses the memory, never the pick', async () => {
    installWindow({ pickFolder: async () => '/work/a' });
    installServer({ start: '/work', settingsFails: true });

    await expect(Effect.runPromise(pickFolder())).resolves.toEqual({ folder: '/work/a' });
  });

  it('the settings control clears the default by writing null', async () => {
    // The PUT merges, so a key cannot be deleted — `null` is "not set", and the
    // start resolver reads it exactly like an absent key.
    const seen = installServer({});
    await Effect.runPromise(saveProjectFolderDefault(null));
    await Effect.runPromise(saveProjectFolderDefault('/work'));
    expect(settingsWrites(seen).map((r) => r.body)).toEqual([
      { [PROJECT_FOLDER_DEFAULT_KEY]: null },
      { [PROJECT_FOLDER_DEFAULT_KEY]: '/work' },
    ]);
  });

  it('Create remembers the folder it made, not the parent it picked', () => {
    const src = readFileSync(at('packages/feature/workspace/src/client/EmptyState.tsx'), 'utf8');
    expect(src).toContain('requestFolder(trigger, { remember: false })');
    expect(src).toContain('rememberProjectFolder(result.path)');
  });

  it('every call site goes through the shared quick folder menu, not at the route directly', () => {
    // The preference above is worth nothing if a component fetches
    // `/api/pick-folder` itself — and the favorites menu is worth nothing if a
    // component calls the chooser around it. So the four "open a project"
    // entry points (sidebar, home Open + Create, session browser) all use ONE
    // hook, and only the hook and Settings call `pickFolder`.
    const dir = at('packages/feature/workspace/src/client');
    for (const file of ['Workspace.tsx', 'SessionBrowser.tsx', 'EmptyState.tsx']) {
      const src = readFileSync(join(dir, file), 'utf8');
      expect(src, `${file} calls the pick-folder route directly`).not.toContain('/api/pick-folder');
      expect(src, `${file} does not use the shared folder menu`).toContain('useProjectFolderMenu()');
      expect(src, `${file} calls the chooser around the menu`).not.toMatch(/\bpickFolder\(/);
    }
    for (const file of ['ProjectFolderMenu.tsx', 'ProjectFolderSettingsPanel.tsx']) {
      const src = readFileSync(join(dir, file), 'utf8');
      expect(src, `${file} calls the pick-folder route directly`).not.toContain('/api/pick-folder');
      expect(src, `${file} no longer uses the pickFolder client`).toContain('pickFolder(');
    }
  });
});

// ---------------------------------------------------------------------------
// (b) the shell tree never imports electron
// ---------------------------------------------------------------------------

const SOURCE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.next-prod', 'dist', '.git', 'chrome-extension']);

function sourceFiles(root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(root, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (SOURCE_EXT.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

describe('the shell tree stays free of electron', () => {
  it('no source file imports or requires electron', () => {
    // The shell is served to a browser (and to an iframe inside the app), and
    // Next resolves `electron` at build time; an import here breaks the bundle
    // rather than the runtime, i.e. it fails late and confusingly. The bridge
    // is a `window.naby` object put there by the preload, so nothing in this
    // tree ever needs the module.
    const offenders = [...sourceFiles(at('src')), ...sourceFiles(at('packages'))].filter(
      (file) => /(?:from\s*|require\(\s*)['"]electron(?:\/[^'"]*)?['"]/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (c) main registers fs:pickFolder
// ---------------------------------------------------------------------------

// The Electron main process lives in the NABY repository, one level above this
// submodule. A standalone cockpit checkout has no `electron/` at all — there
// the bridge can never exist and the route fallback is the whole story, so the
// assertion is skipped rather than failed.
const ipcSource = resolve(shellRoot, '..', 'electron', 'ipc.ts');
const inNabyRepo = existsSync(ipcSource);

describe.skipIf(!inNabyRepo)('electron main — the fs:pickFolder channel', () => {
  it('registers the channel and handles it', () => {
    const src = readFileSync(ipcSource, 'utf8');
    // Both halves matter: an allowed channel with no handler rejects the
    // invoke, and a handler on a channel outside CHANNELS is never registered.
    expect(src).toContain("'fs:pickFolder',");
    expect(src).toContain("handle('fs:pickFolder'");
  });

  it('opens a directory chooser that can create a folder', () => {
    const src = readFileSync(ipcSource, 'utf8');
    // `createDirectory` is what puts the "New Folder" button — and its text
    // field — in the panel. Without `openDirectory` it is a file picker.
    expect(src).toMatch(/properties:\s*\[\s*'openDirectory',\s*'createDirectory'\s*\]/);
  });

  it('parents the dialog to a BrowserWindow — the fix itself', () => {
    const src = readFileSync(ipcSource, 'utf8');
    // A parentless `showOpenDialog(options)` would reproduce the bug it fixes
    // on the window-menu front, so the window lookup and the two-argument call
    // are the load-bearing part.
    expect(src).toContain('BrowserWindow.fromWebContents(event.sender)');
    expect(src).toContain('dialog.showOpenDialog(win, options)');
  });

  it('opens at the validated defaultPath, never at an unchecked one', () => {
    const src = readFileSync(ipcSource, 'utf8');
    // The renderer's value goes through the validator, and the validator falls
    // back to home on every doubtful input instead of failing the call.
    expect(src).toContain('defaultPath: await pickFolderStart(defaultPath)');
    const fn = /async function pickFolderStart\([^]*?\n}\n/.exec(src)?.[0];
    expect(fn, 'pickFolderStart not found in ipc.ts').toBeDefined();
    expect(fn).toContain('isAbsolute(candidate)');
    expect(fn).toContain('isDirectory()');
    expect(fn).toContain('return homedir()');
    expect(fn).not.toContain('fail(');
  });

  it('the preload forwards defaultPath with the message', () => {
    const preload = readFileSync(resolve(shellRoot, '..', 'electron', 'preload.ts'), 'utf8');
    expect(preload).toMatch(/pickFolder: async \(message\?: string, defaultPath\?: string\)/);
    expect(preload).toMatch(/invoke\('fs:pickFolder', \{\s*message,\s*defaultPath,\s*\}\)/);
  });
});
