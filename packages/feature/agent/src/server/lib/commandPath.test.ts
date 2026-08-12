import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  candidateNames,
  commandPathEnvVar,
  isExecutableFile,
  resolveCommandPath,
  searchPath,
  wellKnownDirs,
} from './commandPath';

/**
 * RESOLVING A LAUNCHER'S ABSOLUTE PATH (skill-hub-builtin §2.1).
 *
 * The environment this runs in is the developer's machine, which may or may not
 * have uv installed — so nothing here asserts against a real `uvx`. What is
 * asserted is the contract the Atlassian preset depends on: an explicit override
 * wins and is verified, a name that cannot exist resolves to null rather than
 * throwing, and a shell-hostile argument never reaches a shell.
 *
 * THE WINDOWS HALF IS ASSERTED FROM A MAC, ON PURPOSE. Windows resolution was
 * broken in a way no test here could see, because every function read
 * `process.platform` directly and this suite has never run on Windows. The fix
 * turns `platform` into an argument, and these tests spend that: they pass
 * `'win32'` explicitly, build a PATH with `;`, and create files named `*.exe`.
 * What they can prove is the SEARCH ORDER and the NAMES; what they cannot prove
 * is anything about Windows' own filesystem or process semantics (see the notes
 * on `isExecutableFile` below).
 */

const dir = mkdtempSync(join(tmpdir(), 'naby-cmdpath-'));

/** A file that exists and is executable, as far as `access(X_OK)` is concerned. */
function fakeBinary(name: string, inDir: string = dir): string {
  const path = join(inDir, name);
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
}

/**
 * An environment for a search to read. Next augments `NodeJS.ProcessEnv` with a
 * REQUIRED `NODE_ENV`, so a bare object literal does not typecheck as one; the
 * cast is confined here rather than repeated at every call site.
 */
function asEnv(vars: Record<string, string>): NodeJS.ProcessEnv {
  return vars as unknown as NodeJS.ProcessEnv;
}

/** A fresh empty directory, so one test's fake `uvx.exe` is not another's. */
function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `naby-cmdpath-${label}-`));
}

const touched: string[] = [];
function setEnv(bin: string, value: string | undefined) {
  const key = commandPathEnvVar(bin);
  touched.push(key);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const key of touched.splice(0)) delete process.env[key];
});

describe('commandPathEnvVar', () => {
  it('names the override after the binary', () => {
    expect(commandPathEnvVar('uvx')).toBe('NABY_UVX_PATH');
    expect(commandPathEnvVar('my-tool.v2')).toBe('NABY_MY_TOOL_V2_PATH');
  });
});

describe('isExecutableFile', () => {
  it('is true for an executable file and false for everything else', () => {
    const bin = fakeBinary('runnable');
    expect(isExecutableFile(bin)).toBe(true);
    expect(isExecutableFile(join(dir, 'does-not-exist'))).toBe(false);

    const plain = join(dir, 'not-executable');
    writeFileSync(plain, 'data');
    chmodSync(plain, 0o644);
    expect(isExecutableFile(plain)).toBe(false);
  });
});

