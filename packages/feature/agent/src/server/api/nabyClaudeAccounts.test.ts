import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNabyState, runNabyAction } from './naby';
import { getStore } from '../engines/naby';
import { markRunIdle, startRun } from '../sessionRunHub';
// The folder layout, imported rather than respelled: a literal here would keep
// passing if the runtime moved the accounts root.
import { CLAUDE_ACCOUNTS_DIR_NAME } from '../../../../../../../dist/naby-runtime.mjs';

/**
 * `/api/naby` — MORE THAN ONE CLAUDE SUBSCRIPTION (claude-multi-account §5).
 *
 * NO TEST HERE MAY REACH THE DEVELOPER'S OWN CLAUDE SIGN-IN. Two things make that
 * true, and both are load-bearing rather than incidental:
 *
 *   * `vitest.setup.ts` points NABY_HOME at a throwaway directory, and the whole
 *     feature resolves its folders under the naby home — so every account folder
 *     these tests create lives there and dies with it.
 *   * `NABY_CLAUDE_BIN` points at a FAKE `claude` script — by default, from
 *     `vitest.setup.ts`, and per-case here when a case needs a different one.
 *     Nothing here spawns the real CLI, and nothing here opens a browser. The
 *     default matters more than the per-case pins: a case added later that
 *     forgets to pin one still cannot reach the developer's own `claude`.
 *
 * The runtime's own behaviour (the folder layout, the environment rule, the
 * removal ORDER) is covered by `npm run spike:claude-accounts`, which drives the
 * real functions. This file covers the WIRING: that the actions exist, that they
 * refuse what they must refuse, and that the block the settings screen reads
 * carries ids and labels rather than paths.
 */

/** A `claude` that reports a live sign-in for ANY config directory — the machine
 *  §5.3 says to hide the feature on. */
function writeLeakyClaude(): string {
  const dir = mkdtempSync(join(tmpdir(), 'naby-fake-claude-'));
  const path = join(dir, 'claude');
  writeFileSync(
    path,
    '#!/bin/sh\n' +
      'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then\n' +
      '  printf \'{"loggedIn":true,"email":"machine-wide@example.com"}\\n\'\n' +
      '  exit 0\n' +
      'fi\n' +
      'exit 0\n',
  );
  chmodSync(path, 0o755);
  return path;
}

/** A `claude` that partitions properly: it answers out of `CLAUDE_CONFIG_DIR`
 *  alone, so a brand-new folder reads as signed out — and `auth login` exits at
 *  once rather than opening a browser. */
function writeFakeClaude(): string {
  const dir = mkdtempSync(join(tmpdir(), 'naby-fake-claude-'));
  const path = join(dir, 'claude');
  writeFileSync(
    path,
    '#!/bin/sh\n' +
      'DIR="${CLAUDE_CONFIG_DIR:-UNSET}"\n' +
      'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then\n' +
      '  if [ -f "$DIR/signed-in" ]; then\n' +
      '    printf \'{"loggedIn":true,"email":"in-folder@example.com"}\\n\'\n' +
      '  else\n' +
      '    printf \'{"loggedIn":false}\\n\'\n' +
      '  fi\n' +
      '  exit 0\n' +
      'fi\n' +
      'exit 0\n',
  );
  chmodSync(path, 0o755);
  return path;
}

const ISOLATION_KEY = 'claude.accountIsolation';
const ACTIVE_KEY = 'claude.activeAccount';

afterEach(() => {
  // Each case owns the world it asserts on: the isolation verdict and the
  // selection are global settings, so leaving one behind would decide the next
  // test's answer for it.
  const store = getStore();
  store.setSetting(ISOLATION_KEY, '');
  store.setSetting(ACTIVE_KEY, '');
  // RESTORE the suite-wide fake rather than deleting the variable. Deleting it
  // used to drop every case after this one onto whatever `claude` the machine
  // has, which is the real CLI on a developer's laptop.
  const fallback = process.env.NABY_TEST_FAKE_CLAUDE_BIN;
  if (fallback) process.env.NABY_CLAUDE_BIN = fallback;
  else delete process.env.NABY_CLAUDE_BIN;
});

describe('GET /api/naby — the Claude account block', () => {
  it('reports no accounts, no selection, and NO PATH on a fresh install', async () => {
    const state = await readNabyState(null);
    expect(state.claudeAccounts).toBeDefined();
    expect(state.claudeAccounts.accounts).toEqual([]);
    // null is "the one sign-in this computer has" — the single-account default.
    expect(state.claudeAccounts.activeId).toBeNull();
    expect(state.claudeAccounts.isolation).toBe('unknown');
    // §5.6 — the config directory never crosses this boundary. A path on screen
    // becomes an endpoint that accepts one back.
    expect(JSON.stringify(state.claudeAccounts)).not.toContain('claude-accounts');
  });

  it('hides the feature once the machine has been PROVEN not to keep sign-ins apart', async () => {
    getStore().setSetting(ISOLATION_KEY, 'broken');
    const state = await readNabyState(null);
    expect(state.claudeAccounts.supported).toBe(false);
    expect(state.claudeAccounts.isolation).toBe('broken');
  });
});

