import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SILENT UPDATE, ONE POPUP PER VERSION, AND THE STATUS BAR'S READ
 * (specs/org-harness-sync.md §3.1, §3.5, §3.9).
 *
 * The runtime's rules (first install quiet, carry-over of an unseen notice, the
 * log cap, readers filtering against the allowlist) are proven in
 * `npm run spike:org-harness-recheck`. What is tested HERE is the shell side:
 * the manual "check now" pass records the notice, `status.connections` and the
 * global-state push carry it, `orgHarness.ackUpdate` retires it for every
 * reader, and nothing secret rides along.
 *
 * NO NETWORK. A fake Skill Hub (`setOrgHarnessFetch`) that refuses everything
 * until a case installs it; background passes stay off (vitest.setup.ts).
 */

import { runNabyAction } from '../api/naby';
import { getStore } from '../engines/naby';
import { getPendingOrgUpdateSnapshot } from '../state/globalState';
import { buildZip, nabyHomeDir } from '../../../../../../../dist/naby-runtime.mjs';
import {
  readConnectionsStatus,
  resetOrgHarnessBootForTests,
  setAtlassianOAuthFetch,
  setAtlassianOAuthServerUrl,
  setOrgHarnessFetch,
  syncOrgHarnessNow,
} from './orgHarness';
import { SKILL_HUB_SERVER_NAME } from './systemMcp';

const HUB_KEY = 'shub_updateNoticeKeyDoNotLeak';
const METRICS_TOKEN = 'hmt_update_notice_secret';

type HookSpec = { event: string; script: string };

/** A minimal package: one skill, and a hooks.json naming `hooks`. */
function packageZip(version: string, hooks: HookSpec[]): Buffer {
  const byEvent: Record<string, unknown[]> = {};
  for (const h of hooks) {
    (byEvent[h.event] ??= []).push({
      hooks: [{ type: 'command', command: 'node', args: [`\${CLAUDE_PLUGIN_ROOT}/scripts/${h.script}`] }],
    });
  }
  return buildZip([
    { name: '.claude-plugin/plugin.json', data: JSON.stringify({ name: 'altimedia-harness', version }) },
    { name: 'hooks/hooks.json', data: JSON.stringify({ hooks: byEvent }) },
    { name: 'scripts/metrics-emit.js', data: '// stub\n' },
    { name: 'skills/task/SKILL.md', data: '---\nname: task\ndescription: Open and close a task.\n---\n\n# task\n' },
  ]);
}

const BASE_HOOKS: HookSpec[] = [
  { event: 'Stop', script: 'metrics-emit.js' },
  { event: 'SessionStart', script: 'activate.js' },
];

function installHub(): { publish: (version: string, hooks: HookSpec[]) => void; calls: string[] } {
  let offered: { version: string; zip: Buffer } | undefined;
  const calls: string[] = [];
  setOrgHarnessFetch(async (url) => {
    calls.push(url);
    const respond = (status: number, body: unknown, bytes?: Buffer) => ({
      status,
      json: async () => body,
      arrayBuffer: async () => {
        const b = bytes ?? Buffer.alloc(0);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      },
    });
    if (url.endsWith('/api/v1/marketplace.json')) {
      return respond(200, {
        plugins: offered
          ? [
              {
                name: 'altimedia-harness',
                version: offered.version,
                source: {
                  url: '/api/v1/plugins/altimedia-harness/download',
                  sha256: createHash('sha256').update(offered.zip).digest('hex'),
                },
              },
            ]
          : [],
      });
    }
    if (url.endsWith('/api/v1/plugins/altimedia-harness/download')) {
      return offered ? respond(200, null, offered.zip) : respond(404, null);
    }
    if (url.endsWith('/api/v1/harness/bootstrap')) return respond(200, { env: { HARNESS_METRICS_TOKEN: METRICS_TOKEN } });
    return respond(404, null);
  });
  return {
    calls,
    publish(version, hooks) {
      offered = { version, zip: packageZip(version, hooks) };
    },
  };
}

beforeEach(async () => {
  setOrgHarnessFetch(async (url) => {
    throw new Error(`unexpected request before the case installed its hub: ${url}`);
  });
  resetOrgHarnessBootForTests();
  const r = await runNabyAction({ action: 'systemMcp.set', preset: SKILL_HUB_SERVER_NAME, fields: { token: HUB_KEY } });
  expect(r.ok).toBe(true);
});

afterEach(() => {
  resetOrgHarnessBootForTests();
  setOrgHarnessFetch(undefined);
  const store = getStore();
  store.removeMcpEntry(SKILL_HUB_SERVER_NAME);
  for (const key of Object.keys(store.listSettings())) {
    if (key.startsWith('harness.org.')) store.setSetting(key, '');
  }
  for (const row of store.listHarness('org', 'default', { kind: 'skill' })) store.removeHarness({ id: row.id });
  rmSync(join(nabyHomeDir(), 'org'), { recursive: true, force: true });
});

async function sync() {
  const r = await runNabyAction({ action: 'orgHarness.sync' });
  expect(r.ok).toBe(true);
  return r;
}

async function connections() {
  const r = await runNabyAction({ action: 'status.connections' });
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error('status.connections failed');
  return r.connections!;
}

