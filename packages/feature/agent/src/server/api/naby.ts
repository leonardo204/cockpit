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
  addClaudeAccount,
  applyBuiltinHarnessActivation,
  claudeLoginForAccount,
  claudeLogoutForAccount,
  describeClaudeAccounts,
  describeClaudeLoginForAccount,
  logActivity,
  removeClaudeAccount,
  resetClaudeLoginCache,
  setActiveClaudeAccount,
  verifyClaudeAccount,
  activeClaudeAccountId,
  isClaudeAccountId,
  listClaudeAccounts,
  type ClaudeAccountsDescription,
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
  DEFAULT_USER_ID,
  BUILTIN_PERSONA_ID,
  parseAgentSidecar,
  probeClaudeModels,
  listGoogleModels,
  type ClaudeModelInfo,
  BOOTSTRAP_DONE_KEY,
  BOOTSTRAP_QUESTIONS,
  answersToMemory,
  parseStyleFingerprint,
  readLearningEnabled,
  STYLE_FINGERPRINT_KEY,
  STYLE_FINGERPRINT_MIN_SAMPLES,
  type StyleFingerprint,
  shouldOfferBootstrap,
  writeLearningEnabled,
  CLAUDE_CLI_MISSING_HEADLINE,
  type ClaudeInstallHelp,
  type ClaudeLoginAccount,
  type McpEntry,
  type HarnessScope,
  type PolicyEffect,
  type PolicyRule,
  type Agent,
  type AgentInput,
  type AgentKind,
  type AgentEscalation,
  type MemoryScope,
} from '../../../../../../../dist/naby-runtime.mjs';
import { getStore } from '../engines/naby';
// "Is anything running anywhere" — the one question the account switch has to ask
// before it may change which subscription answers (claude-multi-account §5.4).
import { anyRunActive } from '../sessionRunHub';
import { resolveApproval } from '../lib/approvalRegistry';
import { resolveCheckin } from '../lib/checkinRegistry';
import { growthReport, type GrowthReport } from '../lib/growthRead';
import { safeLearningReport, type LearningReport } from '../lib/learningRead';
import {
  modelReflectionJudge,
  runReflectionSweep,
  type ReflectionSweepResult,
} from '../lib/reflection';
import { exportAgent } from '../lib/agentExport';
import { applyAgentImport } from '../lib/agentImport';
import type {
  AgentExportResult,
  AgentImportPlan,
  AgentImportReport,
} from '../../../../../../../dist/naby-runtime.mjs';
import { AUTONOMY_STEP_CAP, resolveMaxSteps } from '../lib/autonomy';
import {
  readPersonaAutonomy,
  writePersonaAutonomy,
  type PersonaAutonomy,
} from '../lib/personaAutonomy';
import {
  readTelegramConfig,
  writeTelegramConfig,
  redactToken,
  isTelegramReady,
  sendTelegramMessage,
  detectChatId,
  type TelegramConfig,
} from '../lib/telegram';
import {
  ensureListener,
  pauseTelegramListener,
  registerTelegramCommands,
  resetBotCommandRegistration,
  resumeTelegramListener,
  stopTelegramListener,
} from '../lib/telegramEscalation';
import {
  findSystemMcpPreset,
  mergeSystemMcpFields,
  readPresetUrl,
  readSystemMcpStatus,
  type SystemMcpStatus,
} from '../lib/systemMcp';
import { resolveCommandPath } from '../lib/commandPath';
// The key a user-supplied session rename lives under. IMPORTED rather than
// respelled here: it is what the recent-session list reads and what the v1.6.0
// rename writes, and a second copy of the string would be a second source of
// truth for what a session is called — the exact failure `recentSessions` was
// written to end.
import { customTitleKey } from '../state/recentSessions';
// The opening turn of a fast-growth session (§3.3b). It loads the engine lazily
// inside itself, so importing it here costs this route nothing at request time.
import { startFastGrowthKickoff } from '../lib/fastGrowthKickoff';
import { continueSessionInNewTab } from '../lib/sessionHandoff';
import { modelHandoffSummarizer } from '../lib/handoffSummary';
// The chat link's rebind (session-context-management §2.2). Pure over the store —
// no poll loop, no network — so importing it here costs nothing.
import { repointLink } from '../lib/telegramChat';

/** How much of a client-supplied session title is kept. A name is a row in a
 *  list, not a description; anything past this is a paragraph in a sidebar. */
const FAST_GROWTH_TITLE_MAX = 60;

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
// scope is 'dev-claude' for the Claude subscription, the ChatGPT provider id for
// the dev ChatGPT subscription, and the Google provider id for Gemini.
//
// WHAT A SCOPE MEANS, unchanged by the Google addition: the pick is stored under
// `model.selected:<scope>` in the settings table, which is APP-WIDE and NOT
// per-session — there is no session id anywhere in the key. Every session
// running on that engine gets the same model until the user picks another. The
// client also threads the pick into each turn's payload; this is the durable
// copy that survives a reload.
//
// WHY GOOGLE JOINS THEM AND THE OTHER METERED PROVIDERS DO NOT. The rule was
// "a metered provider's model is a profile setting, not a per-turn pick", and
// it holds wherever a key means ONE model. A Google key opens the whole Gemini
// catalogue at once (`models.list` provider:'google' enumerates it), so "which
// model" is a live choice there in exactly the way it is for a subscription —
// while an Azure key addresses one deployment and Anthropic/OpenAI profiles
// name the one model the user configured.

/** The engine scopes that expose a per-turn model pick. Mirrors modelCatalog.ts. */
const GOOGLE_PROVIDER_ID = 'google';
const MODEL_SCOPES: readonly string[] = [
  'dev-claude',
  CHATGPT_OAUTH_PROVIDER_ID,
  GOOGLE_PROVIDER_ID,
];

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
// "Does this server actually work" — ONE implementation
// ---------------------------------------------------------------------------

/**
 * Connect one configured MCP server and list its tools, then close.
 *
 * The same code path a real turn takes (`loadMcpToolset`), so a green answer here
 * means what a turn would find. It deliberately does not CALL anything:
 * connecting is safe, invoking is the thing the gate exists to mediate.
 *
 * Both `mcp.test` and `systemMcp.test` go through this. A second copy for the
 * presets would be a second thing to keep in step with the loader — and the two
 * would drift on exactly the day the connect semantics changed.
 */
type McpProbeResult =
  | { ok: true; toolCount: number; toolNames: string[] }
  | { ok: false; error: string };

