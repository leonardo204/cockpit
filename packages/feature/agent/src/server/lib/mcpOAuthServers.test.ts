import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * BROWSER SIGN-IN FOR ANY REMOTE MCP — the `mcpOAuth.*` actions
 * (specs/mcp-oauth-catalog.md §3, §4.1, §5).
 *
 * Everything runs against LOCAL fakes (src/spikes/fixtures/fake-oauth-mcp.ts,
 * bound to 127.0.0.1): the quick-connect entries are pointed at them with
 * `setMcpOAuthCatalogUrl`, so no test can reach Notion, Linear, Asana, Sentry or
 * Atlassian. The store is the throwaway one vitest.setup.ts points NABY_DB_PATH at.
 *
 * No test here reaches an engine; the orchestrator is mocked for the same reason
 * as in api/naby.test.ts.
 */
vi.mock('../engines/orchestrator', () => ({
  dispatchChat: async () => ({ ok: false as const, status: 503, error: 'no engine in tests' }),
}));

import { readNabyState, runNabyAction } from '../api/naby';
import { getStore } from '../engines/naby';
import { mcpOAuthSettingKey, mcpOAuthStatus, type McpEntry } from '../../../../../../../dist/naby-runtime.mjs';
import { startFakeOAuthMcp, type FakeOAuthMcp } from '../../../../../../../src/spikes/fixtures/fake-oauth-mcp';
import { MCP_OAUTH_CATALOG_NAMES, setMcpOAuthCatalogUrl } from './mcpOAuthCatalog';
import { resetServerOAuthLoginsForTests } from './mcpOAuthLogin';
import { resetOrgHarnessBootForTests, setAtlassianOAuthServerUrl } from './orgHarness';
import { SYSTEM_MCP_PRESET_NAMES } from './systemMcp';

const fakes: FakeOAuthMcp[] = [];
async function fake(opts: Parameters<typeof startFakeOAuthMcp>[0] = {}): Promise<FakeOAuthMcp> {
  const f = await startFakeOAuthMcp(opts);
  fakes.push(f);
  return f;
}

const row = (name: string): McpEntry | undefined =>
  getStore()
    .listMcpEntries()
    .find((e) => e.name === name);

