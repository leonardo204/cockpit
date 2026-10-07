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
  applyOrgHarnessIfDue,
  keepUserCopy,
  nabyHomeDir,
  pinOrgHarnessTurn,
  readOrgHarnessState,
  runOrgHarnessSync,
  setOrgHarnessEnabled,
  useOrgVersion,
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
 * session start"). Codes, not sentences: the server has no locale, and the client
 * renders them (`client/harnessPill.ts`). Empty when there is nothing to say —
 * which, with no skill-hub key, is always.
 */
export function orgHarnessSessionStartNotices(store: Store): string[] {
  let state: OrgHarnessState;
  try {
    state = orgHarnessState(store);
  } catch {
    return [];
  }
  const out: string[] = [];
  if (state.configured && state.auth === 'unauthorized') out.push('unauthorized');
  if (state.on) {
    for (const n of state.copyNotices) out.push(`copy-notice:${n.name}:${n.copy}`);
  }
  return out;
}

// -- what the HTTP actions call ----------------------------------------------

export function orgHarnessState(store: Store): OrgHarnessState {
  return readOrgHarnessState(store, orgHarnessContext(store));
}

export function orgHarnessSetEnabled(store: Store, enabled: boolean): OrgHarnessState {
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
}
