import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readUsageCache, usageCacheState } from './naby';
import { SUBSCRIPTION_USAGE_MAX_STALE_MS, SUBSCRIPTION_USAGE_TTL_MS } from '../../../../../../../dist/naby-runtime.mjs';

/**
 * THE PLAN-USAGE READING IS DISPLAY STATE, AND IT STAYS OUT OF THE TRANSCRIPT.
 *
 * The rule is written at length in src/runtime/session.ts beside the `rate_limit`
 * case: an account's billing state must not be persisted into a transcript,
 * because a transcript has to replay identically on an engine that has no
 * subscription at all — and `RuntimeMessage` has a closed three-variant contract
 * with no system role for it to become anyway. The same rule binds this feature,
 * and the temptation is stronger here: this path carries numbers AND is fetched
 * on a schedule, which makes it look like data to keep.
 *
 * Structurally it cannot leak: `usage.limits` is an HTTP action, not an
 * `EngineEvent`, so it never enters `runTurn`'s stream and never reaches the fold
 * that mints messages. That is an argument, not a guarantee — the guarantee is
 * below, and it is a SOURCE ASSERTION because the thing being asserted is the
 * ABSENCE of a call, which no runtime test can observe.
 */

const NABY_API = readFileSync(join(__dirname, 'naby.ts'), 'utf8');
const RUNTIME_SESSION = readFileSync(
  join(__dirname, '../../../../../../../src/runtime/session.ts'),
  'utf8',
);
const RUNTIME_ENGINE = readFileSync(
  join(__dirname, '../../../../../../../src/runtime/engine.ts'),
  'utf8',
);

/** The `usage.limits` case body, sliced out so the assertions below are about
 *  THIS case and not about the two thousand lines around it. */
function usageCaseBody(): string {
  const start = NABY_API.indexOf("case 'usage.limits': {");
  expect(start).toBeGreaterThan(-1);
  const end = NABY_API.indexOf("case 'bootstrap.get': {", start);
  expect(end).toBeGreaterThan(start);
  return NABY_API.slice(start, end);
}

