// packages/feature/agent/src/server/lib/orgHarness.ts
//
// THE SHELL SIDE OF THE ORG HARNESS (specs/org-harness-sync.md, M1).
//
// The runtime (`src/runtime/org-harness.ts`) owns every rule: package sync,
// activation, row reconciliation, the §4.5 choices, the §4.8 switch. This file
// owns only what the runtime deliberately does not know:
//
//   * WHICH KEY. The Skill Hub key is the token of the System MCP preset that
//     declares `ownsOrgHarnessKey` (lib/systemMcp.ts). The runtime never reads the
//     MCP registry; this module reads it and hands the key over.
//   * WHEN. A background pass after startup (§4.2), a pass when the key is saved
//     or removed (§3.6 "a changed key is re-checked immediately"), and the cheap
//     turn-boundary apply the engine calls before a turn assembles (§4.7).
//   * THE NETWORK. `fetch` is the global one unless a test installs a fake.
//
// NO NETWORK IN TESTS. `NABY_ORG_HARNESS_SYNC=0` (set by vitest.setup.ts) stops
// every background pass before it starts. Tests drive `syncOrgHarnessNow` with an
// injected fetch instead, so the wiring is covered without touching Skill Hub.
//
// THE M4 TIMER. "Every six hours" (§3.1) is one `setInterval(kick, SIX_HOURS)` in
// `ensureOrgHarnessSyncStarted`, next to the boot kick. The pass is idempotent
// and single-flight, so adding it changes nothing else.

import {
  applyAtlassianOAuthSwapIfDue,
  applyOrgHarnessIfDue,
  ATLASSIAN_MCP_SERVER_NAME,
  ATLASSIAN_MCP_URL,
  atlassianRowShape,
  checkOrgHarnessDeps,
  DAY_MS,
  evaluateOrgAtlassianGate,
  keepUserCopy,
  mcpOAuthStatus,
  nabyHomeDir,
  orgGateBlockFrom,
  orgHarnessOnState,
  pinOrgHarnessTurn,
  readAtlassianMigrationReport,
  readCurrentOrgPackage,
  readMcpOAuthRecord,
  readOrgDeps,
  readOrgHarnessState,
  readOrgHookConfig,
  runOrgHarnessSync,
  setOrgHarnessEnabled,
  startMcpOAuthLogin,
  unsupportedOrgHooks,
  useOrgVersion,
  type AtlassianMigrationReport,
  type AtlassianRowShape,
  type McpOAuthFetch,
  type McpOAuthLogin,
  type McpOAuthStatus,
  type OrgDepsState,
  type OrgGateVerdict,
  type OrgHarnessActionResult,
  type OrgHarnessApplyResult,
  type OrgHarnessContext,
  type OrgHarnessFetch,
  type OrgHarnessState,
  type OrgHarnessSyncReport,
  type OrgHarnessTurn,
  type Store,
} from '../../../../../../../dist/naby-runtime.mjs';
import { anyRunActive } from '../sessionRunHub';
import { CIC_SERVER_NAME, findSystemMcpPreset, orgHarnessKeyPreset } from './systemMcp';

/** Turns the BACKGROUND passes off (tests, CI). Not the kill switch: that is
 *  `NABY_ORG_HARNESS=0` (runtime), which turns the org harness itself off. */
export const ORG_HARNESS_SYNC_ENV = 'NABY_ORG_HARNESS_SYNC';

/** How long after the first request the boot pass starts — long enough that the
 *  first window paint and session restore never wait on it (§4.2). */
const BOOT_DELAY_MS = 1500;

let fetchOverride: OrgHarnessFetch | undefined;

/** Test seam: install a fake Skill Hub. `undefined` restores the global fetch. */
export function setOrgHarnessFetch(fn: OrgHarnessFetch | undefined): void {
  fetchOverride = fn;
}

function currentFetch(): OrgHarnessFetch | undefined {
  if (fetchOverride) return fetchOverride;
  return typeof globalThis.fetch === 'function' ? (globalThis.fetch as OrgHarnessFetch) : undefined;
}

/**
 * The Skill Hub key, or undefined when no skill-hub preset is configured.
 *
 * A `proposed` entry does not count. That status means an AGENT wrote the
 * server through `naby_add_mcp` and a human has not approved it yet; the org
 * harness arrives enabled and (from M3) runs hooks, so an unapproved credential
 * must not be what switches it on.
 */
