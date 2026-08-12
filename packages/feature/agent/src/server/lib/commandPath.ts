// packages/feature/agent/src/server/lib/commandPath.ts
//
// WHERE IS `uvx` — asked at SAVE time, not at connect time (skill-hub-builtin §2.1).
//
// A stdio MCP preset stores a COMMAND, and the command is spawned by the runtime
// loader with `shell: false`. In a packaged Electron build the child inherits the
// PATH of the process that launched the app — for a Finder/Dock launch that is a
// bare `/usr/bin:/bin:/usr/sbin:/sbin`, not the login shell's PATH — so a stored
// `command: 'uvx'` resolves on the developer's machine and fails with ENOENT on
// the user's. The failure surfaces a week later as "the assistant says Confluence
// is not available", which is the worst possible place to learn about PATH.
//
// So the absolute path is resolved ONCE, HERE, while the user is still looking at
// the form, and frozen into the entry. If it cannot be resolved the save is
// refused with an instruction to install uv — a refusal the user can act on beats
// a stored entry that can never work.
//
// NOTHING IS CACHED. A resolution costs one short-lived shell and happens only on
// an explicit save; a cache would just be a stale absolute path surviving the
// `brew uninstall` that invalidated it.
//
// WINDOWS HAD NO WAY TO SUCCEED AT ALL
// ------------------------------------
// Everything above was written for POSIX, and on Windows it left NO branch that
// could ever return a path: the login-shell probe returns null by design, the
// well-known directories were POSIX-only (`/usr/bin`, the Homebrew prefixes),
// and — the decisive one — the only candidate file name tried was the
// extensionless `uvx`, while uv's installer writes `uvx.exe`. A Windows user
// with uv correctly installed had their Confluence preset refused with
// `systemMcp.uvxMissing`, forever, with no setting that could fix it.
//
// So this module is now PLATFORM-AWARE in three places: the candidate NAMES
// (`candidateNames`), a PATH search that exists only on Windows (`searchPath` —
// a GUI process on Windows inherits the registry's user+system PATH properly,
// unlike a Finder-launched app on macOS, so PATH is trustworthy there and is in
// fact where WinGet's shim folder lives), and the well-known directory list.
// Each takes `platform` as a PARAMETER rather than reading `process.platform`,
// because the bug being fixed is one that cannot be reproduced on the machine
// this is written on.

import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Resolve an executable name to an absolute path, or null when it is absent.
 *  Injectable so the presets can be exercised without a real uv install. */
export type CommandResolver = (bin: string) => Promise<string | null>;

/** Only bare executable NAMES are resolvable. The names come from the preset
 *  registry (constants in this repo), but this function interpolates its argument
 *  into a shell command line, so the guard is a property of the function rather
 *  than a property of today's callers. */
const SAFE_BIN = /^[A-Za-z0-9._-]+$/;

/** How long the login shell gets. A user's rc files can be slow (nvm, conda,
 *  version managers), but a save that hangs is worse than a save that falls
 *  through to the well-known paths below. */
const SHELL_TIMEOUT_MS = 5_000;

/**
 * The env var that pins a binary's path explicitly: `uvx` → `NABY_UVX_PATH`.
 *
 * It exists for two reasons. One is real: an install that keeps uv somewhere none
 * of the searches below would look. The other is testability — a test that needs
 * "uvx is present" or "uvx is absent" to be TRUE must not depend on whether the
 * machine running the suite happens to have uv installed.
 */
export function commandPathEnvVar(bin: string): string {
  return `NABY_${bin.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_PATH`;
}

/** What Windows uses when `PATHEXT` is somehow unset. The value Windows itself
 *  ships is longer (`.VBS`, `.JS`, …), but a launcher is never one of those. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * The file names `bin` can actually have on `platform`.
 *
 * On POSIX there is exactly one: executability lives in the mode bits, so the
 * file is called `uvx`. On Windows executability lives in the EXTENSION, and
 * the set of extensions that count is `PATHEXT` — uv's official installer writes
 * `uvx.exe`, while other routes can leave a `uvx.cmd` shim. Probing only the
 * extensionless `uvx` (what this module used to do) can therefore never match
 * anything on Windows: that name is not what any installer writes.
 *
 * `.exe` IS SORTED FIRST, DELIBERATELY. The stored command is spawned by the MCP
 * loader with `shell: false`, and since the CVE-2024-27980 fix (Node 18.20 /
 * 20.12 and later) spawning a `.cmd` or `.bat` without a shell throws EINVAL.
 * A `.cmd` picked here would resolve fine at save time and then fail at every
 * connect — the exact "saved fine, never works" shape this module exists to
 * prevent. `.exe` is both safe to spawn that way and what uv actually installs,
 * so when both exist the `.exe` wins.
 */
export function candidateNames(
  bin: string,
  platform: NodeJS.Platform = process.platform,
  pathext: string | undefined = process.env.PATHEXT,
): string[] {
  if (platform !== 'win32') return [bin];
  const exts = (pathext?.trim() || DEFAULT_PATHEXT)
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    // A trailing ';' is common; an empty entry would become the bare name, which
    // on Windows is not executable.
    .filter((ext) => ext.length > 0);
  const unique = [...new Set(exts)];
  const ordered = [
    ...unique.filter((ext) => ext === '.exe'),
    ...unique.filter((ext) => ext !== '.exe'),
  ];
  return ordered.map((ext) => `${bin}${ext}`);
}

