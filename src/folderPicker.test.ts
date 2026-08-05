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
import { pickFolder } from '../packages/feature/workspace/src/client/effect/workspaceClient';

// This file lives at <shellRoot>/src/folderPicker.test.ts
const shellRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p: string[]) => resolve(shellRoot, ...p);

// ---------------------------------------------------------------------------
// (a) the client prefers the bridge
// ---------------------------------------------------------------------------

type Bridge = { pickFolder: (message?: string) => Promise<string | null> };

/** Install a fake `window` carrying the preload bridge, or one carrying no
 *  `naby` at all (the plain-browser case). */
function installWindow(bridge: Bridge | null): void {
  (globalThis as { window?: unknown }).window = bridge ? { naby: { fsOps: bridge } } : {};
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.unstubAllGlobals();
});

describe('pickFolder — Electron first, route as fallback', () => {
  it('uses the bridge and never touches /api/pick-folder', async () => {
    const bridgeCalls: Array<string | undefined> = [];
    installWindow({
      pickFolder: async (message) => {
        bridgeCalls.push(message);
        return '/Users/someone/projects/naby';
      },
    });
    // Any fetch at all is the failure this test exists to catch, so make one
    // loud rather than letting it quietly answer.
    const fetchSpy = vi.fn(() => {
      throw new Error('fetch must not be called when the bridge is present');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await Effect.runPromise(pickFolder());

    expect(result).toEqual({ folder: '/Users/someone/projects/naby' });
    expect(bridgeCalls).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports a cancelled bridge dialog as folder: null, not as an error', async () => {
    // Cancelling is what a user does half the time. It must reach the call
    // sites as "no folder", never as a failed Effect (which would surface as an
    // error toast for an ordinary Escape key).
    installWindow({ pickFolder: async () => null });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('fetch must not be called when the bridge is present');
      }),
    );

    await expect(Effect.runPromise(pickFolder())).resolves.toEqual({ folder: null });
  });

  it('falls back to /api/pick-folder when there is no bridge', async () => {
    // The cockpit standalone dev server: `window.naby` is simply absent.
    installWindow(null);
    const requested: string[] = [];
    const fetchSpy = vi.fn(async (input: unknown) => {
      requested.push(String(input));
      return {
        ok: true,
        status: 200,
        json: async () => ({ folder: '/from/the/route' }),
      };
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await Effect.runPromise(pickFolder());

    expect(result).toEqual({ folder: '/from/the/route' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(requested).toEqual(['/api/pick-folder']);
  });

  it('falls back when naby exists but the bridge predates pickFolder', async () => {
    // An older preload (or a future one that drops the method) must degrade to
    // the route rather than throwing "pickFolder is not a function".
    (globalThis as { window?: unknown }).window = { naby: { fsOps: { trash: () => {} } } };
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ folder: '/from/the/route' }),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(Effect.runPromise(pickFolder())).resolves.toEqual({
      folder: '/from/the/route',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('every call site goes through this client, not at the route directly', () => {
    // The preference above is worth nothing if a component fetches
    // `/api/pick-folder` itself. Only the client module may name that path.
    const dir = at('packages/feature/workspace/src/client');
    for (const file of ['Workspace.tsx', 'SessionBrowser.tsx', 'EmptyState.tsx']) {
      const src = readFileSync(join(dir, file), 'utf8');
      expect(src, `${file} calls the pick-folder route directly`).not.toContain(
        '/api/pick-folder',
      );
      expect(src, `${file} no longer uses the pickFolder client`).toContain('pickFolder');
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
});