export function readOrgHarnessKey(store: Pick<Store, 'listMcpEntries'>): string | undefined {
  const preset = orgHarnessKeyPreset();
  if (!preset) return undefined;
  const entry = store.listMcpEntries().find((e) => e.name === preset.name);
  if (!entry || entry.status === 'proposed') return undefined;
  const token = preset.readStoredFields(entry).token?.trim();
  return token ? token : undefined;
}

/**
 * The cic preset's token, or undefined when it is not configured (§3.4: scripts
 * get `CLAUDE_PLUGIN_OPTION_CIC_TOKEN` only "if set"). Same reading rule as the
 * Skill Hub key — an agent-proposed entry does not count.
 */
export function readOrgCicToken(store: Pick<Store, 'listMcpEntries'>): string | undefined {
  const preset = findSystemMcpPreset(CIC_SERVER_NAME);
  if (!preset) return undefined;
  const entry = store.listMcpEntries().find((e) => e.name === preset.name);
  if (!entry || entry.status === 'proposed') return undefined;
  const token = preset.readStoredFields(entry).token?.trim();
  return token ? token : undefined;
}

/** Everything the runtime needs, resolved here once. */
export function orgHarnessContext(
  store: Pick<Store, 'listMcpEntries'>,
  env: Record<string, string | undefined> = process.env,
): OrgHarnessContext {
  const apiKey = readOrgHarnessKey(store);
  return { home: nabyHomeDir(), env, ...(apiKey ? { apiKey } : {}) };
}

let inflight: Promise<OrgHarnessSyncReport> | undefined;

/**
 * One full pass now: activation → package → rows. Single-flight. The rows are
 * applied only when no turn is running (`anyRunActive`); otherwise the next turn
 * boundary applies them (§4.2 step 3).
 */
export function syncOrgHarnessNow(
  store: Store,
  opts: { applyNow?: boolean } = {},
): Promise<OrgHarnessSyncReport> {
  if (inflight) return inflight;
  const fetch = currentFetch();
  const ctx = orgHarnessContext(store);
  if (!fetch) {
    // No fetch at all (very old embedded Node): still reconcile what is on disk.
    return Promise.resolve({ apply: applyOrgHarnessIfDue(store, ctx) });
  }
  const p = runOrgHarnessSync(store, {
    ...ctx,
    fetch,
    applyNow: opts.applyNow ?? !anyRunActive(),
  });
  inflight = p.finally(() => {
    inflight = undefined;
  });
  return inflight;
}

function backgroundDisabled(): boolean {
  return (process.env[ORG_HARNESS_SYNC_ENV] ?? '').trim() === '0';
}

/**
 * Fire-and-forget pass. A no-op without a key (no network at all, §4.3) and
 * when background passes are disabled. Never throws, never rejects.
 */
export function kickOrgHarnessSync(store: Store): void {
  let ctx: OrgHarnessContext;
  try {
    ctx = orgHarnessContext(store);
  } catch {
    return;
  }
  if (!ctx.apiKey) {
    // Key removed: no network, but the rows still have to switch off (§4.3).
    // Local and synchronous, so it runs even where background passes are off.
    try {
      applyOrgHarnessIfDue(store, ctx);
    } catch {
      /* best effort */
    }
    return;
  }
  if (backgroundDisabled()) return;
  void syncOrgHarnessNow(store)
    .then((r) => {
      const pkg = r.package;
      if (pkg && pkg.outcome !== 'current') {
        console.log(
          `[org-harness] package ${pkg.outcome}${pkg.current ? ` (current ${pkg.current})` : ''}` +
            (pkg.detail ? `: ${pkg.detail}` : ''),
        );
      }
      if (r.skipped === 'unauthorized') console.log('[org-harness] Skill Hub rejected the key; org harness is off');
    })
    .catch((e) => {
      console.warn(`[org-harness] sync failed: ${e instanceof Error ? e.message : String(e)}`);
    });
}

let started = false;

/**
 * The boot pass, once per process (§3.1 "on app start", §4.2 "after the window
 * is up"). Called from the first state read and the first turn — whichever comes
 * first — so it runs in the same Next realm as the engine that applies rows.
 */
export function ensureOrgHarnessSyncStarted(store: Store): void {
  if (started || backgroundDisabled()) return;
  started = true;
  const timer = setTimeout(() => kickOrgHarnessSync(store), BOOT_DELAY_MS);
  timer.unref?.();
  // M4: const every = setInterval(() => kickOrgHarnessSync(store), 6 * 60 * 60 * 1000); every.unref?.();
}

