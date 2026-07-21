/**
 * `/api/naby` — the runtime's own configuration + reporting surface.
 *
 * WHY AN HTTP ROUTE AND NOT MORE IPC
 * ----------------------------------
 * F1-04 put credentials on the Electron IPC bridge, and that was right: a key is
 * a secret, `safeStorage` lives in the main process, and the renderer must never
 * have a read path to it.
 *
 * NOTHING HERE IS A SECRET. Per-session token counts (F1-07) and the MCP
 * registry (F1-08) are ordinary application data owned by the RUNTIME, and the
 * runtime lives in this Next server, not in main. Routing them through IPC would
 * mean main proxying calls into a store it does not own, and would widen the
 * preload bridge — the one surface F1-04's design says to keep as narrow as
 * possible — for data that has no reason to be privileged.
 *
 * So the split is by SENSITIVITY, not by convenience:
 *   window.naby.credentials / providers  →  IPC, main, secrets
 *   /api/naby                            →  HTTP, this server, no secrets
 *
 * NO KEY MATERIAL CROSSES THIS FILE. `readNabyState` reports which provider is
 * selected and whether a credential RESOLVES; it never reads, returns, or logs
 * the credential itself. MCP entries can carry `env`/`headers` that a user may
 * have put a token in, so those two fields are REDACTED on the way out (see
 * `redactEntry`) — the UI shows that a header exists and its name, never its
 * value.
 */

import { Effect } from 'effect';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import {
  claudeLogout,
  describeClaudeLogin,
  getCredentialBridge,
  isClaudeAgentSdkAvailable,
  loadMcpToolset,
  readSettings,
  resolveProviderCredential,
  selectEngine,
  summarizeSessionUsage,
  toSelectOptions,
  validateMcpEntry,
  writeSettings,
  type ClaudeLoginAccount,
  type McpEntry,
} from '../../../../../../../dist/naby-runtime.mjs';
import { getStore } from '../engines/naby';

// The store is opened on demand and the MCP test path spawns child processes,
// so this must run on the node runtime and must never be statically rendered.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * An MCP entry as it is safe to hand the renderer.
 *
 * `env` (stdio) and `headers` (http/sse) are exactly where a user puts an API
 * token for the MCP server, so their VALUES never leave this process. The KEYS
 * are kept, because "which headers are set" is what the user needs to see to
 * confirm they configured the thing correctly, and a key name is not a secret.
 */
type RedactedMcpEntry = Omit<McpEntry, 'env' | 'headers'> & {
  envKeys?: string[];
  headerKeys?: string[];
};

function redactEntry(entry: McpEntry): RedactedMcpEntry {
  if (entry.transport === 'stdio') {
    const { env, ...rest } = entry;
    return env && Object.keys(env).length > 0 ? { ...rest, envKeys: Object.keys(env) } : rest;
  }
  const { headers, ...rest } = entry;
  return headers && Object.keys(headers).length > 0
    ? { ...rest, headerKeys: Object.keys(headers) }
    : rest;
}

// ---------------------------------------------------------------------------
// GET — what is answering, what it has cost, what MCP servers exist
// ---------------------------------------------------------------------------