describe('it never touches the transcript', () => {
  const body = usageCaseBody();

  it('writes no message, no session row, and no activity', () => {
    // The only write it is allowed is its own cache row.
    for (const forbidden of [
      'appendMessage',
      'createSession',
      'setSessionRollingSummary',
      'logActivity',
      'recordCheckin',
      'appendLedger',
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });

  it('writes exactly one thing: its own per-account cache row', () => {
    expect(body).toContain('writeUsageCache(store, cacheKey, fresh)');
    // One write call in the whole case.
    expect(body.match(/writeUsageCache\(/g)).toHaveLength(1);
    // And the key is namespaced per account, so a switch cannot show one
    // subscription's numbers under another's name.
    expect(body).toContain('`usage.limits.cache.${accountId ?? \'default\'}`');
  });

  it('is not an EngineEvent — the runtime has no `subscription_usage` event kind', () => {
    // If this ever became an event it would flow through `runTurn`, and the fold
    // there is one `else if` away from persisting anything it recognises.
    expect(RUNTIME_ENGINE).not.toContain("kind: 'subscription_usage'");
  });

  it('the turn loop knows nothing about it', () => {
    // session.ts must not import, read or branch on any of it. A branch here
    // would make a run's length depend on backend billing state that only one
    // provider reports — the provider-independence this seam exists to protect.
    for (const symbol of [
      'subscription-usage',
      'SubscriptionUsage',
      'probeClaudeUsage',
      'readClaudeCliUsage',
      'utilizationPercent',
    ]) {
      expect(RUNTIME_SESSION).not.toContain(symbol);
    }
  });

  it('leaves the existing rate_limit path intact', () => {
    // The two are complementary and both are kept: the push carries `status`
    // ("you are being throttled"), the poll carries utilization ("you are 39%
    // through"). Neither replaces the other.
    expect(RUNTIME_ENGINE).toContain("kind: 'rate_limit'");
    expect(RUNTIME_SESSION).toContain("`rate_limit` is held to the SAME RULE");
  });
});

describe('it reads no credential', () => {
  const HUD = readFileSync(
    join(__dirname, '../../../../../../../src/engines/claude-hud-usage.ts'),
    'utf8',
  );

  /**
   * Comments out, code only.
   *
   * That module's header EXPLAINS the rejected alternative by name — the
   * credential file, the bearer header, the endpoint — because a reader needs to
   * know which door was considered and why it was left shut. Asserting over the
   * raw text would therefore fail on the very paragraph that documents the
   * decision, and the obvious "fix" would be to delete the explanation. So the
   * assertion is about what the module DOES.
   */
  const code = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('never opens the credential file, the keychain, or the usage endpoint', () => {
    // An exception to the "naby reads no credential" invariant was authorised for
    // this feature and deliberately NOT SPENT: the status-line cache carries the
    // same numbers with no token and no network call. This pins that choice so a
    // later "simplification" back to the endpoint has to argue with a test.
    for (const forbidden of [
      '.credentials.json',
      'accessToken',
      'Authorization',
      'oauth/usage',
      'api.anthropic.com',
      'security find-generic-password',
    ]) {
      expect(code(HUD)).not.toContain(forbidden);
    }
    // And it makes no request at all.
    expect(code(HUD)).not.toContain('fetch(');
    // What it DOES read, stated positively so the test says what the module is
    // for rather than only what it is not.
    expect(HUD).toContain('HUD_CACHE_FILE');
    expect(HUD).toContain('CLAUDE_IDENTITY_FILE');
  });

  it('records the exception where the invariant is stated', () => {
    // Otherwise the next reader finds code that reads `~/.claude` next to a
    // comment swearing nothing does, and files the code as the bug.
    const ACCOUNTS = readFileSync(
      join(__dirname, '../../../../../../../src/engines/claude-accounts.ts'),
      'utf8',
    );
    expect(ACCOUNTS).toContain('claude-hud-usage.ts');
    expect(ACCOUNTS).toContain('THE EXCEPTION WAS NOT SPENT');
  });
});

describe('the cache row', () => {
  it('refuses a row it cannot age', () => {
    // Every caller decides freshness by subtracting `fetchedAt`. A row without
    // one would read as a successful lookup and suppress a real probe.
    expect(readUsageCache(undefined)).toBeNull();
    expect(readUsageCache('not json')).toBeNull();
    expect(readUsageCache(JSON.stringify({ limits: null }))).toBeNull();
    expect(readUsageCache(JSON.stringify({ fetchedAt: 0, limits: null }))).toBeNull();
  });

  it('keeps a stored `limits: null` distinct from a missing key', () => {
    // `null` is a real stored answer — "we asked, and this account has no plan
    // windows". A missing key is a broken row.
    expect(readUsageCache(JSON.stringify({ fetchedAt: 1, limits: null }))).toMatchObject({
      limits: null,
      fetchedAt: 1,
    });
    expect(readUsageCache(JSON.stringify({ fetchedAt: 1 }))).toBeNull();
  });

  it('drops junk out of `sources` and unknown reasons', () => {
    const row = readUsageCache(
      JSON.stringify({ fetchedAt: 1, limits: null, sources: ['sdk', 'evil', 7], cliReason: 'made-up' }),
    );
    expect(row?.sources).toEqual(['sdk']);
    expect(row?.cliReason).toBe('no-cache');
  });
});

describe('usageCacheState — the poll floor and the staleness ceiling', () => {
  const NOW = 1_787_531_824_602;
  const at = (ageMs: number, refresh = false) =>
    usageCacheState({ fetchedAt: NOW - ageMs }, NOW, refresh);

  it('serves from cache inside the 15-minute TTL, touching no source', () => {
    // This is what makes the client's "ask whenever a turn ends" free, and it is
    // the floor that keeps naby off accounting that is rate-limited in practice.
    expect(at(0)).toBe('fresh');
    expect(at(SUBSCRIPTION_USAGE_TTL_MS - 1)).toBe('fresh');
  });

  it('looks again past the TTL, but keeps the old row as a fallback', () => {
    expect(at(SUBSCRIPTION_USAGE_TTL_MS)).toBe('stale-usable');
    expect(at(SUBSCRIPTION_USAGE_MAX_STALE_MS - 1)).toBe('stale-usable');
  });

  it('STOPS SERVING past the ceiling — no frozen percentage, ever', () => {
    // Serving a stale number forever is the exact defect that disqualified
    // another program's cache as a lone source; it is no less a defect for being
    // our own cache. Past here, a failed look answers with nothing.
    expect(at(SUBSCRIPTION_USAGE_MAX_STALE_MS)).toBe('expired');
    expect(at(SUBSCRIPTION_USAGE_MAX_STALE_MS * 10)).toBe('expired');
  });

  it('an explicit refresh skips the TTL but can still fall back', () => {
    expect(at(0, true)).toBe('stale-usable');
    expect(at(SUBSCRIPTION_USAGE_MAX_STALE_MS, true)).toBe('expired');
  });

  it('reports nothing cached as `none`', () => {
    expect(usageCacheState(null, NOW, false)).toBe('none');
  });
});