/**
 * The turn-boundary apply (§4.2 step 3, §4.7). Cheap when nothing changed (one
 * small file read and a few settings reads); never throws — a turn must not fail
 * because the org harness could not reconcile.
 */
export function applyOrgHarnessAtTurnBoundary(store: Store): OrgHarnessApplyResult | undefined {
  try {
    const result = applyOrgHarnessIfDue(store, orgHarnessContext(store));
    if (result.ran === 'full') {
      console.log(
        `[org-harness] applied ${result.on ? `v${result.version ?? '-'}` : `off (${result.offReason})`}` +
          ` added=${result.added.length} updated=${result.updated.length}` +
          ` withdrawn=${result.withdrawn.length} revived=${result.revived.length}` +
          ` switched=${result.switched.length} notices=${result.notices.length}`,
      );
    }
    return result;
  } catch (e) {
    console.warn(`[org-harness] apply skipped: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/**
 * THE ORG HARNESS PINNED FOR ONE TURN (org-harness-sync §4.7, M2). Called once,
 * right after the turn-boundary apply and before the toolset is built: the
 * switch and the package folder it resolves are what the listing, every
 * `naby_skill_load` and every package command of this turn use — including every
 * step of an autonomous run. Never throws; an error is an "off" turn.
 *
 * The cic token is read lazily (only when a package command actually runs), so
 * it is never resolved on a turn that does not use it.
 */
export function pinOrgHarnessForTurn(
  store: Store,
  opts: { projectDir?: string; nativeClaudeTools: boolean },
): OrgHarnessTurn {
  let ctx: OrgHarnessContext;
  try {
    ctx = orgHarnessContext(store);
  } catch {
    ctx = { home: nabyHomeDir(), env: process.env };
  }
  return pinOrgHarnessTurn(store, {
    ...ctx,
    nativeClaudeTools: opts.nativeClaudeTools,
    ...(opts.projectDir ? { projectDir: opts.projectDir } : {}),
    readCicToken: () => readOrgCicToken(store),
  });
}

/**
 * What a NEW session is told once, as harness pills on its first turn (§4.5
 * "the notice shows once at session start", §3.6 "a rejected key is announced at
 * session start", §4.4 step 2 and §4.6 for Atlassian). Codes, not sentences: the
 * server has no locale, and the client renders them (`client/harnessPill.ts`).
 * Empty when there is nothing to say.
 *
 *   `atlassian-migrate`       the API-token row is still in use: log in once (§4.4)
 *   `atlassian-grace:<days>`  not signed in; new sessions are blocked in N days (§4.6)
 *   `atlassian-relogin`       the sign-in expired; log in again
 *
 * `gate` is this turn's gate verdict (the grace days come from it).
 */
export function orgHarnessSessionStartNotices(store: Store, gate?: OrgGateVerdict): string[] {
  let state: OrgHarnessState;
  try {
    state = readOrgHarnessState(store, orgHarnessContext(store));
  } catch {
    return [];
  }
  const out: string[] = [];
  if (state.configured && state.auth === 'unauthorized') out.push('unauthorized');
  if (state.on) {
    for (const n of state.copyNotices) out.push(`copy-notice:${n.name}:${n.copy}`);
  }
  try {
    const status = mcpOAuthStatus(store, ATLASSIAN_MCP_SERVER_NAME);
    if (atlassianRowShape(store) === 'legacy' && status !== 'connected') out.push('atlassian-migrate');
    if (gate && !gate.block && gate.why === 'grace' && gate.graceDaysLeft !== undefined) {
      out.push(`atlassian-grace:${gate.graceDaysLeft}`);
    } else if (status === 'relogin' && atlassianRowShape(store) === 'oauth') {
      out.push('atlassian-relogin');
    }
  } catch {
    /* notices are best effort */
  }
  return out;
}

// -- the Atlassian gate (§3.6, §4.6) -------------------------------------------

/**
 * The gate for one prompt. Runs BEFORE the turn mints a session, so the session's
 * creation time is the existing session's (undefined for a new one). Never
 * throws: an error reads as "not blocked" — a broken gate must not lock anyone
 * out of the app.
 */
export function orgHarnessPromptGate(
  store: Store,
  args: { sessionId?: string; rawPrompt?: string; now?: number },
): OrgGateVerdict {
  const fallback: OrgGateVerdict = { block: false, why: 'off', atlassian: 'none' };
  try {
    const ctx = orgHarnessContext(store);
    const on = orgHarnessOnState(store, ctx).on;
    const pkg = on ? readCurrentOrgPackage(ctx.home) : undefined;
    const verb = /^\s*\/([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(args.rawPrompt ?? '')?.[1]?.toLowerCase();
    const namesOrgSkill = verb !== undefined && (pkg?.skills ?? []).some((sk) => sk.name.toLowerCase() === verb);
    const session = args.sessionId ? store.getSession(args.sessionId) : undefined;
    return evaluateOrgAtlassianGate(store, {
      on,
      packagePresent: pkg !== undefined,
      env: process.env,
      ...(args.now !== undefined ? { now: args.now } : {}),
      ...(session ? { sessionCreatedAt: session.createdAt } : {}),
      ...(args.rawPrompt !== undefined ? { rawPrompt: args.rawPrompt } : {}),
      namesOrgSkill,
      hasPriorSessions: () => store.listSessions().length > 0,
    });
  } catch (e) {
    console.warn(`[org-harness] gate skipped: ${e instanceof Error ? e.message : String(e)}`);
    return fallback;
  }
}

/** The blocked prompt's answer — English, like every other server-side refusal;
 *  the harness pill beside it carries the localized sentence. */
export const ATLASSIAN_GATE_MESSAGE =
  'The org harness needs an Atlassian sign-in before it can take prompts. ' +
  'Open Settings → Harness → Org harness and choose "Log in to Atlassian", then send your message again.';

/** Kick the Python/PyYAML check (§3.6) without waiting. */
export function kickOrgHarnessDepsCheck(store: Store): void {
  void checkOrgHarnessDeps(store).catch(() => undefined);
}

const depsCheckedSessions = new Set<string>();
/** The same, once per session in this process ("at session start", §3.6). */
export function kickOrgHarnessDepsCheckForSession(store: Store, sessionId: string): void {
  if (depsCheckedSessions.has(sessionId)) return;
  depsCheckedSessions.add(sessionId);
  kickOrgHarnessDepsCheck(store);
}

// -- Atlassian browser sign-in (§3.8) -----------------------------------------

let atlassianFetch: McpOAuthFetch | undefined;
/** Test seam: a fake Atlassian. `undefined` restores the global fetch. */
export function setAtlassianOAuthFetch(fn: McpOAuthFetch | undefined): void {
  atlassianFetch = fn;
}
let atlassianServerUrl: string | undefined;
/** Test seam: point the login at a fake server. */
export function setAtlassianOAuthServerUrl(url: string | undefined): void {
  atlassianServerUrl = url;
}

type PendingLogin = { login: McpOAuthLogin; startedAt: number };
let pendingLogin: PendingLogin | undefined;
let lastLoginError: string | undefined;

/**
 * Start a browser sign-in. Returns the authorization URL — the CLIENT opens it
 * (in the app, `window.open` lands in the OS browser through the window-open
 * handler). A second start cancels the first. When the callback lands, the
 * API-token row is swapped right away if no turn is running, otherwise at the
 * next turn boundary (§4.4 step 3).
 */
export async function startAtlassianLogin(
  store: Store,
): Promise<{ ok: true; authorizationUrl: string } | { ok: false; error: string }> {
  pendingLogin?.login.cancel();
  pendingLogin = undefined;
  lastLoginError = undefined;
  let login: McpOAuthLogin;
  try {
    login = await startMcpOAuthLogin({
      store,
      server: ATLASSIAN_MCP_SERVER_NAME,
      serverUrl: atlassianServerUrl ?? ATLASSIAN_MCP_URL,
      ...(atlassianFetch ? { fetch: atlassianFetch } : {}),
    });
  } catch (e) {
    lastLoginError = e instanceof Error ? e.message : String(e);
    return { ok: false, error: lastLoginError };
  }
  const mine: PendingLogin = { login, startedAt: Date.now() };
  pendingLogin = mine;
  void login.done.then((r) => {
    if (pendingLogin === mine) pendingLogin = undefined;
    if (!r.ok) {
      if (r.error !== 'cancelled') lastLoginError = r.error;
      return;
    }
    lastLoginError = undefined;
    if (!anyRunActive()) applyAtlassianAtTurnBoundary(store);
  });
  if (!login.authorizationUrl) {
    // Already authorized (cannot normally happen: the login drops old tokens).
    return { ok: true, authorizationUrl: '' };
  }
  return { ok: true, authorizationUrl: login.authorizationUrl };
}

export function cancelAtlassianLogin(): void {
  pendingLogin?.login.cancel();
  pendingLogin = undefined;
}

/** §4.4 step 3 at a turn boundary. Never throws. */
export function applyAtlassianAtTurnBoundary(store: Store): AtlassianMigrationReport | undefined {
  try {
    const report = applyAtlassianOAuthSwapIfDue(store);
    if (report) {
      console.log(
        `[atlassian] switched to OAuth (was ${report.from}); confluence-upload ${report.confluenceUpload}` +
          `, legacy tool refs ${report.legacyRefs.length}`,
      );
    }
    return report;
  } catch (e) {
    console.warn(`[atlassian] swap skipped: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/** What the Settings card shows about Atlassian. No token, no client secret. */
export type AtlassianView = {
  status: McpOAuthStatus;
  row: AtlassianRowShape;
  loginPending: boolean;
  lastLoginError?: string;
  /** epoch ms of the last browser sign-in. */
  loggedInAt?: number;
  migration?: AtlassianMigrationReport;
  /** Days until new sessions are blocked, while the gate is in its grace. */
  graceDaysLeft?: number;
  /** The gate is blocking new sessions now. */
  blocking: boolean;
};

export function readAtlassianView(store: Store, now = Date.now()): AtlassianView {
  const status = mcpOAuthStatus(store, ATLASSIAN_MCP_SERVER_NAME);
  const rec = readMcpOAuthRecord(store, ATLASSIAN_MCP_SERVER_NAME);
  const blockFrom = orgGateBlockFrom(store);
  const notReady = status !== 'connected';
  const migration = readAtlassianMigrationReport(store);
  return {
    status,
    row: atlassianRowShape(store),
    loginPending: pendingLogin !== undefined,
    ...(lastLoginError ? { lastLoginError } : {}),
    ...(rec?.loggedInAt !== undefined ? { loggedInAt: rec.loggedInAt } : {}),
    ...(migration ? { migration } : {}),
    ...(notReady && blockFrom !== undefined && now < blockFrom
      ? { graceDaysLeft: Math.max(1, Math.ceil((blockFrom - now) / DAY_MS)) }
      : {}),
    blocking: notReady && blockFrom !== undefined && now >= blockFrom,
  };
}

/** The org harness card's whole state: the runtime's, plus what M3 adds. */
export type OrgHarnessStateView = OrgHarnessState & {
  atlassian: AtlassianView;
  deps: OrgDepsState | null;
  /** Hooks in the current package naby does not run (§3.5). */
  unsupportedHooks: { event: string; script: string; why: string }[];
};

// -- what the HTTP actions call ----------------------------------------------

export function orgHarnessState(store: Store): OrgHarnessStateView {
  const ctx = orgHarnessContext(store);
  const base = readOrgHarnessState(store, ctx);
  let unsupportedHooks: OrgHarnessStateView['unsupportedHooks'] = [];
  try {
    const pkg = readCurrentOrgPackage(ctx.home);
    if (pkg) unsupportedHooks = unsupportedOrgHooks(readOrgHookConfig(pkg.dir));
  } catch {
    unsupportedHooks = [];
  }
  return {
    ...base,
    atlassian: readAtlassianView(store),
    deps: readOrgDeps(store) ?? null,
    unsupportedHooks,
  };
}

export function orgHarnessSetEnabled(store: Store, enabled: boolean): OrgHarnessStateView {
  setOrgHarnessEnabled(store, enabled, orgHarnessContext(store));
  // Turning it back on may need today's activation and a package check.
  if (enabled) kickOrgHarnessSync(store);
  return orgHarnessState(store);
}

export function orgHarnessUseOrgVersion(store: Store, name: string): OrgHarnessActionResult {
  return useOrgVersion(store, name, orgHarnessContext(store));
}

export function orgHarnessKeepUserCopy(store: Store, name: string): OrgHarnessActionResult {
  return keepUserCopy(store, name, orgHarnessContext(store));
}

/** Test-only: forget that the boot pass started. */
export function resetOrgHarnessBootForTests(): void {
  started = false;
  inflight = undefined;
  pendingLogin?.login.cancel();
  pendingLogin = undefined;
  lastLoginError = undefined;
}
