/**
 * The chat status bar's decisions (org-harness-sync §3.9), kept out of the
 * component so every color and every click is a table a test can read.
 *
 * Input is `status.connections` (server `ConnectionsStatus`): status words and
 * versions, no secrets. Output is a tone per item (StatusDot), i18n keys for the
 * hover text, and what a click does. The component only renders.
 *
 * THE ORG HARNESS IS MANDATORY (user decision, 2026-10-08). The row always
 * shows in the desktop chat, both items always show, and the colors mean:
 *
 *   green  connected and working
 *   amber  in progress, settles on its own (a sign-in waiting on the browser, a
 *          key saved but not yet verified, the first download running)
 *   red    not connected — something the user has to do
 *
 * Gray is not used: "switched off" or "not set up" is not a neutral state when
 * the harness is required.
 */

import type { StatusTone } from '@cockpit/shared-ui';

/** Mirror of the server's `ConnectionsStatus` (lib/orgHarness.ts). Declared
 *  here, not imported: the client bundle must not reach into server modules. */
export type ConnectionsStatusView = {
  atlassian: {
    status: 'connected' | 'relogin' | 'none';
    row: 'none' | 'legacy' | 'oauth' | 'other';
    loginPending: boolean;
    lastLoginError?: string;
    required: boolean;
    blocking: boolean;
    graceDaysLeft?: number;
  };
  skillHub: {
    configured: boolean;
    on: boolean;
    offReason?: 'no-skill-hub' | 'env-off' | 'user-off' | 'unauthorized';
    auth: 'ok' | 'unauthorized' | 'unknown';
    version?: string;
    lastSync?: { at: number; outcome: string };
    /** A package check is running right now. Optional for an older server. */
    syncing?: boolean;
  };
};

export type OrgUpdateNoticeView = {
  version: string;
  previous: string;
  newHooks: { script: string; events: string[] }[];
  detectedAt: number;
};

/** A translation key plus the values it interpolates. */
export type Line = { key: string; values?: Record<string, string | number> };

// -- tones --------------------------------------------------------------------

/**
 * Atlassian:
 *   connected                         → green
 *   sign-in waiting on the browser    → amber
 *   anything else                     → red  (never signed in, expired, the old
 *     API-token row, a user-defined server — also during the 7-day grace: the
 *     grace only delays blocking, the tooltip says how many days are left)
 */
export function atlassianTone(a: ConnectionsStatusView['atlassian']): StatusTone {
  if (a.status === 'connected') return 'success';
  if (a.loginPending) return 'warning';
  return 'danger';
}

/** Skill Hub is in a transient state that settles on its own: a key saved but
 *  not verified yet, or the first download not finished (running, or not yet
 *  attempted). */
export function skillHubSettling(s: ConnectionsStatusView['skillHub']): boolean {
  if (!s.configured || s.offReason === 'env-off' || s.offReason === 'user-off') return false;
  if (s.auth === 'unauthorized' || s.offReason === 'unauthorized') return false;
  if (s.auth === 'unknown') return true;
  return !s.version && (s.syncing === true || !s.lastSync);
}

/**
 * Skill Hub, in priority order:
 *   no key                                              → red
 *   switched off (Settings toggle or NABY_ORG_HARNESS=0) → red
 *   key rejected (401)                                  → red
 *   key saved, not verified yet                         → amber
 *   no package: first download running / not attempted → amber
 *   no package after a check (unreachable, bad file…)   → red
 *   key accepted, on, package installed                 → green
 */
export function skillHubTone(s: ConnectionsStatusView['skillHub']): StatusTone {
  if (!s.configured) return 'danger';
  if (s.offReason === 'env-off' || s.offReason === 'user-off' || s.offReason === 'no-skill-hub') return 'danger';
  if (s.auth === 'unauthorized' || s.offReason === 'unauthorized') return 'danger';
  if (skillHubSettling(s)) return 'warning';
  if (!s.on || !s.version) return 'danger';
  return 'success';
}

// -- hover text ---------------------------------------------------------------

/** The Atlassian hover lines, reusing the Settings card's sentences. */
export function atlassianLines(a: ConnectionsStatusView['atlassian']): Line[] {
  const out: Line[] = [];
  if (a.loginPending) out.push({ key: 'orgHarness.atlassian.waiting' });
  if (a.status === 'connected') out.push({ key: 'orgHarness.atlassian.status.connected' });
  else if (a.status === 'relogin') out.push({ key: 'orgHarness.atlassian.status.relogin' });
  else if (a.row === 'legacy') out.push({ key: 'orgHarness.atlassian.status.legacy' });
  else if (a.row === 'other') out.push({ key: 'connectionStatus.atlassianOther' });
  else out.push({ key: 'orgHarness.atlassian.status.none' });
  if (a.status !== 'connected') {
    if (a.required && a.blocking) out.push({ key: 'orgHarness.atlassian.blocking' });
    else if (a.required && a.graceDaysLeft !== undefined) {
      out.push({ key: 'orgHarness.atlassian.grace', values: { days: a.graceDaysLeft } });
    } else out.push({ key: 'connectionStatus.atlassianNeeded' });
  }
  if (!a.loginPending && a.lastLoginError) {
    out.push({ key: 'orgHarness.atlassian.loginFailed', values: { error: a.lastLoginError } });
  }
  out.push({ key: atlassianClick(a) === 'login' ? 'connectionStatus.clickLogin' : 'connectionStatus.clickSettings' });
  return out;
}