describe('POST /api/naby — claude-account.select', () => {
  it('refuses an account it has never heard of', async () => {
    const result = await runNabyAction({
      action: 'claude-account.select',
      accountId: 'acct-000000000000',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('unknown account');
  });

  it("accepts '' — the way back to this computer's own sign-in", async () => {
    const result = await runNabyAction({ action: 'claude-account.select', accountId: '' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claudeAccounts?.activeId).toBeNull();
  });

  it('refuses a switch while a turn is still being written, and allows it once idle (§5.4)', async () => {
    // A REAL account row, made the way the app makes one: the fake CLI reports a
    // brand-new folder as signed out (so isolation reads ok) and its `auth login`
    // exits immediately instead of opening a browser.
    process.env.NABY_CLAUDE_BIN = writeFakeClaude();
    const added = await runNabyAction({ action: 'claude-account.add' });
    expect(added.ok).toBe(true);
    if (!added.ok || !added.accountId) return;
    const accountId = added.accountId;

    // The environment is fixed into the child process at turn start, so a running
    // turn keeps spending the account it started on. Switching now would leave the
    // screen naming one account while the answer being written belongs to another
    // — the refusal exists to stop that, not for safety.
    const key = 'run-key-for-account-switch-test';
    startRun(key, process.cwd());
    let refused: Awaited<ReturnType<typeof runNabyAction>>;
    try {
      refused = await runNabyAction({ action: 'claude-account.select', accountId });
    } finally {
      markRunIdle(key);
    }
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.errorKey).toBe('claudeAccounts.busy');

    // Nothing moved while it was refused.
    expect((await readNabyState(null)).claudeAccounts.activeId).toBeNull();

    // And with nothing running it goes through, globally (§5.5) — one id, not a
    // per-session choice.
    const accepted = await runNabyAction({ action: 'claude-account.select', accountId });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.claudeAccounts?.activeId).toBe(accountId);
    expect((await readNabyState(null)).claudeAccounts.activeId).toBe(accountId);

    // Clean up through the product path, which also exercises that removing the
    // ACTIVE account clears the selection.
    const removed = await runNabyAction({ action: 'claude-account.remove', accountId });
    expect(removed.ok).toBe(true);
    const after = await readNabyState(null);
    expect(after.claudeAccounts.accounts).toEqual([]);
    expect(after.claudeAccounts.activeId).toBeNull();
  });
});

describe('POST /api/naby — claude-account.verify / remove', () => {
  it('refuses anything that is not an id this app minted', async () => {
    for (const action of ['claude-account.verify', 'claude-account.remove'] as const) {
      const bad = await runNabyAction({ action, accountId: '../../etc' });
      expect(bad.ok).toBe(false);
      if (bad.ok) continue;
      expect(bad.error).toContain('accountId');
    }
  });

  it('refuses to verify an id it does not have a row for', async () => {
    const result = await runNabyAction({
      action: 'claude-account.verify',
      accountId: 'acct-111111111111',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('unknown account');
  });
});

describe('GET /api/naby — the sign-in chip follows the selected account', () => {
  it('reports the SELECTED account\'s identity, not the machine default', async () => {
    process.env.NABY_CLAUDE_BIN = writeFakeClaude();
    const added = await runNabyAction({ action: 'claude-account.add' });
    expect(added.ok).toBe(true);
    if (!added.ok || !added.accountId) return;
    const accountId = added.accountId;

    // Nothing is signed in anywhere yet, so both namespaces read signed-out.
    const beforeState = await readNabyState(null, { recheckLogin: true });
    expect(beforeState.claudeLogin.status).toBe('signed-out');

    // The browser flow lands in THAT account's folder (the fake CLI reads the
    // credential out of `CLAUDE_CONFIG_DIR`, exactly as the real one does). The
    // test computes the path from the documented layout; the product never sends
    // it anywhere.
    writeFileSync(
      join(process.env.NABY_HOME!, CLAUDE_ACCOUNTS_DIR_NAME, accountId, 'signed-in'),
      'x',
    );

    // Still the machine default while nothing is selected...
    expect((await readNabyState(null, { recheckLogin: true })).claudeLogin.status).toBe(
      'signed-out',
    );

    // ...and the account's own identity once it is.
    await runNabyAction({ action: 'claude-account.select', accountId });
    const state = await readNabyState(null, { recheckLogin: true });
    expect(state.claudeLogin.status).toBe('signed-in');
    expect(state.claudeLogin.account?.email).toBe('in-folder@example.com');

    await runNabyAction({ action: 'claude-account.remove', accountId });
  });
});

describe('POST /api/naby — claude-account.add on a machine with no partitioning', () => {
  it('refuses, says so with a translatable key, and puts the feature away (§5.3)', async () => {
    // The fake CLI answers "signed in" for a directory created milliseconds ago
    // and containing nothing, which can only mean the credentials are not
    // partitioned by directory here.
    process.env.NABY_CLAUDE_BIN = writeLeakyClaude();
    const result = await runNabyAction({ action: 'claude-account.add' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorKey).toBe('claudeAccounts.notIsolated');

    // And the verdict is remembered, so the settings screen stops offering it
    // rather than re-discovering the same refusal on every click.
    const state = await readNabyState(null);
    expect(state.claudeAccounts.supported).toBe(false);
    expect(state.claudeAccounts.accounts).toEqual([]);
  });
});