export async function readNabyState(
  sessionId: string | null,
  /** Bypass the runtime's 10s login-status cache. Set by an explicit user
   *  "Re-check" only — a user who has just run `claude login` in a terminal must
   *  not be shown a stale answer, but ordinary polls must not defeat the cache
   *  that keeps this off the filesystem. */
  opts: { recheckLogin?: boolean } = {},
): Promise<{
  engine: {
    ok: boolean;
    /** 'dev-claude' | 'ai-sdk' when ok. */
    id?: string;
    /** 'metered' | 'subscription' when ok. */
    costBasis?: string;
    /** The sentence explaining which engine answers, or why none can. */
    summary: string;
  };
  settings: { enginePreference?: string; selectedProvider?: string };
  /** Whether the dev engine exists in THIS build. The UI must not offer a
   *  choice that cannot work — in a packaged app the Agent SDK is excluded. */
  devEngineAvailable: boolean;
  /** Whether the LOCAL Claude sign-in the dev engine runs on is present and
   *  usable. NOT A SECRET and not derived from one: the runtime reads two
   *  expiry timestamps and returns a status word plus a sentence — no token
   *  material reaches this process boundary, let alone the renderer. */
  claudeLogin: {
    status: string;
    summary: string;
    remedy: string | null;
    cliFound: boolean;
    checkedAt: number;
    relevant: boolean;
    /** WHICH account is signed in, to the extent the credential file says so.
     *  `null` when signed out/unknown or when the file carries no identity —
     *  NEVER an email, because the OAuth file has none (see ClaudeLoginAccount).
     *  No secret material: these are subscription/tier LABELS only. */
    account: ClaudeLoginAccount | null;
  };
  /** The app-wide "Allow changes" gate policy (setting `gate.allowChanges`).
   *  `true` (the default when unset) = the agent may edit files / run commands;
   *  `false` = read-only observation. Not a secret. */
  gate: { allowChanges: boolean };
  /** Configured providers, for the selection UI. NO SECRETS: `ready` is the
   *  result of a credential resolution, never the credential. */
  providers: { id: string; label: string; model: string; ready: boolean }[];
  usage: ReturnType<typeof summarizeSessionUsage> | null;
  mcp: RedactedMcpEntry[];
}> {
  const store = getStore();
  const settings = readSettings(store);
  const selection = await selectEngine(toSelectOptions(settings));

  // Profiles come from the credential bridge the Electron main process installs
  // (F1-04). It is absent under the plain CLI / browser dev server, which is not
  // an error — there is simply nothing to choose between, and the UI says so.
  const bridge = getCredentialBridge();
  const profiles = bridge ? await bridge.listProfiles() : [];
  const providers = await Promise.all(
    profiles.map(async (p) => {
      // `ready` asks "would a turn on this provider start" by running the SAME
      // resolution a turn runs. It returns a boolean; the key it looked at
      // never leaves resolveProviderCredential.
      const resolution = await resolveProviderCredential({ providerId: p.id });
      return { id: p.id, label: p.label, model: p.model, ready: resolution.ok };
    }),
  );

  return {
    devEngineAvailable: isClaudeAgentSdkAvailable(),
    // Synchronous and cached in the runtime, so this adds nothing measurable to
    // a request that already opened the store and resolved a credential.
    claudeLogin: describeClaudeLogin(opts.recheckLogin ? { force: true } : {}),
    // The gate policy is a single global setting. Default ON (allow) when unset —
    // the same default the engine applies, kept in one place here so the UI and
    // the engine can never disagree about what "unset" means.
    gate: { allowChanges: (store.getSetting('gate.allowChanges') ?? 'true') !== 'false' },
    providers,
    engine: selection.ok
      ? {
          ok: true,
          id: selection.engine,
          costBasis: selection.costBasis,
          summary: selection.summary,
        }
      : { ok: false, summary: selection.message },
    settings,
    // No session yet (a brand-new tab) is not an error — it is "nothing has
    // been spent", which the UI renders as an empty state rather than a crash.
    usage: sessionId ? summarizeSessionUsage(store, sessionId) : null,
    mcp: store.listMcpEntries().map(redactEntry),
  };
}

// ---------------------------------------------------------------------------
// POST — the mutations (F1-08 CRUD + provider selection)
// ---------------------------------------------------------------------------

export type NabyAction =
  | { action: 'settings.set'; enginePreference?: string; selectedProvider?: string }
  | { action: 'gate.set'; allowChanges: boolean }
  | { action: 'claude.logout' }
  | { action: 'mcp.upsert'; entry: unknown }
  | { action: 'mcp.remove'; name: string }
  | { action: 'mcp.test'; name: string };