async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function untilAsync<T>(read: () => Promise<T>, pred: (v: T) => boolean, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (pred(v)) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const leaks = (value: unknown, secret: string | undefined) =>
  secret !== undefined && JSON.stringify(value ?? null).includes(secret);

/** The browser coming back with an error instead of a code. */
async function denyInBrowser(authorizationUrl: string): Promise<void> {
  const redirect = new URL(authorizationUrl).searchParams.get('redirect_uri')!;
  const back = new URL(redirect);
  back.searchParams.set('error', 'access_denied');
  await fetch(back);
}

const TOUCHED = ['notion', 'linear', 'asana', 'sentry', 'my-sentry', 'prop', 'mine', 'atlassian'];

afterEach(async () => {
  resetServerOAuthLoginsForTests();
  resetOrgHarnessBootForTests();
  setAtlassianOAuthServerUrl(undefined);
  for (const name of MCP_OAUTH_CATALOG_NAMES) setMcpOAuthCatalogUrl(name, undefined);
  const store = getStore();
  for (const name of TOUCHED) {
    store.removeMcpEntry(name);
    store.setSetting(mcpOAuthSettingKey(name), '');
  }
  await Promise.all(fakes.splice(0).map((f) => f.close()));
});

describe('quick connect — the row exists only after the sign-in (§3.1)', () => {
  it('login hands out the URL, writes nothing, and the callback creates the oauth row', async () => {
    const f = await fake({ shape: 'notion' });
    setMcpOAuthCatalogUrl('notion', f.mcpUrl);
    const started = await runNabyAction({ action: 'mcpOAuth.login', server: 'notion' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.authorizationUrl).toMatch(/\/v1\/authorize\?/);
    // Nothing yet: no row, and the quick-connect entry is "signing in".
    expect(row('notion')).toBeUndefined();
    expect(started.mcpOAuth?.catalog.notion).toEqual({ status: 'none', pending: true, conflict: false, present: false });

    await f.consent(started.authorizationUrl!);
    await until(() => row('notion') !== undefined);
    expect(row('notion')).toEqual({
      name: 'notion',
      transport: 'http',
      url: f.mcpUrl,
      auth: 'oauth',
      status: 'enabled',
    });
    const state = await readNabyState(null);
    expect(state.mcpOAuth.catalog.notion).toEqual({ status: 'connected', pending: false, conflict: false, present: true });
    expect(state.mcpOAuth.servers.notion).toEqual({ status: 'connected', pending: false });
    // No token in any reply.
    const { access, refresh } = f.current();
    expect(leaks(state, access) || leaks(state, refresh) || leaks(started, access)).toBe(false);
  });

  it('a cancelled sign-in leaves no row, and is not reported as a failure', async () => {
    const f = await fake({ shape: 'notion' });
    setMcpOAuthCatalogUrl('notion', f.mcpUrl);
    const started = await runNabyAction({ action: 'mcpOAuth.login', server: 'notion' });
    expect(started.ok).toBe(true);
    const cancelled = await runNabyAction({ action: 'mcpOAuth.cancel', server: 'notion' });
    expect(cancelled.ok && cancelled.mcpOAuth?.catalog.notion).toEqual({
      status: 'none',
      pending: false,
      conflict: false,
      present: false,
    });
    expect(row('notion')).toBeUndefined();
    expect(mcpOAuthStatus(getStore(), 'notion')).toBe('none');
  });

  it('a failed sign-in leaves no row and reports the error', async () => {
    const f = await fake({ shape: 'notion' });
    setMcpOAuthCatalogUrl('notion', f.mcpUrl);
    const started = await runNabyAction({ action: 'mcpOAuth.login', server: 'notion' });
    if (!started.ok) throw new Error(started.error);
    await denyInBrowser(started.authorizationUrl!);
    const view = await untilAsync(
      () => runNabyAction({ action: 'mcpOAuth.status' }),
      (r) => r.ok && r.mcpOAuth?.catalog.notion?.pending === false && !!r.mcpOAuth.catalog.notion.lastError,
    );
    expect(view.ok && view.mcpOAuth?.catalog.notion?.lastError).toContain('access_denied');
    expect(row('notion')).toBeUndefined();
  });

  it('re-login on a connected row keeps the row and signs in again', async () => {
    const f = await fake({ shape: 'sentry' });
    setMcpOAuthCatalogUrl('sentry', f.mcpUrl);
    const first = await runNabyAction({ action: 'mcpOAuth.login', server: 'sentry' });
    if (!first.ok) throw new Error(first.error);
    await f.consent(first.authorizationUrl!);
    await until(() => row('sentry') !== undefined);
    const regs = f.stats.registrations;
    const again = await runNabyAction({ action: 'mcpOAuth.login', server: 'sentry' });
    if (!again.ok) throw new Error(again.error);
    await f.consent(again.authorizationUrl!);
    await until(() => f.stats.codeExchanges === 2);
    await until(() => mcpOAuthStatus(getStore(), 'sentry') === 'connected');
    expect(row('sentry')?.status).toBe('enabled');
    // The stored registration is reused (same loopback port when free).
    expect(f.stats.registrations).toBeLessThanOrEqual(regs + 1);
  });
});

describe('quick connect — a name that is already taken (§3.1)', () => {
  it('shows the clash, refuses to sign in, and leaves the user row alone', async () => {
    const mine: McpEntry = { name: 'linear', transport: 'stdio', command: '/usr/bin/true', status: 'enabled' };
    getStore().upsertMcpEntry(mine);
    const state = await readNabyState(null);
    expect(state.mcpOAuth.catalog.linear).toMatchObject({ conflict: true, present: false, status: 'none' });
    const refused = await runNabyAction({ action: 'mcpOAuth.login', server: 'linear' });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.errorKey).toBe('mcpOAuth.nameTaken');
    expect(row('linear')).toEqual(mine);
  });

  it('a header-token row with the name and another URL is the user\'s too', async () => {
    const f = await fake({ shape: 'sentry' });
    setMcpOAuthCatalogUrl('sentry', f.mcpUrl);
    const mine: McpEntry = {
      name: 'sentry',
      transport: 'http',
      url: 'http://127.0.0.1:9/self-hosted',
      headers: { Authorization: 'Bearer x' },
      status: 'enabled',
    };
    getStore().upsertMcpEntry(mine);
    const state = await readNabyState(null);
    expect(state.mcpOAuth.catalog.sentry?.conflict).toBe(true);
    const refused = await runNabyAction({ action: 'mcpOAuth.login', server: 'sentry' });
    expect(refused.ok).toBe(false);
    expect(row('sentry')).toEqual(mine);
  });
});

describe('one pending sign-in per server, many servers at once (§4.1)', () => {
  it('two servers sign in side by side; cancelling one leaves the other', async () => {
    const n = await fake({ shape: 'notion' });
    const s = await fake({ shape: 'sentry' });
    setMcpOAuthCatalogUrl('notion', n.mcpUrl);
    setMcpOAuthCatalogUrl('sentry', s.mcpUrl);
    const a = await runNabyAction({ action: 'mcpOAuth.login', server: 'notion' });
    const b = await runNabyAction({ action: 'mcpOAuth.login', server: 'sentry' });
    if (!a.ok || !b.ok) throw new Error('start failed');
    // Different loopback listeners.
    const portOf = (u: string) => new URL(new URL(u).searchParams.get('redirect_uri')!).port;
    expect(portOf(a.authorizationUrl!)).not.toBe(portOf(b.authorizationUrl!));
    let st = await runNabyAction({ action: 'mcpOAuth.status' });
    expect(st.ok && st.mcpOAuth?.catalog.notion?.pending).toBe(true);
    expect(st.ok && st.mcpOAuth?.catalog.sentry?.pending).toBe(true);

    await runNabyAction({ action: 'mcpOAuth.cancel', server: 'notion' });
    st = await runNabyAction({ action: 'mcpOAuth.status' });
    expect(st.ok && st.mcpOAuth?.catalog.notion?.pending).toBe(false);
    expect(st.ok && st.mcpOAuth?.catalog.sentry?.pending).toBe(true);

    await s.consent(b.authorizationUrl!);
    await until(() => row('sentry') !== undefined);
    expect(row('notion')).toBeUndefined();
    expect(mcpOAuthStatus(getStore(), 'sentry')).toBe('connected');
  });

  it('a second start for the SAME server replaces the first', async () => {
    const n = await fake({ shape: 'notion' });
    setMcpOAuthCatalogUrl('notion', n.mcpUrl);
    const first = await runNabyAction({ action: 'mcpOAuth.login', server: 'notion' });
    const second = await runNabyAction({ action: 'mcpOAuth.login', server: 'notion' });
    if (!first.ok || !second.ok) throw new Error('start failed');
    const back = await n.consent(second.authorizationUrl!);
    expect(back.status).toBe(200);
    await until(() => row('notion') !== undefined);
    const st = await runNabyAction({ action: 'mcpOAuth.status' });
    expect(st.ok && st.mcpOAuth?.catalog.notion).toMatchObject({ status: 'connected', pending: false });
  });

  it('an Atlassian sign-in and a quick-connect sign-in run at the same time', async () => {
    const atl = await fake({ shape: 'atlassian' });
    const n = await fake({ shape: 'notion' });
    setAtlassianOAuthServerUrl(atl.mcpUrl);
    setMcpOAuthCatalogUrl('notion', n.mcpUrl);
    const a = await runNabyAction({ action: 'atlassian.login' });
    const b = await runNabyAction({ action: 'mcpOAuth.login', server: 'notion' });
    if (!a.ok || !b.ok) throw new Error('start failed');
    expect(a.orgHarness?.atlassian.loginPending).toBe(true);
    const st = await readNabyState(null);
    expect(st.orgHarness.atlassian.loginPending).toBe(true);
    expect(st.mcpOAuth.catalog.notion?.pending).toBe(true);
    // The Atlassian row is not one of these: presets never appear in `servers`.
    expect(Object.keys(st.mcpOAuth.servers)).not.toContain('atlassian');
    await n.consent(b.authorizationUrl!);
    await until(() => row('notion') !== undefined);
    expect((await readNabyState(null)).orgHarness.atlassian.loginPending).toBe(true);
    await atl.consent(a.authorizationUrl!);
    await until(() => mcpOAuthStatus(getStore(), 'atlassian') === 'connected');
    // Atlassian's own after-step (the row swap) ran for Atlassian only.
    await until(() => row('atlassian')?.transport === 'http');
    const notionRow = row('notion');
    expect(notionRow?.transport !== 'stdio' && notionRow?.url).toBe(n.mcpUrl);
  }, 20_000);
});

describe('disconnect and remove take the sign-in with the row (§3.1, §3.3)', () => {
  it('mcpOAuth.disconnect removes the row AND the tokens', async () => {
    const f = await fake({ shape: 'notion' });
    setMcpOAuthCatalogUrl('notion', f.mcpUrl);
    const started = await runNabyAction({ action: 'mcpOAuth.login', server: 'notion' });
    if (!started.ok) throw new Error(started.error);
    await f.consent(started.authorizationUrl!);
    await until(() => row('notion') !== undefined);
    expect(getStore().getSetting(mcpOAuthSettingKey('notion'))).toBeTruthy();
    const r = await runNabyAction({ action: 'mcpOAuth.disconnect', server: 'notion' });
    expect(r.ok && r.mcpOAuth?.catalog.notion).toEqual({ status: 'none', pending: false, conflict: false, present: false });
    expect(row('notion')).toBeUndefined();
    expect(getStore().getSetting(mcpOAuthSettingKey('notion')) ?? '').toBe('');
    expect(mcpOAuthStatus(getStore(), 'notion')).toBe('none');
  });

  it('mcp.remove of an OAuth row from the general list clears its sign-in too', async () => {
    const f = await fake({ shape: 'sentry' });
    const started = await runNabyAction({ action: 'mcpOAuth.login', server: 'mine', url: f.mcpUrl });
    if (!started.ok) throw new Error(started.error);
    await f.consent(started.authorizationUrl!);
    await until(() => row('mine') !== undefined);
    expect(mcpOAuthStatus(getStore(), 'mine')).toBe('connected');
    await runNabyAction({ action: 'mcp.remove', name: 'mine' });
    expect(row('mine')).toBeUndefined();
    expect(mcpOAuthStatus(getStore(), 'mine')).toBe('none');
    expect(getStore().getSetting(mcpOAuthSettingKey('mine')) ?? '').toBe('');
  });
});

describe('System MCP preset names are refused at the entry (§4.1)', () => {
  it('every mcpOAuth action refuses skill-hub, atlassian and cic', async () => {
    for (const preset of SYSTEM_MCP_PRESET_NAMES) {
      for (const action of ['mcpOAuth.login', 'mcpOAuth.cancel', 'mcpOAuth.disconnect'] as const) {
        const r = await runNabyAction({ action, server: preset, url: 'http://127.0.0.1:9/mcp' });
        expect(r.ok, `${action} accepted ${preset}`).toBe(false);
        if (!r.ok) expect(r.errorKey).toBe('mcpOAuth.presetName');
      }
    }
  });

  it('refusing "atlassian" leaves a pending Atlassian sign-in and its row alone', async () => {
    const atl = await fake({ shape: 'atlassian' });
    setAtlassianOAuthServerUrl(atl.mcpUrl);
    const started = await runNabyAction({ action: 'atlassian.login' });
    expect(started.ok).toBe(true);
    await runNabyAction({ action: 'mcpOAuth.cancel', server: 'atlassian' });
    await runNabyAction({ action: 'mcpOAuth.disconnect', server: 'atlassian' });
    expect((await readNabyState(null)).orgHarness.atlassian.loginPending).toBe(true);
  });
});

describe('mcpOAuth.probe — the add form\'s URL check (§3.2)', () => {
  it('reads oauth / no-registration / open / unreachable and stores nothing', async () => {
    const notion = await fake({ shape: 'notion' });
    const sentry = await fake({ shape: 'sentry' });
    const noReg = await fake({ shape: 'notion', registration: false });
    const open = await fake({ shape: 'notion', open: true });
    const closed = await startFakeOAuthMcp({ shape: 'notion' });
    const closedUrl = closed.mcpUrl;
    await closed.close();
    const before = getStore().listMcpEntries().length;

    const probe = async (url: string, transport: 'http' | 'sse' = 'http') => {
      const r = await runNabyAction({ action: 'mcpOAuth.probe', url, transport });
      if (!r.ok) throw new Error(r.error);
      return r.probe!;
    };
    expect((await probe(notion.mcpUrl)).verdict).toBe('oauth');
    const s = await probe(sentry.mcpUrl, 'sse');
    expect(s.verdict).toBe('oauth');
    expect(s.resourceMetadataUrl).toBe(`${sentry.origin}/.well-known/oauth-protected-resource/mcp`);
    expect((await probe(noReg.mcpUrl)).verdict).toBe('no-registration');
    expect((await probe(open.mcpUrl)).verdict).toBe('open');
    const u = await probe(closedUrl);
    expect(u.verdict).toBe('unreachable');
    expect(u.error).toBeTruthy();

    expect(getStore().listMcpEntries().length).toBe(before);
    expect(notion.stats.registrations + sentry.stats.registrations).toBe(0);
    const bad = await runNabyAction({ action: 'mcpOAuth.probe', url: notion.mcpUrl, transport: 'stdio' as never });
    expect(bad.ok).toBe(false);
  });

  it('a URL-form sign-in (custom name, sse, the probe\'s resource metadata) writes its own row', async () => {
    const f = await fake({ shape: 'sentry' });
    setMcpOAuthCatalogUrl('sentry', 'http://127.0.0.1:9/never');
    const p = await runNabyAction({ action: 'mcpOAuth.probe', url: f.mcpUrl, transport: 'sse' });
    if (!p.ok) throw new Error(p.error);
    const started = await runNabyAction({
      action: 'mcpOAuth.login',
      server: 'my-sentry',
      url: f.mcpUrl,
      transport: 'sse',
      resourceMetadataUrl: p.probe!.resourceMetadataUrl!,
    });
    if (!started.ok) throw new Error(started.error);
    await f.consent(started.authorizationUrl!);
    await until(() => row('my-sentry') !== undefined);
    expect(row('my-sentry')).toEqual({ name: 'my-sentry', transport: 'sse', url: f.mcpUrl, auth: 'oauth', status: 'enabled' });
    const state = await readNabyState(null);
    expect(state.mcpOAuth.servers['my-sentry']).toEqual({ status: 'connected', pending: false });
    // Not the quick-connect row: that one is a different name.
    expect(state.mcpOAuth.catalog.sentry?.present).toBe(false);
  });

  it('an agent-proposed remote row is approved by signing in', async () => {
    const f = await fake({ shape: 'notion' });
    getStore().upsertMcpEntry({ name: 'prop', transport: 'http', url: f.mcpUrl, status: 'proposed', timeoutMs: 45_000 });
    const p = await runNabyAction({ action: 'mcpOAuth.probe', url: f.mcpUrl, transport: 'http' });
    expect(p.ok && p.probe?.verdict).toBe('oauth');
    const started = await runNabyAction({ action: 'mcpOAuth.login', server: 'prop', url: f.mcpUrl });
    if (!started.ok) throw new Error(started.error);
    // Still proposed until the sign-in lands.
    expect(row('prop')?.status).toBe('proposed');
    await f.consent(started.authorizationUrl!);
    await until(() => row('prop')?.status === 'enabled');
    expect(row('prop')).toEqual({
      name: 'prop',
      transport: 'http',
      url: f.mcpUrl,
      auth: 'oauth',
      status: 'enabled',
      timeoutMs: 45_000,
    });
  });
});

describe('mcp.upsert does not write browser-OAuth rows (§3.1, §3.3)', () => {
  it('refuses a new oauth row and an edit of an existing one', async () => {
    const created = await runNabyAction({
      action: 'mcp.upsert',
      entry: { name: 'mine', transport: 'http', url: 'http://127.0.0.1:9/mcp', auth: 'oauth' },
    });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.errorKey).toBe('mcpOAuth.oauthRowLocked');
    expect(row('mine')).toBeUndefined();

    const existing: McpEntry = { name: 'mine', transport: 'http', url: 'http://127.0.0.1:9/mcp', auth: 'oauth', status: 'enabled' };
    getStore().upsertMcpEntry(existing);
    const edited = await runNabyAction({
      action: 'mcp.upsert',
      entry: { name: 'mine', transport: 'http', url: 'http://127.0.0.1:9/elsewhere' },
    });
    expect(edited.ok).toBe(false);
    expect(row('mine')).toEqual(existing);
  });
});
