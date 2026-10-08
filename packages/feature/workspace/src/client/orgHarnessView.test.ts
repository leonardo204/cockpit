import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  atlassianGateLine,
  atlassianLoginKey,
  atlassianStatusKey,
  orgDepsMissing,
  orgActivation,
  orgActivationKey,
  orgChoiceRows,
  orgCopyKindKey,
  orgSkillRows,
  orgStatusKey,
  orgSyncOutcomeKey,
  orgToggleDisabled,
  type OrgHarnessView,
} from './orgHarnessView';

/**
 * THE ORG HARNESS SETTINGS CARD (org-harness-sync §4.5, §4.8, M2) — its logic.
 *
 * The card only renders; what a state MEANS is decided in `orgHarnessView.ts`,
 * tested here without a DOM. The last block holds the i18n down: every key the
 * card can produce must exist in BOTH locales, because a missing one renders the
 * English default and nobody notices in an English run.
 */

const base: OrgHarnessView = {
  configured: true,
  on: true,
  enabledSetting: true,
  envOff: false,
  auth: 'ok',
  package: { version: '0.8.1', skills: ['ctx', 'pdoc', 'task'] },
  lastSync: { at: 0, outcome: 'updated', version: '0.8.1' },
  rows: [
    { name: 'task', status: 'enabled', origin: 'org:altimedia-harness@0.8.1', withdrawn: false },
    { name: 'pdoc', status: 'disabled', origin: 'org:altimedia-harness@0.8.1', withdrawn: false },
    { name: 'old', status: 'removed', origin: 'org-withdrawn:altimedia-harness@0.7.1', withdrawn: true },
  ],
  copyNotices: [],
  keepUserCopy: [],
};

describe('activation and status', () => {
  it('ok / 401 needs key / no skill-hub key / not yet checked', () => {
    expect(orgActivation(base)).toBe('ok');
    expect(orgActivation({ ...base, auth: 'unauthorized', on: false, offReason: 'unauthorized' })).toBe('needsKey');
    expect(orgActivation({ ...base, configured: false, auth: 'unknown' })).toBe('noKey');
    expect(orgActivation({ ...base, auth: 'unknown' })).toBe('unchecked');
  });

  it('the status line names why it is off', () => {
    expect(orgStatusKey(base)).toBe('orgHarness.status.on');
    expect(orgStatusKey({ ...base, on: false, offReason: 'env-off' })).toBe('orgHarness.status.envOff');
    expect(orgStatusKey({ ...base, on: false, offReason: 'user-off' })).toBe('orgHarness.status.userOff');
    expect(orgStatusKey({ ...base, on: false, offReason: 'no-skill-hub' })).toBe('orgHarness.status.noKey');
  });

  it('the toggle cannot override NABY_ORG_HARNESS=0 and needs a key', () => {
    expect(orgToggleDisabled(base)).toBe(false);
    expect(orgToggleDisabled({ ...base, envOff: true })).toBe(true);
    expect(orgToggleDisabled({ ...base, configured: false })).toBe(true);
  });
});

describe('skills and copies', () => {
  it('lists live org skills with their enabled state, not withdrawn ones', () => {
    expect(orgSkillRows(base)).toEqual([
      { name: 'pdoc', enabled: false },
      { name: 'task', enabled: true },
    ]);
  });

  it('one choice row per name; "edited" wins over "unmodified"; kept names stay choosable', () => {
    const rows = orgChoiceRows({
      ...base,
      copyNotices: [
        { name: 'task', scope: 'user', scopeKey: 'u', itemId: '1', copy: 'unmodified' },
        { name: 'task', scope: 'project', scopeKey: '/p', itemId: '2', copy: 'edited' },
        { name: 'ctx', scope: 'user', scopeKey: 'u', itemId: '3', copy: 'unmodified' },
      ],
      keepUserCopy: ['pdoc', 'task'],
    });
    expect(rows).toEqual([
      { name: 'ctx', state: 'pending', copy: 'unmodified', scopes: ['user'] },
      { name: 'task', state: 'pending', copy: 'edited', scopes: ['user', 'project'] },
      { name: 'pdoc', state: 'kept', scopes: [] },
    ]);
  });
});

describe('every key the card can produce exists in both locales', () => {
  const LOCALES = join(__dirname, '..', '..', '..', '..', 'shared', 'i18n', 'locales');
  const dict = (lang: string) => JSON.parse(readFileSync(join(LOCALES, `${lang}.json`), 'utf8')) as Record<string, unknown>;
  const lookup = (d: Record<string, unknown>, key: string): unknown =>
    key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), d);

  const keys = [
    ...(['ok', 'needsKey', 'noKey', 'unchecked'] as const).map(orgActivationKey),
    ...(['on', 'envOff', 'userOff', 'unauthorized', 'noKey'] as const).map((k) => `orgHarness.status.${k}`),
    ...(['unmodified', 'edited', 'unknown'] as const).map(orgCopyKindKey),
    ...['updated', 'current', 'unreachable', 'no-plugin', 'integrity-mismatch', 'invalid-package', 'weird'].map(orgSyncOutcomeKey),
    ...[
      'title', 'loading', 'description', 'version', 'noPackage', 'lastSync', 'toggle', 'envOffHint', 'skills',
      'skillOn', 'skillOff', 'copiesTitle', 'copyPending', 'copyKept', 'useOrg', 'keepMine', 'useOrgDone',
      'checkNow', 'checking',
    ].map((k) => `orgHarness.${k}`),
    'harnessPill.orgHarness',
    'harnessPill.orgUnauthorized',
    'harnessPill.orgCopyNotice',
  ];

  for (const lang of ['en', 'ko']) {
    it(`${lang}: all ${keys.length} keys are present`, () => {
      const d = dict(lang);
      const missing = keys.filter((k) => typeof lookup(d, k) !== 'string');
      expect(missing).toEqual([]);
    });
  }

  it('ko uses the spec’s own words for the two actions and the two kinds of copy', () => {
    const ko = dict('ko');
    expect(lookup(ko, 'orgHarness.useOrg')).toBe('조직 버전 쓰기');
    expect(lookup(ko, 'orgHarness.keepMine')).toBe('내 사본 유지');
    expect(lookup(ko, 'orgHarness.copyUnmodified')).toBe('고치지 않은 사본');
    expect(lookup(ko, 'orgHarness.copyEdited')).toBe('직접 고친 사본');
  });

  it('the card is mounted under Settings → Harness', () => {
    const modal = readFileSync(join(__dirname, 'SettingsModal.tsx'), 'utf8');
    const harness = modal.indexOf("section === 'harness'");
    const card = modal.indexOf('<NabyOrgHarnessSettings isOpen={isOpen} />');
    expect(card).toBeGreaterThan(harness);
    expect(card - harness).toBeLessThan(600);
  });
});

