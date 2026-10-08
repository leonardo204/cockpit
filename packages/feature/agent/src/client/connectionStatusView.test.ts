import { describe, expect, it } from 'vitest';
import en from '../../../../shared/i18n/locales/en.json';
import ko from '../../../../shared/i18n/locales/ko.json';
import {
  atlassianClick,
  atlassianLines,
  atlassianTone,
  orgUpdateFromPush,
  orgUpdateLines,
  skillHubClick,
  skillHubLines,
  skillHubSettling,
  skillHubTone,
  visibleOrgUpdate,
  type ConnectionsStatusView,
  type OrgUpdateNoticeView,
} from './connectionStatusView';
import { statusToneClass } from '../../../../shared/ui/src/StatusDot';

/**
 * THE CHAT STATUS BAR'S DECISIONS (org-harness-sync §3.9), as tables.
 *
 * Every color the row can show is a row below, so a change to what "amber"
 * means is a visible diff here rather than a quiet change in a component.
 *
 * THE ORG HARNESS IS MANDATORY (user decision, 2026-10-08): not connected is
 * red, amber is only for states that settle on their own, and gray is never
 * used in the bar.
 */

type A = ConnectionsStatusView['atlassian'];
type S = ConnectionsStatusView['skillHub'];

const A0: A = { status: 'none', row: 'none', loginPending: false, required: false, blocking: false };
const S0: S = { configured: true, on: true, auth: 'ok', version: '0.8.1', lastSync: { at: 1, outcome: 'updated' }, syncing: false };

describe('Atlassian tone', () => {
  const table: [string, Partial<A>, ReturnType<typeof atlassianTone>][] = [
    ['connected', { status: 'connected', row: 'oauth' }, 'success'],
    ['connected, even while the gate is armed', { status: 'connected', row: 'oauth', required: true, blocking: true }, 'success'],
    ['sign-in waiting on the browser', { loginPending: true }, 'warning'],
    ['sign-in waiting beats blocking', { loginPending: true, required: true, blocking: true }, 'warning'],
    ['never signed in', {}, 'danger'],
    ['never signed in, during the 7-day grace (grace is not a color)', { required: true, graceDaysLeft: 3 }, 'danger'],
    ['never signed in, gate not armed yet', { required: true }, 'danger'],
    ['required and blocking now', { required: true, blocking: true }, 'danger'],
    ['expired', { status: 'relogin', row: 'oauth' }, 'danger'],
    ['old API-token row', { row: 'legacy' }, 'danger'],
    ['OAuth row without a sign-in', { row: 'oauth' }, 'danger'],
    ['only a user-defined non-OAuth server', { row: 'other' }, 'danger'],
    ['org harness off, not signed in (still required)', { required: false }, 'danger'],
  ];
  for (const [name, patch, tone] of table) {
    it(`${name} → ${tone}`, () => expect(atlassianTone({ ...A0, ...patch })).toBe(tone));
  }
});

describe('Skill Hub tone', () => {
  const table: [string, Partial<S>, ReturnType<typeof skillHubTone>][] = [
    ['key accepted, on, package installed', {}, 'success'],
    ['no key', { configured: false, on: false, offReason: 'no-skill-hub', auth: 'unknown', version: undefined }, 'danger'],
    ['key rejected', { on: false, offReason: 'unauthorized', auth: 'unauthorized' }, 'danger'],
    ['switched off in Settings', { on: false, offReason: 'user-off' }, 'danger'],
    ['kill switch NABY_ORG_HARNESS=0', { on: false, offReason: 'env-off' }, 'danger'],
    ['switched off with a rejected key', { on: false, offReason: 'user-off', auth: 'unauthorized' }, 'danger'],
    ['key saved, not verified yet', { auth: 'unknown', version: undefined, lastSync: undefined }, 'warning'],
    ['key saved, not verified, a check running', { auth: 'unknown', version: undefined, syncing: true }, 'warning'],
    ['key accepted, first download running', { version: undefined, syncing: true, lastSync: undefined }, 'warning'],
    ['key accepted, first download not attempted yet', { version: undefined, lastSync: undefined }, 'warning'],
    ['key accepted, a check ran but no package (unreachable)', { version: undefined, lastSync: { at: 1, outcome: 'unreachable' } }, 'danger'],
    ['key accepted, download discarded (checksum)', { version: undefined, lastSync: { at: 1, outcome: 'integrity-mismatch' } }, 'danger'],
    ['a re-check running while a package is installed', { syncing: true }, 'success'],
  ];
  for (const [name, patch, tone] of table) {
    it(`${name} → ${tone}`, () => expect(skillHubTone({ ...S0, ...patch })).toBe(tone));
  }
  it('pulses only while settling', () => {
    expect(skillHubSettling({ ...S0, version: undefined, syncing: true })).toBe(true);
    expect(skillHubSettling(S0)).toBe(false);
    expect(skillHubSettling({ ...S0, configured: false })).toBe(false);
  });
});

