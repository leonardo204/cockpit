import { describe, it, expect } from 'vitest';
import {
  claudeIdentityPath,
  defaultClaudeConfigDir,
  nabyClaudeConfigDir,
  readClaudeCliUsage,
  readClaudeIdentityFrom,
  sameClaudeAccount,
} from '../../../../../../../dist/naby-runtime.mjs';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * WHOSE PLAN IS THIS? — the guard on the second usage source.
 *
 * THE HAZARD, IN ONE SENTENCE. naby is multi-account and isolates each Claude
 * subscription behind its own `CLAUDE_CONFIG_DIR`, while `~/.claude` belongs to
 * Claude Code and may be a COMPLETELY DIFFERENT subscription — so merging the two
 * readings, which the feature does by keeping whichever has less headroom, can
 * take a stranger's exhausted week and show it as the user's.
 *
 * That makes this the most dangerous part of the feature and the least visible:
 * every failure produces a plausible-looking number. The rule is therefore
 * "prove they are the same account or do not merge at all", with two proofs
 * (same directory; same `accountUuid`) and refusal as the default for everything
 * else, INCLUDING "could not tell".
 *
 * No real home directory is touched: every path here is a temp dir, and the
 * environment is passed in rather than read from the process.
 */

const HOME = mkdtempSync(join(tmpdir(), 'naby-usage-home-'));

/**
 * An environment literal for these rules.
 *
 * Cast because the shell's `NodeJS.ProcessEnv` is augmented by Next to REQUIRE
 * `NODE_ENV`, while the entire point of passing an environment in is to supply a
 * controlled one instead of inheriting the real process's — a `{}` here is the
 * accurate input, not an incomplete one.
 */
const env = (vars: Record<string, string> = {}): NodeJS.ProcessEnv => vars as NodeJS.ProcessEnv;

/** Write an identity file the way Claude Code writes one — the `oauthAccount`
 *  block, and NOT a credential (there is no token in this file). */
function writeIdentity(path: string, uuid: string, email = 'someone@example.com'): void {
  writeFileSync(path, JSON.stringify({ numStartups: 3, oauthAccount: { accountUuid: uuid, emailAddress: email } }));
}

describe('claudeIdentityPath — the file is NOT always inside the config dir', () => {
  it('puts it beside ~/.claude when no CLAUDE_CONFIG_DIR is set', () => {
    // Verified on a live machine: `~/.claude/.claude.json` does not exist while
    // `~/.claude.json` does. Getting this wrong makes every comparison answer
    // "cannot tell", which fails safe but silently disables the second source —
    // a bug that looks exactly like the feature working.
    expect(claudeIdentityPath(join(HOME, '.claude'), env(), HOME)).toBe(join(HOME, '.claude.json'));
  });

  it('puts it inside the directory for an isolated account', () => {
    const acct = join(HOME, 'naby', 'claude-accounts', 'acct-0123456789ab');
    expect(claudeIdentityPath(acct, env(), HOME)).toBe(join(acct, '.claude.json'));
  });

  it('puts it inside the directory when CLAUDE_CONFIG_DIR names one explicitly', () => {
    const dir = join(HOME, '.claude');
    expect(claudeIdentityPath(dir, env({ CLAUDE_CONFIG_DIR: dir }), HOME)).toBe(join(dir, '.claude.json'));
  });
});

describe('defaultClaudeConfigDir / nabyClaudeConfigDir', () => {
  it('follows an ambient CLAUDE_CONFIG_DIR, else ~/.claude', () => {
    expect(defaultClaudeConfigDir(env(), HOME)).toBe(join(HOME, '.claude'));
    expect(defaultClaudeConfigDir(env({ CLAUDE_CONFIG_DIR: '/somewhere/else' }), HOME)).toBe('/somewhere/else');
  });

  it('gives the inherited directory when no naby account is chosen', () => {
    // The single-account case: `probeClaudeUsage` passes no `env`, so the child
    // inherits, so naby's namespace IS the CLI's. That is proof 1 below.
    expect(nabyClaudeConfigDir(undefined, env(), HOME)).toBe(join(HOME, '.claude'));
  });

  it('gives nothing for an id it did not mint', () => {
    // An id from a request body or a hand-edited setting must not be joined onto
    // a path. Undefined here means "cannot tell", which refuses the merge.
    expect(nabyClaudeConfigDir('../../etc', env(), HOME)).toBeUndefined();
    expect(nabyClaudeConfigDir('acct-NOTHEX', env(), HOME)).toBeUndefined();
  });
});