describe('the Atlassian section (M3: §3.6, §3.8, §4.4, §4.6)', () => {
  const a = (over: Partial<NonNullable<OrgHarnessView['atlassian']>> = {}): NonNullable<OrgHarnessView['atlassian']> => ({
    status: 'none',
    row: 'none',
    loginPending: false,
    blocking: false,
    ...over,
  });

  it('names the state: connected, expired, still on the API token, not signed in', () => {
    expect(atlassianStatusKey(a({ status: 'connected', row: 'oauth' }))).toBe('orgHarness.atlassian.status.connected');
    expect(atlassianStatusKey(a({ status: 'relogin', row: 'oauth' }))).toBe('orgHarness.atlassian.status.relogin');
    expect(atlassianStatusKey(a({ row: 'legacy' }))).toBe('orgHarness.atlassian.status.legacy');
    expect(atlassianStatusKey(a())).toBe('orgHarness.atlassian.status.none');
  });

  it('offers "log in" the first time and "log in again" after that', () => {
    expect(atlassianLoginKey(a())).toBe('orgHarness.atlassian.login');
    expect(atlassianLoginKey(a({ status: 'relogin', row: 'oauth' }))).toBe('orgHarness.atlassian.relogin');
    expect(atlassianLoginKey(a({ status: 'connected', row: 'oauth', loggedInAt: 1 }))).toBe('orgHarness.atlassian.relogin');
  });

  it('warns about the gate: blocking now, or the days left — never when signed in', () => {
    expect(atlassianGateLine(a({ blocking: true }))).toEqual({ key: 'orgHarness.atlassian.blocking' });
    expect(atlassianGateLine(a({ graceDaysLeft: 4 }))).toEqual({ key: 'orgHarness.atlassian.grace', days: 4 });
    expect(atlassianGateLine(a({ status: 'connected', blocking: true }))).toBeUndefined();
    expect(atlassianGateLine(a())).toBeUndefined();
  });

  it('lists the missing dependencies with the install command for the platform', () => {
    expect(orgDepsMissing(null, 'MacIntel')).toEqual([]);
    expect(orgDepsMissing({ at: 1, python: '3.12.0', pyyaml: true }, 'MacIntel')).toEqual([]);
    expect(orgDepsMissing({ at: 1, python: '3.12.0', pyyaml: false }, 'MacIntel')).toEqual([
      { id: 'pyyaml', install: 'python3 -m pip install --user pyyaml' },
    ]);
    expect(orgDepsMissing({ at: 1, python: null, pyyaml: false }, 'Win32').map((d) => d.install)).toEqual([
      'winget install Python.Python.3.12',
      'py -3 -m pip install --user pyyaml',
    ]);
  });

  it('every Atlassian key the card can produce exists in both locales', () => {
    const dict = (locale: string) =>
      JSON.parse(readFileSync(join(__dirname, '../../../../shared/i18n/locales', `${locale}.json`), 'utf8')) as Record<string, unknown>;
    const lookup = (src: Record<string, unknown>, key: string): unknown =>
      key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), src);
    const keys = [
      'orgHarness.atlassian.title',
      'orgHarness.atlassian.status.connected',
      'orgHarness.atlassian.status.relogin',
      'orgHarness.atlassian.status.legacy',
      'orgHarness.atlassian.status.none',
      'orgHarness.atlassian.login',
      'orgHarness.atlassian.relogin',
      'orgHarness.atlassian.waiting',
      'orgHarness.atlassian.cancel',
      'orgHarness.atlassian.openHint',
      'orgHarness.atlassian.loginDone',
      'orgHarness.atlassian.loginFailed',
      'orgHarness.atlassian.blocking',
      'orgHarness.atlassian.grace',
      'orgHarness.atlassian.migrated',
      'orgHarness.atlassian.confluenceUploadKept',
      'orgHarness.atlassian.legacyRefs',
      'orgHarness.deps.title',
      'orgHarness.deps.python',
      'orgHarness.deps.pyyaml',
      'orgHarness.unsupportedHooks',
      'systemMcp.oauth.connected',
      'systemMcp.oauth.relogin',
      'systemMcp.oauth.legacy',
      'systemMcp.oauth.none',
      'systemMcp.oauthUseLogin',
      'toolApproval.hookReason',
    ];
    for (const locale of ['en', 'ko']) {
      const d = dict(locale);
      for (const key of keys) expect(typeof lookup(d, key), `${locale}: ${key}`).toBe('string');
    }
  });
});