async function probeMcpServer(
  store: { listMcpEntries(): McpEntry[] },
  name: string,
): Promise<McpProbeResult> {
  const entry = store.listMcpEntries().find((e) => e.name === name);
  if (!entry) return { ok: false, error: `no MCP server named "${name}"` };
  const load = await loadMcpToolset([entry]);
  try {
    const failure = load.failures[0];
    if (failure) return { ok: false, error: failure.message };
    return {
      ok: true,
      toolCount: load.toolSchemas.length,
      toolNames: load.toolSchemas.map((t) => t.name),
    };
  } finally {
    await load.closeAll();
  }
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
    /** HOW TO INSTALL Claude Code on THIS machine, present only when no `claude`
     *  executable was found (`cliFound:false`). The runtime computes it from the
     *  official setup page so the settings UI can render a link and copy buttons
     *  rather than telling the user to "install it" and stopping there. Nothing
     *  here is machine-specific beyond the platform: a docs URL and commands. */
    installHelp: ClaudeInstallHelp | null;
  };
  /** MORE THAN ONE CLAUDE SUBSCRIPTION (claude-multi-account §5): the accounts
   *  naby keeps, which one answers turns, and whether this computer can keep them
   *  apart at all. IDS AND LABELS ONLY — the config directory each account lives
   *  in never crosses this boundary (§5.6), because a path that reaches a client
   *  is a path some later endpoint accepts back. Read from the store; no process
   *  is spawned on this path. */
  claudeAccounts: ClaudeAccountsDescription;
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
  /** The BUILT-IN presets' connection state, keyed by preset name
   *  (skill-hub-builtin §2.2). Their entries are also present in `mcp` above —
   *  this is the same row read through the one function that answers "is this
   *  connected", so the dedicated System MCP rows and the general list can never
   *  disagree. Nothing here can carry a secret: the shape is a boolean, a status
   *  word, and the values of the fields explicitly marked non-secret. */
  systemMcp: Record<string, SystemMcpStatus>;
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
    // ABOUT THE ACCOUNT THAT ACTUALLY ANSWERS. With a second Claude account
    // selected, reading the machine's default sign-in here would put one identity
    // in the chip while the turns spent another — the exact disagreement §5.4
    // refuses a mid-turn switch to prevent. The id goes in, the runtime resolves
    // the namespace; with no account selected this is the original call.
    claudeLogin: await describeClaudeLoginForAccount(
      activeClaudeAccountId(store),
      opts.recheckLogin ? { force: true } : {},
    ),
    // The account list is a settings read, so it rides along with every poll at
    // no cost. The identity of each row is refreshed only when the user (or the
    // post-login poll) asks — `claude-account.verify` — because refreshing three
    // accounts on every GET would be three processes per poll.
    claudeAccounts: describeClaudeAccounts(store),
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
    systemMcp: readSystemMcpStatus(store),
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
  // MORE THAN ONE CLAUDE SUBSCRIPTION (claude-multi-account §5), shaped after the
  // two actions above because they are the same operations with one difference:
  // WHICH namespace the CLI is pointed at. Every one of them takes an opaque
  // account id and never a path (§5.6).
  //
  //   add     make a namespace, prove the machine keeps namespaces apart, then
  //           start the browser sign-in in it. Does not wait for the user.
  //   verify  ask `claude auth status` in one account's namespace and store what
  //           it says. Also the post-add poll.
  //   select  which account answers turns. GLOBAL, not per session (§5.5), and
  //           REFUSED while any turn is in flight (§5.4).
  //   remove  logout in that namespace FIRST, then delete it.
  | { action: 'claude-account.add'; email?: string; console?: boolean }
  | { action: 'claude-account.verify'; accountId: string }
  | { action: 'claude-account.select'; accountId: string }
  | { action: 'claude-account.remove'; accountId: string }
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
  | { action: 'mcp.test'; name: string }
  // The BUILT-IN System MCP presets (skill-hub-builtin §2.2). SECRETS ONLY EVER
  // TRAVEL INWARDS: `set` takes the typed values and the SERVER assembles the
  // whole entry from the registry (transport, url/command, header and env names),
  // so the client never has to know — or echo back — anything but what the user
  // typed. Every response is a redacted status; no reply on this route contains a
  // secret field's value.
  //
  // `preset` is a registry name ('skill-hub', 'atlassian'), and `fields` is keyed
  // by the preset's own field ids. A blank value on a configured preset means
  // "keep the stored one" — the merge happens server-side, where the stored
  // secret actually is.
  | { action: 'systemMcp.set'; preset: string; fields?: Record<string, string> }
  | { action: 'systemMcp.test'; preset: string }
  | { action: 'systemMcp.remove'; preset: string }
  // Phase 2 (M1) tool-execution policy rules. `scopeKey` is optional for the
  // user scope (server-defaulted); required (a cwd) for project.
  | { action: 'policy.list'; scope?: string; scopeKey?: string }
  | { action: 'policy.put'; scope?: string; scopeKey?: string; toolPattern: string; effect: string }
  | { action: 'policy.remove'; id: string }
  // Phase 2 (M2) — resolve a pending tool-approval prompt, settling the paused
  // turn. `remember` persists a matching policy rule so future calls skip the
  // prompt (scope/scopeKey/toolPattern describe the rule to write).
  | {
      action: 'approval.resolve';
      approvalId: string;
      decision: string;
      remember?: boolean;
      scope?: string;
      scopeKey?: string;
      toolPattern?: string;
    }
  // Phase 3 (P3-M1) — the naby agent layer (built-in persona + custom agents),
  // addressed by `@`. `agent.put` upserts (omit `id` to create a custom agent,
  // supply one to edit); the built-in persona is editable but never deletable.
  | { action: 'agent.list' }
  | {
      action: 'agent.put';
      id?: string;
      name: string;
      kind?: string;
      description?: string;
      systemPrompt: string;
      model?: string;
      toolRefs?: string[];
      memoryScope?: string;
      escalation?: string;
      maxSteps?: number;
    }
  | { action: 'agent.remove'; id: string }
  // Phase 3 (P3-M9, G1) — HOW MUCH THE USER DELEGATES TO THE BUILT-IN PERSONA.
  // Not `agent.put` and deliberately not on the agent row: the persona is
  // read-only, and this is the user's setting about the delegation rather than a
  // property of the agent's identity (see lib/personaAutonomy.ts). `set` takes
  // either field on its own, clamps `maxSteps`, and answers with what was kept.
  | { action: 'personaAutonomy.get' }
  | { action: 'personaAutonomy.set'; escalation?: string; maxSteps?: number }
  // Phase 3 (P3-M3) — the Telegram escalation channel config. `get` returns the
  // config with the token REDACTED; `set` persists (a token '' is left unchanged
  // so the redacted UI never wipes it); `test` sends a live message.
  | { action: 'telegram.get' }
  | {
      action: 'telegram.set';
      enabled?: boolean;
      botToken?: string;
      chatId?: string;
      /** telegram-chat §8.1 — unknown values leave the stored mode untouched. */
      syncMode?: 'manual' | 'always';
    }
  | { action: 'telegram.test' }
  // Auto-detect the chat id from the naby bot's latest message (the user messages
  // their dedicated naby bot once, then this fills the chat id in).
  | { action: 'telegram.detectChat' }
  // Phase 3 (P3-M5) — the butterfly trust meter. `growth.get` is the reading the
  // Settings panel renders (stage, gauge, the axes, the regression reason and the
  // per-task-type breakdown); `checkin.resolve` settles a paused check-in the way
  // `approval.resolve` settles a paused tool approval.
  // `cwd` (P3-M8c) only widens the LEARNING block, which counts project-scope
  // memory when the panel is open on a project. The trust reading is per agent
  // and ignores it — growth must not depend on which folder is open.
  | { action: 'growth.get'; agentId?: string; cwd?: string }
  // Phase 3 (P3-M8a/M8b) — run the session-reflection sweep on demand. Normally a
  // turn kicks it fire-and-forget; this is the manual/test entry point (spec
  // §4.3). `excludeSessionId` skips a session that is still live. The result
  // carries both halves: ledger marks and memory proposals/promotions.
  | { action: 'reflection.run'; excludeSessionId?: string }
  // Phase 3 (P3-M6) — package a grown agent for another environment. READ-ONLY:
  // it returns the two files' contents and a report of what was dropped, and
  // writes nothing. The user sees the report and decides whether to save.
  | { action: 'agent.export'; agentId: string; cwd?: string }
  // Phase 3 (P3-M7) — bring an agent in. TWO PHASES: without `apply` it only
  // parses and reports (writes nothing), so the user sees what a foreign file
  // carries before it lands. `trustLedger` is their answer to "is this your own
  // export?" — the only thing that lets the imported growth record count.
  | { action: 'agent.import'; sidecar: string; apply?: boolean; trustLedger?: boolean }
  // Phase 1.5 (P15-07) — the cold-start interview. `bootstrap.get` says whether to
  // offer it and what to ask; `bootstrap.save` writes the answers as CONFIRMED
  // user-tier memory (the user typed them, which is what that tier means).
  // `dismiss` closes it for good without storing anything.
  // WHICH MODELS THIS ACCOUNT ACTUALLY HAS. The chat bar's list used to be a
  // constant, so it went stale the day a new model shipped and naby had to be
  // rebuilt to name one. `models.list` returns the cached answer (and probes when
  // the cache is empty or old); `refresh: true` always probes.
  //
  // `provider` picks the catalogue, and defaults to Claude so every existing
  // caller keeps its meaning:
  //   absent / 'claude'  the local sign-in, asked through the Agent SDK — what
  //                      THIS plan is entitled to, which is strictly better than
  //                      any list we could maintain.
  //   'google'           the Gemini catalogue, asked over HTTP with the stored
  //                      key. THE KEY IS READ SERVER-SIDE and never returned;
  //                      the answer is a list of model ids.
  | { action: 'models.list'; refresh?: boolean; provider?: string }
  | { action: 'bootstrap.get' }
  | { action: 'bootstrap.save'; answers?: Record<string, string>; dismiss?: boolean }
  | { action: 'checkin.resolve'; checkinId: string; chosen: number; correction?: string }
  // -- P3-M10 (memory-hygiene §3) — the two sovereignty switches -------------
  //
  // The app-wide "learn from my conversations" setting. It rides /api/naby
  // rather than /api/memory because it is a SETTING, like `gate.allowChanges`,
  // and because /api/memory is the review surface for memory ROWS — a switch
  // that decides whether rows are ever written is a different kind of thing.
  | { action: 'learning.get' }
  | { action: 'learning.set'; enabled: boolean }
  // P3-M13c (§3.3): READ-ONLY. The style fingerprint is counted from the user's
  // own messages by the reflection sweep and has no setter at all — there is
  // nothing here for a person to configure, only something for them to SEE. It
  // rides /api/naby rather than /api/memory for the same reason the learning
  // switch does: it is a setting, and /api/memory is the surface for memory ROWS.
  | { action: 'style.get' }
  // The per-session temporary flag, toggled from the tab context menu. `list`
  // exists so the tab bar can mark every affected tab from ONE request rather
  // than asking per tab as tabs open.
  | { action: 'session.noLearn.list' }
  | { action: 'session.noLearn.set'; sessionId: string; noLearn: boolean }
  // -- P3-M12b (fast-evolution §3.3) — the fast-growth session ---------------
  //
  // `create` is what the growth panel's button calls: it mints a session that is
  // ALREADY marked, so the flag is never absent for the session's first turn (a
  // create-then-toggle round trip would leave a window in which the opening
  // check-in was scored as real work). `set` exists for the same reason
  // `session.noLearn.set` does — a session that already exists can be marked.
  //
  // NOTHING THE MODEL CAN REACH. Both are HTTP actions the UI calls on a click;
  // no tool exposes them. That is the invariant the drill discount rests on
  // (checkin-contracts §4, invariant 9).
  | { action: 'session.fastGrowth.create'; cwd?: string; title?: string; kickoff?: string }
  | { action: 'session.fastGrowth.set'; sessionId: string; fastGrowth: boolean }
  // -- session-context-management §2.2 — continue in a new tab ---------------
  //
  // The window filled up. This compresses the conversation into a handoff, mints
  // a session carrying it, and answers with its id so the client can open a tab
  // there (the same OpenProject path the fast-growth session uses).
  //
  // IT NEVER FAILS FOR WANT OF A SUMMARY. A machine with no engine configured
  // gets a new session with no handoff — the empty new tab it would have had
  // anyway — rather than a refusal to continue.
  | { action: 'session.continueInNewTab'; sessionId: string; cwd?: string; title?: string };

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
      /** `claude-account.*`: the account block as it now stands, so the settings
       *  screen redraws from the reply instead of racing its own next GET. Same
       *  shape as the GET's block — ids and labels, never a path. */
      claudeAccounts?: ClaudeAccountsDescription;
      /** `claude-account.add`: the id of the account that was just created. The
       *  UI polls `claude-account.verify` with it until the browser flow lands. */
      accountId?: string;
      /** `claude-account.remove`: whether `claude auth logout` succeeded in that
       *  namespace before the folder was deleted. The removal is a success either
       *  way; this is what lets the UI say so honestly. */
      loggedOut?: boolean;
      /** `chatgpt-oauth.signin`/`signout`: the fresh sign-in status once the flow
       *  resolves, so the chip updates without waiting for the next GET poll
       *  (mirrors the old preload bridge, which resolved with the new status). */
      chatgpt?: ChatgptLoginState;
      /** `systemMcp.*`: every preset's connection state after the operation — the
       *  ONLY thing these actions ever answer with. Booleans, status words and
       *  the non-secret field values; no URL, no header name, never a secret.
       *  The WHOLE map rather than the one preset that changed, so a UI showing
       *  several rows refreshes them all from one reply. */
      systemMcp?: Record<string, SystemMcpStatus>;
      /** `systemMcp.test`: how many tools the server offered on connect. The
       *  number is the whole point of the test — "connected" without it does not
       *  tell the user whether their credentials reach a populated server. */
      toolCount?: number;
      /** `systemMcp.test`: the namespaced tool names, for the curious. */
      toolNames?: string[];
      /** `policy.*`: the scope's rules after the operation. */
      rules?: PolicyRule[];
      /** `approval.resolve`: whether a pending prompt was actually settled (false
       *  if it had already timed out / the turn was gone). */
      resolved?: boolean;
      /** `agent.*`: the full agent list after the operation (persona first). */
      agents?: Agent[];
      /** `agent.put`: the agent that was created/updated. */
      agent?: Agent;
      /** `personaAutonomy.get`/`set`: the persona delegation settings as they now
       *  stand — already clamped, so the UI renders the effective values rather
       *  than the ones it asked for. */
      personaAutonomy?: PersonaAutonomy;
      /** The ceiling `maxSteps` is clamped to, shipped with the settings so the UI
       *  states the limit instead of letting the user discover it. */
      autonomyStepCap?: number;
      /** `telegram.get`: current config with the token REDACTED (never the secret). */
      telegram?: {
        enabled: boolean;
        botTokenRedacted: string;
        chatId: string;
        /** telegram-chat §8: `manual` (escalations only) or `always` (mirror every turn). */
        syncMode: 'manual' | 'always';
        ready: boolean;
      };
      /** `telegram.detectChat`: the chat id discovered from the bot's latest message. */
      chatId?: string;
      /** `growth.get`: the full trust-meter reading for one agent. */
      growth?: GrowthReport;
      /** `growth.get` (P3-M8c): what the agent has LEARNED — counts of confirmed
       *  and pending facts, corroboration, kinds of work seen, last reflection.
       *  A SEPARATE field from `growth` on purpose: none of it enters the
       *  butterfly gate (continuous-learning §6.3), and keeping it out of
       *  `GrowthReport` is what stops it drifting into the meter. */
      learning?: LearningReport;
      /** `reflection.run`: what the sweep did — sessions read, ledger rows marked
       *  `correctedAfter`, verdicts the validator threw out, and (P3-M8b) memory
       *  rows proposed, candidates refused, and proposals the consolidation step
       *  auto-confirmed. */
      reflection?: ReflectionSweepResult;
      /** `learning.get`/`set` (P3-M10): whether new memory may be captured at all.
       *  Injection is unaffected either way — see memory-hygiene §3. */
      learningEnabled?: boolean;
      /** `style.get` (P3-M13c): the counted writing profile, or null when there
       *  is not one yet. */
      style?: StyleFingerprint | null;
      /** How many user messages a fingerprint needs before it shapes a turn —
       *  sent rather than duplicated client-side, for the same reason
       *  `corroborationThreshold` is (a hardcoded number in a sentence goes wrong
       *  silently the day the constant is tuned). */
      styleMinSamples?: number;
      /** `session.noLearn.set`: the flag as it now stands. */
      noLearn?: boolean;
      /** `session.noLearn.list`: every session currently marked temporary, so the
       *  tab bar can badge them in one pass. */
      noLearnSessions?: string[];
      /** `session.fastGrowth.set`/`create`: the flag as it now stands. */
      fastGrowth?: boolean;
      /** `session.fastGrowth.create`: the session that was minted, so the client
       *  can open it (or tell the user where to find it). */
      sessionId?: string;
      /** `session.continueInNewTab`: whether a handoff summary was actually stored
       *  on the new session. False is a SUCCESS — the tab opens either way (§2.2);
       *  it only says the continuation starts cold. */
      handoff?: boolean;
      /** `session.continueInNewTab`: the project the new session is linked to —
       *  the requested one, or the SOURCE session's when the request carried none.
       *  The client navigates on it, so a tab with no cwd of its own can still
       *  open the continuation. */
      cwd?: string;
      /** `session.fastGrowth.create`: the name the session was given, echoed back
       *  so the client renders what was actually stored rather than what it asked
       *  for (they differ when the request carried no title, or an over-long one). */
      title?: string;
      /** `agent.export`: both files' contents plus what was left out. */
      export?: AgentExportResult;
      /** `models.list`: the live model catalog for the catalogue that was asked
       *  for. Exactly one of `claude` / `google` is present — the other was not
       *  probed, which is different from "probed and empty" and is why the absent
       *  one is absent rather than an empty array. NO SECRET: model ids only. */
      models?: {
        claude?: ClaudeModelInfo[];
        /** Gemini model ids, `models/` prefix already stripped. */
        google?: string[];
        /** epoch ms the list was fetched, or 0 when it has never succeeded. */
        fetchedAt: number;
        /** True when this list came from the cache rather than a fresh probe. False
         *  with an empty list means the probe failed and nothing was cached. */
        cached: boolean;
      };
      /** `bootstrap.get`/`save`: whether to offer the interview and what happened. */
      bootstrap?: {
        offer: boolean;
        questions: typeof BOOTSTRAP_QUESTIONS;
        /** Answers already stored, so the form opens pre-filled rather than blank. */
        existing: Record<string, string>;
        stored?: number;
        skipped?: Array<{ id: string; reason: string }>;
      };
      /** `agent.import`: what the file carries (preview) and what landed (apply). */
      import?: {
        report: AgentImportReport;
        origin: AgentImportPlan['origin'];
        applied: boolean;
        ledgerWritten?: number;
      };
    }
  | {
      ok: false;
      /** Always English, always present: it is what a log, a script or a client
       *  with no dictionary reads. */
      error: string;
      /** An i18n key the UI should prefer over `error` when it has one
       *  (`systemMcp.*` refusals — a missing field, a bad email, a missing uvx).
       *  The English text stays authoritative; this only makes it readable. */
      errorKey?: string;
      /** The field id `errorKey` refers to, so the UI can name it with the
       *  field's own translated label instead of the server guessing a language. */
      errorField?: string;
      /** `claude.login`: how to install Claude Code, when the refusal was "there
       *  is none on this computer". Absent for every other failure — a spawn that
       *  broke for another reason is not fixed by installing anything. */
      installHelp?: ClaudeInstallHelp;
      /** The first sentence of `error`, for a UI with no room for the rest.
       *  Sent only alongside `installHelp`, since that is the one refusal whose
       *  full text is a paragraph. */
      errorHeadline?: string;
    };