describe('readClaudeIdentityFrom — labels only, and only when usable', () => {
  it('reads accountUuid and emailAddress', () => {
    expect(readClaudeIdentityFrom({ oauthAccount: { accountUuid: 'u-1', emailAddress: 'a@b.c' } })).toEqual({
      uuid: 'u-1',
      email: 'a@b.c',
    });
  });

  it('refuses anything without an accountUuid', () => {
    // Email is NEVER the decider — one person can hold two accounts reporting the
    // same email in different organisations, which is the same reason the account
    // registry refuses to derive an id from one.
    expect(readClaudeIdentityFrom({ oauthAccount: { emailAddress: 'a@b.c' } })).toBeUndefined();
    expect(readClaudeIdentityFrom({ oauthAccount: { accountUuid: '   ' } })).toBeUndefined();
    expect(readClaudeIdentityFrom({ oauthAccount: null })).toBeUndefined();
    expect(readClaudeIdentityFrom({})).toBeUndefined();
    expect(readClaudeIdentityFrom(null)).toBeUndefined();
    expect(readClaudeIdentityFrom('nope')).toBeUndefined();
  });
});

describe('sameClaudeAccount — the merge is refused unless equality is PROVED', () => {
  const idA = { uuid: 'uuid-a', email: 'a@example.com' };
  const idB = { uuid: 'uuid-b', email: 'b@example.com' };

  it('proof 1: the same directory is the same namespace', () => {
    // The single-account case, and it holds structurally — no file is read, so an
    // unreadable identity file cannot refuse a merge the directory has settled.
    expect(
      sameClaudeAccount({
        nabyConfigDir: '/home/u/.claude',
        cliConfigDir: '/home/u/.claude',
        nabyIdentity: undefined,
        cliIdentity: undefined,
      }),
    ).toBe(true);
  });

  it('proof 2: different directories, same accountUuid', () => {
    // Legitimate: the user signed the same subscription into both places.
    expect(
      sameClaudeAccount({
        nabyConfigDir: '/naby/acct-1',
        cliConfigDir: '/home/u/.claude',
        nabyIdentity: idA,
        cliIdentity: { ...idA, email: 'renamed@example.com' },
      }),
    ).toBe(true);
  });

  it('REFUSES two different accounts — the defect this guard exists for', () => {
    expect(
      sameClaudeAccount({
        nabyConfigDir: '/naby/acct-1',
        cliConfigDir: '/home/u/.claude',
        nabyIdentity: idA,
        cliIdentity: idB,
      }),
    ).toBe(false);
  });

  it('REFUSES when it cannot tell — an unreadable identity is not a match', () => {
    // "Probably the same" is not a state this returns. Refusing costs a second
    // opinion; merging wrongly costs the user a true number.
    for (const [n, c] of [
      [idA, undefined],
      [undefined, idA],
      [undefined, undefined],
    ] as const) {
      expect(
        sameClaudeAccount({
          nabyConfigDir: '/naby/acct-1',
          cliConfigDir: '/home/u/.claude',
          nabyIdentity: n,
          cliIdentity: c,
        }),
      ).toBe(false);
    }
  });

  it('REFUSES when naby’s own directory could not be resolved', () => {
    expect(
      sameClaudeAccount({
        nabyConfigDir: undefined,
        cliConfigDir: '/home/u/.claude',
        nabyIdentity: idA,
        cliIdentity: idA,
      }),
    ).toBe(false);
  });
});

