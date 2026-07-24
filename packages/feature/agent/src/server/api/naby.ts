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
  claudeLogin,
  claudeLogout,
  describeClaudeLoginAsync,
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
  CHATGPT_OAUTH_DEFAULT_MODEL,
  CHATGPT_OAUTH_LABEL,
  CHATGPT_OAUTH_PROVIDER_ID,
  getChatgptOauthBridge,
  getChatgptTokenSource,
  isChatgptOauthEnabled,
  type ClaudeLoginAccount,
  type McpEntry,
} from '../../../../../../../dist/naby-runtime.mjs';
import { getStore } from '../engines/naby';

// The store is opened on demand and the MCP test path spawns child processes,
// so this must run on the node runtime and must never be statically rendered.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Model switcher persistence (shell-side, no runtime-bundle change)
// ---------------------------------------------------------------------------
//
// The bottom-bar ModelSwitcher persists its pick under a per-engine SCOPE, using
// the generic setting store directly (the same escape hatch `gate.allowChanges`
// uses), so it never needs a new key in the runtime's typed `writeSettings`. The
// scope is 'dev-claude' for the Claude subscription and the ChatGPT provider id
// for the dev ChatGPT subscription — the only two engines with a per-turn model
// choice. A metered API-key provider's model is a profile setting, not a pick.

/** The engine scopes that expose a per-turn model pick. Mirrors modelCatalog.ts. */
const MODEL_SCOPES: readonly string[] = ['dev-claude', CHATGPT_OAUTH_PROVIDER_ID];

/** The setting key a scope's picked model lives under. */
function modelSettingKey(scope: string): string {
  return `model.selected:${scope}`;
}

/** Read every persisted model pick (absent scope = no pick). */
function readSelectedModels(store: { getSetting(k: string): string | undefined }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const scope of MODEL_SCOPES) {
    const v = store.getSetting(modelSettingKey(scope))?.trim();
    if (v) out[scope] = v;
  }
  return out;
}

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
// CO-06 — the DEV-ONLY ChatGPT subscription sign-in, over HTTP (not IPC)
// ---------------------------------------------------------------------------

/**
 * The ChatGPT sign-in status the GET reports, the exact HTTP MIRROR of what the
 * preload `window.naby.chatgptOauth.status()` bridge used to answer over IPC.
 *
 * WHY IT MOVED TO THE SERVER. The chat bottom bar renders inside the project
 * IFRAME, where `window.naby` does not exist — so the IPC-based chip could never
 * even read its status there and thus never appeared. This block lets the chip
 * read status the SAME way `claudeLogin` (above) does: a plain `/api/naby` fetch,
 * which works identically in the iframe. `available` is the dev seal; the rest is
 * read from the vault through the in-process account bridge the Electron main
 * process installs at boot (electron/boot.ts, `installChatgptOauthBridge`).
 *
 * NO TOKEN MATERIAL. `email`/`accountId` are identity LABELS from the JWT; the
 * access/refresh tokens never leave the main process.
 */
export type ChatgptLoginState = {
  /** The dev seal (`isChatgptOauthEnabled()`). False in every packaged build, so
   *  the chip renders nothing there. */
  available: boolean;
  signedIn: boolean;
  email: string | null;
  accountId: string | null;
};