describe('resolveCommandPath', () => {
  it('takes the explicit override when it points at something runnable', async () => {
    const bin = fakeBinary('uvx-override');
    setEnv('uvx', bin);
    await expect(resolveCommandPath('uvx')).resolves.toBe(bin);
  });

  it('FAILS on an override that is set but wrong, rather than looking elsewhere', async () => {
    // Someone who pinned a path wants to be told it is not there. Falling through
    // would silently run a different binary than the one they named.
    setEnv('uvx', join(dir, 'nowhere', 'uvx'));
    await expect(resolveCommandPath('uvx')).resolves.toBeNull();
  });

  it('ignores a blank override', async () => {
    // An empty settings/env value is "not set", not "set to nothing".
    const bin = fakeBinary('blank-probe');
    setEnv('blank-probe', '   ');
    // With the override ignored, nothing else can find a binary by this name.
    await expect(resolveCommandPath('blank-probe')).resolves.toBeNull();
    expect(isExecutableFile(bin)).toBe(true);
  });

  it('answers null for a binary no search can find', async () => {
    // Goes all the way through: the login shell, then the well-known directories.
    await expect(resolveCommandPath('naby-nonexistent-launcher-xyz')).resolves.toBeNull();
  }, 15_000);

  it('finds a real system binary through the search', async () => {
    // `sh` is in /bin on every platform this app supports, so this exercises the
    // whole path (shell lookup, or the well-known fallback when there is no
    // login shell) without depending on the developer's tool installs.
    const resolved = await resolveCommandPath('sh');
    expect(resolved, 'sh should be resolvable').toBeTruthy();
    expect(resolved?.startsWith('/')).toBe(true);
    expect(isExecutableFile(resolved!)).toBe(true);
  }, 15_000);

  it('refuses a name that is not a bare executable name, on Windows too', async () => {
    // The name is interpolated into a shell command line. These must never get
    // there — the guard belongs to the function, not to today's callers.
    for (const bad of ['uvx; rm -rf /', '../../bin/sh', 'uvx $(whoami)', '', 'uv x']) {
      await expect(resolveCommandPath(bad)).resolves.toBeNull();
      // The Windows branch reaches no shell, but it does reach `join()`, so the
      // guard has to hold there as well or `../../` becomes a directory escape.
      await expect(resolveCommandPath(bad, { platform: 'win32' })).resolves.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

describe('candidateNames', () => {
  it('is just the bare name on POSIX, whatever PATHEXT says', () => {
    // PATHEXT can be inherited into a POSIX process (WSL, a CI image); it means
    // nothing there, because executability is a mode bit.
    expect(candidateNames('uvx', 'darwin', '.COM;.EXE')).toEqual(['uvx']);
    expect(candidateNames('uvx', 'linux', undefined)).toEqual(['uvx']);
  });

  it('expands PATHEXT on Windows, lower-cased, with .exe FIRST', () => {
    // `.exe` first is not cosmetic: the MCP loader spawns with `shell: false`,
    // and Node refuses to spawn a `.cmd`/`.bat` that way (EINVAL). Picking the
    // `.cmd` would save successfully and fail at every connect.
    expect(candidateNames('uvx', 'win32', '.COM;.EXE;.BAT;.CMD')).toEqual([
      'uvx.exe',
      'uvx.com',
      'uvx.bat',
      'uvx.cmd',
    ]);
  });

  it('drops empty PATHEXT entries and duplicates', () => {
    // A trailing ';' is ordinary. The bare name it would produce is not
    // executable on Windows, so it must not become a candidate.
    expect(candidateNames('uvx', 'win32', '.EXE;;.CMD;')).toEqual(['uvx.exe', 'uvx.cmd']);
    expect(candidateNames('uvx', 'win32', '.EXE;.exe;.CMD')).toEqual(['uvx.exe', 'uvx.cmd']);
  });

  it('falls back to the standard PATHEXT when the variable is missing or blank', () => {
    for (const pathext of [undefined, '', '   ']) {
      expect(candidateNames('uvx', 'win32', pathext)).toEqual([
        'uvx.exe',
        'uvx.com',
        'uvx.bat',
        'uvx.cmd',
      ]);
    }
  });
});

describe('wellKnownDirs', () => {
  it('keeps the POSIX list exactly as it was', () => {
    expect(wellKnownDirs('darwin', asEnv({}))).toEqual([
      join(homedir(), '.local', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ]);
  });

  it('is the uv installer location on Windows', () => {
    // uv's standalone installer documents `%USERPROFILE%\.local\bin`. WinGet's
    // links directory is deliberately absent: it is already on PATH, which the
    // PATH search covers.
    expect(wellKnownDirs('win32', asEnv({ USERPROFILE: 'C:\\Users\\naby' }))).toEqual([
      join('C:\\Users\\naby', '.local', 'bin'),
    ]);
  });
});

describe('searchPath on Windows', () => {
  it('finds uvx.exe in a PATH directory — the case that used to be unreachable', () => {
    // Before the fix there was no PATH search at all on Windows, and the only
    // name ever probed was the extensionless `uvx`. A machine with uv correctly
    // installed still resolved to null.
    const binDir = tempDir('winpath');
    const exe = fakeBinary('uvx.exe', binDir);
    const env = asEnv({ PATH: [tempDir('empty'), binDir].join(';'), PATHEXT: '.COM;.EXE;.BAT;.CMD' });
    expect(searchPath('uvx', 'win32', env)).toBe(exe);
  });

  it('never matches the extensionless name', () => {
    // `uvx` with no extension is not runnable on Windows, so a POSIX-shaped file
    // sitting on PATH must not be mistaken for an install.
    const binDir = tempDir('winbare');
    fakeBinary('uvx', binDir);
    expect(searchPath('uvx', 'win32', asEnv({ PATH: binDir }))).toBeNull();
  });

  it('prefers uvx.exe over uvx.cmd in the same directory', () => {
    const binDir = tempDir('winboth');
    const exe = fakeBinary('uvx.exe', binDir);
    fakeBinary('uvx.cmd', binDir);
    expect(searchPath('uvx', 'win32', asEnv({ PATH: binDir }))).toBe(exe);
  });

  it('takes the first PATH directory that has a match', () => {
    const first = tempDir('winfirst');
    const second = tempDir('winsecond');
    const exe = fakeBinary('uvx.exe', first);
    fakeBinary('uvx.exe', second);
    expect(searchPath('uvx', 'win32', asEnv({ PATH: [first, second].join(';') }))).toBe(exe);
  });

  it('answers null with no PATH at all', () => {
    expect(searchPath('uvx', 'win32', asEnv({}))).toBeNull();
  });
});

describe('resolveCommandPath on Windows', () => {
  it('resolves uvx.exe from PATH', async () => {
    const binDir = tempDir('winresolve');
    const exe = fakeBinary('uvx.exe', binDir);
    await expect(
      resolveCommandPath('uvx', {
        platform: 'win32',
        env: asEnv({ PATH: binDir, USERPROFILE: tempDir('winhome') }),
      }),
    ).resolves.toBe(exe);
  });

  it('falls back to %USERPROFILE%\\.local\\bin when PATH does not carry it', async () => {
    // The freshly-installed case: uv's installer edits the registry's PATH, but
    // an already-running Electron process inherited its environment at launch
    // and will not see that until it restarts.
    const home = tempDir('winhome2');
    const localBin = join(home, '.local', 'bin');
    mkdirSync(localBin, { recursive: true });
    const exe = fakeBinary('uvx.exe', localBin);
    await expect(
      resolveCommandPath('uvx', {
        platform: 'win32',
        env: asEnv({ PATH: tempDir('empty2'), USERPROFILE: home }),
      }),
    ).resolves.toBe(exe);
  });

  it('still answers null when uv is genuinely absent', async () => {
    // The refusal has to survive: `systemMcp.uvxMissing` is the right answer for
    // a machine with no uv, and it is only trustworthy if it is not the answer
    // for every Windows machine.
    await expect(
      resolveCommandPath('uvx', {
        platform: 'win32',
        env: asEnv({ PATH: tempDir('empty3'), USERPROFILE: tempDir('winhome3') }),
      }),
    ).resolves.toBeNull();
  });

  it('honours the explicit override, and fails rather than searching when it is wrong', async () => {
    const exe = fakeBinary('uvx-pinned.exe');
    const env = asEnv({ [commandPathEnvVar('uvx')]: exe, PATH: tempDir('empty4') });
    await expect(resolveCommandPath('uvx', { platform: 'win32', env })).resolves.toBe(exe);

    const wrong = asEnv({ [commandPathEnvVar('uvx')]: join(dir, 'nope.exe'), PATH: dir });
    await expect(resolveCommandPath('uvx', { platform: 'win32', env: wrong })).resolves.toBeNull();
  });

  it('wires the defaults up too, not only the injected arguments', async () => {
    // Parameterising `platform` would be worth nothing if `resolveCommandPath()`
    // called with no options still took the POSIX path. So this one forces
    // `process.platform` itself and passes no env, which is exactly how
    // api/naby.ts calls it.
    const binDir = tempDir('windefault');
    const exe = fakeBinary('uvx-default-probe.exe', binDir);
    const realPlatform = process.platform;
    const realPath = process.env.PATH;
    const realUserProfile = process.env.USERPROFILE;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      process.env.PATH = binDir;
      process.env.USERPROFILE = tempDir('windefaulthome');
      await expect(resolveCommandPath('uvx-default-probe')).resolves.toBe(exe);
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
      process.env.PATH = realPath;
      if (realUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = realUserProfile;
    }
  });
});
