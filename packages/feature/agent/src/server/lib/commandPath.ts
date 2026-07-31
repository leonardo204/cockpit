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

/** Directories a user-level tool installer actually writes to, in the order they
 *  should win: uv's own installer first (`~/.local/bin`), then Homebrew on Apple
 *  Silicon, then Intel Homebrew / manual `/usr/local`, then the system. */
function wellKnownDirs(): string[] {
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
 *  useless here as one that does not exist. */
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
async function askLoginShell(bin: string): Promise<string | null> {
  if (process.platform === 'win32') return null;
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
 * The absolute path of `bin`, or null.
 *
 * Order: the explicit override, then the login shell, then the well-known
 * install directories. An override that is SET BUT WRONG returns null instead of
 * falling through — someone who pointed naby at a specific binary wants to be
 * told it is not there, not to be silently given a different one.
 */
export async function resolveCommandPath(bin: string): Promise<string | null> {
  if (!SAFE_BIN.test(bin)) return null;

  const override = process.env[commandPathEnvVar(bin)]?.trim();
  if (override) return isExecutableFile(override) ? override : null;

  const fromShell = await askLoginShell(bin);
  if (fromShell) return fromShell;

  for (const dir of wellKnownDirs()) {
    const candidate = join(dir, bin);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}