/**
 * Directories a user-level tool installer actually writes to, in the order they
 * should win.
 *
 * POSIX: uv's own installer first (`~/.local/bin`), then Homebrew on Apple
 * Silicon, then Intel Homebrew / manual `/usr/local`, then the system.
 *
 * Windows: `%USERPROFILE%\.local\bin` is enough on its own — it is the location
 * uv's documentation names for its standalone installer. The other common route,
 * WinGet, installs into a links directory that IS already on PATH, so the PATH
 * search above it catches that one; duplicating a WinGet path here would be a
 * guess at a directory layout we have no way to verify.
 */
export function wellKnownDirs(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'win32') {
    // `USERPROFILE` is the variable Windows itself sets and uv's docs quote;
    // `homedir()` is the fallback (and what a test can redirect via HOME).
    const home = env.USERPROFILE?.trim() || env.HOME?.trim() || homedir();
    return [join(home, '.local', 'bin')];
  }
  return [
    join(homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
}

/** True when the path exists and this process could execute it. `access` rather
 *  than `stat`, because a file that exists without the execute bit is exactly as
 *  useless here as one that does not exist.
 *
 *  On Windows `X_OK` is not a real permission bit — the check degrades to "does
 *  this file exist", which is precisely the question there, since executability
 *  on Windows is carried by the extension that `candidateNames` already picked. */
export function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask the user's LOGIN shell where a binary is.
 *
 * `$SHELL -l -c 'command -v <bin>'` is the only reliable way to see the PATH the
 * user themselves has: it sources the same rc files their terminal does, which is
 * where `~/.local/bin` and the Homebrew prefix are put. `command -v` is a POSIX
 * builtin (`which` is not, and is a shell function in some setups).
 *
 * Every failure — no shell, spawn error, non-zero exit, timeout, a path that is
 * not executable — reads as "not found" rather than throwing, because the caller's
 * next move is the same in all of them.
 */
async function askLoginShell(
  bin: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (platform === 'win32') return null;
  const shell = process.env.SHELL || '/bin/sh';
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let out = '';
    try {
      const child = spawn(shell, ['-l', '-c', `command -v ${bin}`], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        done(null);
      }, SHELL_TIMEOUT_MS);
      timer.unref?.();
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
      });
      child.on('error', () => {
        clearTimeout(timer);
        done(null);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return done(null);
        // `command -v` can print several lines (aliases, functions); the first
        // absolute path is the executable.
        const line = out
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l.startsWith('/'));
        done(line && isExecutableFile(line) ? line : null);
      });
    } catch {
      done(null);
    }
  });
}

/**
 * Walk `PATH` for any of `bin`'s candidate names. First hit wins, in PATH order.
 *
 * WINDOWS ONLY, by choice of the one caller. A Windows GUI process inherits the
 * user+system PATH from the registry, so PATH there really does describe where
 * the user's tools are — and it is where WinGet's shim directory lives, which is
 * why one PATH walk covers an install route this module does not model. On macOS
 * the equivalent is worthless (a Finder launch hands the app a bare
 * `/usr/bin:/bin:/usr/sbin:/sbin`), which is the entire reason `askLoginShell`
 * exists; adding a PATH walk there would only add a way to answer differently
 * depending on how the app was started.
 *
 * `platform` and `env` are parameters so the Windows behaviour is assertable
 * from a Mac: the delimiter and the candidate names both follow from `platform`.
 */
export function searchPath(
  bin: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.PATH || '';
  if (!raw) return null;
  const delimiter = platform === 'win32' ? ';' : ':';
  const names = candidateNames(bin, platform, env.PATHEXT);
  for (const dir of raw.split(delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    for (const name of names) {
      const candidate = join(trimmed, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

export type ResolveCommandPathOptions = {
  /** Override the environment (the pinned path, PATH, PATHEXT, USERPROFILE). */
  env?: NodeJS.ProcessEnv;
  /** Override the platform, so the Windows search order is testable anywhere. */
  platform?: NodeJS.Platform;
};

/**
 * The absolute path of `bin`, or null.
 *
 * Order: the explicit override, then the login shell (POSIX only), then — on
 * Windows — PATH, then the well-known install directories. An override that is
 * SET BUT WRONG returns null instead of falling through — someone who pointed
 * naby at a specific binary wants to be told it is not there, not to be silently
 * given a different one.
 */
export async function resolveCommandPath(
  bin: string,
  opts: ResolveCommandPathOptions = {},
): Promise<string | null> {
  if (!SAFE_BIN.test(bin)) return null;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;

  const override = env[commandPathEnvVar(bin)]?.trim();
  if (override) return isExecutableFile(override) ? override : null;

  const fromShell = await askLoginShell(bin, platform);
  if (fromShell) return fromShell;

  if (platform === 'win32') {
    const fromPath = searchPath(bin, platform, env);
    if (fromPath) return fromPath;
  }

  for (const dir of wellKnownDirs(platform, env)) {
    for (const name of candidateNames(bin, platform, env.PATHEXT)) {
      const candidate = join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}
