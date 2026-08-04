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
  DEFAULT_USER_ID,
  BUILTIN_PERSONA_ID,
  parseAgentSidecar,
  probeClaudeModels,
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
  | { action: 'telegram.set'; enabled?: boolean; botToken?: string; chatId?: string }
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
  // WHICH MODELS THE LOCAL SIGN-IN ACTUALLY HAS. The chat bar's list used to be a
  // constant, so it went stale the day a new model shipped and naby had to be
  // rebuilt to name one. `models.list` returns the cached answer (and probes when
  // the cache is empty or old); `refresh: true` always probes. The probe asks the
  // Agent SDK, which reports what THIS sign-in is entitled to — strictly better
  // than any list we could maintain, because it reflects the user's own plan.
  | { action: 'models.list'; refresh?: boolean }
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
  | { action: 'session.fastGrowth.set'; sessionId: string; fastGrowth: boolean };

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
      telegram?: { enabled: boolean; botTokenRedacted: string; chatId: string; ready: boolean };
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
      /** `session.fastGrowth.create`: the name the session was given, echoed back
       *  so the client renders what was actually stored rather than what it asked
       *  for (they differ when the request carried no title, or an over-long one). */
      title?: string;
      /** `agent.export`: both files' contents plus what was left out. */
      export?: AgentExportResult;
      /** `models.list`: the live model catalog for the Claude sign-in. */
      models?: {
        claude: ClaudeModelInfo[];
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
    };

/** Setting key holding the last successful model probe. */
const CLAUDE_MODELS_CACHE_KEY = 'models.claude.cache';

/** How long a probed list is trusted before another probe is worth it. A day: new
 *  models do not ship hourly, and the user has an explicit refresh either way. */
const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Read the cache defensively — it is JSON in a settings row, so a hand-edited or
 *  half-written value must read as "no cache" rather than throwing in a chat
 *  header. */
function readModelCache(raw: string | undefined): { fetchedAt: number; claude: ClaudeModelInfo[] } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { fetchedAt?: unknown; claude?: unknown };
    const fetchedAt = typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0;
    const claude = Array.isArray(parsed.claude)
      ? parsed.claude.filter(
          (m): m is ClaudeModelInfo =>
            !!m && typeof m === 'object' && typeof (m as ClaudeModelInfo).value === 'string',
        )
      : [];
    return { fetchedAt, claude };
  } catch {
    return null;
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
      const sweep = await runReflectionSweep(store, modelReflectionJudge(), {
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

    // The live model catalog. Cached in settings because the probe spawns the
    // Claude CLI: cheap (~1.6s measured) but not something to pay on every render
    // of a chat header.
    case 'models.list': {
      const cachedRaw = store.getSetting(CLAUDE_MODELS_CACHE_KEY);
      const cached = readModelCache(cachedRaw);
      const fresh =
        cached !== null && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS && cached.claude.length > 0;
      if (fresh && body.refresh !== true) {
        return { ok: true, models: { claude: cached!.claude, fetchedAt: cached!.fetchedAt, cached: true } };
      }
      const probed = await probeClaudeModels();
      if (!probed) {
        // Not signed in, SDK absent, or the CLI did not answer in time. Hand back
        // whatever was cached rather than nothing: a stale list beats an empty
        // picker, and the client's own fallback covers a cold cache. `cached` is
        // only true when there is genuinely something cached — reporting a cache
        // hit for an empty list would be a small lie the client cannot check.
        const have = cached?.claude ?? [];
        return {
          ok: true,
          models: { claude: have, fetchedAt: cached?.fetchedAt ?? 0, cached: have.length > 0 },
        };
      }
      const fetchedAt = Date.now();
      try {
        store.setSetting(CLAUDE_MODELS_CACHE_KEY, JSON.stringify({ fetchedAt, claude: probed }));
      } catch {
        /* an unwritable cache costs a probe next time, nothing more */
      }
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
