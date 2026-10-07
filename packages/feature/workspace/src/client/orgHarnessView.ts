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
};

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
