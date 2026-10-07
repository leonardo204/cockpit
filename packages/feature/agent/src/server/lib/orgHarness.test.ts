import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE ORG HARNESS, THROUGH THE SHELL (specs/org-harness-sync.md, M1).
 *
 * The rules are proven in the runtime spike (`npm run spike:org-harness-migrate`).
 * What is tested HERE is the wiring the spike cannot see:
 *
 *   * the Skill Hub key comes from the preset that declares `ownsOrgHarnessKey`,
 *     and an agent-PROPOSED entry does not count;
 *   * the HTTP actions (`orgHarness.get/set/sync/useOrgVersion/keepUserCopy`)
 *     reach the same store the engine reads, and answer with state;
 *   * the turn-boundary apply the engine calls turns a downloaded package into
 *     rows;
 *   * no response — action or GET — carries the key or the metrics token.
 *
 * NO NETWORK. vitest.setup.ts sets NABY_ORG_HARNESS_SYNC=0, so no background
 * pass starts; `orgHarness.sync` runs against a fake Skill Hub installed with
 * `setOrgHarnessFetch`. The package lands under the throwaway NABY_HOME.
 */

import { readNabyState, runNabyAction } from '../api/naby';
import { getStore } from '../engines/naby';
import {
  buildZip,
  DEFAULT_USER_ID,
  nabyHomeDir,
  ORG_HARNESS_SCOPE_KEY,
  ORG_HARNESS_SETTING,
  ORG_SUPERSEDED_BY,
  type HarnessItem,
} from '../../../../../../../dist/naby-runtime.mjs';
import {
  applyOrgHarnessAtTurnBoundary,
  kickOrgHarnessSync,
  readOrgHarnessKey,
  resetOrgHarnessBootForTests,
  setOrgHarnessFetch,
} from './orgHarness';
import {
  orgHarnessKeyPreset,
  SKILL_HUB_SERVER_NAME,
  SYSTEM_MCP_PRESETS,
} from './systemMcp';

const HUB_KEY = 'shub_orgHarnessTestKeyDoNotLeak';
const METRICS_TOKEN = 'hmt_org_harness_test_do_not_leak';
const leaks = (value: unknown) => {
  const s = JSON.stringify(value ?? null);
  return s.includes(HUB_KEY) || s.includes(METRICS_TOKEN);
};

const TASK_BODY = '# task\n\nOpen and close one unit of work.';
const skill = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

function packageZip(version: string): Buffer {
  return buildZip([
    {
      name: '.claude-plugin/plugin.json',
      data: JSON.stringify({ name: 'altimedia-harness', version }),
    },
    { name: 'hooks/hooks.json', data: '{"hooks":{}}' },
    { name: 'skills/task/SKILL.md', data: skill('task', 'Open and close a task.', TASK_BODY) },
    { name: 'skills/pdoc/SKILL.md', data: skill('pdoc', 'Project documents.', '# pdoc\n\nDocs.') },
    { name: 'skills/ctx/SKILL.md', data: skill('ctx', "'Context file lifecycle.'", '# ctx\n\nContext.') },
    { name: 'skills/task/scripts/task.py', data: 'print("task")\n' },
  ]);
}

/** A fake Skill Hub serving one package version. */
function installHub(version: string, opts: { bootstrap?: number } = {}) {
  const zip = packageZip(version);
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
        plugins: [
          {
            name: 'altimedia-harness',
            version,
            source: {
              url: '/api/v1/plugins/altimedia-harness/download',
              sha256: createHash('sha256').update(zip).digest('hex'),
            },
          },
        ],
      });
    }
    if (url.endsWith('/api/v1/plugins/altimedia-harness/download')) return respond(200, null, zip);
    if (url.endsWith('/api/v1/harness/bootstrap')) {
      const status = opts.bootstrap ?? 200;
      return respond(status, status === 200 ? { env: { HARNESS_METRICS_TOKEN: METRICS_TOKEN } } : {});
    }
    return respond(404, null);
  });
  return calls;
}

const orgRows = (): HarnessItem[] =>
  getStore().listHarness('org', ORG_HARNESS_SCOPE_KEY, { kind: 'skill' });

/** Put the store back: no preset, no org rows, no org settings, no copies. */
function clear(): void {
  const store = getStore();
  store.removeMcpEntry(SKILL_HUB_SERVER_NAME);
  for (const row of orgRows()) store.removeHarness({ id: row.id });
  for (const row of store.listHarness('user', DEFAULT_USER_ID, { kind: 'skill' })) {
    if (['task', 'pdoc', 'ctx'].includes(row.name)) store.removeHarness({ id: row.id });
  }
  for (const key of Object.keys(store.listSettings())) {
    if (key.startsWith('harness.org.')) store.setSetting(key, '');
  }
  // The package lives on disk under the throwaway home; a case that re-publishes
  // the same bytes must see a fresh install, not "already current".
  rmSync(join(nabyHomeDir(), 'org'), { recursive: true, force: true });
  setOrgHarnessFetch(undefined);
  resetOrgHarnessBootForTests();
}