describe('gray is never used in the bar', () => {
  const aStates: Partial<A>[] = [{}, { row: 'other' }, { row: 'legacy' }, { status: 'relogin' }, { loginPending: true }, { status: 'connected' }];
  const sStates: Partial<S>[] = [
    {},
    { configured: false },
    { offReason: 'env-off', on: false },
    { offReason: 'user-off', on: false },
    { auth: 'unauthorized' },
    { auth: 'unknown' },
    { version: undefined },
    { version: undefined, lastSync: undefined },
  ];
  it('no Atlassian or Skill Hub state maps to neutral', () => {
    for (const a of aStates) expect(atlassianTone({ ...A0, ...a })).not.toBe('neutral');
    for (const x of sStates) expect(skillHubTone({ ...S0, ...x })).not.toBe('neutral');
  });
});

describe('tones map onto the shared StatusDot colors', () => {
  it('success/warning/danger/neutral use the semantic tokens', () => {
    expect(statusToneClass('success')).toBe('bg-success');
    expect(statusToneClass('warning')).toBe('bg-warning');
    expect(statusToneClass('danger')).toBe('bg-destructive');
    expect(statusToneClass('neutral')).toContain('bg-muted-foreground');
    expect(statusToneClass('active')).toBe('bg-brand');
  });
});

describe('what a click does', () => {
  const table: [string, Partial<A>, 'login' | 'settings'][] = [
    ['never signed in', {}, 'login'],
    ['expired', { status: 'relogin', row: 'oauth' }, 'login'],
    ['old API-token row (the sign-in migrates it)', { row: 'legacy' }, 'login'],
    ['a user-defined server (the sign-in replaces it)', { row: 'other' }, 'login'],
    ['red during the grace', { required: true, graceDaysLeft: 5 }, 'login'],
    ['connected', { status: 'connected', row: 'oauth' }, 'settings'],
    ['already waiting on the browser', { loginPending: true }, 'settings'],
  ];
  for (const [name, patch, action] of table) {
    it(`${name} → ${action}`, () => expect(atlassianClick({ ...A0, ...patch })).toBe(action));
  }
});

describe('what a Skill Hub click opens', () => {
  const keyFix = { section: 'connections', focus: 'system-mcp:skill-hub' };
  const table: [string, Partial<S>, object][] = [
    ['no key', { configured: false, on: false, offReason: 'no-skill-hub', auth: 'unknown' }, keyFix],
    ['key rejected', { on: false, offReason: 'unauthorized', auth: 'unauthorized' }, keyFix],
    ['rejected key, switched off too', { on: false, offReason: 'user-off', auth: 'unauthorized' }, keyFix],
    ['switched off in Settings', { on: false, offReason: 'user-off' }, { section: 'harness' }],
    ['kill switch', { on: false, offReason: 'env-off' }, { section: 'harness' }],
    ['key not verified yet', { auth: 'unknown' }, { section: 'harness' }],
    ['no package after a check', { version: undefined }, { section: 'harness' }],
    ['green', {}, { section: 'harness' }],
  ];
  for (const [name, patch, target] of table) {
    it(`${name} → ${JSON.stringify(target)}`, () => expect(skillHubClick({ ...S0, ...patch })).toEqual(target));
  }
  it('the last tooltip line says where the click goes', () => {
    const last = (x: Partial<S>) => skillHubLines({ ...S0, ...x }, () => 'now').at(-1)!.key;
    expect(last({ configured: false })).toBe('connectionStatus.clickSettingsKey');
    expect(last({ auth: 'unauthorized' })).toBe('connectionStatus.clickSettingsKey');
    expect(last({ on: false, offReason: 'user-off' })).toBe('connectionStatus.clickSettings');
    expect(last({})).toBe('connectionStatus.clickSettings');
  });
});

describe('the tooltip says why', () => {
  const keys = (lines: { key: string }[]) => lines.map((l) => l.key);
  it('Atlassian in grace names the days left; blocking says so; a user-defined server is named', () => {
    expect(atlassianLines({ ...A0, required: true, graceDaysLeft: 4 })).toContainEqual({
      key: 'orgHarness.atlassian.grace',
      values: { days: 4 },
    });
    expect(keys(atlassianLines({ ...A0, required: true, blocking: true }))).toContain('orgHarness.atlassian.blocking');
    expect(keys(atlassianLines({ ...A0, row: 'other' }))).toContain('connectionStatus.atlassianOther');
    expect(keys(atlassianLines({ ...A0 }))).toContain('connectionStatus.atlassianNeeded');
  });
  it('Skill Hub names the reason it is red or amber', () => {
    const fmt = () => 'now';
    expect(
      keys(skillHubLines({ ...S0, configured: false, on: false, version: undefined, lastSync: undefined }, fmt)),
    ).toEqual(['orgHarness.status.noKey', 'connectionStatus.clickSettingsKey']);
    expect(keys(skillHubLines({ ...S0, on: false, offReason: 'env-off' }, fmt))[0]).toBe('orgHarness.status.envOff');
    expect(keys(skillHubLines({ ...S0, on: false, offReason: 'user-off' }, fmt))[0]).toBe('orgHarness.status.userOff');
    expect(keys(skillHubLines({ ...S0, auth: 'unauthorized' }, fmt))[0]).toBe('orgHarness.activation.needsKey');
    expect(keys(skillHubLines({ ...S0, version: undefined, syncing: true }, fmt))).toContain('connectionStatus.syncing');
    expect(keys(skillHubLines({ ...S0, version: undefined, lastSync: { at: 1, outcome: 'unreachable' } }, fmt))).toContain(
      'orgHarness.noPackage',
    );
  });
});

