import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandPathEnvVar, isExecutableFile, resolveCommandPath } from './commandPath';

/**
 * RESOLVING A LAUNCHER'S ABSOLUTE PATH (skill-hub-builtin §2.1).
 *
 * The environment this runs in is the developer's machine, which may or may not
 * have uv installed — so nothing here asserts against a real `uvx`. What is
 * asserted is the contract the Atlassian preset depends on: an explicit override
 * wins and is verified, a name that cannot exist resolves to null rather than
 * throwing, and a shell-hostile argument never reaches a shell.
 */

const dir = mkdtempSync(join(tmpdir(), 'naby-cmdpath-'));

/** A file that exists and is executable, as far as `access(X_OK)` is concerned. */
function fakeBinary(name: string): string {
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
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

  it('refuses a name that is not a bare executable name', async () => {
    // The name is interpolated into a shell command line. These must never get
    // there — the guard belongs to the function, not to today's callers.
    for (const bad of ['uvx; rm -rf /', '../../bin/sh', 'uvx $(whoami)', '', 'uv x']) {
      await expect(resolveCommandPath(bad)).resolves.toBeNull();
    }
  });
});