/**
 * WHICH CATALOGUES `models.list` CAN ANSWER FOR.
 *
 * Two providers ask the same question — "which models may I use" — of two very
 * different places: Claude asks the local sign-in through the Agent SDK, Google
 * asks its own HTTP catalogue with the stored key. Everything AROUND that probe
 * is identical (a settings-row cache, a day's TTL, an explicit refresh, and a
 * failure that falls back to the cache rather than emptying a picker), so it is
 * written once below and parameterised by this name rather than copied.
 */
type ModelCatalog = 'claude' | 'google';

/** Setting key holding the last successful probe, per catalogue. The names follow
 *  one rule — `models.<catalogue>.cache` — and `claude`'s is the pre-existing key,
 *  so nothing that was already cached is invalidated by the generalisation. */
function modelCacheKey(catalog: ModelCatalog): string {
  return `models.${catalog}.cache`;
}

/** How long a probed list is trusted before another probe is worth it. A day: new
 *  models do not ship hourly, and the user has an explicit refresh either way. */
const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Read the cache defensively — it is JSON in a settings row, so a hand-edited or
 * half-written value must read as "no cache" rather than throwing in a chat
 * header or a settings screen.
 *
 * The payload field is NAMED AFTER THE CATALOGUE (`{ fetchedAt, claude: [...] }`,
 * `{ fetchedAt, google: [...] }`), which is what lets one reader serve both
 * without touching the shape Claude's cache is already written in.
 */