async function readChatgptLogin(): Promise<ChatgptLoginState> {
  // Sealed out of official builds — same discipline as the dedicated sign-in
  // card and `describeProviders`. With the flag off there is nothing to sign in.
  if (!isChatgptOauthEnabled()) {
    return { available: false, signedIn: false, email: null, accountId: null };
  }
  // The vault lives in the main process; the account bridge is the in-process
  // seam it installs (boot.ts). Absent under a plain browser dev server / before
  // boot wired it — report available-but-signed-out rather than fail.
  const bridge = getChatgptOauthBridge();
  if (!bridge) return { available: true, signedIn: false, email: null, accountId: null };
  try {
    const s = await bridge.status();
    return { available: true, signedIn: s.signedIn, email: s.email, accountId: s.accountId };
  } catch {
    // A failed probe keeps the chip in a safe signed-out state; the send path
    // surfaces any real failure with a clearer message than a dot could.
    return { available: true, signedIn: false, email: null, accountId: null };
  }
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
   *  usable — the answer of `claude auth status`, run by the runtime against a
   *  de-shimmed `claude` binary. NOT A SECRET: the CLI reports identity LABELS
   *  (email, org name, plan) and a status word, never token material. */
  claudeLogin: {
    status: string;
    summary: string;
    remedy: string | null;
    cliFound: boolean;
    checkedAt: number;
    relevant: boolean;
    /** WHICH account is signed in. `email`/`orgName` are the REAL identity from
     *  `claude auth status` (the credential file has neither); `null` when signed
     *  out/unknown. Labels only, no secret material. */
    account: ClaudeLoginAccount | null;
  };
  /** CO-06 — the DEV-ONLY ChatGPT subscription sign-in, the HTTP mirror of the
   *  former preload bridge so the chat bottom-bar chip works inside the iframe.
   *  `available` is the dev seal; `signedIn`/`email` come from the vault via the
   *  in-process account bridge. Labels only, never token material. */
  chatgptLogin: ChatgptLoginState;
  /** The app-wide "Allow changes" gate policy (setting `gate.allowChanges`).
   *  `true` (the default when unset) = the agent may edit files / run commands;
   *  `false` = read-only observation. Not a secret. */
  gate: { allowChanges: boolean };
  /** Configured providers, for the selection UI. NO SECRETS: `ready` is the
   *  result of a credential resolution, never the credential. */
  providers: { id: string; label: string; model: string; ready: boolean }[];
  /** The bottom-bar ModelSwitcher's persisted pick per engine SCOPE ('dev-claude'
   *  for the Claude subscription, the ChatGPT provider id for the dev ChatGPT
   *  subscription). A scope is absent when the user has picked nothing (the
   *  engine's own default answers). A model slug is not a secret. */
  selectedModels: Record<string, string>;
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

  // CO-05 — the DEV-ONLY ChatGPT subscription provider is not a stored credential
  // profile (it authenticates by OAuth, not an API key), so it never comes back
  // from `listProfiles()` above. Surface it here so the selection UIs that read
  // this GET — the header EngineSwitcher and the chip's own label/engine-name
  // derivation — can see the provider that a signed-in owner has just chosen.
  //
  // SEAL-GATED: added only when the dev seal is open (`isChatgptOauthEnabled`).
  // With the seal closed — every official/packaged build — it is absent, exactly
  // like the dedicated sign-in card, so it never appears anywhere in a shipped
  // app. `ready` reflects that the vault-backed token SOURCE was installed at
  // boot (the mechanism exists); the header refines selectability against the
  // authoritative `chatgptOauth.status().signedIn` from the preload bridge, the
  // one place that knows whether the owner is actually signed in right now.
  if (isChatgptOauthEnabled()) {
    providers.push({
      id: CHATGPT_OAUTH_PROVIDER_ID,
      label: CHATGPT_OAUTH_LABEL,
      // The engine's default subscription model when the turn requests none.
      model: CHATGPT_OAUTH_DEFAULT_MODEL,
      ready: getChatgptTokenSource() != null,
    });
  }

  return {
    devEngineAvailable: isClaudeAgentSdkAvailable(),
    // Runs `claude auth status` (against a de-shimmed binary) and is cached 10s
    // in the runtime, so ordinary polls do not spawn a process — only a forced
    // re-check (a user action or the post-login poll) bypasses the cache.
    claudeLogin: await describeClaudeLoginAsync(opts.recheckLogin ? { force: true } : {}),
    // CO-06 — read from the vault through the in-process account bridge (the exact
    // sibling of claudeLogin's `claude auth status` read). Seal-gated inside.
    chatgptLogin: await readChatgptLogin(),
    // The gate policy is a single global setting. Default ON (allow) when unset —
    // the same default the engine applies, kept in one place here so the UI and
    // the engine can never disagree about what "unset" means.
    gate: { allowChanges: (store.getSetting('gate.allowChanges') ?? 'true') !== 'false' },
    // The bottom-bar model picks, one per engine scope. Persisted shell-side via
    // the generic setting store (the `gate.allowChanges` precedent) so it needs
    // no runtime-bundle change; read here for the two scopes that expose a
    // per-turn model choice — the Claude subscription and the dev ChatGPT one.
    selectedModels: readSelectedModels(store),
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
  // The bottom-bar ModelSwitcher's pick for one engine scope. `model` '' clears it.
  | { action: 'model.set'; providerId: string; model: string }
  | { action: 'claude.login'; email?: string; console?: boolean }
  | { action: 'claude.logout' }
  // CO-06 — the DEV-ONLY ChatGPT sign-in, mirroring `claude.login`/`claude.logout`.
  | { action: 'chatgpt-oauth.signin' }
  | { action: 'chatgpt-oauth.signout' }
  | { action: 'mcp.upsert'; entry: unknown }
  | { action: 'mcp.remove'; name: string }
  // Approve an agent-proposed MCP server (status:'proposed' -> 'enabled'). A
  // human-only action — the HITL step that lets a credential-bearing, agent-added
  // server actually run. Status-only: it re-reads the STORED entry (secrets
  // intact) so approval never needs the redacted UI to resend them.
  | { action: 'mcp.approve'; name: string }
  | { action: 'mcp.test'; name: string };

export type NabyActionResult =
  | {
      ok: true;
      message?: string;
      tools?: string[];
      allowChanges?: boolean;
      removed?: boolean;
      /** `claude.login`: the flow was launched — the UI must now poll status. */
      started?: boolean;
      /** `claude.login`: the exact command, as a copy-paste fallback for a
       *  headless machine where no browser can open. */
      command?: string;
      /** `chatgpt-oauth.signin`/`signout`: the fresh sign-in status once the flow
       *  resolves, so the chip updates without waiting for the next GET poll
       *  (mirrors the old preload bridge, which resolved with the new status). */
      chatgpt?: ChatgptLoginState;
    }
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

    case 'model.set': {
      // THE BOTTOM-BAR MODEL PICK for one engine scope. Stored under a per-scope
      // key so switching engines never carries a model onto an engine that lacks
      // it; the client also threads the pick into the turn payload, so this is the
      // durable copy that survives a reload. An unknown scope is rejected rather
      // than silently written — only the two engines with a per-turn choice.
      if (typeof body.providerId !== 'string' || !MODEL_SCOPES.includes(body.providerId)) {
        return { ok: false, error: `unknown model scope "${String(body.providerId)}"` };
      }
      if (typeof body.model !== 'string') {
        return { ok: false, error: 'model must be a string' };
      }
      // '' clears the pick (back to the engine default); the store keeps '' and
      // readSelectedModels trims it out, so an absent scope reads as "no pick".
      store.setSetting(modelSettingKey(body.providerId), body.model);
      return { ok: true };
    }

    case 'claude.login': {
      // Kick off the interactive browser OAuth by spawning `claude auth login`
      // (detached — the runtime does not block on the user). Returns promptly
      // with `started:true`; the UI then polls status (force re-check) until the
      // sign-in lands. `command` is the copy-paste fallback for a headless box.
      const result = claudeLogin({
        ...(typeof body.email === 'string' ? { email: body.email } : {}),
        ...(typeof body.console === 'boolean' ? { console: body.console } : {}),
      });
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, started: true, command: result.command };
    }

    case 'claude.logout': {
      // Sign out of the LOCAL Claude dev sign-in by running `claude auth logout`
      // (a clean CLI logout — the runtime resolves a de-shimmed binary and owns
      // the safety; see `claudeLogout`). No secret crosses this boundary. The
      // runtime resets its login cache, so the next GET (or the UI's explicit
      // re-check) reports signed-out immediately rather than a 10s-stale answer.
      const result = await claudeLogout();
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, removed: result.removed };
    }

    case 'chatgpt-oauth.signin': {
      // The HTTP mirror of `chatgpt-oauth:signin` (the old IPC channel). Runs the
      // browser PKCE flow on the main side through the in-process account bridge
      // and resolves with LABELS only once the token set is stored in the vault.
      // Seal-gated exactly like the Claude actions: refused when the flag is off.
      if (!isChatgptOauthEnabled()) {
        return { ok: false, error: 'ChatGPT subscription sign-in is a dev-only, flag-sealed feature.' };
      }
      const bridge = getChatgptOauthBridge();
      if (!bridge) {
        return { ok: false, error: 'ChatGPT subscription sign-in is not available in this build.' };
      }
      try {
        const s = await bridge.signIn();
        return {
          ok: true,
          chatgpt: { available: true, signedIn: s.signedIn, email: s.email, accountId: s.accountId },
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not sign in.' };
      }
    }

    case 'chatgpt-oauth.signout': {
      // Clear the stored token set (idempotent). No secret crosses this boundary.
      // With the seal closed there is nothing stored — report signed-out cleanly.
      if (!isChatgptOauthEnabled()) {
        return { ok: true, chatgpt: { available: false, signedIn: false, email: null, accountId: null } };
      }
      const bridge = getChatgptOauthBridge();
      if (bridge) {
        try {
          await bridge.signOut();
        } catch {
          // A failed clear leaves the vault as-is; the next GET corrects the chip.
        }
      }
      return { ok: true, chatgpt: { available: true, signedIn: false, email: null, accountId: null } };
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

    case 'mcp.approve': {
      // THE HITL STEP. Flip an agent-proposed server to active. Reads the stored
      // entry (secrets intact, server-side) and rewrites only its status, so the
      // redacted UI never has to round-trip the env/headers it cannot see. Reject
      // is just `mcp.remove`.
      if (typeof body.name !== 'string' || !body.name) {
        return { ok: false, error: 'name is required' };
      }
      const stored = store.listMcpEntries().find((e) => e.name === body.name);
      if (!stored) return { ok: false, error: `no MCP server named "${body.name}"` };
      store.upsertMcpEntry({ ...stored, status: 'enabled' });
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