export type NabyActionResult =
  | { ok: true; message?: string; tools?: string[]; allowChanges?: boolean; removed?: boolean }
  | { ok: false; error: string };

export async function runNabyAction(body: NabyAction): Promise<NabyActionResult> {
  const store = getStore();

  switch (body.action) {
    case 'settings.set': {
      // An empty string is a deliberate CLEAR (back to automatic) — see
      // runtime/settings.ts — so it is passed through rather than filtered out.
      writeSettings(store, {
        ...(body.enginePreference !== undefined
          ? { enginePreference: body.enginePreference }
          : {}),
        ...(body.selectedProvider !== undefined
          ? { selectedProvider: body.selectedProvider }
          : {}),
      });
      return { ok: true };
    }

    case 'gate.set': {
      // THE "ALLOW CHANGES" TOGGLE. Stored as a string ('true'/'false') because
      // that is the store's setting shape and exactly what the engine reads per
      // turn (`getSetting('gate.allowChanges')`). One writer, one reader, one
      // encoding — so a flip here takes effect on the very next message.
      if (typeof body.allowChanges !== 'boolean') {
        return { ok: false, error: 'allowChanges must be a boolean' };
      }
      store.setSetting('gate.allowChanges', body.allowChanges ? 'true' : 'false');
      return { ok: true, allowChanges: body.allowChanges };
    }

    case 'claude.logout': {
      // Sign out of the LOCAL Claude dev sign-in by removing its OAuth
      // credential file (the runtime owns the path and the safety — see
      // `claudeLogout`). No secret crosses this boundary: the file is deleted,
      // never read. The runtime resets its login cache, so the next GET (or the
      // UI's explicit re-check) reports signed-out immediately rather than a
      // 10s-stale "signed in".
      const result = claudeLogout();
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, removed: result.removed };
    }

    case 'mcp.upsert': {
      const problems = validateMcpEntry(body.entry);
      if (problems.length > 0) return { ok: false, error: problems.join('; ') };
      store.upsertMcpEntry(body.entry as McpEntry);
      return { ok: true };
    }

    case 'mcp.remove': {
      if (typeof body.name !== 'string' || !body.name) {
        return { ok: false, error: 'name is required' };
      }
      store.removeMcpEntry(body.name);
      return { ok: true };
    }

    case 'mcp.test': {
      // "Does this server actually work" answered by CONNECTING to it and
      // listing its tools — the same code path a real turn uses, so a green
      // result here means the same thing a turn would find. It deliberately
      // does not CALL anything: connecting is safe, invoking is not.
      const entry = store.listMcpEntries().find((e) => e.name === body.name);
      if (!entry) return { ok: false, error: `no MCP server named "${body.name}"` };
      const load = await loadMcpToolset([entry]);
      try {
        const failure = load.failures[0];
        if (failure) return { ok: false, error: failure.message };
        return {
          ok: true,
          message: `Connected. ${load.toolSchemas.length} tool(s) available, each of which will go through the approval gate.`,
          tools: load.toolSchemas.map((t) => t.name),
        };
      } finally {
        await load.closeAll();
      }
    }

    default:
      return { ok: false, error: 'unknown action' };
  }
}

// ---------------------------------------------------------------------------
// Next.js mount points
// ---------------------------------------------------------------------------

export const GET = handler((request) =>
  Effect.gen(function* () {
    const params = new URL(request.url).searchParams;
    const sessionId = params.get('sessionId');
    const state = yield* Effect.promise(() =>
      readNabyState(sessionId, { recheckLogin: params.get('recheckLogin') === '1' }),
    );
    return ok(state);
  })
);

export const POST = handler((request) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(request)) as NabyAction;
    const result = yield* Effect.promise(() => runNabyAction(body));
    if (!result.ok) {
      return new Response(JSON.stringify({ error: result.error }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return ok(result);
  })
);
