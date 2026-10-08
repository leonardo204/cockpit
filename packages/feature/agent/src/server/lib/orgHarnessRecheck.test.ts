import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE SIX-HOUR RE-CHECK, WIRED (specs/org-harness-sync.md §3.1, M4).
 *
 * The clock's own rules (jitter band, no overlap, skip, failure) are proven in
 * `npm run spike:org-harness-recheck` with injected timers. What is tested HERE
 * is the shell's wiring of it: `ensureOrgHarnessSyncStarted` starts the boot
 * pass AND the clock, each tick is the same single-flight pass, and a tick is
 * skipped — with no request at all — while the org harness is switched off or
 * background passes are disabled.
 *
 * NO NETWORK. A fake Skill Hub (`setOrgHarnessFetch`); vitest's fake timers move
 * six hours in a millisecond. `NABY_ORG_HARNESS_SYNC=0` (vitest.setup.ts) is
 * lifted only inside this file, and put back after every case.
 */

import { runNabyAction } from '../api/naby';
import { getStore } from '../engines/naby';
import {
  buildZip,
  nabyHomeDir,
  ORG_HARNESS_RECHECK_JITTER_MS,
  ORG_HARNESS_RECHECK_MS,
  ORG_HARNESS_SETTING,
} from '../../../../../../../dist/naby-runtime.mjs';
import {
  ensureOrgHarnessSyncStarted,
  orgHarnessRecheckClock,
  orgHarnessRecheckDue,
  ORG_HARNESS_SYNC_ENV,
  resetOrgHarnessBootForTests,
  setOrgHarnessFetch,
} from './orgHarness';
import { SKILL_HUB_SERVER_NAME } from './systemMcp';

const HUB_KEY = 'shub_recheckTestKeyDoNotLeak';
const MAX_WAIT = ORG_HARNESS_RECHECK_MS + ORG_HARNESS_RECHECK_JITTER_MS;

function installHub(): string[] {
  const zip = buildZip([
    { name: '.claude-plugin/plugin.json', data: JSON.stringify({ name: 'altimedia-harness', version: '0.8.1' }) },
    { name: 'hooks/hooks.json', data: '{"hooks":{}}' },
    { name: 'skills/task/SKILL.md', data: '---\nname: task\ndescription: Open and close a task.\n---\n\n# task\n' },
  ]);
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
            version: '0.8.1',
            source: {
              url: '/api/v1/plugins/altimedia-harness/download',
              sha256: createHash('sha256').update(zip).digest('hex'),
            },
          },
        ],
      });
    }
    if (url.endsWith('/api/v1/plugins/altimedia-harness/download')) return respond(200, null, zip);
    if (url.endsWith('/api/v1/harness/bootstrap')) return respond(200, { env: { HARNESS_METRICS_TOKEN: 'hmt_recheck_test' } });
    return respond(404, null);
  });
  return calls;
}

const marketplaceCalls = (calls: string[]) => calls.filter((u) => u.endsWith('/marketplace.json')).length;
const bootstrapCalls = (calls: string[]) => calls.filter((u) => u.endsWith('/harness/bootstrap')).length;

let savedSyncEnv: string | undefined;
let savedKillSwitch: string | undefined;

beforeEach(async () => {
  // NEVER THE REAL SKILL HUB: a fetch that refuses everything is in place before
  // anything could kick a pass, and the key is saved while background passes
  // are still disabled (saving it kicks one).
  setOrgHarnessFetch(async (url) => {
    throw new Error(`unexpected request before the case installed its hub: ${url}`);
  });
  savedSyncEnv = process.env[ORG_HARNESS_SYNC_ENV];
  savedKillSwitch = process.env.NABY_ORG_HARNESS;
  resetOrgHarnessBootForTests();
  const r = await runNabyAction({ action: 'systemMcp.set', preset: SKILL_HUB_SERVER_NAME, fields: { token: HUB_KEY } });
  expect(r.ok).toBe(true);
  delete process.env[ORG_HARNESS_SYNC_ENV];
  delete process.env.NABY_ORG_HARNESS;
  // 10:00 KST.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: Date.UTC(2026, 9, 8, 1, 0, 0) });
});

afterEach(() => {
  vi.useRealTimers();
  resetOrgHarnessBootForTests();
  setOrgHarnessFetch(undefined);
  if (savedSyncEnv === undefined) delete process.env[ORG_HARNESS_SYNC_ENV];
  else process.env[ORG_HARNESS_SYNC_ENV] = savedSyncEnv;
  if (savedKillSwitch === undefined) delete process.env.NABY_ORG_HARNESS;
  else process.env.NABY_ORG_HARNESS = savedKillSwitch;
  const store = getStore();
  store.removeMcpEntry(SKILL_HUB_SERVER_NAME);
  for (const key of Object.keys(store.listSettings())) {
    if (key.startsWith('harness.org.')) store.setSetting(key, '');
  }
  for (const row of store.listHarness('org', 'default', { kind: 'skill' })) store.removeHarness({ id: row.id });
  rmSync(join(nabyHomeDir(), 'org'), { recursive: true, force: true });
});

