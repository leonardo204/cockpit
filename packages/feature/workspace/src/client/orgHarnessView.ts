/**
 * The org harness Settings card's logic (org-harness-sync §4.5, §4.8), kept out
 * of the component so it can be tested without a DOM.
 *
 * Everything here reads the `orgHarness` object `/api/naby` answers with (the
 * runtime's `OrgHarnessState`, which carries no key and no token) and turns it
 * into i18n KEYS plus the few values they interpolate. The component only
 * renders; it never decides what a state means.
 */

export type OrgCopyKind = 'unmodified' | 'edited' | 'unknown';

/** The subset of the runtime's `OrgHarnessState` the card reads. Declared here,
 *  not imported: the client bundle must not reach into the server's runtime. */
export type OrgHarnessView = {
  configured: boolean;
  on: boolean;
  offReason?: 'no-skill-hub' | 'env-off' | 'user-off' | 'unauthorized';
  enabledSetting: boolean;
  envOff: boolean;
  auth: 'ok' | 'unauthorized' | 'unknown';
  package: { version: string; skills: string[] } | null;
  lastSync: { at: number; outcome: string; version?: string; detail?: string } | null;
  rows: { name: string; status: 'enabled' | 'disabled' | 'removed'; origin: string; withdrawn: boolean }[];
  copyNotices: { name: string; scope: 'user' | 'project'; scopeKey: string; itemId: string; copy: OrgCopyKind }[];
  keepUserCopy: string[];
  /** M3 (org-harness-sync §3.6, §3.8, §4.4, §4.6). Optional so a server that
   *  predates it still renders the card. */
  atlassian?: AtlassianView;
  deps?: OrgDepsView | null;
  unsupportedHooks?: { event: string; script: string; why: string }[];
};

export type AtlassianView = {
  status: 'connected' | 'relogin' | 'none';
  /** `legacy` = the API-token connection still runs, waiting for the sign-in. */
  row: 'none' | 'legacy' | 'oauth' | 'other';
  loginPending: boolean;
  lastLoginError?: string;
  loggedInAt?: number;
  migration?: {
    at: number;
    from: string;
    confluenceUpload: 'withdrawn' | 'kept' | 'absent' | 'already';
    legacyRefs: { kind: string; scope: string; scopeKey: string; id: string; name: string; ref: string }[];
  };
  graceDaysLeft?: number;
  blocking: boolean;
};

export type OrgDepsView = { at: number; python: string | null; pythonCommand?: string; pyyaml: boolean };

/** i18n key for the Atlassian status line. */
export function atlassianStatusKey(a: AtlassianView): string {
  if (a.status === 'connected') return 'orgHarness.atlassian.status.connected';
  if (a.status === 'relogin') return 'orgHarness.atlassian.status.relogin';
  if (a.row === 'legacy') return 'orgHarness.atlassian.status.legacy';
  return 'orgHarness.atlassian.status.none';
}

/** The button: first sign-in or "sign in again". */
export function atlassianLoginKey(a: AtlassianView): string {
  return a.status === 'none' && a.loggedInAt === undefined && a.row !== 'oauth'
    ? 'orgHarness.atlassian.login'
    : 'orgHarness.atlassian.relogin';
}

/** The gate line (§4.6): blocking now, or N days of grace left; undefined when
 *  there is nothing to warn about. */
export function atlassianGateLine(a: AtlassianView): { key: string; days?: number } | undefined {
  if (a.status === 'connected') return undefined;
  if (a.blocking) return { key: 'orgHarness.atlassian.blocking' };
  if (a.graceDaysLeft !== undefined) return { key: 'orgHarness.atlassian.grace', days: a.graceDaysLeft };
  return undefined;
}

export type OrgDepMissing = { id: 'python' | 'pyyaml'; install: string };

/** Install commands, by platform — commands are not translated. */
const INSTALL: Record<'darwin' | 'win32' | 'linux', Record<'python' | 'pyyaml', string>> = {
  darwin: { python: 'brew install python', pyyaml: 'python3 -m pip install --user pyyaml' },
  win32: { python: 'winget install Python.Python.3.12', pyyaml: 'py -3 -m pip install --user pyyaml' },
  linux: { python: 'sudo apt install python3 python3-pip', pyyaml: 'python3 -m pip install --user pyyaml' },
};