function readModelCache<T>(
  raw: string | undefined,
  catalog: ModelCatalog,
  keep: (row: unknown) => row is T,
): { fetchedAt: number; models: T[] } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const fetchedAt = typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0;
    const rows = parsed[catalog];
    return { fetchedAt, models: Array.isArray(rows) ? rows.filter(keep) : [] };
  } catch {
    return null;
  }
}

const isClaudeModel = (row: unknown): row is ClaudeModelInfo =>
  !!row && typeof row === 'object' && typeof (row as ClaudeModelInfo).value === 'string';

const isModelId = (row: unknown): row is string => typeof row === 'string' && row.length > 0;

/** Persist a probe. An unwritable cache costs a probe next time, nothing more —
 *  which is why this swallows rather than failing the request that produced it. */
function writeModelCache(
  store: { setSetting(k: string, v: string): void },
  catalog: ModelCatalog,
  fetchedAt: number,
  models: unknown[],
): void {
  try {
    store.setSetting(modelCacheKey(catalog), JSON.stringify({ fetchedAt, [catalog]: models }));
  } catch {
    /* see above */
  }
}

/** The in-house org scopeKey — kept in sync with the engine's gatherPolicyRules. */
const DEFAULT_POLICY_ORG_ID = 'default';

/** Resolve a policy action's scope + scopeKey. `user`/`org` are server-defaulted;
 *  `project` requires a cwd. Mirrors how harness/commands key their scopes. */