describe('org harness — the six-hour re-check (§3.1)', () => {
  it('boot pass, then one jittered pass every ~6 h; the daily key check rides it', async () => {
    const calls = installHub();
    const store = getStore();
    ensureOrgHarnessSyncStarted(store);
    const clock = orgHarnessRecheckClock();
    expect(clock).toBeDefined();
    const wait = (clock!.nextAt ?? 0) - Date.now();
    expect(wait).toBeGreaterThanOrEqual(ORG_HARNESS_RECHECK_MS - ORG_HARNESS_RECHECK_JITTER_MS);
    expect(wait).toBeLessThanOrEqual(MAX_WAIT);

    await vi.advanceTimersByTimeAsync(1600); // the boot pass
    expect(marketplaceCalls(calls)).toBe(1);
    expect(bootstrapCalls(calls)).toBe(1);

    await vi.advanceTimersByTimeAsync(MAX_WAIT); // ~16:00 KST
    expect(marketplaceCalls(calls)).toBe(2);
    expect(bootstrapCalls(calls)).toBe(1); // same KST day: the key is not re-asked
    expect(clock!.stats.ran).toBe(1);

    await vi.advanceTimersByTimeAsync(MAX_WAIT); // ~22:00 KST
    await vi.advanceTimersByTimeAsync(MAX_WAIT); // ~04:00 KST next day
    expect(marketplaceCalls(calls)).toBe(4);
    expect(bootstrapCalls(calls)).toBe(2); // once per KST day, app left running
    expect(store.getSetting(ORG_HARNESS_SETTING.lastSync)).toContain('"outcome":"current"');
  });

  it('starts once per process — a second call adds no second clock', async () => {
    installHub();
    const store = getStore();
    ensureOrgHarnessSyncStarted(store);
    const first = orgHarnessRecheckClock();
    ensureOrgHarnessSyncStarted(store);
    expect(orgHarnessRecheckClock()).toBe(first);
  });

  it('a tick is skipped, with no request, while the kill switch or the toggle is off', async () => {
    const calls = installHub();
    const store = getStore();
    ensureOrgHarnessSyncStarted(store);
    const clock = orgHarnessRecheckClock()!;
    await vi.advanceTimersByTimeAsync(1600);
    const afterBoot = calls.length;

    process.env.NABY_ORG_HARNESS = '0';
    expect(orgHarnessRecheckDue(store)).toBe(false);
    await vi.advanceTimersByTimeAsync(MAX_WAIT);
    expect(calls.length).toBe(afterBoot);
    expect(clock.stats.skipped).toBe(1);
    delete process.env.NABY_ORG_HARNESS;

    store.setSetting(ORG_HARNESS_SETTING.enabled, 'false');
    expect(orgHarnessRecheckDue(store)).toBe(false);
    await vi.advanceTimersByTimeAsync(MAX_WAIT);
    expect(calls.length).toBe(afterBoot);
    expect(clock.stats.skipped).toBe(2);
    store.setSetting(ORG_HARNESS_SETTING.enabled, 'true');

    process.env[ORG_HARNESS_SYNC_ENV] = '0';
    expect(orgHarnessRecheckDue(store)).toBe(false);
    await vi.advanceTimersByTimeAsync(MAX_WAIT);
    expect(calls.length).toBe(afterBoot);
    expect(clock.stats.skipped).toBe(3);
    delete process.env[ORG_HARNESS_SYNC_ENV];

    // Back on: the next tick goes out again.
    expect(orgHarnessRecheckDue(store)).toBe(true);
    await vi.advanceTimersByTimeAsync(MAX_WAIT);
    expect(marketplaceCalls(calls)).toBe(2);
  });

  it('a pass that fails keeps the clock going and the installed version in place', async () => {
    const calls = installHub();
    const store = getStore();
    ensureOrgHarnessSyncStarted(store);
    await vi.advanceTimersByTimeAsync(1600);
    expect(store.getSetting(ORG_HARNESS_SETTING.lastSync)).toContain('"version":"0.8.1"');
    setOrgHarnessFetch(async () => {
      calls.push('offline');
      throw new TypeError('fetch failed (offline)');
    });
    await vi.advanceTimersByTimeAsync(MAX_WAIT);
    expect(calls).toContain('offline');
    const last = JSON.parse(store.getSetting(ORG_HARNESS_SETTING.lastSync) ?? '{}') as { outcome?: string; version?: string };
    expect(last.outcome).toBe('unreachable');
    expect(last.version).toBe('0.8.1');
    expect(orgHarnessRecheckClock()?.nextAt).toBeDefined();
  });

  it('no clock at all when background passes are disabled at startup', () => {
    process.env[ORG_HARNESS_SYNC_ENV] = '0';
    ensureOrgHarnessSyncStarted(getStore());
    expect(orgHarnessRecheckClock()).toBeUndefined();
  });
});