/** Look a dotted key up in a dictionary, resolving i18next's plural suffixes. */
function has(dict: unknown, key: string): boolean {
  const walk = (k: string) =>
    k.split('.').reduce<unknown>((o, p) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[p] : undefined), dict);
  return typeof walk(key) === 'string' || typeof walk(`${key}_other`) === 'string';
}

describe('every sentence the bar and the popup use exists in en and ko', () => {
  const notice: OrgUpdateNoticeView = {
    version: '0.8.2',
    previous: '0.8.1',
    newHooks: [{ script: 'remind.js', events: ['SessionStart'] }],
    detectedAt: 1,
  };
  const keys = new Set<string>([
    'connectionStatus.ariaLabel',
    'connectionStatus.atlassian',
    'connectionStatus.skillHub',
    'orgUpdate.title',
    'orgUpdate.details',
    'orgUpdate.dismiss',
    'orgHarness.updateLog.title',
    'orgHarness.updateLog.entry',
  ]);
  const aStates: Partial<A>[] = [
    {},
    { status: 'connected', row: 'oauth' },
    { status: 'relogin', row: 'oauth', required: true, blocking: true },
    { row: 'legacy', required: true, graceDaysLeft: 2 },
    { required: true },
    { loginPending: true, lastLoginError: 'x' },
    { lastLoginError: 'x' },
    { row: 'other' },
  ];
  for (const a of aStates) for (const l of atlassianLines({ ...A0, ...a })) keys.add(l.key);
  const sStates: Partial<S>[] = [
    {},
    { configured: false },
    { offReason: 'env-off' },
    { offReason: 'user-off' },
    { auth: 'unauthorized' },
    { auth: 'unknown', version: undefined, lastSync: { at: 1, outcome: 'unreachable' } },
    { version: undefined, syncing: true },
  ];
  for (const s of sStates) {
    for (const l of skillHubLines({ ...S0, ...s }, () => 'now')) {
      keys.add(l.key);
      const ok = l.values?.outcomeKey;
      if (typeof ok === 'string') keys.add(ok);
    }
  }
  for (const l of orgUpdateLines(notice)) keys.add(l.key);
  for (const key of keys) {
    it(key, () => {
      expect(has(en, key)).toBe(true);
      expect(has(ko, key)).toBe(true);
    });
  }
});

describe('the update popup', () => {
  const n: OrgUpdateNoticeView = { version: '0.8.2', previous: '0.8.1', newHooks: [], detectedAt: 5 };

  it('says the versions, and the hook line only when there are waiting hooks', () => {
    expect(orgUpdateLines(n).map((l) => l.key)).toEqual(['orgUpdate.versions']);
    const withHooks = orgUpdateLines({
      ...n,
      newHooks: [
        { script: 'remind.js', events: ['SessionStart'] },
        { script: 'audit.js', events: ['PostToolUse'] },
      ],
    });
    expect(withHooks[1]).toEqual({ key: 'orgUpdate.newHooks', values: { count: 2, names: 'remind.js, audit.js' } });
  });

  it('reads the push: absent field = no news, null = nothing, a notice = show it', () => {
    expect(orgUpdateFromPush({ type: 'global-state', data: { sessions: [] } })).toBeUndefined();
    expect(orgUpdateFromPush({ type: 'ping' })).toBeUndefined();
    expect(orgUpdateFromPush({ type: 'global-state', data: { sessions: [], orgUpdate: null } })).toBeNull();
    expect(orgUpdateFromPush({ type: 'global-state', data: { orgUpdate: { version: 1 } } })).toBeNull();
    expect(orgUpdateFromPush({ type: 'global-state', data: { orgUpdate: n } })).toEqual(n);
  });

  it('a version dismissed in this window hides at once; a newer one still shows', () => {
    expect(visibleOrgUpdate(n, new Set(['0.8.2']))).toBeNull();
    expect(visibleOrgUpdate(n, new Set(['0.8.1']))).toEqual(n);
    expect(visibleOrgUpdate(null, new Set())).toBeNull();
  });
});