function resolvePolicyScope(
  scope: string | undefined,
  scopeKey: string | undefined,
): { ok: true; scope: HarnessScope; scopeKey: string } | { ok: false; error: string } {
  const s = scope ?? 'user';
  if (s === 'user') return { ok: true, scope: 'user', scopeKey: DEFAULT_USER_ID };
  if (s === 'org') return { ok: true, scope: 'org', scopeKey: DEFAULT_POLICY_ORG_ID };
  if (s === 'project') {
    if (!scopeKey) return { ok: false, error: 'project scope needs a scopeKey (cwd)' };
    return { ok: true, scope: 'project', scopeKey };
  }
  return { ok: false, error: `unknown scope '${s}'` };
}

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

    // -- P3-M10 (memory-hygiene §3): the sovereignty switches ---------------

    case 'learning.get':
      return { ok: true, learningEnabled: readLearningEnabled(store) };

    case 'style.get': {
      // An absent or unreadable fingerprint answers `null`, not an error: "naby
      // has not worked out how you write yet" is a normal state on every fresh
      // install, and the panel renders it as a sentence rather than a failure.
      const fingerprint = parseStyleFingerprint(store.getSetting(STYLE_FINGERPRINT_KEY));
      return {
        ok: true,
        style: fingerprint ?? null,
        styleMinSamples: STYLE_FINGERPRINT_MIN_SAMPLES,
      };
    }

    case 'learning.set': {
      // STRICTLY boolean, like `autoConfirm.set` and for the mirror reason: a
      // malformed request must not be able to silently turn learning OFF, which
      // would look exactly like an agent that had stopped working.
      if (typeof body.enabled !== 'boolean') {
        return { ok: false, error: 'enabled must be a boolean' };
      }
      writeLearningEnabled(store, body.enabled);
      return { ok: true, learningEnabled: body.enabled };
    }

    case 'session.noLearn.list':
      return {
        ok: true,
        noLearnSessions: store
          .listSessions()
          .filter((s) => s.noLearn === true)
          .map((s) => s.sessionId),
      };

    case 'session.noLearn.set': {
      if (typeof body.sessionId !== 'string' || !body.sessionId) {
        return { ok: false, error: 'sessionId is required' };
      }
      if (typeof body.noLearn !== 'boolean') {
        return { ok: false, error: 'noLearn must be a boolean' };
      }
      store.setSessionNoLearn(body.sessionId, body.noLearn);
      return { ok: true, noLearn: body.noLearn };
    }

    // -- P3-M12b: the fast-growth session ---------------------------------

    case 'session.fastGrowth.create': {
      // Minted ALREADY MARKED, not marked afterwards: the engine reads the flag
      // once at the top of a turn, so a session created plain and flagged a
      // moment later could run its first turn as ordinary work — and that turn is
      // exactly the one the button was pressed for.
      //
      // The provider is left empty, as everywhere else a session is minted: the
      // turn that answers records who actually did (it is a hint, not a key).
      const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : undefined;
      // IT IS NAMED AT BIRTH, in BOTH places a name can live.
      //
      // The session used to be minted untitled, so the session list derived its
      // title the ordinary way — from the first user message — and the one
      // conversation the user had just deliberately created looked exactly like
      // every other one in the list. They could not find it, twice.
      //
      // `title` on the row is what the project session browser reads
      // (`deriveTitle`, which prefers it over the first message), and
      // `session.customTitle.*` is what the RECENT list reads and what the v1.6.0
      // rename writes. Auto-titling never overwrites either — nothing updates
      // `sessions.title` after insert, and the custom title wins over a derived
      // one by construction — so this survives the first turn rather than being
      // replaced by it.
      //
      // THE WORDS COME FROM THE CLIENT because this server has no locale (the
      // same reason harness pills carry codes and not sentences). A request
      // without one still gets a name, in English, rather than an empty title
      // that would put the bug straight back.
      const title =
        typeof body.title === 'string' && body.title.trim()
          ? body.title.trim().slice(0, FAST_GROWTH_TITLE_MAX)
          : 'Fast-growth session';
      const ref = store.createSession('', title, cwd);
      store.setSessionFastGrowth(ref.sessionId, true);
      store.setSetting(customTitleKey(ref.sessionId), title);
      // ---- AND NABY OPENS ITS MOUTH (§3.3b) ------------------------------
      //
      // The user pressed a button whose whole promise is that naby asks the
      // questions, arrived at an EMPTY conversation, and had to type "시작"
      // to find out what was expected of them. So one ordinary turn is fired
      // into the session it just minted, through the same orchestrator every
      // other turn uses — the greeting is in the transcript (or streaming into
      // it) by the time the tab opens.
      //
      // NOT AWAITED, ON PURPOSE. This response is what the client navigates on;
      // blocking it on a model call would trade an empty tab for a frozen
      // button. The run is detached anyway, and the tab tails it live. Every
      // failure inside is logged and swallowed — a kickoff that could fail the
      // creation would mean a machine with no engine configured cannot make a
      // fast-growth session at all.
      //
      // ONLY HERE. `session.fastGrowth.set` marks a conversation that already
      // exists and may already be mid-thread; an opening question dropped into
      // it would interrupt the user rather than greet them.
      void startFastGrowthKickoff({
        store,
        sessionId: ref.sessionId,
        ...(cwd ? { cwd } : {}),
        // The words travel from the client for the same reason the title does:
        // this server has no locale. Absent = the English default.
        ...(typeof body.kickoff === 'string' && body.kickoff.trim()
          ? { text: body.kickoff }
          : {}),
      });
      return { ok: true, sessionId: ref.sessionId, fastGrowth: true, title };
    }

    case 'session.continueInNewTab': {
      if (typeof body.sessionId !== 'string' || !body.sessionId) {
        return { ok: false, error: 'sessionId is required' };
      }
      const outcome = await continueSessionInNewTab(
        {
          store,
          // The store rides in twice on purpose: the flow reads and writes
          // sessions with it, and the summariser reads the user's provider choice
          // from it so its model call is billed where the user aimed it.
          summarize: modelHandoffSummarizer(store),
          // The name lands in BOTH places a name can live, exactly as the
          // fast-growth session's does — `sessions.title` for the project browser
          // and the custom-title setting for the Recent list and the tab bar.
          setCustomTitle: (sessionId, title) => store.setSetting(customTitleKey(sessionId), title),
          // The two bindings that name a session id from OUTSIDE the store. Both
          // are passed as seams (see `ContinueDeps`) so the flow's own tests never
          // touch a bot link or the scheduled-task file.
          //
          // A no-op on most machines: `repointLink` only moves a link that names
          // the old session, and the rebind only touches tasks bound to it.
          rebindTelegramLink: (fromId, toId) => void repointLink(store, fromId, toId),
          // IMPORTED LAZILY, exactly as the engine modules are: /api/naby is
          // imported by every settings request, and scheduledTasks drags in the
          // orchestrator and the run hub behind it.
          rebindScheduledTasks: async (fromId, toId) => {
            const { scheduledTaskManager } = await import('../scheduledTasks');
            await scheduledTaskManager.rebindSession(fromId, toId);
          },
        },
        {
          sessionId: body.sessionId,
          ...(typeof body.cwd === 'string' && body.cwd ? { cwd: body.cwd } : {}),
          // THE WORDS TRAVEL FROM THE CLIENT because this server has no locale —
          // the same reason the fast-growth title does. An absent one falls back
          // to an English "Continued — …".
          ...(typeof body.title === 'string' && body.title.trim()
            ? { title: body.title }
            : {}),
        },
      );
      if (!outcome.ok) return { ok: false, error: outcome.error };
      console.log(
        `[handoff] continued session ${body.sessionId} into ${outcome.sessionId}` +
          (outcome.handoff ? ' with a handoff' : ` without one (${outcome.reason ?? 'unknown'})`) +
          ` (carried: ${outcome.carried.memoryKeys} memory key(s)` +
          `${outcome.carried.noLearn ? ', no-learn' : ''}` +
          `${outcome.carried.planMode ? ', plan mode' : ''}` +
          `${outcome.carried.failed.length ? `; failed: ${outcome.carried.failed.join(', ')}` : ''})`,
      );
      return {
        ok: true,
        sessionId: outcome.sessionId,
        title: outcome.title,
        handoff: outcome.handoff,
        // THE PROJECT THE TAB OPENS IN. Echoed rather than assumed by the client:
        // when the request carried no cwd the flow fell back to the SOURCE
        // session's project, and that is the only place the client can learn it.
        ...(outcome.cwd ? { cwd: outcome.cwd } : {}),
      };
    }

    case 'session.fastGrowth.set': {
      if (typeof body.sessionId !== 'string' || !body.sessionId) {
        return { ok: false, error: 'sessionId is required' };
      }
      if (typeof body.fastGrowth !== 'boolean') {
        return { ok: false, error: 'fastGrowth must be a boolean' };
      }
      store.setSessionFastGrowth(body.sessionId, body.fastGrowth);
      return { ok: true, fastGrowth: body.fastGrowth };
    }

    case 'policy.list': {
      const r = resolvePolicyScope(body.scope, body.scopeKey);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, rules: store.listPolicyRules(r.scope, r.scopeKey) };
    }

    case 'policy.put': {
      const r = resolvePolicyScope(body.scope, body.scopeKey);
      if (!r.ok) return { ok: false, error: r.error };
      const pattern = typeof body.toolPattern === 'string' ? body.toolPattern.trim() : '';
      if (!pattern) return { ok: false, error: 'toolPattern is required' };
      if (body.effect !== 'allow' && body.effect !== 'deny' && body.effect !== 'ask') {
        return { ok: false, error: "effect must be 'allow', 'deny', or 'ask'" };
      }
      store.putPolicyRule({
        scope: r.scope,
        scopeKey: r.scopeKey,
        toolPattern: pattern,
        effect: body.effect as PolicyEffect,
      });
      return { ok: true, rules: store.listPolicyRules(r.scope, r.scopeKey) };
    }

    case 'policy.remove': {
      if (typeof body.id !== 'string' || !body.id) return { ok: false, error: 'id is required' };
      store.removePolicyRule(body.id);
      return { ok: true };
    }

    case 'agent.list': {
      return { ok: true, agents: store.listAgents() };
    }

    case 'agent.put': {
      // THE BUILT-IN PERSONA IS READ-ONLY (user decision, 2026-07-30). Refused
      // HERE as well as in the store, for two different reasons: the store throw
      // is the invariant (nothing can get past it), and this is the ANSWER — a
      // sentence the panel can show, rather than a driver's error text leaking
      // into a toast. Both spellings of the attempt are caught: the well-known id,
      // and any id that happens to name a persona row.
      const targetId = typeof body.id === 'string' && body.id ? body.id : '';
      const targetKind = targetId ? store.getAgent(targetId)?.kind : undefined;
      if (targetId === BUILTIN_PERSONA_ID || targetKind === 'persona' || body.kind === 'persona') {
        return { ok: false, error: 'the built-in persona is read-only and cannot be edited' };
      }

      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) return { ok: false, error: 'name is required' };
      // The name is the @-routing handle — it must address unambiguously, so no
      // whitespace (a turn line is parsed as `@name <rest>`).
      if (/\s/.test(name)) return { ok: false, error: 'name cannot contain spaces' };
      const systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt.trim() : '';
      if (!systemPrompt) return { ok: false, error: 'systemPrompt is required' };

      // Every agent this route writes is 'custom' — unconditionally, now that the
      // persona is refused above. Only `seedBuiltinPersona` mints kind='persona',
      // and it does not come through here.
      const kind: AgentKind = 'custom';

      const memoryScope: MemoryScope =
        body.memoryScope === 'session' ||
        body.memoryScope === 'project' ||
        body.memoryScope === 'user' ||
        body.memoryScope === 'org'
          ? body.memoryScope
          : 'user';

      const escalation: AgentEscalation =
        body.escalation === 'telegram' || body.escalation === 'both' || body.escalation === 'inline'
          ? body.escalation
          : 'inline';

      const input: AgentInput = {
        ...(typeof body.id === 'string' && body.id ? { id: body.id } : {}),
        name,
        kind,
        ...(typeof body.description === 'string' && body.description.trim()
          ? { description: body.description.trim() }
          : {}),
        systemPrompt,
        ...(typeof body.model === 'string' && body.model.trim() ? { model: body.model.trim() } : {}),
        ...(Array.isArray(body.toolRefs) ? { toolRefs: body.toolRefs.filter((r) => typeof r === 'string') } : {}),
        memoryScope,
        autonomy: {
          escalation,
          // P3-M3c: store the step budget ALREADY CLAMPED (same `resolveMaxSteps`
          // the loop applies), so the value the user sees after saving is the
          // value that will actually run — a stored 999 next to a UI that says
          // "hard cap 20" would be a lie. 1 (or absent) means autonomy off, which
          // is the field's absence rather than a stored 1.
          ...(typeof body.maxSteps === 'number' && resolveMaxSteps(body.maxSteps) > 1
            ? { maxSteps: resolveMaxSteps(body.maxSteps) }
            : {}),
        },
      };

      try {
        const agent = store.putAgent(input);
        return { ok: true, agent, agents: store.listAgents() };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    case 'agent.remove': {
      if (typeof body.id !== 'string' || !body.id) return { ok: false, error: 'id is required' };
      // The store no-ops a persona delete (undeletable); reflect that to the UI so
      // it never shows a "removed" persona.
      store.removeAgent(body.id);
      return { ok: true, agents: store.listAgents() };
    }

    // Phase 3 (P3-M9, G1) — the persona's DELEGATION settings. Read and written
    // through lib/personaAutonomy, which owns the keys, the defaults and the
    // clamp; this route only validates what came off the wire.
    case 'personaAutonomy.get': {
      return {
        ok: true,
        personaAutonomy: readPersonaAutonomy(store),
        autonomyStepCap: AUTONOMY_STEP_CAP,
      };
    }

    case 'personaAutonomy.set': {
      // Both fields are optional — a save from one control must not reset the
      // other — but a field that IS present has to be usable. Rejecting here
      // rather than coercing means a UI bug surfaces as an error the user can
      // report, not as a setting that quietly became something else.
      if (body.escalation !== undefined) {
        if (
          body.escalation !== 'inline' &&
          body.escalation !== 'telegram' &&
          body.escalation !== 'both'
        ) {
          return { ok: false, error: "escalation must be 'inline', 'telegram', or 'both'" };
        }
      }
      if (body.maxSteps !== undefined && !Number.isFinite(body.maxSteps)) {
        return { ok: false, error: 'maxSteps must be a number' };
      }
      return {
        ok: true,
        personaAutonomy: writePersonaAutonomy(store, {
          ...(body.escalation !== undefined ? { escalation: body.escalation } : {}),
          ...(body.maxSteps !== undefined ? { maxSteps: body.maxSteps } : {}),
        }),
        autonomyStepCap: AUTONOMY_STEP_CAP,
      };
    }

    case 'telegram.get': {
      const cfg = readTelegramConfig(store);
      return {
        ok: true,
        telegram: {
          enabled: cfg.enabled,
          botTokenRedacted: redactToken(cfg.botToken),
          chatId: cfg.chatId,
          syncMode: cfg.syncMode,
          ready: isTelegramReady(cfg),
        },
      };
    }

    case 'telegram.set': {
      const patch: Partial<TelegramConfig> = {};
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
      // A blank token from the redacted UI means "unchanged" — never wipe a stored
      // secret because the form showed a mask. A non-blank value replaces it.
      if (typeof body.botToken === 'string' && body.botToken.trim()) patch.botToken = body.botToken.trim();
      if (typeof body.chatId === 'string') patch.chatId = body.chatId.trim();
      // Delivery mode (telegram-chat §8.1). Only the two known values are
      // accepted; anything else leaves the stored mode untouched.
      if (body.syncMode === 'always' || body.syncMode === 'manual') patch.syncMode = body.syncMode;
      // A NEW TOKEN IS A NEW BOT: its command menu is empty until we publish one,
      // so the once-per-process guard has to be lifted here or the menu would
      // only appear after a restart.
      if (patch.botToken) resetBotCommandRegistration();
      writeTelegramConfig(store, patch);
      const cfg = readTelegramConfig(store);
      // Saving is what turns two-way chat ON (telegram-chat §5): the loop runs
      // whenever the config can chat, so it starts here rather than waiting for
      // an escalation that may never come. Both calls are best-effort and neither
      // is awaited — Settings must answer at once.
      if (isTelegramReady(cfg)) {
        void registerTelegramCommands(store);
        ensureListener(store);
      } else {
        // Disabled or half-configured: the loop notices on its next iteration and
        // exits (it re-reads the config every pass), so nothing to do here.
        stopTelegramListener();
      }
      return {
        ok: true,
        telegram: {
          enabled: cfg.enabled,
          botTokenRedacted: redactToken(cfg.botToken),
          chatId: cfg.chatId,
          syncMode: cfg.syncMode,
          ready: isTelegramReady(cfg),
        },
      };
    }

    case 'telegram.test': {
      const cfg = readTelegramConfig(store);
      if (!cfg.botToken || !cfg.chatId) {
        return { ok: false, error: 'Set a bot token and chat id first.' };
      }
      const sent = await sendTelegramMessage(cfg, '🤖 naby test — Telegram is connected.');
      return sent.ok ? { ok: true } : { ok: false, error: sent.error };
    }

    case 'telegram.detectChat': {
      const cfg = readTelegramConfig(store);
      // ONE getUpdates PER BOT (telegram-chat §5). Detect calls getUpdates too,
      // and with the listener promoted to always-on the two would collide with a
      // 409 — which reads to the user as "Detect is broken". So the loop hands
      // the slot over for the length of the call and takes it back after. The
      // shared watermark already prevents a double interpretation of whatever
      // Detect consumes.
      await pauseTelegramListener();
      try {
        const found = await detectChatId(cfg);
        if (!found.ok) return { ok: false, error: found.error };
        // Persist it so the next get/test uses it, and echo it to the UI.
        writeTelegramConfig(store, { chatId: found.chatId });
        return { ok: true, chatId: found.chatId };
      } finally {
        resumeTelegramListener(store);
      }
    }

    case 'approval.resolve': {
      if (typeof body.approvalId !== 'string' || !body.approvalId) {
        return { ok: false, error: 'approvalId is required' };
      }
      if (body.decision !== 'allow' && body.decision !== 'deny') {
        return { ok: false, error: "decision must be 'allow' or 'deny'" };
      }
      const gateDecision =
        body.decision === 'allow'
          ? ({ behavior: 'allow' } as const)
          : ({ behavior: 'deny', reason: 'you denied this tool call' } as const);
      const resolved = resolveApproval(body.approvalId, gateDecision);
      // Remember: persist a rule so this tool no longer prompts in that scope.
      const pattern = typeof body.toolPattern === 'string' ? body.toolPattern.trim() : '';
      if (body.remember && pattern) {
        const r = resolvePolicyScope(body.scope, body.scopeKey);
        if (r.ok) {
          store.putPolicyRule({
            scope: r.scope,
            scopeKey: r.scopeKey,
            toolPattern: pattern,
            effect: body.decision,
          });
        }
      }
      return { ok: true, resolved };
    }

    // Phase 3 (P3-M5) — settle a paused check-in with the option the user picked.
    // Shaped like `approval.resolve` and for the same reason: the turn is
    // suspended in another request's promise, and this is what wakes it.
    case 'checkin.resolve': {
      if (typeof body.checkinId !== 'string' || !body.checkinId) {
        return { ok: false, error: 'checkinId is required' };
      }
      // -1 means "the user answered in their own words" and REQUIRES those words:
      // resolving with neither an index nor text would hand the agent an empty
      // decision, which is worse than the prompt having timed out.
      const chosen = typeof body.chosen === 'number' ? Math.trunc(body.chosen) : NaN;
      if (Number.isNaN(chosen) || chosen < -1) {
        return { ok: false, error: 'chosen must be an option index, or -1 with a correction' };
      }
      const correction = typeof body.correction === 'string' ? body.correction.trim() : '';
      if (chosen === -1 && !correction) {
        return { ok: false, error: 'a free-text answer needs `correction`' };
      }
      const resolved = resolveCheckin(body.checkinId, {
        chosen,
        ...(correction ? { correction } : {}),
      });
      return { ok: true, resolved };
    }

    // Phase 3 (P3-M5) — the trust-meter reading. Defaults to the built-in persona,
    // which is the agent the Settings panel is about; an `agentId` reads a custom
    // agent instead. Never throws on an empty ledger: an unmeasured agent reads as
    // an egg, which is the honest answer rather than an error.
    case 'growth.get': {
      const agentId = typeof body.agentId === 'string' && body.agentId ? body.agentId : BUILTIN_PERSONA_ID;
      const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : undefined;
      return {
        ok: true,
        growth: growthReport(store, agentId),
        // P3-M8c: shipped alongside, never folded in. `safeLearningReport`
        // swallows its own failures so a learning count can never be the reason
        // the trust meter fails to render.
        learning: safeLearningReport(store, agentId, { ...(cwd ? { cwd } : {}) }),
      };
    }

    // Phase 3 (P3-M8a) — run a reflection sweep NOW, rather than waiting for the
    // next turn to kick one (spec §4.3). Exists for tests and for a user who wants
    // the ledger brought up to date on demand; it takes the same path the engine's
    // fire-and-forget trigger takes, so there is one sweep implementation.
    //
    // Awaited here, unlike the engine's trigger: an on-demand caller asked for the
    // counts, so returning before the work is done would report zeros.
    case 'reflection.run': {
      // The judge gets the store for the same reason `kickReflectionSweep` hands
      // its default one the store: the sweep must bill the provider the user
      // picked, not whichever profile holds the first key.
      const sweep = await runReflectionSweep(store, modelReflectionJudge(store), {
        ...(typeof body.excludeSessionId === 'string' && body.excludeSessionId
          ? { excludeSessionId: body.excludeSessionId }
          : {}),
      });
      return { ok: true, reflection: sweep };
    }

    // Phase 3 (P3-M6) — build the export pair. Nothing is written and nothing
    // leaves the machine here: the client shows the report first and only then
    // offers to save, because "it exported fine" is not informed consent about
    // a file containing what naby learned about its user.
    case 'agent.export': {
      if (typeof body.agentId !== 'string' || !body.agentId) {
        return { ok: false, error: 'agentId is required' };
      }
      const target = store.getAgent(body.agentId);
      if (!target) return { ok: false, error: 'no such agent' };
      return {
        ok: true,
        export: exportAgent(store, target, {
          ...(typeof body.cwd === 'string' && body.cwd ? { cwd: body.cwd } : {}),
          now: Date.now(),
        }),
      };
    }

    // Phase 3 (P3-M7) — parse a sidecar, and only write when told to. The parse
    // is where every trust rule lives (runtime `agent-import.ts`); this decides
    // nothing about the file's contents, it just reports and then applies.
    case 'agent.import': {
      if (typeof body.sidecar !== 'string' || !body.sidecar.trim()) {
        return { ok: false, error: 'sidecar is required' };
      }
      const parsed = parseAgentSidecar(body.sidecar, {
        trustLedger: body.trustLedger === true,
        // Read fresh so a name minted between the preview and the apply is still
        // seen — the rename has to be right at the moment of writing.
        existingNames: store.listAgents().map((a) => a.name),
        now: Date.now(),
      });
      if (!parsed.ok) return { ok: false, error: parsed.problems.join('; ') };

      // PREVIEW: report and stop. Nothing is written, so the user can decline
      // after seeing what a colleague's file actually contains.
      if (body.apply !== true) {
        return {
          ok: true,
          import: { report: parsed.plan.report, origin: parsed.plan.origin, applied: false },
        };
      }

      const outcome = applyAgentImport(store, parsed.plan);
      return {
        ok: true,
        agents: store.listAgents(),
        agent: outcome.agent,
        import: {
          report: parsed.plan.report,
          origin: parsed.plan.origin,
          applied: true,
          ledgerWritten: outcome.ledgerWritten,
        },
      };
    }

    // The live model catalog. Cached in settings because a probe is not free:
    // Claude's spawns the CLI (~1.6s measured), Google's is a network round trip.
    // Neither is something to pay on every render of a chat header or a settings
    // screen.
    case 'models.list': {
      if (body.provider === GOOGLE_PROVIDER_ID) {
        const cached = readModelCache(
          store.getSetting(modelCacheKey('google')),
          'google',
          isModelId,
        );
        const fresh =
          cached !== null &&
          Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS &&
          cached.models.length > 0;
        if (fresh && body.refresh !== true) {
          return {
            ok: true,
            models: { google: cached!.models, fetchedAt: cached!.fetchedAt, cached: true },
          };
        }
        /** Whatever is cached — the answer for every failure below. A stale list
         *  beats an empty picker, and the settings form still takes a typed id. */
        const fallback = (): NabyActionResult => {
          const have = cached?.models ?? [];
          return {
            ok: true,
            models: { google: have, fetchedAt: cached?.fetchedAt ?? 0, cached: have.length > 0 },
          };
        };
        // THE KEY IS READ HERE, IN THE SERVER, AND GOES NO FURTHER. This is the
        // same resolution a turn runs; the secret is handed to the runtime's
        // catalogue call and what comes back — and what this route returns — is a
        // list of model ids. A user with no Google key saved simply gets the
        // fallback, which is why this never becomes an error the settings screen
        // has to render.
        const resolution = await resolveProviderCredential({ providerId: GOOGLE_PROVIDER_ID });
        if (!resolution.ok) return fallback();
        const probed = await listGoogleModels({ apiKey: resolution.value.apiKey });
        // `undefined` = could not ask (offline, refused, timed out). `[]` = asked
        // and nothing qualifies, which is also no reason to throw away a list that
        // worked yesterday.
        if (!probed || probed.length === 0) return fallback();
        const fetchedAt = Date.now();
        writeModelCache(store, 'google', fetchedAt, probed);
        return { ok: true, models: { google: probed, fetchedAt, cached: false } };
      }

      const cached = readModelCache(
        store.getSetting(modelCacheKey('claude')),
        'claude',
        isClaudeModel,
      );
      const fresh =
        cached !== null && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS && cached.models.length > 0;
      if (fresh && body.refresh !== true) {
        return { ok: true, models: { claude: cached!.models, fetchedAt: cached!.fetchedAt, cached: true } };
      }
      const probed = await probeClaudeModels();
      if (!probed) {
        // Not signed in, SDK absent, or the CLI did not answer in time. Hand back
        // whatever was cached rather than nothing: a stale list beats an empty
        // picker, and the client's own fallback covers a cold cache. `cached` is
        // only true when there is genuinely something cached — reporting a cache
        // hit for an empty list would be a small lie the client cannot check.
        const have = cached?.models ?? [];
        return {
          ok: true,
          models: { claude: have, fetchedAt: cached?.fetchedAt ?? 0, cached: have.length > 0 },
        };
      }
      const fetchedAt = Date.now();
      writeModelCache(store, 'claude', fetchedAt, probed);
      return { ok: true, models: { claude: probed, fetchedAt, cached: false } };
    }

    // Phase 1.5 (P15-07) — cold start. Read-only.
    case 'bootstrap.get': {
      const existingRows = store.getScopedMemory('user', DEFAULT_USER_ID);
      const existing: Record<string, string> = {};
      for (const q of BOOTSTRAP_QUESTIONS) {
        const row = existingRows.find((m) => m.key === q.id);
        if (row) existing[q.id] = row.value;
      }
      return {
        ok: true,
        bootstrap: {
          offer: shouldOfferBootstrap({
            doneFlag: store.getSetting(BOOTSTRAP_DONE_KEY),
            existingKeys: Object.keys(existing),
          }),
          questions: BOOTSTRAP_QUESTIONS,
          existing,
        },
      };
    }

    // Writes the answers, then records the interview as done EITHER WAY: a user
    // who answered one question and a user who dismissed it both mean "stop
    // asking", and re-offering a form someone closed is how a first run turns
    // annoying.
    case 'bootstrap.save': {
      let stored = 0;
      let skipped: Array<{ id: string; reason: string }> = [];
      if (!body.dismiss && body.answers && typeof body.answers === 'object') {
        const plan = answersToMemory(body.answers as Record<string, string>, {
          userId: DEFAULT_USER_ID,
          now: Date.now(),
        });
        skipped = plan.skipped;
        for (const write of plan.writes) {
          try {
            store.putMemory(write);
            stored += 1;
          } catch (e) {
            // A gate refusal is information, not a crash — and there is no reason
            // one bad answer should lose the others.
            skipped.push({ id: write.key, reason: e instanceof Error ? e.message : String(e) });
          }
        }
      }
      store.setSetting(BOOTSTRAP_DONE_KEY, 'true');
      return {
        ok: true,
        bootstrap: {
          offer: false,
          questions: BOOTSTRAP_QUESTIONS,
          existing: {},
          stored,
          skipped,
        },
      };
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
      //
      // IN THE SELECTED ACCOUNT'S NAMESPACE, when there is one: the chip that
      // offers this button is describing that account (see readNabyState), so
      // signing in anywhere else would fix nothing the user can see.
      const result = claudeLoginForAccount(activeClaudeAccountId(store), {
        ...(typeof body.email === 'string' ? { email: body.email } : {}),
        ...(typeof body.console === 'boolean' ? { console: body.console } : {}),
      });
      // A refusal because there is NO CLI carries install instructions; pass them
      // through so the UI can offer the command instead of only the complaint.
      if (!result.ok) {
        return {
          ok: false,
          error: result.error,
          // The short form travels BESIDE the long one, not instead of it. The
          // chat chip renders a failure in a small amber span where four
          // sentences read as a wall; the settings card has room for all of it.
          // Both come from the runtime so neither is a second wording.
          ...(result.installHelp
            ? { installHelp: result.installHelp, errorHeadline: CLAUDE_CLI_MISSING_HEADLINE }
            : {}),
        };
      }
      return { ok: true, started: true, command: result.command };
    }

    case 'claude.logout': {
      // Sign out of the LOCAL Claude dev sign-in by running `claude auth logout`
      // (a clean CLI logout — the runtime resolves a de-shimmed binary and owns
      // the safety; see `claudeLogout`). No secret crosses this boundary. The
      // runtime resets its login cache, so the next GET (or the UI's explicit
      // re-check) reports signed-out immediately rather than a 10s-stale answer.
      //
      // Of the SELECTED account when there is one — the same namespace the chip
      // is describing. The account itself is kept: this is "sign out", not
      // "remove", so the folder and the row survive and a later sign-in lands
      // back in the same place.
      const result = await claudeLogoutForAccount(activeClaudeAccountId(store));
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, removed: result.removed };
    }

    // -- more than one Claude subscription (claude-multi-account §5) ----------
    //
    // The runtime owns every one of these: it mints the id, resolves the folder,
    // builds the environment, and runs the same `claude auth` CLI the single
    // account path runs. This file only decides WHEN they may happen — which is
    // where §5.4's refusal and §5.5's activity line live, because both are
    // policy about the app's state rather than about an account.

    case 'claude-account.add': {
      // Creates the namespace, probes isolation, and spawns the browser flow —
      // and cleans up after itself on every failure, so a refusal leaves no row.
      const result = await addClaudeAccount(store, {
        ...(typeof body.email === 'string' ? { email: body.email } : {}),
        ...(typeof body.console === 'boolean' ? { console: body.console } : {}),
      });
      if (!result.ok) {
        return {
          ok: false,
          error: result.error,
          // §5.3 — the machine cannot keep sign-ins apart. The verdict is already
          // stored, so the account block in this reply says `supported:false` and
          // the screen puts the feature away.
          ...(result.isolationBroken ? { errorKey: 'claudeAccounts.notIsolated' } : {}),
          ...(result.installHelp
            ? { installHelp: result.installHelp, errorHeadline: CLAUDE_CLI_MISSING_HEADLINE }
            : {}),
        };
      }
      return {
        ok: true,
        started: true,
        accountId: result.accountId,
        command: result.command,
        claudeAccounts: describeClaudeAccounts(store),
      };
    }

    case 'claude-account.verify': {
      if (!isClaudeAccountId(body.accountId)) {
        return { ok: false, error: 'accountId is required' };
      }
      const result = await verifyClaudeAccount(store, body.accountId);
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, claudeAccounts: describeClaudeAccounts(store) };
    }

    case 'claude-account.select': {
      // '' is a real choice: "use the one sign-in this computer has", which is
      // how a user gets back to single-account behaviour without deleting
      // anything.
      const wanted = typeof body.accountId === 'string' ? body.accountId.trim() : '';
      if (wanted && !listClaudeAccounts(store).some((a) => a.id === wanted)) {
        return { ok: false, error: 'unknown account' };
      }
      if (activeClaudeAccountId(store) !== (wanted || undefined)) {
        // §5.4 — REFUSE MID-TURN, and the reason is honesty rather than safety.
        // The environment is fixed into the child process at turn start, so a
        // running turn keeps spending the account it started on; switching now
        // would leave the screen naming one account while the answer being
        // written belongs to another.
        if (anyRunActive()) {
          return {
            ok: false,
            error: 'A turn is still running, so the Claude account cannot be switched yet.',
            errorKey: 'claudeAccounts.busy',
          };
        }
        setActiveClaudeAccount(store, wanted || null);
        // The next status read must not be answered from the previous account's
        // ten-second-old entry.
        resetClaudeLoginCache();
        // §5.5 — the only durable record of WHICH account's limits a conversation
        // spent. The id and the email, and deliberately NOT the config directory:
        // the activity log is a file people read, grep and attach to bug reports.
        const chosen = listClaudeAccounts(store).find((a) => a.id === wanted);
        logActivity('setting_change', {
          setting: 'claude.activeAccount',
          accountId: wanted || null,
          email: chosen?.email ?? null,
        });
      }
      return { ok: true, claudeAccounts: describeClaudeAccounts(store) };
    }

    case 'claude-account.remove': {
      if (!isClaudeAccountId(body.accountId)) {
        return { ok: false, error: 'accountId is required' };
      }
      // Removing the ACTIVE account changes which account answers, so it is the
      // same interruption a switch is and is refused for the same reason.
      if (activeClaudeAccountId(store) === body.accountId && anyRunActive()) {
        return {
          ok: false,
          error: 'A turn is still running, so this Claude account cannot be removed yet.',
          errorKey: 'claudeAccounts.busy',
        };
      }
      const result = await removeClaudeAccount(store, body.accountId);
      if (!result.ok) return { ok: false, error: result.error };
      if (result.wasActive) {
        logActivity('setting_change', {
          setting: 'claude.activeAccount',
          accountId: null,
          email: null,
        });
      }
      return {
        ok: true,
        removed: true,
        loggedOut: result.loggedOut,
        claudeAccounts: describeClaudeAccounts(store),
      };
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
      // Connect, list, close — see `probeMcpServer`. This case owns only the
      // SENTENCE; the connecting is shared with `systemMcp.test` so the two can
      // never come to mean different things.
      const probe = await probeMcpServer(store, body.name);
      if (!probe.ok) return { ok: false, error: probe.error };
      return {
        ok: true,
        message: `Connected. ${probe.toolCount} tool(s) available, each of which will go through the approval gate.`,
        tools: probe.toolNames,
      };
    }

    // -----------------------------------------------------------------------
    // The BUILT-IN System MCP presets (skill-hub-builtin §2.2)
    // -----------------------------------------------------------------------
    //
    // WHY THESE EXIST AT ALL, given `mcp.upsert` could store the same rows: the
    // client would then have to know the URL or the command, the transport, and
    // the header/env names, and would have to SEND a block containing the secret —
    // which is the one thing `redactEntry` refuses to hand back, so the UI could
    // never show or preserve what it had just written. Assembling server-side from
    // the registry means secrets move in exactly one direction and the user types
    // exactly what only they can know.
    //
    // THREE CASES, NO PER-PRESET BRANCHING. Everything specific to a server lives
    // in lib/systemMcp.ts; adding a third preset changes nothing here.

    case 'systemMcp.set': {
      const preset = findSystemMcpPreset(body.preset);
      if (!preset) return { ok: false, error: `unknown system MCP preset "${body.preset}"` };

      // Only strings, only declared field ids — `mergeSystemMcpFields` drops the
      // rest, so a client cannot smuggle an extra key into a built entry.
      const incoming: Record<string, string> = {};
      for (const [key, value] of Object.entries(body.fields ?? {})) {
        if (typeof value === 'string') incoming[key] = value;
      }

      // BLANK MEANS KEEP. A secret has no way back out to the client, so its box
      // is empty every time the form opens; rebuilding from the typed values
      // alone would wipe the token whenever the user edited anything else.
      const existing = store.listMcpEntries().find((e) => e.name === preset.name);
      const fields = mergeSystemMcpFields(preset, existing, incoming);

      // The launcher's absolute path is resolved HERE, at save time, while the
      // user is still looking at the form (skill-hub-builtin §2.1). A stored bare
      // `uvx` works in dev and ENOENTs in the packaged app, where the child
      // process inherits a PATH with no user bin directories on it.
      let commandPath: string | undefined;
      if (preset.launcher) {
        commandPath = (await resolveCommandPath(preset.launcher)) ?? undefined;
      }

      // The URL override is read HERE, not inside the pure builder, so the policy
      // ("settings win, otherwise the built-in URL") lives on the server side of
      // the boundary and the builder stays a function of its arguments.
      const built = preset.build(fields, { url: readPresetUrl(store, preset), commandPath });
      if (!built.ok) {
        return {
          ok: false,
          error: built.error,
          ...(built.errorKey ? { errorKey: built.errorKey } : {}),
          ...(built.errorField ? { errorField: built.errorField } : {}),
        };
      }

      // Validated like any other entry — the thing most likely to be wrong is a
      // hand-edited URL override, and a malformed URL should be an error the user
      // can read rather than a connect failure later.
      const problems = validateMcpEntry(built.entry);
      if (problems.length > 0) return { ok: false, error: problems.join('; ') };

      store.upsertMcpEntry(built.entry);

      // THE CREDENTIAL IS THE SWITCH for a preset that owns a built-in harness
      // bundle (skill-hub-builtin §2.7). `cic` ships with a skill and a subagent
      // that can do nothing without it — the subagent's only tools are `cic__*` —
      // so they are seeded disabled and come alive here, at the moment the user
      // proves they have access. No per-preset branching: the registry says whether
      // there is a bundle, and the runtime decides what may be flipped (it refuses
      // to touch anything the user has moved by hand since the last automatic
      // write, which is why re-saving a token never re-enables a skill somebody
      // deliberately turned off).
      if (preset.harnessBundle) {
        try {
          applyBuiltinHarnessActivation(store, preset.harnessBundle, true);
        } catch {
          // Never fail the save over the bundle: the server IS connected, and the
          // user can still enable the two items by hand in Settings.
        }
      }

      // The status, and only the status. The secrets are now in the store and
      // have no way back out through this route.
      return { ok: true, systemMcp: readSystemMcpStatus(store) };
    }

    case 'systemMcp.test': {
      // The same one-shot connect `mcp.test` runs, named for the preset so the
      // client does not have to know the registry name.
      const preset = findSystemMcpPreset(body.preset);
      if (!preset) return { ok: false, error: `unknown system MCP preset "${body.preset}"` };
      const probe = await probeMcpServer(store, preset.name);
      if (!probe.ok) return { ok: false, error: probe.error };
      return {
        ok: true,
        toolCount: probe.toolCount,
        toolNames: probe.toolNames,
        systemMcp: readSystemMcpStatus(store),
      };
    }

    case 'systemMcp.remove': {
      const preset = findSystemMcpPreset(body.preset);
      if (!preset) return { ok: false, error: `unknown system MCP preset "${body.preset}"` };
      // Idempotent, like `mcp.remove`: removing a server that is not there is the
      // state the caller asked for, not an error.
      store.removeMcpEntry(preset.name);
      // The other half of the switch. Without this a removed cic would leave a
      // skill that still fires and a subagent that still runs — with no tools, so
      // every triggered turn would end in "I could not research Confluence". The
      // items are disabled, not deleted: reconnecting brings them back, and a user
      // who enabled them by hand keeps them (the runtime only touches what its own
      // last write left behind).
      if (preset.harnessBundle) {
        try {
          applyBuiltinHarnessActivation(store, preset.harnessBundle, false);
        } catch {
          /* removing the server is what was asked for; the bundle is best-effort */
        }
      }
      return { ok: true, systemMcp: readSystemMcpStatus(store) };
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
      // `errorKey`/`errorField` ride along when the refusal has a translation
      // (a missing preset field, a bad email, a missing uvx). They are hints, not
      // a replacement: `error` is always the English truth, and a client without
      // a dictionary reads that.
      return new Response(
        JSON.stringify({
          error: result.error,
          ...(result.errorKey ? { errorKey: result.errorKey } : {}),
          ...(result.errorField ? { errorField: result.errorField } : {}),
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
    return ok(result);
  })
);