describe('readClaudeCliUsage — the refusal is structural, not advisory', () => {
  const NOW = 1787531824602;
  const FRESH_CACHE = {
    _ts: NOW,
    _ok: true,
    five_hour: { utilization: 5, resets_at: '2026-08-24T05:19:59.552361+00:00' },
    seven_day: { utilization: 84, resets_at: '2026-08-24T10:59:59.552386+00:00' },
  };

  function makeHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'naby-usage-case-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
    return home;
  }

  it('merges when naby has no account of its own — same directory', () => {
    const home = makeHome();
    writeFileSync(join(home, '.claude', '.hud_cache'), JSON.stringify(FRESH_CACHE));
    const r = readClaudeCliUsage({ now: NOW, env: env(), home });
    expect(r.reason).toBe('same-account');
    expect(r.usage?.sevenDay?.utilizationPercent).toBe(84);
  });

  it('reports no-cache when the file is missing or unparseable', () => {
    const home = makeHome();
    expect(readClaudeCliUsage({ now: NOW, env: env(), home }).reason).toBe('no-cache');
    writeFileSync(join(home, '.claude', '.hud_cache'), 'not json{');
    const r = readClaudeCliUsage({ now: NOW, env: env(), home });
    expect(r.reason).toBe('no-cache');
    expect(r.usage).toBeNull();
  });

  it('reports stale-cache rather than different-account for an old file', () => {
    // Freshness is checked BEFORE identity on purpose: reporting a
    // multi-account refusal for a file that was merely old would send the next
    // reader hunting a bug that is not there.
    const home = makeHome();
    writeFileSync(join(home, '.claude', '.hud_cache'), JSON.stringify(FRESH_CACHE));
    const r = readClaudeCliUsage({ now: NOW + 60 * 60 * 1000, env: env(), home });
    expect(r.reason).toBe('stale-cache');
    expect(r.usage).toBeNull();
  });

  /**
   * Set up the ISOLATED-ACCOUNT case properly.
   *
   * NOTE WHAT IS *NOT* DONE HERE: the ambient `CLAUDE_CONFIG_DIR` is left unset.
   * naby never sets that variable on ITSELF — it sets it on the CLI CHILD it
   * spawns — so the server process's own environment still points at the user's
   * `~/.claude`, which is precisely why the two sides can disagree. Setting it
   * here would move BOTH sides at once and quietly test nothing (the first draft
   * of this test did exactly that and reported `no-cache`).
   *
   * `nabyClaudeConfigDir` resolves the id against the naby home, which the shell
   * test setup has already pointed at a temp directory.
   */
  function makeIsolatedAccount(uuid: string): string {
    const accountId = 'acct-0123456789ab';
    const dir = nabyClaudeConfigDir(accountId, env(), HOME) as string;
    expect(dir).toBeTruthy();
    mkdirSync(dir, { recursive: true });
    writeIdentity(join(dir, '.claude.json'), uuid);
    return accountId;
  }

  it('DROPS THE READING when the two sides are different accounts', () => {
    // The whole point. `usage` is null on a refusal, so a caller that ignores
    // `reason` still cannot merge across accounts — the guard cannot be defeated
    // by forgetting to check it.
    const home = makeHome();
    writeFileSync(join(home, '.claude', '.hud_cache'), JSON.stringify(FRESH_CACHE));
    writeIdentity(join(home, '.claude.json'), 'uuid-claude-code');

    const accountId = makeIsolatedAccount('uuid-someone-else');

    const r = readClaudeCliUsage({ accountId, now: NOW, env: env(), home });
    expect(r.reason).toBe('different-account');
    expect(r.usage).toBeNull();
  });

  it('merges two different directories that hold the SAME account', () => {
    const home = makeHome();
    writeFileSync(join(home, '.claude', '.hud_cache'), JSON.stringify(FRESH_CACHE));
    writeIdentity(join(home, '.claude.json'), 'uuid-shared');
    const accountId = makeIsolatedAccount('uuid-shared');

    const r = readClaudeCliUsage({ accountId, now: NOW, env: env(), home });
    expect(r.reason).toBe('same-account');
    expect(r.usage?.sevenDay?.utilizationPercent).toBe(84);
  });

  it('refuses when naby’s side has no readable identity at all', () => {
    // "Could not tell" is a refusal, not a fallback to trusting the file.
    const home = makeHome();
    writeFileSync(join(home, '.claude', '.hud_cache'), JSON.stringify(FRESH_CACHE));
    writeIdentity(join(home, '.claude.json'), 'uuid-claude-code');
    const accountId = 'acct-ffffffffffff';
    mkdirSync(nabyClaudeConfigDir(accountId, env(), HOME) as string, { recursive: true });
    // No `.claude.json` written for it — a login that has not landed yet.
    const r = readClaudeCliUsage({ accountId, now: NOW, env: env(), home });
    expect(r.reason).toBe('different-account');
    expect(r.usage).toBeNull();
  });
});