async function saveHubKey(): Promise<void> {
  const r = await runNabyAction({ action: 'systemMcp.set', preset: SKILL_HUB_SERVER_NAME, fields: { token: HUB_KEY } });
  expect(r.ok).toBe(true);
}

function putTaskCopy(body: string): HarnessItem {
  return getStore().putHarnessItem({
    item: {
      scope: 'user',
      scopeKey: DEFAULT_USER_ID,
      kind: 'skill',
      name: 'task',
      provenance: {
        source: 'external',
        origin: join(nabyHomeDir(), 'skills', 'task', 'SKILL.md'),
        format: 'claude-skill-md',
      },
      skill: { instructions: body },
    },
    requestedStatus: 'enabled',
    autoEnable: true,
  });
}

beforeEach(() => clear());
afterAll(() => clear());

describe('org harness — which key', () => {
  it('exactly one preset owns the org harness key, and it is skill-hub', () => {
    expect(SYSTEM_MCP_PRESETS.filter((p) => p.ownsOrgHarnessKey)).toHaveLength(1);
    expect(orgHarnessKeyPreset()?.name).toBe(SKILL_HUB_SERVER_NAME);
  });

  it('reads the skill-hub token, and nothing when the preset is absent or only proposed', async () => {
    const store = getStore();
    expect(readOrgHarnessKey(store)).toBeUndefined();
    await saveHubKey();
    expect(readOrgHarnessKey(store)).toBe(HUB_KEY);
    const entry = store.listMcpEntries().find((e) => e.name === SKILL_HUB_SERVER_NAME)!;
    store.upsertMcpEntry({ ...entry, status: 'proposed' });
    expect(readOrgHarnessKey(store)).toBeUndefined();
  });
});