describe('org harness update notice — once per version (§3.1, §3.5)', () => {
  it('a first install is quiet; an update raises one notice with the new hooks; the ack retires it everywhere', async () => {
    const hub = installHub();
    hub.publish('0.8.1', BASE_HOOKS);
    await sync();
    const c = await connections();
    expect(c.skillHub.version).toBe('0.8.1');
    expect(getPendingOrgUpdateSnapshot()).toBeNull();

    // 0.8.2 adds two scripts naby does not run, plus a native one on another event.
    hub.publish('0.8.2', [
      ...BASE_HOOKS,
      { event: 'SessionStart', script: 'remind.js' },
      { event: 'PostToolUse', script: 'audit.js' },
      { event: 'Stop', script: 'gate.js' },
    ]);
    await sync();
    // The popup's data rides the global-state push, not the status bar's read.
    const pending = getPendingOrgUpdateSnapshot();
    expect(pending).toMatchObject({ version: '0.8.2', previous: '0.8.1' });
    expect(pending!.newHooks.map((h) => h.script)).toEqual(['remind.js', 'audit.js']);
    expect('orgUpdate' in (await connections())).toBe(false);

    // The Settings card sees it too, with the per-version list.
    const state = await runNabyAction({ action: 'orgHarness.get' });
    expect(state.ok && state.orgHarness?.updateLog.map((e) => e.version)).toEqual(['0.8.2']);
    expect(state.ok && state.orgHarness?.updateLog[0]!.newHooks.map((h) => h.script)).toEqual(['remind.js', 'audit.js']);

    // An ack for another version changes nothing; the right one retires it.
    const wrong = await runNabyAction({ action: 'orgHarness.ackUpdate', version: '0.8.1' });
    expect(wrong.ok && wrong.acked).toBe(false);
    expect(getPendingOrgUpdateSnapshot()?.version).toBe('0.8.2');
    const acked = await runNabyAction({ action: 'orgHarness.ackUpdate', version: '0.8.2' });
    expect(acked.ok && acked.acked).toBe(true);
    expect(getPendingOrgUpdateSnapshot()).toBeNull();
    const again = await runNabyAction({ action: 'orgHarness.ackUpdate', version: '0.8.2' });
    expect(again.ok && again.acked).toBe(false);

    // "Check now" again on the same version: nothing comes back.
    await sync();
    expect(getPendingOrgUpdateSnapshot()).toBeNull();

    // The next version without new hooks: a notice, and no hook line.
    hub.publish('0.8.3', [
      ...BASE_HOOKS,
      { event: 'SessionStart', script: 'remind.js' },
      { event: 'PostToolUse', script: 'audit.js' },
    ]);
    await sync();
    expect(getPendingOrgUpdateSnapshot()).toMatchObject({ version: '0.8.3', previous: '0.8.2', newHooks: [] });
  });

  it('the ack needs a version', async () => {
    const r = await runNabyAction({ action: 'orgHarness.ackUpdate', version: '' });
    expect(r.ok).toBe(false);
  });
});

describe('status.connections — what the chat status bar reads (§3.9)', () => {
  it('carries status words and versions, never the key or the metrics token', async () => {
    const hub = installHub();
    hub.publish('0.8.1', BASE_HOOKS);
    await sync();
    const c = await connections();
    expect(c.skillHub).toMatchObject({ configured: true, on: true, auth: 'ok', version: '0.8.1', syncing: false });
    expect(c.skillHub.lastSync?.outcome).toBe('updated');
    // On, a package installed, HARNESS_GATE unset: the Atlassian gate applies.
    expect(c.atlassian).toMatchObject({ status: 'none', row: 'none', loginPending: false, required: true });
    const raw = JSON.stringify(c);
    expect(raw).not.toContain(HUB_KEY);
    expect(raw).not.toContain(METRICS_TOKEN);
    expect(raw).not.toContain('skills.altimedia.com');
  });

  it('switched off: Skill Hub reads off and Atlassian is no longer required', async () => {
    const hub = installHub();
    hub.publish('0.8.1', BASE_HOOKS);
    await sync();
    const off = await runNabyAction({ action: 'orgHarness.set', enabled: false });
    expect(off.ok).toBe(true);
    const c = readConnectionsStatus(getStore());
    expect(c.skillHub).toMatchObject({ on: false, offReason: 'user-off' });
    expect(c.atlassian.required).toBe(false);
    expect(c.atlassian.blocking).toBe(false);
  });

  it('reports a running pass as syncing, and not once it settles', async () => {
    const hub = installHub();
    hub.publish('0.8.1', BASE_HOOKS);
    const running = syncOrgHarnessNow(getStore());
    expect(readConnectionsStatus(getStore()).skillHub.syncing).toBe(true);
    await running;
    expect(readConnectionsStatus(getStore()).skillHub).toMatchObject({ syncing: false, version: '0.8.1' });
  });

  it('carries the last sign-in failure for the tooltip and the toast', async () => {
    const seen: string[] = [];
    setAtlassianOAuthServerUrl('https://atlassian.invalid/v1/mcp');
    setAtlassianOAuthFetch((async (url: string) => {
      seen.push(String(url));
      throw new Error('fake atlassian is offline');
    }) as never);
    try {
      const r = await runNabyAction({ action: 'atlassian.login' });
      expect(r.ok).toBe(false);
      const c = await connections();
      expect(c.atlassian.loginPending).toBe(false);
      expect(c.atlassian.lastLoginError).toBeTruthy();
      expect(seen.every((u) => u.startsWith('https://atlassian.invalid'))).toBe(true);
    } finally {
      setAtlassianOAuthFetch(undefined);
      setAtlassianOAuthServerUrl(undefined);
    }
  });

  it('no key: not configured, and no request is made', async () => {
    const hub = installHub();
    getStore().removeMcpEntry(SKILL_HUB_SERVER_NAME);
    const c = await connections();
    expect(c.skillHub.configured).toBe(false);
    expect(c.atlassian.required).toBe(false);
    expect(hub.calls).toEqual([]);
  });
});