/** The Skill Hub hover lines: status, version, last check. `formatTime` turns
 *  an epoch into the user's local time (the component passes the locale's). */
export function skillHubLines(s: ConnectionsStatusView['skillHub'], formatTime: (ms: number) => string): Line[] {
  const out: Line[] = [];
  if (!s.configured) out.push({ key: 'orgHarness.status.noKey' });
  else if (s.offReason === 'env-off') out.push({ key: 'orgHarness.status.envOff' });
  else if (s.offReason === 'user-off') out.push({ key: 'orgHarness.status.userOff' });
  else if (s.auth === 'unauthorized' || s.offReason === 'unauthorized') out.push({ key: 'orgHarness.activation.needsKey' });
  else if (s.auth === 'unknown') out.push({ key: 'orgHarness.activation.unchecked' });
  else out.push({ key: 'orgHarness.status.on' });
  if (s.version) out.push({ key: 'orgHarness.version', values: { version: s.version } });
  else if (s.configured && s.syncing) out.push({ key: 'connectionStatus.syncing' });
  else if (s.configured) out.push({ key: 'orgHarness.noPackage' });
  if (s.lastSync) {
    out.push({
      key: 'connectionStatus.lastCheck',
      values: { at: formatTime(s.lastSync.at), outcomeKey: syncOutcomeKey(s.lastSync.outcome) },
    });
  }
  out.push({
    key: skillHubClick(s).section === 'connections' ? 'connectionStatus.clickSettingsKey' : 'connectionStatus.clickSettings',
  });
  return out;
}

/** Same mapping as the Settings card's `orgSyncOutcomeKey`. */
export function syncOutcomeKey(outcome: string): string {
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

// -- clicks -------------------------------------------------------------------

/**
 * What clicking the Atlassian item does: every red state starts the browser
 * sign-in (never signed in, expired, the old API-token row and a user-defined
 * server — the sign-in swaps either row to the OAuth one, §4.4). A sign-in
 * already waiting on the browser and a connected account open Settings → Harness.
 * Skill Hub: see `skillHubClick`.
 */
export function atlassianClick(a: ConnectionsStatusView['atlassian']): 'login' | 'settings' {
  if (a.loginPending || a.status === 'connected') return 'settings';
  return 'login';
}

/** Where the Skill Hub key is entered: the Skill Hub row of the System MCP list
 *  under Settings → Connections (`data-settings-anchor` on that row). */
export const SKILL_HUB_KEY_ANCHOR = 'system-mcp:skill-hub';

/**
 * What clicking the Skill Hub item opens. No key, or a key Skill Hub rejected:
 * Settings → Connections, scrolled to the Skill Hub key — the fix is there.
 * Anything else: Settings → Harness (the org harness card: the switch, "check
 * now", the version and the last check).
 */
export function skillHubClick(
  s: ConnectionsStatusView['skillHub'],
): { section: 'connections'; focus: string } | { section: 'harness' } {
  if (!s.configured || s.auth === 'unauthorized' || s.offReason === 'unauthorized') {
    return { section: 'connections', focus: SKILL_HUB_KEY_ANCHOR };
  }
  return { section: 'harness' };
}

// -- the update popup ---------------------------------------------------------

/** The popup's lines (§3.1): the version change, then the waiting hooks if any. */
export function orgUpdateLines(n: OrgUpdateNoticeView): Line[] {
  const out: Line[] = [{ key: 'orgUpdate.versions', values: { previous: n.previous, version: n.version } }];
  if (n.newHooks.length > 0) {
    out.push({
      key: 'orgUpdate.newHooks',
      values: { count: n.newHooks.length, names: n.newHooks.map((h) => h.script).join(', ') },
    });
  }
  return out;
}

/**
 * Read the update notice from a `/ws/global-state` push. `undefined` = this push
 * says nothing about it (an older server); `null` = nothing to show; otherwise
 * the notice. Shape-checked: a malformed field reads as "nothing to show".
 */
export function orgUpdateFromPush(raw: unknown): OrgUpdateNoticeView | null | undefined {
  const data = (raw as { type?: unknown; data?: unknown } | null)?.data as Record<string, unknown> | undefined;
  if ((raw as { type?: unknown } | null)?.type !== 'global-state' || !data || typeof data !== 'object') return undefined;
  if (!('orgUpdate' in data)) return undefined;
  return parseOrgUpdate(data.orgUpdate);
}

export function parseOrgUpdate(v: unknown): OrgUpdateNoticeView | null {
  if (!v || typeof v !== 'object') return null;
  const n = v as Record<string, unknown>;
  if (typeof n.version !== 'string' || typeof n.previous !== 'string' || !Array.isArray(n.newHooks)) return null;
  const newHooks = n.newHooks.filter(
    (h): h is { script: string; events: string[] } =>
      !!h &&
      typeof (h as { script?: unknown }).script === 'string' &&
      Array.isArray((h as { events?: unknown }).events),
  );
  return {
    version: n.version,
    previous: n.previous,
    newHooks,
    detectedAt: typeof n.detectedAt === 'number' ? n.detectedAt : 0,
  };
}

/** The popup to draw: the pushed notice, unless this window already dismissed
 *  that version (the server's ack reaches the next push a moment later). */
export function visibleOrgUpdate(
  notice: OrgUpdateNoticeView | null,
  dismissed: ReadonlySet<string>,
): OrgUpdateNoticeView | null {
  return notice && !dismissed.has(notice.version) ? notice : null;
}