/** What the dependency check found missing (§3.6), with the install command. */
export function orgDepsMissing(deps: OrgDepsView | null | undefined, platform: string): OrgDepMissing[] {
  if (!deps) return [];
  const os: 'darwin' | 'win32' | 'linux' = /win/i.test(platform) ? 'win32' : /mac|darwin/i.test(platform) ? 'darwin' : 'linux';
  const out: OrgDepMissing[] = [];
  if (!deps.python) out.push({ id: 'python', install: INSTALL[os].python });
  if (!deps.pyyaml) out.push({ id: 'pyyaml', install: INSTALL[os].pyyaml });
  return out;
}

/** Activation as the card states it (§3.6, §4.3). */
export type OrgActivation = 'ok' | 'needsKey' | 'noKey' | 'unchecked';

export function orgActivation(v: OrgHarnessView): OrgActivation {
  if (!v.configured) return 'noKey';
  if (v.auth === 'unauthorized') return 'needsKey';
  if (v.auth === 'ok') return 'ok';
  return 'unchecked';
}

/** i18n key for the activation line. */
export function orgActivationKey(a: OrgActivation): string {
  return `orgHarness.activation.${a}`;
}

/** i18n key for the one-line on/off status. */
export function orgStatusKey(v: OrgHarnessView): string {
  if (v.on) return 'orgHarness.status.on';
  switch (v.offReason) {
    case 'env-off':
      return 'orgHarness.status.envOff';
    case 'user-off':
      return 'orgHarness.status.userOff';
    case 'unauthorized':
      return 'orgHarness.status.unauthorized';
    default:
      return 'orgHarness.status.noKey';
  }
}

/** The toggle cannot move what the environment pinned (§4.8: `NABY_ORG_HARNESS=0`
 *  wins), and there is nothing to switch without a key. */
export function orgToggleDisabled(v: OrgHarnessView): boolean {
  return v.envOff || !v.configured;
}

/** The skills the card lists: live org rows (not withdrawn, not deleted), by name. */
export function orgSkillRows(v: OrgHarnessView): { name: string; enabled: boolean }[] {
  return v.rows
    .filter((r) => !r.withdrawn && r.status !== 'removed')
    .map((r) => ({ name: r.name, enabled: r.status === 'enabled' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** i18n key for "what kind of copy" (§4.5: unmodified / edited). */
export function orgCopyKindKey(copy: OrgCopyKind): string {
  return copy === 'unmodified'
    ? 'orgHarness.copyUnmodified'
    : copy === 'edited'
      ? 'orgHarness.copyEdited'
      : 'orgHarness.copyUnknown';
}

/** One row per skill name the user still has to choose for (pending notices),
 *  then one per name they chose to keep — "can choose again any time" (§4.5).
 *  A name with a copy in two scopes appears once, with every scope listed. */
export type OrgChoiceRow = {
  name: string;
  state: 'pending' | 'kept';
  copy?: OrgCopyKind;
  scopes: ('user' | 'project')[];
};

export function orgChoiceRows(v: OrgHarnessView): OrgChoiceRow[] {
  const byName = new Map<string, OrgChoiceRow>();
  for (const n of v.copyNotices) {
    const row = byName.get(n.name);
    if (!row) {
      byName.set(n.name, { name: n.name, state: 'pending', copy: n.copy, scopes: [n.scope] });
      continue;
    }
    if (!row.scopes.includes(n.scope)) row.scopes.push(n.scope);
    // Two copies of one name: "edited" wins — the user must not read "unmodified"
    // when one of the copies is not.
    if (n.copy === 'edited') row.copy = 'edited';
  }
  const out = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const name of [...v.keepUserCopy].sort()) {
    if (byName.has(name)) continue;
    out.push({ name, state: 'kept', scopes: [] });
  }
  return out;
}

/** i18n key for the last package check's outcome. */
export function orgSyncOutcomeKey(outcome: string): string {
  switch (outcome) {
    case 'updated':
    case 'current':
    case 'unreachable':
    case 'no-plugin':
    case 'integrity-mismatch':
    case 'invalid-package':
      return `orgHarness.sync.${outcome}`;
    default:
      return 'orgHarness.sync.other';
  }
}