describe('org harness — no skill-hub preset (§4.3)', () => {
  it('get/turn-boundary/kick write nothing and report "not configured"', async () => {
    const store = getStore();
    const before = JSON.stringify(store.listSettings());
    const result = await runNabyAction({ action: 'orgHarness.get' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.orgHarness?.configured).toBe(false);
    expect(result.orgHarness?.on).toBe(false);
    expect(result.orgHarness?.offReason).toBe('no-skill-hub');
    expect(applyOrgHarnessAtTurnBoundary(store)?.ran).toBe('skipped');
    kickOrgHarnessSync(store);
    expect(JSON.stringify(store.listSettings())).toBe(before);
    expect(orgRows()).toHaveLength(0);
  });
});

describe('org harness — HTTP actions', () => {
  it('sync installs the package and the rows; GET state carries no secret', async () => {
    await saveHubKey();
    const calls = installHub('0.7.1');
    const result = await runNabyAction({ action: 'orgHarness.sync' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.orgHarnessSync).toMatchObject({ activation: 'ok', package: 'updated', version: '0.7.1' });
    expect(calls.some((u) => u.endsWith('/harness/bootstrap'))).toBe(true);
    expect(existsSync(join(nabyHomeDir(), 'org', 'altimedia-harness', '0.7.1', 'skills', 'task', 'SKILL.md'))).toBe(true);

    const rows = orgRows();
    expect(rows.map((r) => r.name).sort()).toEqual(['ctx', 'pdoc', 'task']);
    expect(rows.every((r) => r.status === 'enabled')).toBe(true);
    expect(rows.find((r) => r.name === 'task')?.skill).toMatchObject({
      instructions: 'Open and close a task.',
      toolRefs: ['naby_skill_load', 'run_command'],
      loadMode: 'on-demand',
      packageRef: 'altimedia-harness',
    });
    // The metrics token is stored server-side…
    expect(getStore().getSetting(ORG_HARNESS_SETTING.metricsToken)).toBe(METRICS_TOKEN);
    // …and never travels outwards.
    expect(leaks(result)).toBe(false);
    const state = await readNabyState(null);
    expect(state.orgHarness.on).toBe(true);
    expect(state.orgHarness.package?.version).toBe('0.7.1');
    expect(leaks(state)).toBe(false);
  });

  it('a downloaded package becomes rows at the turn boundary when sync could not apply', async () => {
    await saveHubKey();
    installHub('0.7.1');
    // Simulate "a turn was running": verify and extract, but leave the rows.
    const { syncOrgHarnessNow } = await import('./orgHarness');
    const report = await syncOrgHarnessNow(getStore(), { applyNow: false });
    expect(report.package?.outcome).toBe('updated');
    expect(report.apply).toBeUndefined();
    expect(orgRows()).toHaveLength(0);
    const applied = applyOrgHarnessAtTurnBoundary(getStore());
    expect(applied?.ran).toBe('full');
    expect(orgRows()).toHaveLength(3);
    // The next boundary has nothing to do.
    expect(applyOrgHarnessAtTurnBoundary(getStore())?.ran).toBe('copies');
  });

  it('useOrgVersion sets a same-name copy aside; the switch gives it back and takes it again', async () => {
    await saveHubKey();
    installHub('0.7.1');
    const copy = putTaskCopy(TASK_BODY);
    await runNabyAction({ action: 'orgHarness.sync' });

    const got = await runNabyAction({ action: 'orgHarness.get' });
    if (!got.ok) throw new Error(got.error);
    expect(got.orgHarness?.copyNotices).toEqual([
      expect.objectContaining({ name: 'task', scope: 'user', itemId: copy.id, copy: 'unmodified' }),
    ]);
    // Never disabled behind the user's back.
    expect(getStore().getHarnessItem(copy.id)?.status).toBe('enabled');

    const used = await runNabyAction({ action: 'orgHarness.useOrgVersion', name: 'task' });
    if (!used.ok) throw new Error(used.error);
    expect(used.changed).toEqual([copy.id]);
    expect(used.orgHarness?.copyNotices).toEqual([]);
    const marked = getStore().getHarnessItem(copy.id)!;
    expect(marked.status).toBe('disabled');
    expect(marked.provenance.supersededBy).toBe(ORG_SUPERSEDED_BY);

    const off = await runNabyAction({ action: 'orgHarness.set', enabled: false });
    if (!off.ok) throw new Error(off.error);
    expect(off.orgHarness?.on).toBe(false);
    expect(off.orgHarness?.offReason).toBe('user-off');
    expect(orgRows().every((r) => r.status === 'disabled')).toBe(true);
    expect(getStore().getHarnessItem(copy.id)?.status).toBe('enabled');

    const on = await runNabyAction({ action: 'orgHarness.set', enabled: true });
    if (!on.ok) throw new Error(on.error);
    expect(on.orgHarness?.on).toBe(true);
    expect(orgRows().every((r) => r.status === 'enabled')).toBe(true);
    expect(getStore().getHarnessItem(copy.id)?.status).toBe('disabled');
    expect(getStore().getHarnessItem(copy.id)?.provenance.supersededBy).toBe(ORG_SUPERSEDED_BY);
  });

  it('keepUserCopy stops the notice and changes nothing', async () => {
    await saveHubKey();
    installHub('0.7.1');
    const copy = putTaskCopy(`${TASK_BODY}\n\nmy edits`);
    await runNabyAction({ action: 'orgHarness.sync' });
    const before = await runNabyAction({ action: 'orgHarness.get' });
    if (!before.ok) throw new Error(before.error);
    expect(before.orgHarness?.copyNotices?.[0]).toMatchObject({ name: 'task', copy: 'edited' });

    const kept = await runNabyAction({ action: 'orgHarness.keepUserCopy', name: 'task' });
    if (!kept.ok) throw new Error(kept.error);
    expect(kept.orgHarness?.copyNotices).toEqual([]);
    expect(kept.orgHarness?.keepUserCopy).toEqual(['task']);
    expect(getStore().getHarnessItem(copy.id)?.status).toBe('enabled');
  });

  it('removing the skill-hub preset switches the org rows off without deleting them', async () => {
    await saveHubKey();
    installHub('0.7.1');
    await runNabyAction({ action: 'orgHarness.sync' });
    expect(orgRows().every((r) => r.status === 'enabled')).toBe(true);
    const removed = await runNabyAction({ action: 'systemMcp.remove', preset: SKILL_HUB_SERVER_NAME });
    expect(removed.ok).toBe(true);
    expect(orgRows()).toHaveLength(3);
    expect(orgRows().every((r) => r.status === 'disabled')).toBe(true);
  });

  it('a rejected key (401) leaves the org harness off with a readable flag', async () => {
    await saveHubKey();
    installHub('0.7.1', { bootstrap: 401 });
    const result = await runNabyAction({ action: 'orgHarness.sync' });
    if (!result.ok) throw new Error(result.error);
    expect(result.orgHarnessSync).toMatchObject({ skipped: 'unauthorized', activation: 'unauthorized' });
    expect(result.orgHarness?.auth).toBe('unauthorized');
    expect(result.orgHarness?.on).toBe(false);
    expect(orgRows()).toHaveLength(0);
  });

  it('refuses malformed requests', async () => {
    const badSet = await runNabyAction({ action: 'orgHarness.set', enabled: 'yes' as unknown as boolean });
    expect(badSet.ok).toBe(false);
    const noName = await runNabyAction({ action: 'orgHarness.useOrgVersion', name: '' });
    expect(noName.ok).toBe(false);
    // The org harness is off (no key): choosing the org version is refused.
    const off = await runNabyAction({ action: 'orgHarness.useOrgVersion', name: 'task' });
    expect(off.ok).toBe(false);
  });
});
