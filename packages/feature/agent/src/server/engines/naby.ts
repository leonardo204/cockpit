/**
 * The `naby` engine — the shell's seam onto OUR runtime.
 *
 * This is an ADAPTER, nothing more. It owns no agent logic: the loop, the
 * policy gate and the tool executors all live in the naby runtime (the parent
 * repo). Everything here is translation in two directions:
 *
 *   shell RunCtx  →  our EngineRunInput   (prompt, cwd, abort signal)
 *   our EngineEvent  →  the shell's Agent-SDK-shaped RunEvents  (via ctx.emit)
 *
 * WHY THE IMPORT LOOKS LIKE THAT
 * ------------------------------
 * `../../../../../../../dist/naby-runtime.mjs` is the parent repo's prebuilt
 * runtime bundle (`npm run build:runtime` there). It is a single self-contained
 * ESM file: `ai@7`, the five provider adapters and zod are already inlined, so
 * it imports nothing but node builtins.
 *
 * That matters because the shell pins `ai@6` and the runtime pins `ai@7`. Any
 * linkage that left a bare `import 'ai'` for the shell's resolver to answer —
 * a `file:` dependency, a tsconfig path alias — would hand our engine the wrong
 * major. Prebundling settles the resolution in the parent tree, where ai@7
 * lives. It also means this fork needs NO config changes: no dependency, no
 * package-lock churn, no tsconfig `paths`, no `transpilePackages` entry. The
 * whole fork diff is this file plus one line in registry.ts.
 *
 * EVENT SHAPES
 * ------------
 * The shell's client is coupled to Claude Agent SDK message shapes, so we speak
 * those. Two details verified against `client/applyStreamEvent.ts`:
 *   - assistant TEXT is only rendered from an `assistant` event for a hardcoded
 *     set of engines (codex/kimi/ollama) or `model === '<synthetic>'`. `naby` is
 *     in neither, so text goes out as a `stream_event` text_delta — the
 *     engine-agnostic path — and the `assistant` event carries tool_use blocks
 *     ONLY. That keeps us off the client's engine allowlist (no client diff)
 *     and makes double-rendering structurally impossible.
 *   - tool results are `user` events with `tool_use_id` + `content` blocks.
 *
 * MULTI-TURN (F1-05)
 * ------------------
 * History is OURS now: the runtime persists transcripts and memory in SQLite,
 * so a run resumes rather than starting from `ctx.prompt` alone. `ctx.sessionId`
 * (when the shell supplies one) addresses an existing session; otherwise we mint
 * one and `rekey()` to it. `runTurn` loads the prior messages, drives the
 * engine, and appends the new ones — this file no longer touches the history at
 * all, it only translates the events streaming out.
 *
 * MILESTONE LIMITATIONS (deliberate, tracked)
 *   - `ctx.images` are forwarded to runTurn (multimodal input): the runtime
 *     attaches them to the user message and each engine builds a native image
 *     block. They are transient — not persisted to the transcript.
 *   - The gate runs the Phase-1 harness-observation FLOOR (not the full Phase 2
 *     policy): it allows read-only inspection + delegation + skills + our own
 *     runtime tools and DENIES filesystem mutation / shell exec — from the main
 *     loop and from inside any subagent. This is what makes it safe to run the
 *     dev engine with built-ins enabled (so skill/subagent activity is visible).
 *     EVERY call still goes through the gate and is logged; the Phase 2 policy
 *     gate drops in by replacing the decision policy below and nothing else.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AiSdkEngine,
  buildToolset,
  buildWorkspaceTools,
  canCaptureMemory,
  isMcpEntryActive,
  ClaudeAgentSdkEngine,
  CHATGPT_OAUTH_DEFAULT_MODEL,
  CHATGPT_OAUTH_LABEL,
  CHATGPT_OAUTH_PROVIDER_ID,
  DEV_ENGINE_LABEL,
  getChatgptTokenSource,
  isChatgptOauthEnabled,
  DEFAULT_USER_ID,
  DANGEROUS_BUILTINS,
  OBSERVATION_BUILTINS,
  loadMcpToolset,
  makeGate,
  isBuiltinPersona,
  normalizeToolName,
  parseAgentAddress,
  phase1HarnessFloor,
  BUILTIN_PERSONA_ID,
  realPolicy,
  resolvePolicyEffect,
  makeModelResolver,
  Outbox,
  preflightEngine,
  parseStyleFingerprint,
  readLearningEnabled,
  renderStyleFingerprintLine,
  STYLE_FINGERPRINT_KEY,
  readSettings,
  resolveProviderCredential,
  runTurn,
  seedBuiltinPersona,
  selectEngine,
  SqliteStore,
  stageContract,
  stageProgressSummary,
  stageRefusalReason,
  toSelectOptions,
  apiKeyCredential,
  type Engine,
  type EngineEvent,
  type Executor,
  type Gate,
  type GateDecision,
  type GateLogEntry,
  type ToolCall,
  type Agent,
  type McpLoadResult,
  type HarnessItem,
  type ModelResolver,
  type PolicyRule,
  type Project,
  type ProviderProfile,
  type SubagentSpec,
  type RuntimeMessage,
  type SessionRef,
  type Store,
  type ToolSchema,
  type Usage,
} from '../../../../../../../dist/naby-runtime.mjs';

// Re-exported so the session-browsing routes (Phase C-2) can type the store
// data they map without each re-deriving the deep dist/ path. The store is the
// single source of truth for these shapes; the routes render them into the
// existing wire contracts.
export type { Project, RuntimeMessage, SessionRef, Store };
import type { DispatchParams, EngineSpec, RunCtx, RunEvent } from './types';
import { ensureCockpitImport } from './cockpitImport';
import { registerApproval, unregisterApproval } from '../lib/approvalRegistry';
import {
  escalateApproval,
  escalateCheckin,
  finishCheckinEscalation,
  finishEscalation,
  sendFinalReport,
} from '../lib/telegramEscalation';
import { canLearn, learningInstruction } from '../lib/learning';
import { canSteerInstalls, harnessHomeInstruction } from '../lib/harnessHome';
import { readAutoEnableNabyHome } from '../lib/harnessImporter';
import { kickReflectionSweep } from '../lib/reflection';
import { runNestedTurn } from '../lib/delegation';
import { planTextRender } from './textRender';
import {
  canCheckIn,
  checkinInstruction,
  makeCheckinSink,
  recordGateOutcome,
} from '../lib/checkinTurn';
import {
  autonomyInstruction,
  continuationPrompt,
  decideAutonomyStep,
  isAutonomous,
  resolveMaxSteps,
  stepMarker,
  verificationNudgePrompt,
  type AutonomyDecision,
} from '../lib/autonomy';
import { isAddressable, readGrowth } from '../lib/growthRead';
import { readPersonaAutonomy } from '../lib/personaAutonomy';
import { stageInstruction } from '../lib/stageTurn';
import { fastGrowthInstruction } from '../lib/fastGrowth';

// ---------------------------------------------------------------------------
// Where the database lives.
// ---------------------------------------------------------------------------

/**
 * Resolution order, most specific first — never a hardcoded absolute path:
 *   NABY_DB_PATH   full path to the db file (tests point this at a temp dir)
 *   NABY_HOME      our own home dir; db is <NABY_HOME>/app.db
 *   COCKPIT_HOME   the shell's home dir, when running inside cockpit
 *   default        ~/.naby/app.db
 * The packaged app (and `npm run electron:dev`) passes NABY_HOME/NABY_DB_PATH =
 * ~/.naby so every launch mode shares one store; this default already resolves to
 * the same ~/.naby/app.db, so the plain `cockpit` CLI lands there too.
 */
function resolveDbPath(): string {
  const explicit = process.env.NABY_DB_PATH;
  if (explicit) return explicit;
  const home = process.env.NABY_HOME || process.env.COCKPIT_HOME;
  return home ? join(home, 'app.db') : join(homedir(), '.naby', 'app.db');
}

/** One store per server process, opened lazily. SQLite handles the concurrency;
 *  reopening per run would just churn file handles. */
let sharedStore: Store | undefined;

/** The in-house org scopeKey — kept in sync with commands.ts / harness.ts (HP-08)
 *  so policy rules key on the same org rows. */
const DEFAULT_ORG_ID = 'default';

/** How long a tool-approval prompt waits for the user before auto-denying, so a
 *  turn can never hang forever on an unanswered prompt (Phase 2 M2). */
const APPROVAL_TTL_MS = 10 * 60 * 1000;

/** Per-turn hard cap on injected skill instructions (M3). Enough for a few
 *  focused skills; over-budget candidates are dropped and counted, never silent. */
const SKILL_TOKEN_BUDGET = 2000;

/** Per-turn hard cap on injected memory tokens (Phase 3 P3-M2). The runtime
 *  already implements retrieval+injection under this budget; the shell just wires
 *  it here so learned memory reaches every turn (persona turns especially). A
 *  turn with no confirmed memory is byte-for-byte unchanged (the no-op invariant). */
const MEMORY_TOKEN_BUDGET = 2000;

/** Gather the policy rules that apply to a turn: user + org (always) and the
 *  project scope when a cwd is set. Order is irrelevant — realPolicy resolves
 *  scope precedence itself. Best-effort: a store hiccup must never break a turn. */
function gatherPolicyRules(store: Store, cwd: string | undefined): PolicyRule[] {
  const out: PolicyRule[] = [];
  try {
    out.push(...store.listPolicyRules('user', DEFAULT_USER_ID));
  } catch {
    /* ignore — no rules ⇒ baseline decides (non-breaking) */
  }
  try {
    out.push(...store.listPolicyRules('org', DEFAULT_ORG_ID));
  } catch {
    /* ignore */
  }
  if (cwd) {
    try {
      out.push(...store.listPolicyRules('project', cwd));
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Gather enabled subagents (Phase 2.5 M4) across user + org + this project, as
 *  engine-neutral SubagentSpecs. Project overrides a same-named user/org one
 *  (last-write-wins on the ordered scan). Best-effort — never break a turn. */
function gatherSubagents(store: Store, cwd: string | undefined): SubagentSpec[] {
  const items: HarnessItem[] = [];
  try {
    items.push(...store.listHarness('user', DEFAULT_USER_ID, { kind: 'subagent', status: 'enabled' }));
  } catch {
    /* ignore */
  }
  try {
    items.push(...store.listHarness('org', DEFAULT_ORG_ID, { kind: 'subagent', status: 'enabled' }));
  } catch {
    /* ignore */
  }
  if (cwd) {
    try {
      items.push(...store.listHarness('project', cwd, { kind: 'subagent', status: 'enabled' }));
    } catch {
      /* ignore */
    }
  }
  const byName = new Map<string, SubagentSpec>();
  for (const it of items) {
    if (it.kind !== 'subagent' || !it.subagent) continue;
    byName.set(it.name, {
      name: it.name,
      ...(it.description ? { description: it.description } : {}),
      systemPrompt: it.subagent.systemPrompt,
      ...(it.subagent.model ? { model: it.subagent.model } : {}),
      ...(it.subagent.toolRefs && it.subagent.toolRefs.length > 0
        ? { toolRefs: it.subagent.toolRefs }
        : {}),
    });
  }
  return [...byName.values()];
}

/** The resolved database file. Exported so a change WATCHER can watch the same
 *  file this engine writes — a view that derives from the store must refresh on
 *  the store, not on some other file that happens to be written nearby. */
export function storeDbPath(): string {
  return resolveDbPath();
}

/** Exported so the `/api/naby` route reads the SAME database this engine writes
 *  — per-session usage (F1-07) and the MCP registry (F1-08) are only coherent
 *  if the reader and the writer agree on the file. */
export function getStore(): Store {
  if (!sharedStore) {
    const path = resolveDbPath();
    mkdirSync(dirname(path), { recursive: true });
    sharedStore = new SqliteStore({ path });
    // One-time, guarded, non-fatal: carry the existing cockpit project list and
    // session↔project links into the store the first time it opens (Phase C).
    // Runs here — inside the once-per-process init — so it happens exactly once
    // and before any route reads projects out of the store.
    ensureCockpitImport(sharedStore);
    // Phase 3 P3-M1: ensure the naby agent layer has its built-in PERSONA — the
    // agent that learns the user and (P3-M2+) acts on their behalf. Idempotent:
    // seeds exactly one persona and never overwrites the user's later edits.
    seedBuiltinPersona(sharedStore);
  }
  return sharedStore;
}

// ---------------------------------------------------------------------------
// Credentials — read ONLY here, at the engine boundary.
// ---------------------------------------------------------------------------

/**
 * F1-04. Provider selection and key lookup now live in the RUNTIME
 * (`resolveProviderCredential`), not here. This file keeps its old role — the
 * one place a key is read — but no longer owns the policy for finding one.
 *
 * Why it moved: the resolution order is vault-first, environment-second, and
 * the vault is `safeStorage` in the Electron main process. The Next server runs
 * inside that same process, so the runtime reads the key through an in-process
 * bridge the main process installs; this file never imports `electron`, so the
 * plain `cockpit` CLI path still works and falls back to the env vars.
 *
 * It also made the failure testable. `preflightProvider()` is asserted directly
 * by spike-f104 with a fake key and no network — which was impossible while the
 * logic sat in a submodule module that neither the main process nor a spike
 * driver could import.
 */
type ResolvedCredential = { profile: ProviderProfile; apiKey: string };

async function resolveProvider(requestedModel?: string): Promise<ResolvedCredential | null> {
  const resolution = await resolveProviderCredential({ requestedModel });
  return resolution.ok ? { profile: resolution.value.profile, apiKey: resolution.value.apiKey } : null;
}

// ---------------------------------------------------------------------------
// Injection seam — production wiring by default, overridable for tests.
// ---------------------------------------------------------------------------

export interface NabyEngineDeps {
  /**
   * Override the model resolver. Production leaves this unset and the resolver
   * is built from the env-configured profile. SPIKE-02 injects a mock model
   * through this exact seam, so the tested path is the production path minus
   * the network.
   */
  resolveModel?: ModelResolver;
  /** Observe every gate decision, in order. Used by SPIKE-02 to prove the gate
   *  is consulted before the executor runs. */
  onGateDecision?: (entry: GateLogEntry) => void;
}

// ---------------------------------------------------------------------------
// EngineEvent → Agent-SDK-shaped RunEvent
// ---------------------------------------------------------------------------

/**
 * Runtime `Usage` → the Agent-SDK-shaped usage the chat client reads.
 *
 * THE TWO SIDES DISAGREE ABOUT OVERLAP, and getting it wrong is silent:
 *
 *   runtime  `inputTokens` is the TOTAL — cache reads and writes are INSIDE it,
 *            and `cachedInputTokens` is a subset of it (runtime/engine.ts:155).
 *   Anthropic (and therefore TokenUsageBar, which sums all three) reports the
 *            three counts DISJOINTLY.
 *
 * Passing `inputTokens` straight through as `input_tokens` therefore made the bar
 * add the cache reads a second time: the context number was inflated by exactly
 * `cachedInputTokens`, and `Cache: n%` was divided by that inflated total, so a
 * turn running at ~89% cache displayed 47%. Cost was never affected — pricing.ts
 * subtracts the cached portion itself.
 *
 * So subtract here and hand the client disjoint parts. `cache_creation` stays 0
 * because the runtime contract has no cache-write field; those tokens are folded
 * into the non-cached remainder, which keeps the SUM right — the number on screen.
 */
export function toSdkUsage(u: Usage | undefined): Record<string, number> {
  const total = u?.inputTokens ?? 0;
  // Clamp: the contract says cached <= input, but a provider that ever broke it
  // must not produce a negative input count on screen.
  const cacheRead = Math.min(u?.cachedInputTokens ?? 0, total);
  return {
    input_tokens: total - cacheRead,
    output_tokens: u?.outputTokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cacheRead,
  };
}

export function createNabySpec(deps: NabyEngineDeps = {}): EngineSpec {
  return {
    name: 'naby',

    // `runTurn` appends every user/assistant/tool row to the store as the turn
    // runs (src/runtime/session.ts). The orchestrator must not record it again.
    persistsOwnTranscript: true,

    async preflight(params: DispatchParams) {
      // A test-injected resolver supplies its own model, so no key is needed.
      if (deps.resolveModel) return { ok: true as const };
      const model = typeof params.model === 'string' ? params.model : undefined;
      // WHICH ENGINE WILL ANSWER — not just "is there a key". Since the dev
      // engine can answer with no key at all, "no API key configured" is no
      // longer the same question as "this app cannot reply to you", and
      // preflight has to ask the second one.
      //
      // Both the success and failure strings are written in the runtime, next
      // to the selection logic, for a NON-DEVELOPER: they name the thing to
      // click, not the env var to export.
      const result = await preflightEngine({
        requestedModel: model,
        ...toSelectOptions(readSettings(getStore())),
      });
      if (!result.ok) {
        return { ok: false as const, status: result.status, error: result.error };
      }
      // Logged rather than returned: `preflight`'s success shape carries no
      // message field, and inventing one would be a change to the shell's
      // engine interface (i.e. a bigger fork diff) for something the user can
      // already see in the chat header via /api/naby.
      console.log(`[engine:naby] preflight: ${result.summary}`);
      return { ok: true as const };
    },

    runner: {
      async run(ctx: RunCtx): Promise<void> {
        const startedAt = Date.now();
        // Resume when the shell hands us a session id; otherwise mint one and
        // rekey() to it below. providerId is left empty here — runTurn records
        // the provider that actually answers (it is a hint, not a constraint).
        const store = getStore();
        // Phase D — record the OWNING PROJECT on the session lifecycle (§6.1).
        // When this turn is about a directory (`ctx.cwd` is a non-empty string),
        // make sure the project row exists and bumps to the front of the MRU
        // list (`touchProject`), and LINK the session to it — a link, not a key,
        // so message/memory/usage stay keyed by sessionId alone. A projectless
        // turn (no cwd) stays fully valid: none of this runs for it, and provider
        // independence is untouched (nothing here reads or writes a provider).
        //
        // `RunCtx.cwd` is documented "normalized, may be ''", and '' is NOT a
        // directory — the length guard keeps a no-directory turn projectless end
        // to end rather than minting a project keyed by the empty string.
        const projectCwd =
          typeof ctx.cwd === 'string' && ctx.cwd.length > 0 ? ctx.cwd : undefined;
        let sessionId: string;
        if (ctx.sessionId) {
          // Resuming an existing session: link it to this turn's project.
          sessionId = ctx.sessionId;
          if (projectCwd) store.setSessionProject(sessionId, projectCwd);
        } else {
          // Minting a fresh session: create it already linked to the project.
          // providerId is left empty — runTurn records who actually answers.
          sessionId = store.createSession('', undefined, projectCwd).sessionId;
        }
        if (projectCwd) store.touchProject(projectCwd);

        // ---- may this turn LEARN? (Phase 3, P3-M10 — memory-hygiene §3) ----
        //
        // TWO SWITCHES, ONE ANSWER. `memory.learningEnabled` is the app-wide
        // setting (default ON) and `SessionRef.noLearn` is this conversation's own
        // temporary-session flag; `canCaptureMemory` is the ONE place they
        // combine, so the tool, the instruction and the reflection sweep cannot
        // end up disagreeing about whether learning is on.
        //
        // READ PER TURN, like `gate.allowChanges`, so flipping either one lands on
        // the very next message rather than on the next app start.
        //
        // WHAT IT DOES NOT TOUCH: memory INJECTION. Both switches mean "do not
        // learn from this", never "forget what you know" — already-confirmed
        // memory keeps shaping the turn in both states (§3). That asymmetry is the
        // whole reason the flag is not simply "memory off".
        const learningEnabled = readLearningEnabled(store);
        const sessionRef = store.getSession(sessionId);
        const sessionNoLearn = sessionRef?.noLearn === true;
        // ---- is this a FAST-GROWTH session? (P3-M12b, §3.3) ----------------
        //
        // Read from the SESSION ROW and from nowhere else. The user set it by
        // opening the session from the growth panel; no tool, no prompt and no
        // turn can change it. That is what lets the ledger trust the `drill` stamp
        // it derives from this flag (checkin-contracts §4, invariant 9).
        const sessionFastGrowth = sessionRef?.fastGrowth === true;
        const capturesMemory = canCaptureMemory({ learningEnabled, sessionNoLearn });
        if (!capturesMemory) {
          console.log(
            `[engine:naby] learning: OFF (${sessionNoLearn ? 'temporary session' : 'memory.learningEnabled=false'})`,
          );
        }

        // ---- session reflection, fire-and-forget (Phase 3, P3-M8a) ---------
        //
        // The next conversation is what makes the previous ones learnable (spec
        // §4.3): sessions the user walked away from are read back here, and the
        // autonomous actions they later corrected are written to the ledger.
        //
        // NOTHING BELOW WAITS FOR IT. No await, no shared state with the turn, and
        // THIS session is excluded — the user is still reacting to it, so judging
        // it now would score an unfinished exchange. A failure is logged inside
        // `kickReflectionSweep` and cannot surface in the turn.
        kickReflectionSweep(store, { excludeSessionId: sessionId });

        const requestedModel =
          typeof ctx.params.model === 'string' ? ctx.params.model : undefined;

        // ---- which engine answers, and on what ----------------------------
        //
        // TWO BACKENDS BEHIND ONE SEAM (contract §2). `AiSdkEngine` needs a
        // provider API key; `ClaudeAgentSdkEngine` needs none — it runs on the
        // Claude sign-in already on this computer. The runtime's `selectEngine`
        // owns the policy (explicit NABY_ENGINE first, then a configured
        // provider, then the dev engine); this file only builds what it is told
        // to build, so the decision stays testable outside the submodule.
        //
        // The dev engine is only ever REACHABLE in an unpackaged build:
        // electron-builder excludes the Agent SDK, and the runtime imports it
        // lazily, so in a shipped app `selectEngine` never picks it and nothing
        // here loads it.
        let engine: Engine;
        // TWO DIFFERENT THINGS, deliberately not one variable:
        //   modelLabel     — for display (the init event the UI renders).
        //   modelForEngine — the FUNCTIONAL model id handed to the engine, or
        //                    undefined to mean "use your own default".
        // Collapsing them is a real bug, not a style question: the dev engine
        // passes `ModelSelection.model` straight to the Agent SDK's `model`
        // option, so a friendly label like "claude (local sign-in)" is sent as
        // a model id and the SDK rejects the turn with "there's an issue with
        // the selected model". A label must never reach a functional field.
        let modelLabel: string;
        let modelForEngine: string | undefined;
        // The id of the provider that actually answers. Captured from the
        // resolution rather than re-derived later, so the ModelSelection can
        // never name a different provider than the one whose key was used.
        let providerId = 'injected';
        let engineId = 'ai-sdk';
        let costBasis: 'metered' | 'subscription' = 'metered';

        if (deps.resolveModel) {
          // A test-injected resolver supplies its own model, so no key and no
          // engine selection are needed — this is the SPIKE-02 seam.
          const resolveModel: ModelResolver = deps.resolveModel;
          modelLabel = requestedModel || 'injected-model';
          modelForEngine = modelLabel;
          engine = new AiSdkEngine({ resolveModel });
        } else {
          // The user's stored choice (F1-08) rides in as options, so the
          // selection policy itself stays in the runtime and testable.
          const settings = readSettings(store);
          const selection = await selectEngine({
            requestedModel,
            ...toSelectOptions(settings),
          });
          if (!selection.ok) {
            // preflight normally catches this; belt-and-braces for the
            // scheduled-task path, which may call run() directly.
            ctx.emit({ type: 'error', error: selection.message });
            ctx.emit({
              type: 'result',
              subtype: 'error_during_execution',
              session_id: sessionId,
              is_error: true,
              result: selection.message,
              usage: toSdkUsage(undefined),
              total_cost_usd: 0,
              duration_ms: Date.now() - startedAt,
              num_turns: 0,
            });
            return;
          }

          if (selection.engine === 'dev-claude') {
            // No key is read on this path AT ALL — that is the point of it.
            engine = new ClaudeAgentSdkEngine();
            engineId = 'dev-claude';
            costBasis = 'subscription';
            providerId = 'dev-claude';
            // May be undefined — that means "the Agent SDK picks its own
            // default", which is the normal case and must stay undefined
            // rather than becoming a made-up string.
            modelForEngine = selection.model ?? requestedModel;
            modelLabel = modelForEngine ?? 'claude (local sign-in)';
            console.log(`[engine:naby] ${selection.summary}`);
          } else if (
            isChatgptOauthEnabled() &&
            settings.selectedProvider === CHATGPT_OAUTH_PROVIDER_ID
          ) {
            // DEV-ONLY (CO-05), flag-sealed. The ChatGPT subscription provider
            // answers through AiSdkEngine like a metered provider, but its
            // credential is a live OAuth token SOURCE — injected by the Electron
            // main process into the runtime seam (boot.ts). No api key is read
            // on this path; the transport pulls a fresh token per request and
            // refreshes/rotates behind a 401. A missing sign-in surfaces as
            // "sign in again" at turn time (the source throws), which is exactly
            // the right message rather than a spurious "no key". Live queries
            // still need the owner's ChatGPT sign-in (CO-06).
            const source = getChatgptTokenSource();
            if (!source) {
              const message =
                'ChatGPT subscription sign-in is not initialized. Open Settings → AI provider and sign in with ChatGPT first.';
              ctx.emit({ type: 'error', error: message, session_id: sessionId });
              ctx.emit({
                type: 'result',
                subtype: 'error_during_execution',
                session_id: sessionId,
                is_error: true,
                result: message,
                usage: toSdkUsage(undefined),
                total_cost_usd: 0,
                duration_ms: Date.now() - startedAt,
                num_turns: 0,
              });
              return;
            }
            const model = requestedModel || CHATGPT_OAUTH_DEFAULT_MODEL;
            const profile: ProviderProfile = {
              id: CHATGPT_OAUTH_PROVIDER_ID,
              label: CHATGPT_OAUTH_LABEL,
              kind: 'openai-chatgpt-oauth',
              config: { kind: 'openai-chatgpt-oauth' },
              model,
              credentialRef: 'chatgpt-oauth',
            };
            modelLabel = model;
            modelForEngine = model;
            providerId = CHATGPT_OAUTH_PROVIDER_ID;
            engineId = 'ai-sdk';
            // Subscription turn — no invented per-message dollar bill (F1-07),
            // the same treatment the Claude dev engine gets.
            costBasis = 'subscription';
            const base = makeModelResolver([profile], () => ({ kind: 'chatgpt-oauth', source }));
            engine = new AiSdkEngine({
              resolveModel: (selectionArg) => base(selectionArg.providerId, selectionArg.model),
            });
            console.log(`[engine:naby] ${selection.summary}`);
          } else {
            const resolved = await resolveProvider(requestedModel);
            if (!resolved) {
              // selectEngine said a credential resolves, so this is a race
              // (a key cleared between the two calls), not a normal path.
              const message =
                'The provider key changed while this message was being sent. Please try again.';
              ctx.emit({ type: 'error', error: message });
              ctx.emit({
                type: 'result',
                subtype: 'error_during_execution',
                session_id: sessionId,
                is_error: true,
                result: message,
                usage: toSdkUsage(undefined),
                total_cost_usd: 0,
                duration_ms: Date.now() - startedAt,
                num_turns: 0,
              });
              return;
            }
            const { profile, apiKey } = resolved;
            modelLabel = profile.model;
            modelForEngine = profile.model;
            providerId = profile.id;
            const base = makeModelResolver([profile], () => apiKeyCredential(apiKey));
            // Our ModelResolver takes a ModelSelection; makeModelResolver's
            // signature is (providerId, model?). Bridge the two.
            engine = new AiSdkEngine({
              resolveModel: (selectionArg) => base(selectionArg.providerId, selectionArg.model),
            });
          }
        }

        // ---- @agent routing, resolved early (Phase 3, P3-M2) --------------
        //
        // When the prompt begins with `@<name>` and <name> resolves to a
        // registered naby agent, route THIS turn to that agent: adopt its system
        // prompt (its persona), strip the `@name` off the task text, and (if set)
        // prefer its model and restrict it to its allowed tools. The command
        // expander already declined to expand an `@<registeredAgent>` line
        // (slashCommands collision rule), so the address survives to here.
        //
        // Resolved HERE, before the toolset, because P3-M4's learning sink needs
        // the agent's `memoryScope` as the default scope for what it captures.
        // Everything else derived from the agent stays below the toolset.
        const addressed = parseAgentAddress(ctx.prompt ?? '');
        // The agent the `@name` NAMES. Whether it may actually be delegated to is
        // a separate question, answered immediately below.
        const addressedAgent: Agent | undefined = addressed
          ? store.getAgentByName(addressed.name)
          : undefined;

        // ---- ONE `@` GATE (P3-M9 G2), REDEFINED (P3-M12a) ------------------
        //
        // WHAT THE GATE MEANS NOW. Through M9 this was a MENTION gate: an agent
        // that was not a butterfly was not routed to at all, and the turn ran
        // unrouted. That was one surface's answer to a real problem (the palette
        // and routing must agree), but it made a young agent useless — and an
        // agent nobody may call never gets the conversations it would grow from.
        //
        // So the line MOVED rather than loosened (trust-meter §4.9 0.7.0,
        // fast-evolution §3.1): `@name` routes at ANY stage, and the stage decides
        // the ACTION RANGE. `canBeAddressed` still means exactly what it did —
        // only a butterfly is true — but what it now gates is AUTONOMOUS
        // DELEGATION, not the mention. The palette sends the same flag and the
        // same read (`isAddressable` over `readGrowth`), so the two surfaces still
        // cannot drift; they just agree about a different thing.
        const addressable = addressedAgent ? isAddressable(store, addressedAgent.id) : false;
        // THE ADDRESS IS HONOURED. Identity, model, toolRefs and memory scope all
        // follow the named agent whatever its stage; what a sub-butterfly does NOT
        // get is free rein, and that is enforced below in two places — the step
        // budget and the tool gate.
        const routedAgent: Agent | undefined = addressedAgent;
        // The stage this turn is bound by, and the contract that follows from it.
        // Read ONCE (a ledger read per tool call would re-query the same rows) and
        // only for a routed agent: an ordinary, unaddressed turn is untouched by
        // all of this, byte for byte.
        //
        // FAIL-CLOSED by construction: `readGrowth` turns an unreadable ledger into
        // an egg, so an agent whose record cannot be established gets the narrowest
        // contract rather than the widest.
        const routedGrowth = routedAgent ? readGrowth(store, routedAgent.id) : undefined;
        const routedStage = routedGrowth?.stage;
        // Undefined for a butterfly (and for an unrouted turn): there is nothing to
        // enforce, so nothing below runs and no instruction is injected.
        const contract =
          routedStage && !addressable ? stageContract(routedStage) : undefined;

        // ---- WHOSE AGENT THIS TURN BELONGS TO (Phase 3, P3-M5) ------------
        //
        // Distinct from `routedAgent`, and the distinction matters:
        //
        //   routedAgent    the agent whose IDENTITY this turn adopts — its system
        //                  prompt, model, tool restriction, autonomy. Only set by
        //                  an explicit `@name`.
        //   growthSubject  the agent this turn's OBSERVATIONS belong to — its
        //                  memory and its growth ledger. On a plain turn that is
        //                  the built-in persona, because naby IS the persona: the
        //                  product is an agent that learns its user from the work
        //                  they actually do.
        //
        // WHY THIS CHANGED. M4a deliberately attached learning only to a routed
        // agent, to keep a normal turn's tool list untouched. Combined with M5's
        // mention gate that produced a DEADLOCK: the persona cannot be `@`-addressed
        // until it is a butterfly, it cannot become a butterfly without check-ins,
        // and it could not check in unless it was addressed. Gating observation on
        // being trusted meant it could never earn trust. So observation now follows
        // the persona onto ordinary turns, while ADDRESSING it still has to be
        // earned — which is what the gate was actually for.
        //
        // A turn routed to a CUSTOM agent belongs to that agent, not the persona:
        // work handed to a specialist should not teach the persona it did the work.
        const persona = routedAgent ? undefined : store.getAgent(BUILTIN_PERSONA_ID);
        const growthSubject: Agent | undefined = routedAgent ?? persona;

        // ---- runtime construction ----------------------------------------
        const outbox = new Outbox();
        // Pass the store so the agent gets `naby_add_mcp` — it can register an MCP
        // server the user asks for (as a PROPOSAL; a human approves it in Settings
        // before it runs — makeAddMcp). Without a store the tool is simply absent.
        //
        // P3-M4a: the LEARNING sink adds `naby_remember`, so the agent can write
        // down what it learned about the user. Built per turn because it carries
        // this turn's scope keys (session id, project cwd) — scope→key resolution
        // lives in the runtime (contract §2), not here. Like the MCP tool, every
        // capture lands as a PROPOSAL, so it cannot shape an answer until the user
        // confirms it in the memory review UI.
        //
        // BOTH SINKS FOLLOW `growthSubject`, not `routedAgent` (P3-M5). A plain
        // chat turn is the PERSONA's turn, so it learns and it checks in there
        // too — see the growthSubject comment for why gating this on `@` had made
        // the meter unable to move. The tool is still absent when there is no
        // subject at all (no persona row yet), so nothing half-runs.
        //
        // P3-M5: the CHECK-IN sink adds `naby_checkin`, which suspends the turn on
        // a question and writes the answer to the eval-event ledger — the labelled
        // predictions the trust meter is computed from. Built per turn because it
        // closes over this turn's emit and abort signal.
        //
        // P3-M10: a TEMPORARY session checks in about nothing. A check-in writes a
        // labelled prediction to the growth ledger, which is the agent learning
        // about itself from this conversation — the same thing the flag switches
        // off for memory. The app-wide `memory.learningEnabled` switch does NOT
        // reach here (§3 scopes it to memory capture); only `noLearn` does, which
        // is why this reads `sessionNoLearn` rather than `capturesMemory`.
        const checkinSink =
          growthSubject && canCheckIn(growthSubject) && !sessionNoLearn
            ? makeCheckinSink({
                store,
                agentId: growthSubject.id,
                sessionId,
                emit: (event) => ctx.emit(event as RunEvent),
                signal: ctx.signal,
                ttlMs: APPROVAL_TTL_MS,
                now: () => Date.now(),
                // P3-M12c: EVERY row this sink writes in a fast-growth session is
                // a drill. Resolved here, from the session, once per turn — the
                // model is never asked and its tool input is never consulted.
                ...(sessionFastGrowth ? { drill: true } : {}),
                // P3-M3b's channel, for check-ins too: an agent set to escalate
                // sends its question to the phone as numbered buttons. `escalation`
                // is resolved below, so it is read through a getter-free closure
                // here — the sink is built before that line and only CALLS these
                // once a check-in actually happens.
                escalate: {
                  send: (input) => {
                    if (!escalateToTelegram) return;
                    void escalateCheckin({
                      store,
                      ...input,
                      now: Date.now(),
                      ...(routedAgent ? { agentName: routedAgent.name } : {}),
                      ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
                    });
                  },
                  finish: (input) => {
                    if (!escalateToTelegram) return;
                    void finishCheckinEscalation({ store, ...input });
                  },
                },
              })
            : undefined;
        // Phase 2.5 M4b: SUBAGENTS ON AN ENGINE WITH NO NATIVE ONES. dev-claude
        // maps SubagentSpec onto the Agent SDK's own `agents` (delegated through
        // its gated Task tool), so it needs nothing here. The AI-SDK engine had no
        // equivalent and simply ignored the specs — the same imported subagents
        // were reachable on one engine and invisible on the other, which is exactly
        // the provider-dependence the runtime exists to prevent. `naby_delegate`
        // closes that: the subagent runs as a nested turn behind THIS turn's gate.
        //
        // The sink is built even when the roster is empty; `canDelegate` inside
        // buildToolset decides whether the tool is actually offered, so a turn never
        // advertises delegation it cannot perform.
        const nativeSubagents = engineId === 'dev-claude';
        const delegationSink = nativeSubagents
          ? undefined
          : {
              subagents: gatherSubagents(store, projectCwd),
              // The user's own turn. A nested run gets depth + 1, which is what the
              // runtime's cap counts against.
              depth: 0,
              run: (input: { spec: SubagentSpec; task: string }) =>
                runNestedTurn(
                  {
                    store,
                    engine,
                    model: { providerId, ...(modelForEngine ? { model: modelForEngine } : {}) },
                    // THE PARENT'S GATE, passed down unchanged — see lib/delegation.
                    gate,
                    toolSchemas,
                    executors,
                    signal: ctx.signal,
                    ...(projectCwd ? { cwd: projectCwd } : {}),
                    onSession: (childId, spec) =>
                      console.log(`[engine:naby] delegated to @${spec.name} in session ${childId}`),
                  },
                  input,
                ),
            };

        // THE TWO PERMISSION SWITCHES, read before the toolset because they
        // decide which tools it contains.
        //
        // `gate.allowChanges` (default ON) is the app-wide toggle; read per turn
        // so flipping it lands on the next message. `permissionMode: 'plan'` is
        // the per-tab plan-mode checkbox — read-only, plan first, edit nothing.
        // Plan mode used to be sent only to the Claude engine and was a NO-OP
        // here, so the checkbox promised something this engine never did. It is
        // honoured now, and it wins over the toggle: a user who asked for a plan
        // has said what they want more recently than the global default.
        const allowChanges =
          (getStore().getSetting('gate.allowChanges') ?? 'true') !== 'false';
        const planMode = ctx.params.permissionMode === 'plan';

        //
        // P3-M10 (§3): with learning off — app-wide or for this one session — the
        // sink is ABSENT, so `naby_remember` is not in the toolset at all. Not
        // gated, not denied: absent. A tool the model can see but never use
        // produces a turn that keeps trying and keeps being refused, which reads
        // as the assistant being broken rather than as the setting working (the
        // same reasoning as plan mode and the workspace tools above).
        const builtin = buildToolset(
          outbox,
          store,
          growthSubject && capturesMemory
            ? {
                putMemory: (req) => store.putMemory(req),
                sessionId,
                ...(projectCwd ? { cwd: projectCwd } : {}),
                userId: DEFAULT_USER_ID,
                defaultScope: growthSubject.memoryScope,
              }
            : undefined,
          checkinSink,
          delegationSink,
        );

        // ---- MCP tools (F1-08) -------------------------------------------
        //
        // The registry is provider-independent (contract §5) and lives in the
        // same store as everything else, so the SAME servers are loaded
        // whichever engine was selected above.
        //
        // These come back as execute-less schemas plus runtime Executors — the
        // runtime loads them with `listTools()` and dispatches with
        // `callTool()`, never AI SDK's auto-executing `tools()`. That is what
        // puts an MCP call on exactly the same path as a built-in one: through
        // the gate below, which runs before ANY executor.
        //
        // A server that is down yields a failure entry, not an exception — one
        // unreachable MCP server must not stop the user from chatting.
        let mcp: McpLoadResult | undefined;
        try {
          // Only ACTIVE servers become tools — an agent-proposed one
          // (status:'proposed') is stored and shown in Settings but never loaded
          // until the user approves it (isMcpEntryActive / mcp.approve).
          mcp = await loadMcpToolset(store.listMcpEntries().filter(isMcpEntryActive));
          for (const failure of mcp.failures) {
            console.warn(`[engine:naby] MCP server "${failure.name}" unavailable: ${failure.message}`);
          }
        } catch (e) {
          console.warn(
            `[engine:naby] MCP registry could not be loaded: ${e instanceof Error ? e.message : String(e)}`,
          );
        }

        // THE WORKSPACE TOOLS — read/search/edit/run over the open project.
        //
        // Added HERE rather than inside buildToolset because they need two things
        // only this composition root knows: the project directory, and whether
        // this turn is allowed to change anything.
        //
        // NOT ON dev-claude. The Claude Agent SDK brings its own
        // Read/Glob/Grep/Write/Edit/Bash, and offering a second, near-identical
        // set alongside them makes the model pick between two tools that do the
        // same job — for no gain, since that engine was never the one that
        // couldn't read a file. This exists for every OTHER provider, where our
        // tools are the only ones there are.
        //
        // PLAN MODE and ALLOW CHANGES both land on `allowMutations`. When it is
        // false the mutating tools are not merely gated, they are absent from the
        // schema list: a tool the model can see but never use produces a turn
        // that keeps trying and keeps being refused, which reads as the assistant
        // being broken rather than as the mode working.
        const workspace =
          projectCwd && engineId !== 'dev-claude'
            ? buildWorkspaceTools({
                cwd: projectCwd,
                allowMutations: !planMode && allowChanges,
              })
            : undefined;

        const toolSchemas: ToolSchema[] = [
          ...builtin.toolSchemas,
          ...(workspace?.toolSchemas ?? []),
          ...(mcp?.toolSchemas ?? []),
        ];
        const executors: Record<string, Executor> = {
          ...builtin.executors,
          ...(workspace?.executors ?? {}),
          ...(mcp?.executors ?? {}),
        };

        // ---- @agent routing, continued (Phase 3, P3-M2) -------------------
        //
        // `routedAgent` was resolved ABOVE the toolset (the learning sink needs
        // its memory scope); everything derived from it is here.
        if (addressed && !addressedAgent) {
          // `@something` that is not a registered agent: leave the prompt intact
          // (it may be prose, or a harness `@verb` the expander already handled).
          console.log(`[engine:naby] @${addressed.name}: no such agent — not routed`);
        }
        if (addressedAgent && contract && routedStage) {
          // A SUB-BUTTERFLY ADDRESS IS ROUTED, NOT REFUSED (P3-M12a). The agent
          // answers as itself; what it may DO is narrowed by its stage.
          //
          // The user is still TOLD, on the same muted harness pill, because the
          // turn behaves differently from a butterfly's and a silent narrowing
          // would read as the agent being oddly unhelpful. The pill carries a
          // CODE, not a sentence — the server has no locale (the same reason
          // `growthReport.change` is a code) — and the code now names the STAGE,
          // since "not a butterfly" is no longer the whole story.
          console.log(
            `[engine:naby] @${addressedAgent.name}: routed at the ${routedStage} stage` +
              ` (consequential=${contract.allowConsequential}, irreversible=${contract.allowIrreversible},` +
              ` maxSteps<=${String(contract.maxSteps)})`,
          );
          ctx.emit({
            type: 'system',
            subtype: 'harness',
            session_id: sessionId,
            harness_subtype: 'routing-gate',
            harness_detail: `stage-limited:${routedStage}:${addressedAgent.name}`,
          } satisfies RunEvent);
        }
        if (routedAgent) {
          console.log(
            `[engine:naby] routed to @${routedAgent.name} (kind=${routedAgent.kind}` +
              `${routedAgent.model ? `, model=${routedAgent.model}` : ''}` +
              `${routedAgent.toolRefs ? `, tools=${routedAgent.toolRefs.length}` : ''})`,
          );
        }
        // The task text after the address is what the model answers; the address
        // itself is consumed by routing and never sent.
        //
        // Keyed on `addressedAgent`, not `routedAgent`: a refused address was
        // still an address, and the words after it were the user's actual request.
        // Leaving the `@name` in would send the model a handle it has no reason to
        // understand, and stripping the whole line would throw the request away.
        const turnText = addressedAgent ? addressed!.taskText : ctx.prompt ?? '';
        // ---- how much this turn is allowed to do on its own ----------------
        //
        // Phase 3 P3-M9 (G1): FOR THE PERSONA, THAT IS THE USER'S SETTING, NOT THE
        // ROW'S. The persona is read-only, so its `autonomy` field can never say
        // anything but what the seed said — reading it would pin every install to
        // "ask inline, one turn" forever. The user's answer lives in settings
        // (`persona.autonomy.*`), which is the surface they can actually reach.
        //
        // Custom agents keep reading their own row: it is editable, so the config
        // is already where the user can change it, and a second surface would only
        // split the answer in two.
        const personaDelegation =
          routedAgent?.kind === 'persona' ? readPersonaAutonomy(store) : undefined;
        // Phase 3 P3-M3b: WHERE THIS TURN'S CRITICAL DECISIONS GO. 'inline'
        // (default) is the M2 in-app prompt alone, 'telegram'/'both' ALSO send the
        // question — and the end-of-turn report — out over Telegram. Only a routed
        // agent can opt in, so an ordinary turn is byte-for-byte unchanged (no
        // config read, no send).
        const escalation =
          personaDelegation?.escalation ?? routedAgent?.autonomy.escalation ?? 'inline';
        const escalateToTelegram = escalation === 'telegram' || escalation === 'both';
        // A routed agent limited to `toolRefs` may call ONLY those tools; the gate
        // denies anything else (an allowlist, engine-independent). No toolRefs =
        // no restriction (the built-in persona is unrestricted by default).
        const agentAllowedTools = routedAgent?.toolRefs;
        // The turn's system prompt: the routed agent's persona (if any) followed
        // by the working-directory note. Memory + skills are folded in ABOVE this
        // by the runtime. Undefined when neither applies (byte-for-byte no-op).
        const shellNote = ctx.cwd
          ? `You are running inside the naby shell. Working directory: ${ctx.cwd}`
          : undefined;
        // Phase 3 P3-M3c: HOW MANY STEPS THIS AGENT MAY TAKE ALONE. 1 (or no
        // config) is a plain single-turn chat — nothing below runs and the system
        // prompt is untouched. >1 injects the autonomy protocol and lets the loop
        // around runTurn drive the agent until it is done, errors, is stopped, or
        // spends the budget. Clamped in `resolveMaxSteps`, so the store cannot ask
        // for an unbounded agent. See lib/autonomy.ts for the three safety rules.
        //
        // P3-M9: for a persona turn the number comes from the user's settings (see
        // `personaDelegation` above). It is already clamped on the way in AND on
        // the way out of the store, so what Settings shows is what runs; passing it
        // through `resolveMaxSteps` again is idempotent and keeps ONE clamp in the
        // codebase rather than two that could disagree.
        const configuredMaxSteps = resolveMaxSteps(
          personaDelegation ? personaDelegation.maxSteps : routedAgent?.autonomy.maxSteps,
        );
        // P3-M12a: THE STAGE CEILING. A sub-butterfly agent takes the SMALLER of
        // its stage's ceiling and what the user configured — the contract can only
        // ever narrow, never widen, so nothing here can hand an agent more
        // autonomy than its settings already allowed. A butterfly's contract has
        // no number (`maxSteps: undefined`) precisely so that this line is a no-op
        // for it and the persona setting stays the single source of truth.
        const maxSteps =
          contract?.maxSteps !== undefined
            ? Math.min(contract.maxSteps, configuredMaxSteps)
            : configuredMaxSteps;
        if (contract && maxSteps !== configuredMaxSteps) {
          console.log(
            `[engine:naby] stage contract: steps ${configuredMaxSteps} → ${maxSteps} (${routedStage})`,
          );
        }
        const autonomous = isAutonomous(maxSteps);
        if (autonomous) {
          console.log(`[engine:naby] autonomy: up to ${maxSteps} steps (@${routedAgent?.name})`);
        }
        // Phase 3 P3-M4b: TELL THE AGENT TO LEARN. Only when `naby_remember` can
        // actually land this turn — a routed agent whose allowlist (if any)
        // includes the tool. Instructing an agent to call a tool its own gate
        // would deny is the "silent half-run" the skill injection also refuses.
        //
        // P3-M5: keyed on `growthSubject`, so the persona learns from ordinary
        // turns too — the tool is built for the same subject, so the instruction
        // and the tool's presence can never disagree.
        //
        // P3-M10: AND the two sovereignty switches. `capturesMemory` is the exact
        // condition the memory sink above was built on, so the instruction and the
        // tool's presence still cannot disagree — which is what this line has
        // always been for; it just has one more reason the tool might be missing.
        const learns = capturesMemory && canLearn(growthSubject);
        if (learns) {
          console.log(
            `[engine:naby] learning: on (@${growthSubject?.name}, scope=${growthSubject?.memoryScope})`,
          );
        }
        // Phase 3 P3-M5: TELL THE AGENT TO CHECK IN. Same condition as the sink
        // above, so the words are only ever present alongside the tool.
        const checksIn = checkinSink !== undefined;
        // P3-M12e: WHOSE RECORD THE CHECK-IN WORDING FOLLOWS. The instruction leans
        // harder on asking while the subject's record is still short — that is the
        // fix for a ledger real usage could not move (hundreds of autonomous rows,
        // zero real check-ins), and it needs the subject's stage to know when to
        // stop leaning.
        //
        // ONE READ, AT MOST, AND ONLY WHEN THE TOOL IS THERE. A routed turn already
        // read exactly this ledger (`routedGrowth`, and the routed agent IS the
        // subject then), so it is reused; an ordinary persona turn pays for one
        // ledger read, the same one the fast-growth block below now shares instead
        // of repeating. A turn without a check-in tool reads nothing at all.
        //
        // FAILS TOWARD ASKING: `readGrowth` turns an unreadable ledger into an egg,
        // and undefined reads as "not measured yet" in the instruction — an agent
        // whose record cannot be established should be asking.
        const subjectGrowth =
          checksIn && growthSubject
            ? routedGrowth && routedAgent?.id === growthSubject.id
              ? routedGrowth
              : readGrowth(store, growthSubject.id)
            : undefined;
        if (checksIn) {
          console.log(
            `[engine:naby] check-ins: on (@${growthSubject?.name}, record: ` +
              `${subjectGrowth?.stage ?? 'unreadable'})`,
          );
        }
        // skill-hub-builtin §2.5: TELL THE AGENT WHERE INSTALLS GO. A hub's own
        // install instructions name `~/.claude` (they are written for another
        // product), so without this the model installs the user's new skills into
        // the vendor's directory instead of naby's own harness home. Gated on a
        // configured skill-hub entry, not on this turn's MCP connection: see
        // lib/harnessHome.ts for why the registry read is the stable test.
        const steersInstalls = canSteerInstalls(store);
        if (steersInstalls) {
          console.log('[engine:naby] install steering: on (naby harness home)');
        }
        // Phase 3 P3-M12a: TELL THE AGENT ITS OWN CONTRACT, and the real numbers
        // behind it. Injected only when a contract is actually in force (a routed
        // sub-butterfly), so a butterfly's turn and every ordinary turn are
        // untouched. Paired with the gate below exactly as the check-in
        // instruction is paired with its tool: the words and the enforcement are
        // built from the SAME `contract`, so they cannot promise different things.
        const stageLimited = contract !== undefined && routedStage !== undefined;
        // Phase 3 P3-M12b: THE FAST-GROWTH SESSION'S JOB. Only for the PERSONA —
        // this session exists to teach naby about its user, and pointing a
        // specialist agent at the user's private life is neither what the button
        // said nor what the memory scope is for.
        //
        // P3-M10 still wins: a temporary session learns nothing AND writes no
        // ledger row, so neither half of the sitting would leave anything behind
        // and the block is not injected.
        //
        // P3-M12b-5: ONE flag for the WHOLE sitting, not just its interview half.
        // The block it gates now carries both parts — get your bearings, then
        // practise predicting them — because a fast-growth session that only
        // interviewed produced a growth report reading 0/0 (fast-evolution §3.3d).
        const runsFastGrowthSitting =
          sessionFastGrowth && !sessionNoLearn && growthSubject?.id === BUILTIN_PERSONA_ID;
        // Phase 3 P3-M13c (§3.3): THE STYLE FINGERPRINT, as one compact line.
        //
        // PERSONA ONLY, like the fast-growth block. The fingerprint describes how
        // the USER writes, and asking a specialist sub-agent to imitate it would
        // apply a personal voice to work that was routed away from the persona
        // precisely because it is not personal.
        //
        // IT IS NOT GATED ON `capturesMemory`, and that asymmetry is deliberate:
        // the gates decide whether naby LEARNS, never whether it uses what it has
        // already learned — the same rule that keeps confirmed memory injecting
        // with learning off (§3, and the note above). The gate applies to the
        // sweep that WRITES the fingerprint.
        //
        // Below `STYLE_FINGERPRINT_MIN_SAMPLES` the renderer returns undefined and
        // this contributes nothing at all, so a fresh install's turn is
        // byte-for-byte what it was.
        const styleLine =
          growthSubject?.id === BUILTIN_PERSONA_ID
            ? (() => {
                try {
                  return renderStyleFingerprintLine(
                    parseStyleFingerprint(store.getSetting(STYLE_FINGERPRINT_KEY)),
                  );
                } catch {
                  // An unreadable setting is not a reason to fail a turn; it is a
                  // reason to send the turn naby would have sent last month.
                  return undefined;
                }
              })()
            : undefined;
        if (styleLine) console.log('[engine:naby] style fingerprint: injected');
        // ---- the fast-growth session's THREE REAL NUMBERS (P3-M12b-5) --------
        //
        // Computed HERE and handed to the pure text builder, for the reason the
        // stage instruction's numbers are (`stageProgressSummary` two blocks up):
        // a model asked how far along it is writes an encouraging sentence, and an
        // encouraging sentence about a number the user can read off the growth
        // panel is how the meter loses its credibility.
        //
        // EVERY READ IS BEST-EFFORT AND FAILS TOWARD THE HARMLESS ANSWER. An
        // unreadable memory store reads as sparse (naby asks a question instead of
        // inventing a scenario about someone it does not know); an unreadable
        // ledger reads as "nothing practised yet, minimum sample still to go",
        // which is what an agent with no measured history actually has.
        //
        // Skipped entirely on every other turn — an ordinary conversation must not
        // pay for three extra queries it will not use.
        const fastGrowthCounts =
          runsFastGrowthSitting && growthSubject
            ? {
                // WHAT IS CONFIRMED, not what is proposed: proposals are guesses
                // nobody has checked, and practising against them would practise
                // naby's own inventions.
                confirmedUserMemories: (() => {
                  try {
                    return store.countScopedMemory('user', DEFAULT_USER_ID, {
                      status: 'confirmed',
                    });
                  } catch {
                    return 0;
                  }
                })(),
                // HOW MANY PRACTICE CHECK-INS THIS SESSION HAS ALREADY RECORDED.
                // Counted off the ledger rows themselves rather than tracked in
                // memory: those rows are what the growth panel shows, so the
                // sentence naby closes the sitting with and the number the user can
                // go and check come from one place. `drill === true` and not merely
                // "a check-in in this session" — the stamp is the sink's, taken from
                // the session flag, and a row without it was real work.
                practiceThisSession: (() => {
                  try {
                    return store
                      .listEvalEvents(growthSubject.id, { kind: 'checkin', sessionId })
                      .filter((row) => row.drill === true).length;
                  } catch {
                    return 0;
                  }
                })(),
                // HOW MANY REAL CHECK-INS ARE STILL OWED before the stage can be
                // read at all. The SAME source `stageProgressSummary` uses for the
                // honest refusal, so the two instructions cannot quote different
                // numbers at the same user on the same day. `kind: 'samples'` is the
                // only case with a count; once the sample is in, nothing is owed.
                realCheckinsRemaining: (() => {
                  try {
                    // The reading the check-in wording already took this turn
                    // (`subjectGrowth`), so the sitting's closing sentence and the
                    // instruction above it cannot be computed from two different
                    // reads of the same ledger. The fallback covers the one case
                    // that has no check-in tool and therefore no reading.
                    const progress = stageProgressSummary(
                      subjectGrowth ?? readGrowth(store, growthSubject.id),
                    );
                    return progress.kind === 'samples' ? progress.remaining : 0;
                  } catch {
                    return 0;
                  }
                })(),
              }
            : undefined;
        if (fastGrowthCounts) {
          console.log(
            `[engine:naby] fast-growth session: on (confirmed user memories: ` +
              `${fastGrowthCounts.confirmedUserMemories}, practice check-ins this session: ` +
              `${fastGrowthCounts.practiceThisSession}, real check-ins still needed: ` +
              `${fastGrowthCounts.realCheckinsRemaining})`,
          );
        }
        const turnSystem =
          [
            routedAgent?.systemPrompt,
            shellNote,
            stageLimited
              ? stageInstruction(routedStage, stageProgressSummary(routedGrowth!))
              : undefined,
            autonomous ? autonomyInstruction(maxSteps) : undefined,
            learns && growthSubject ? learningInstruction(growthSubject) : undefined,
            // The stage picks the WORDING only (checkinTurn.ts): the block never
            // names a stage, a number or anything that is counted.
            checksIn ? checkinInstruction(subjectGrowth?.stage) : undefined,
            fastGrowthCounts ? fastGrowthInstruction(fastGrowthCounts) : undefined,
            // The arrival-state sentence follows the auto-enable kill switch
            // (invariant 7): the model states what actually happens, not a
            // wording frozen before the switch existed.
            steersInstalls
              ? harnessHomeInstruction(projectCwd, undefined, readAutoEnableNabyHome(store))
              : undefined,
            // LAST of the instruction blocks. Style is the weakest claim in the
            // prompt — it says how to phrase whatever the rest of it decided —
            // so it sits after everything it must not override.
            styleLine,
          ]
            .filter(Boolean)
            .join('\n\n') || undefined;

        // ---- the gate ----------------------------------------------------
        //
        // Built HERE (after the toolset) because the Phase-1 floor needs to
        // know THIS turn's runtime tool names — they are always allowed (they
        // are our own executors, gated for real in Phase 2), while everything
        // else is decided by the floor.
        //
        // WHY A FLOOR AND NOT ALLOW-ALL. The dev engine now runs with the SDK's
        // built-ins ENABLED (so Task / Skill / subagents actually run and their
        // activity can be shown). An allow-all policy would then auto-approve a
        // subagent's internal Bash / Write / Edit — i.e. a real mutation/exec
        // hole. `phase1HarnessFloor` is the minimal safe policy for that world:
        // deny-by-default, allow read-only inspection + delegation + skills +
        // our runtime tools, DENY Bash/Write/Edit/… from the main loop AND from
        // inside any subagent (the PreToolUse gate reaches both — verified in
        // spike-harness-visibility). It is NOT the Phase-2 policy engine (no
        // per-project rules, no approval UI); it is the safety floor that makes
        // observation safe until Phase 2 replaces it.
        //
        // The prod (AI-SDK) engine's tools ARE these same runtime tools, so
        // passing the runtime tool names covers that path too: its calls are on
        // the allowlist and pass, while it has no built-ins to deny.
        const runtimeToolNames = toolSchemas.map((t) => t.name);
        // Phase 2.5 (M3): the bare names of every tool THIS turn can run — runtime
        // tools + MCP (both in toolSchemas) plus, on the Claude Agent SDK engine,
        // its built-ins (Read/Bash/Write/…). A tool-bearing skill is only injected
        // when all its toolRefs are here, so a skill never half-runs against a tool
        // the turn cannot call. The AI-SDK engine has no built-ins, so its set is
        // just the runtime/MCP tools.
        const availableTools =
          engineId === 'dev-claude'
            ? [...runtimeToolNames, ...OBSERVATION_BUILTINS, ...DANGEROUS_BUILTINS]
            : runtimeToolNames;
        // THE "ALLOW CHANGES" TOGGLE (setting `gate.allowChanges`, default ON).
        //
        // The floor above makes OBSERVATION safe, but it also blocks the agent
        // from doing real work (Bash / Write / Edit), which in dev mode — the
        // developer's own local Claude sign-in, where the bare `claude` CLI
        // already has full access — is more restrictive than the user wants. The
        // toggle lets the user opt into full capability:
        //   * ON  (default): allow-all, so the agent can write files and run
        //     commands like the CLI. Every call is STILL logged through makeGate's
        //     observer, and subagent/skill activity still surfaces — the gate runs,
        //     it just permits. This is the interim before Phase 2's approval UI.
        //   * OFF: the phase1HarnessFloor — read-only observation, mutation denied
        //     from the main loop AND inside any subagent.
        // (Read further up, before the toolset is assembled: the workspace tools
        // need to know whether this turn may change anything BEFORE deciding
        // which of them to offer.)
        // Phase 2 (M1): the `allowChanges` toggle becomes the BASELINE, and the
        // user's persistent per-scope policy rules override it per tool. With no
        // rules this is byte-for-byte the pre-M1 behaviour; a rule can deny an
        // otherwise-allowed tool or permit an otherwise-denied one. Rules are
        // gathered project → user → org (precedence resolved in realPolicy) and
        // re-read each turn so a change in Settings lands on the next message.
        // Plan mode forces the floor regardless of the toggle. The mutating tools
        // are already absent from this turn's schemas, so this is the second
        // barrier rather than the only one — it catches a call the model invents
        // from memory of an earlier turn, and it covers the SDK built-ins on any
        // engine that has them.
        const baseline =
          allowChanges && !planMode
            ? () => ({ behavior: 'allow' as const })
            : phase1HarnessFloor(runtimeToolNames);
        const policyRules = gatherPolicyRules(getStore(), projectCwd);
        // Phase 2 (M2): an 'ask' rule SUSPENDS the turn here on a promise, emits an
        // `approval_request` RunEvent for the UI, and resumes when the user resolves
        // it (POST /api/naby {approval.resolve}) — or denies on abort/timeout. The
        // gate is already async, so the whole turn naturally pauses at this call.
        const requestApproval = (call: ToolCall): Promise<GateDecision> => {
          const approvalId = `${sessionId}:${call.toolCallId}`;
          return new Promise<GateDecision>((resolve) => {
            let settled = false;
            const settle = (d: GateDecision) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              ctx.signal.removeEventListener('abort', onAbort);
              unregisterApproval(approvalId);
              // P3-M3b: if the question was ALSO asked over Telegram, close it
              // there. A no-op when Telegram is what answered (the bridge
              // unwatches and confirms in-chat itself), so the user never gets a
              // duplicate — and never gets left with live buttons for a decision
              // that was already made in the app, aborted, or timed out.
              if (escalateToTelegram) {
                void finishEscalation({
                  store,
                  approvalId,
                  decision: d.behavior === 'allow' ? 'allow' : 'deny',
                  ...(d.behavior === 'deny' && d.reason ? { reason: d.reason } : {}),
                });
              }
              // Tell the UI the prompt is resolved (buttons off) before the turn
              // moves on. Reconciled against the tool_use/tool_result that follows.
              ctx.emit({
                type: 'approval_resolved',
                approvalId,
                decision: d.behavior,
                session_id: sessionId,
              });
              resolve(d);
            };
            const onAbort = () =>
              settle({ behavior: 'deny', reason: 'turn was stopped before approval' });
            const timer = setTimeout(
              () => settle({ behavior: 'deny', reason: 'approval request timed out' }),
              APPROVAL_TTL_MS,
            );
            if (ctx.signal.aborted) return onAbort();
            ctx.signal.addEventListener('abort', onAbort);
            registerApproval(approvalId, settle, Date.now());
            ctx.emit({
              type: 'approval_request',
              approvalId,
              tool_name: call.toolName,
              input: call.input,
              session_id: sessionId,
            });
            // P3-M3b: ask REMOTELY too. Deliberately not awaited — the in-app
            // prompt is already up and the turn is already suspended on this
            // promise, so a slow or failing Telegram send must not delay either.
            // The bridge starts its polling loop and a button press / "yes" reply
            // lands on `settle` through the same approvalRegistry entry.
            if (escalateToTelegram) {
              void escalateApproval({
                store,
                approvalId,
                toolName: call.toolName,
                input: call.input,
                now: Date.now(),
                ...(routedAgent ? { agentName: routedAgent.name } : {}),
                ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
              });
            }
          });
        };
        const gated = makeGate(realPolicy({ rules: policyRules, fallback: baseline, requestApproval }));
        // Thin observer around the runtime's gate. The decision is still made
        // (and logged) by makeGate; this only reports it. Because it sits on
        // the return path, an observation is proof the gate ran — and the
        // runtime does not invoke an executor until this returns.
        // Phase 3 P3-M5: THE OTHER TWO LEDGER KINDS, written from here rather than
        // by the agent. A consequential call the agent made without asking is an
        // `autonomous` row; one the gate refused is a `tripwire`. This is what makes
        // "when to check in" a property of the ACTION rather than of the agent's
        // judgement (spec §4.5): it can decline to ask, but it cannot decline to be
        // counted. Read-only calls produce nothing (`classifyToolConsequence`).
        //
        // ONE ROW PER CALL, deliberately not per plan: three writes after a single
        // check-in are three autonomous rows. So coverage reads per action, which
        // is only sound while coverage is REPORTED and not gated on — enforcing a
        // coverage floor means first deciding how a check-in claims the calls that
        // carry out its decision.
        //
        // P3-M8d: MCP TOOLS ARE CLASSIFIED FROM DECLARATIONS, NOT FROM THEIR
        // NAMES (spec §7.4). Two signals travel with the call, and neither is a
        // guess:
        //
        //   * what the SERVER declared — `readOnlyHint: true` in the tool's MCP
        //     annotations, collected at connect time (`loadMcpToolset`) and keyed
        //     by the same namespaced name the gate sees. Anything else, including
        //     no annotation at all, is treated as consequential (fail-closed).
        //   * what the USER declared — an `ask`/`deny` policy rule matching this
        //     tool. Resolved with the SAME `resolvePolicyEffect` the gate itself
        //     runs on, so "the user wanted to watch this" can never be true for
        //     the gate and false for the ledger.
        //
        // This feeds the OBSERVATION ONLY. The decision has already been made and
        // is being reported; nothing here can allow or deny anything.
        const mcpAnnotations = mcp?.toolAnnotations ?? {};
        const observeForGrowth = (call: ToolCall, allowed: boolean, reason?: string): void => {
          if (!growthSubject) return;
          // P3-M10 (§3): a TEMPORARY session leaves no trace in the growth ledger
          // either. An `eval_events` row names the session it came from and is
          // read back by the trust meter, so writing one here would be exactly the
          // record the flag promises not to keep. Spec §6 accepts the cost openly:
          // fewer samples for the meter, in exchange for a session that means what
          // it says. The app-wide learning switch does NOT reach here — it is
          // about MEMORY, and an agent still has to know how well it is doing.
          if (sessionNoLearn) return;
          const bare = normalizeToolName(call.toolName);
          const readOnlyHint = mcpAnnotations[bare]?.readOnlyHint;
          const effect = resolvePolicyEffect(policyRules, bare);
          recordGateOutcome({
            store,
            agentId: growthSubject.id,
            sessionId,
            toolName: call.toolName,
            allowed,
            ...(reason ? { reason } : {}),
            ...(readOnlyHint !== undefined ? { readOnlyHint } : {}),
            policyForcesConsequential: effect === 'ask' || effect === 'deny',
          });
        };
        const gate: Gate = async (call) => {
          // Phase 3 P3-M2: a routed agent restricted to `toolRefs` may use ONLY
          // those tools. This is the OUTERMOST check — it overrides even an
          // allow-all baseline, because the restriction is the agent's identity,
          // not a policy preference. Compared on the bare tool name so an
          // `mcp__x__y` call matches a bare `mcp__x__y` / normalized ref.
          if (agentAllowedTools && !agentAllowedTools.includes(normalizeToolName(call.toolName))) {
            console.log(
              `[engine:naby] gate: ${call.toolName} (${call.toolCallId}) → deny (agent @${routedAgent?.name} toolRefs)`,
            );
            const reason = `agent @${routedAgent?.name} is limited to its allowed tools`;
            observeForGrowth(call, false, reason);
            return { behavior: 'deny', reason };
          }
          // ---- THE STAGE CONTRACT (Phase 3, P3-M12a) ---------------------
          //
          // Second only to the agent's own toolRefs, and above the policy engine,
          // because this is not a preference the user can override per tool: it is
          // what "@ing an agent that has not been measured yet" MEANS. The
          // classification is the ledger's own (`stageRefusalReason` calls
          // `classifyToolConsequence`), fed the same declared signals the
          // observation path reads, so the gate and the meter can never disagree
          // about which calls are consequential.
          //
          // NO LEDGER ROW IS WRITTEN — deliberately, and this is the subtle part.
          // A refusal here is the contract working, not a safety incident, and
          // `observeForGrowth` would file it as a `tripwire`: the meter's HARD
          // block on butterfly (trust-meter §4.8). A larva that dutifully declined
          // to edit a file would thereby stamp its own record with a safety
          // violation, and the stage it needs in order to be allowed to edit files
          // would become unreachable by obeying the rule. Nor is it an
          // `autonomous` row: nothing ran.
          if (contract && routedStage) {
            const bare = normalizeToolName(call.toolName);
            const effect = resolvePolicyEffect(policyRules, bare);
            const readOnlyHint = mcpAnnotations[bare]?.readOnlyHint;
            const refusal = stageRefusalReason({
              toolName: bare,
              stage: routedStage,
              contract,
              signals: {
                ...(readOnlyHint !== undefined ? { readOnlyHint } : {}),
                policyForcesConsequential: effect === 'ask' || effect === 'deny',
              },
            });
            if (refusal) {
              console.log(
                `[engine:naby] gate: ${call.toolName} (${call.toolCallId}) → deny (stage contract: ${routedStage})`,
              );
              return { behavior: 'deny', reason: refusal };
            }
          }
          const decision = await gated.gate(call);
          const entry = gated.log[gated.log.length - 1];
          console.log(
            `[engine:naby] gate: ${call.toolName} (${call.toolCallId}) → ${decision.behavior}`,
          );
          observeForGrowth(
            call,
            decision.behavior === 'allow',
            decision.behavior === 'deny' ? decision.reason : undefined,
          );
          if (entry) deps.onGateDecision?.(entry);
          return decision;
        };

        // ---- init --------------------------------------------------------
        ctx.rekey(sessionId);
        ctx.emit({
          type: 'system',
          subtype: 'init',
          session_id: sessionId,
          model: modelLabel,
          // WHO IS ANSWERING (2026-08-04). The loading bubble used to name the
          // ENGINE ("Claude is thinking"), which is the one thing about a turn the
          // user did not ask about: whichever model answers, it is still naby, and
          // the engine brand is already on the toolbar. So the turn reports its
          // ACTING AGENT, which is what the bubble names.
          //
          // It rides `system/init` rather than a channel of its own because the
          // client already reads this event for the same kind of fact (the resolved
          // model label) — routing is resolved far above, so it is known here.
          //
          // `growthSubject` IS the acting agent by construction: `routedAgent ??
          // persona`. `persona` says whether to use the localized product name
          // ("나비") or the agent's own handle — the persona's stored name is `naby`,
          // but an install that hit the name collision keeps `@persona`, and a
          // Korean user should read 나비 either way. Absent when there is no agent
          // at all (no persona row), which is the only case that still falls back to
          // the engine brand.
          ...(growthSubject
            ? {
                acting_agent: {
                  name: growthSubject.name,
                  persona: isBuiltinPersona(growthSubject),
                },
              }
            : {}),
          cwd: ctx.cwd,
          tools: toolSchemas.map((t) => t.name),
          // F1-08. What actually connected — a server that failed to start is
          // absent here AND logged, so "my MCP server is not working" is
          // visible rather than silent.
          mcp_servers: (mcp?.connections ?? []).map((c) => ({
            name: c.entry.name,
            status: 'connected',
          })),
          // Reported, not hardcoded: the client shows what mode the turn is
          // actually running in, and it was claiming 'default' even when the
          // user had plan mode checked.
          permissionMode: planMode ? 'plan' : 'default',
          slash_commands: [],
          apiKeySource: 'env',
          uuid: randomUUID(),
        });

        // ---- drive the runtime, translating as we go ---------------------
        let assistantText = '';
        let sawResult = false;
        let errorMessage: string | undefined;
        let usage: Usage | undefined;
        let turns = 0;

        // ---- autonomy bookkeeping (Phase 3, P3-M3c) ----------------------
        //
        // `step`/`stepText`/`stepUsedTool` are PER STEP (reset before each
        // runTurn) because that is what the stop decision reads: whether THIS
        // step did work and whether it declared itself done. The token/cost
        // accumulators are per RUN, so the single `result` the client receives
        // reports the whole goal rather than only its last step (for a
        // single-step run they equal that step's own numbers, so nothing about
        // an ordinary turn changes).
        let step = 0;
        let stepText = '';
        // Whether token deltas already put THIS assistant message on screen. Reset
        // when its complete event lands, so the next message decides for itself —
        // an engine may stream one message and not the next.
        let sawPartialText = false;
        let stepUsedTool = false;
        let stepDecision: AutonomyDecision = { proceed: false, reason: 'not-autonomous' };
        // P3-M9 (G4): the run's ONE verification nudge, spent at most once. Per
        // RUN, not per step — that is the whole bound. Without it, an agent that
        // answers a nudge with the same unverified claim would be nudged again,
        // and "verify before you finish" would become a way of never finishing.
        let verifyNudgeSent = false;
        // Whether a terminal `result` RunEvent has reached the client. Distinct
        // from `sawResult` (= the engine produced one): an intermediate step's
        // result is deliberately SUPPRESSED, so the two disagree mid-loop, and
        // it is this flag the end-of-run fallback must key on — otherwise a run
        // stopped between steps would leave the client's turn spinning forever.
        let emittedResult = false;
        const accUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
        let accCostUsd = 0;

        // ---- harness events: low-noise by construction --------------------
        //
        // These are OBSERVATIONAL (see the `harness` doc in the runtime): they
        // report that the backend's own harness did something — a background
        // task, a compaction, injected hook output — and they must never affect
        // the turn. They are also BURSTY: a subagent-heavy turn can emit the
        // same label many times over, and the client renders each one as a
        // muted bar in the transcript.
        //
        // So the stream is thinned HERE, at the point that knows the run, in
        // two ways. Deduping on the full label+detail collapses a repeated
        // event to its first occurrence, which is the only informative one; the
        // hard cap then bounds the pathological case absolutely, so no
        // backend-side loop can turn into an unbounded transcript. Dropping
        // extras is safe precisely because nothing downstream depends on
        // completeness — the events carry no state.
        const harnessSeen = new Set<string>();
        let harnessEmitted = 0;
        const HARNESS_EVENT_CAP = 20;

        const emitToolResult = (
          toolUseId: string,
          content: string,
          isError: boolean,
        ): void => {
          ctx.emit({
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: toolUseId,
                  content,
                  is_error: isError,
                },
              ],
            },
            session_id: sessionId,
          } satisfies RunEvent);
        };

        try {
          // runTurn owns the history: it loads the session's prior messages
          // from the store, appends the user turn, drives the engine, and
          // appends the assistant/tool messages (keeping tool calls paired with
          // their results). We only translate the events as they stream past.
          //
          // THE AUTONOMY LOOP (Phase 3, P3-M3c). One iteration = one step = one
          // model turn. A non-autonomous turn runs the body EXACTLY once and the
          // `while` is false on the first check (`stepDecision` starts at
          // 'not-autonomous'), so this is a no-op wrapper for every ordinary
          // message. When the agent is autonomous, the decision is taken in the
          // `result` case below — the only place that knows whether the step did
          // work and whether it declared itself done — and read here.
          //
          // The MCP toolset, the gate, the escalation channel and the store
          // handle are all built ONCE, outside the loop: they belong to the goal,
          // not to a step. Steps share the session history, so step N sees
          // everything steps 1..N-1 did.
          do {
            step += 1;
            stepText = '';
            stepUsedTool = false;
            await runTurn({
              engine,
              store,
              sessionId,
              // A routed agent may prefer its own model; else the engine's resolved
              // model (or the provider default). Same field the model switcher uses.
              model: (() => {
                const m = routedAgent?.model ?? modelForEngine;
                return { providerId, ...(m ? { model: m } : {}) };
              })(),
              // Step 1 is the user's own words; every later step is the harness
              // asking the agent to continue. That prompt is stored as a real user
              // message because it IS what drove the model — the transcript should
              // never imply the user typed something they did not, nor hide what
              // did (it is labelled `[naby autonomy]`).
              //
              // P3-M9: WHICH continuation depends on why the previous step did not
              // end the run. `stepDecision` still holds that step's verdict here —
              // it is only reassigned inside this call's `result` case — so a
              // 'verify-nudge' verdict swaps in the nudge, which asks the agent to
              // CHECK rather than to carry on. Asking an agent that thinks it is
              // finished to "continue toward the goal" only gets the same claim back.
              userText:
                step === 1
                  ? turnText
                  : stepDecision.reason === 'verify-nudge'
                    ? verificationNudgePrompt(step, maxSteps)
                    : continuationPrompt(step, maxSteps),
              // Multimodal input: hand this turn's images to the runtime, which
              // attaches them (transiently) to the user message so each engine can
              // build a native image block. ImageData -> RuntimeImage (drop the
              // 'base64' discriminant the runtime does not need).
              ...(ctx.images && ctx.images.length > 0
                ? { images: ctx.images.map((im) => ({ media_type: im.media_type, data: im.data })) }
                : {}),
              toolSchemas,
              gate,
              executors,
              signal: ctx.signal,
              // Phase 2.5 (M4): enabled subagents the model may delegate to. The
              // Claude Agent SDK engine maps these to native `agents` (spawned via
              // the gated Task tool); the AI-SDK engine ignores them.
              subagents: gatherSubagents(store, projectCwd),
              // Phase 1.6 / 2.5 (M3): turn-time skill injection. An enabled skill
              // whose trigger matches (or that is always-on) has its instructions
              // appended to the system prompt; a tool-bearing skill participates
              // only when all its tools are in `availableTools`, else it is excluded
              // and counted. Scoped to user + org + this project's cwd (via
              // opts.cwd, set above). Off entirely when no skill is enabled/matches
              // (byte-for-byte no-op).
              // Phase 3 P3-M2: turn-time MEMORY injection (was dormant — the
              // runtime implemented it since Phase 1.5 but no caller wired it). The
              // runtime retrieves confirmed, scope-appropriate memory within this
              // budget and folds it into the system prompt above the engine seam.
              // This is what makes an agent (the persona especially) act on what it
              // has learned. A turn with no confirmed memory is a byte-for-byte
              // no-op. Scoped to user + org + this project's cwd (opts.cwd).
              // P3-M8c: rank what is injected by RELEVANCE to this turn, not by
              // recency alone. `turnText` — the user's words with any `@agent`
              // mention already stripped — is the query on EVERY step, including
              // the autonomy continuation steps: step 2's stored user message is
              // the harness saying "carry on", and ranking memory against that
              // would throw away the only signal about what the work is. A turn
              // whose words match no memory is ordered exactly as before.
              memoryInjection: {
                tokenBudget: MEMORY_TOKEN_BUDGET,
                queryText: turnText,
                userId: DEFAULT_USER_ID,
                orgId: DEFAULT_ORG_ID,
              },
              onMemoryInjection: (injected) => {
                if (injected.items.length > 0 || injected.droppedForBudget > 0) {
                  console.log(
                    `[engine:naby] memory: injected ${injected.items.length}` +
                      `, dropped-for-budget ${injected.droppedForBudget}`,
                  );
                }
              },
              skillInjection: {
                tokenBudget: SKILL_TOKEN_BUDGET,
                userId: DEFAULT_USER_ID,
                orgId: DEFAULT_ORG_ID,
                availableTools,
              },
              onSkillInjection: (injected) => {
                if (injected.skills.length > 0 || injected.excludedForTools > 0) {
                  console.log(
                    `[engine:naby] skills: injected ${injected.skills.length}` +
                      `, excluded-for-tools ${injected.excludedForTools}` +
                      `, dropped-for-budget ${injected.droppedForBudget}`,
                  );
                }
              },
              // F1-07. runTurn records one usage row per answered turn. It cannot
              // infer either of these — `Engine` is an interface and says nothing
              // about which backend implements it or who pays for it — so the
              // composition root, which chose the engine, supplies them.
              engineId,
              costBasis,
              // THE DIRECTORY THIS TURN IS ABOUT — told to the model (`system`)
              // and to the ENGINE (`cwd`) from the SAME source, in the same
              // conditional, on purpose.
              //
              // These used to be one line, not two: the system prompt announced
              // `ctx.cwd` while the engine was given nothing, so the Agent SDK
              // fell back to the Electron process's cwd — naby's own source
              // checkout — and loaded NABY's `.claude/` harness (CLAUDE.md,
              // hooks) into a chat about someone else's project. The model was
              // told one directory and was standing in another. Full write-up on
              // `EngineRunInput.cwd` in the runtime.
              //
              // `RunCtx.cwd` is documented as "normalized, may be ''", and the
              // empty string is NOT a directory: passing it through would hand
              // the SDK a falsy-but-present value and re-open the same ambiguity.
              // The truthiness guard means no-directory stays UNDEFINED end to
              // end, which the contract defines as "say nothing about a
              // directory" rather than "use the ambient one".
              ...(turnSystem ? { system: turnSystem } : {}),
              ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
              onEvent: (ev: EngineEvent) => {
              // Cancellation: stop translating the moment the run is stopped.
              // The signal is also handed to the engine (and through it to the
              // provider call), so this is a second, immediate barrier rather
              // than the only one.
              if (ctx.signal.aborted) return;

              switch (ev.kind) {
                case 'init':
                  break; // already emitted our own init above

                case 'thinking': {
                  if (!ev.text) break;
                  // Its OWN event type, never a text delta: the client shows it in
                  // a collapsed block and it is not part of `assistantText`, so the
                  // stored transcript stays the reply rather than the working-out.
                  ctx.emit({
                    type: 'thinking',
                    session_id: sessionId,
                    text: ev.text,
                    ...(ev.partial ? { partial: true } : {}),
                  });
                  break;
                }
                case 'text': {
                  if (ev.role !== 'assistant' || !ev.text) break;
                  // A PARTIAL is a token-level delta: render it and nothing else.
                  // The complete message arrives as its own non-partial event, so
                  // accumulating both would double the answer and inflate `turns`.
                  // One tested rule for both engines — see lib textRender.ts.
                  const plan = planTextRender(ev.partial === true, sawPartialText);
                  sawPartialText = plan.sawPartialNext;
                  if (plan.accumulate) {
                    assistantText += ev.text;
                    // Per-step copy: the stop decision looks for the done marker in
                    // THIS step's words, not in something the agent said earlier.
                    stepText += ev.text;
                    turns += 1;
                  }
                  if (plan.render) {
                    // Engine-agnostic render path — see the header note.
                    ctx.emit({
                      type: 'stream_event',
                      session_id: sessionId,
                      event: {
                        type: 'content_block_delta',
                        index: 0,
                        delta: { type: 'text_delta', text: ev.text },
                      },
                    });
                  }
                  break;
                }

                case 'tool_request': {
                  // The step DID something — the signal the autonomy loop needs
                  // to distinguish work in progress from an answer. Recorded on
                  // the request (not the result) on purpose: a call the gate
                  // denies is still the agent trying to act, so a denied step
                  // gets to try something else rather than ending the run.
                  stepUsedTool = true;
                  // tool_use must reach the client BEFORE its result so the UI
                  // has a call to merge the result into.
                  ctx.emit({
                    type: 'assistant',
                    message: {
                      role: 'assistant',
                      model: modelLabel,
                      content: [
                        {
                          type: 'tool_use',
                          id: ev.toolCallId,
                          name: ev.toolName,
                          input: ev.input ?? {},
                        },
                      ],
                    },
                    session_id: sessionId,
                  });
                  break;
                }

                case 'gate_result': {
                  // A DENY terminates the call inside the runtime — no
                  // tool_result event follows — so surface the denial here or the
                  // UI would spin on a permanently loading tool call.
                  if (ev.decision === 'deny') {
                    emitToolResult(
                      ev.toolCallId,
                      `Denied by policy gate: ${ev.reason ?? 'no reason given'}`,
                      true,
                    );
                  }
                  break;
                }

                case 'tool_result': {
                  emitToolResult(ev.toolCallId, ev.output.content, ev.isError);
                  break;
                }

                case 'harness': {
                  const key = ev.detail ? `${ev.subtype} ${ev.detail}` : ev.subtype;
                  if (harnessSeen.has(key)) break;
                  if (harnessEmitted >= HARNESS_EVENT_CAP) break;
                  harnessSeen.add(key);
                  harnessEmitted += 1;
                  // `subtype:'harness'` keeps this off the client's existing
                  // system subtypes ('init' / 'task_notification' / 'api_retry'),
                  // each of which has its own handler and its own meaning. The
                  // client turns this into a role:'system' row with
                  // systemEvent.kind 'meta' — the muted one-line bar that already
                  // exists — rather than a conversation bubble.
                  ctx.emit({
                    type: 'system',
                    subtype: 'harness',
                    session_id: sessionId,
                    harness_subtype: ev.subtype,
                    ...(ev.detail ? { harness_detail: ev.detail } : {}),
                  } satisfies RunEvent);
                  break;
                }

                case 'error': {
                  errorMessage = ev.message;
                  ctx.emit({ type: 'error', error: ev.message, session_id: sessionId });
                  break;
                }

                case 'result': {
                  sawResult = true;
                  usage = ev.usage;
                  // Per-run totals (P3-M3c): the client gets ONE result for the
                  // whole goal, so tokens and cost are summed across steps. A
                  // single-step run sums exactly one step — the same numbers a
                  // pre-M3c turn reported.
                  accUsage.inputTokens += ev.usage?.inputTokens ?? 0;
                  accUsage.outputTokens += ev.usage?.outputTokens ?? 0;
                  accUsage.cachedInputTokens += ev.usage?.cachedInputTokens ?? 0;
                  accCostUsd += ev.costUsd ?? 0;
                  // THE STOP DECISION. Taken here because this is the moment both
                  // inputs are known: whether the step used a tool and what it
                  // said. `resolveMaxSteps` collapsed a non-autonomous agent to 1
                  // step, for which the decision is always 'not-autonomous' —
                  // i.e. an ordinary turn cannot accidentally continue.
                  stepDecision = decideAutonomyStep({
                    step,
                    maxSteps,
                    usedTools: stepUsedTool,
                    text: stepText,
                    ok: ev.ok,
                    aborted: ctx.signal.aborted,
                    // P3-M9 (G4): the verification gate, and the only state it
                    // needs. The rule itself is in lib/autonomy.ts so it can be
                    // unit-tested without a model; this passes the run's one bit.
                    verification: { nudgeSent: verifyNudgeSent },
                  });
                  // Spend the nudge the moment it is granted, not when the step it
                  // buys finishes: the decision for THAT step is taken by this same
                  // line, and a nudge still marked unspent would grant a second one.
                  if (stepDecision.reason === 'verify-nudge') verifyNudgeSent = true;
                  // A continuing step must NOT emit `result`: the client ends its
                  // turn on that event, so an intermediate one would close the
                  // bubble and leave the remaining steps streaming into a
                  // finished turn. The step bar (emitted by the loop) is what the
                  // user sees instead; the terminal result comes from the last
                  // step — or from the fallback below if the run is stopped
                  // between steps.
                  if (stepDecision.proceed) break;
                  emittedResult = true;
                  ctx.emit({
                    type: 'result',
                    subtype: ev.ok ? 'success' : 'error_during_execution',
                    session_id: sessionId,
                    is_error: !ev.ok,
                    result: ev.ok ? assistantText : (errorMessage ?? 'run failed'),
                    usage: toSdkUsage(accUsage),
                    total_cost_usd: accCostUsd,
                    duration_ms: Date.now() - startedAt,
                    num_turns: turns,
                  });
                  break;
                }
              }
              },
            });
            // Between steps: tell the user (a muted one-line bar) that the agent
            // is continuing, or why it stopped. Emitted here rather than in the
            // `result` case so it lands after that step's events, and so the
            // reason a run ended is always in the transcript.
            if (autonomous) {
              console.log(`[engine:naby] autonomy: ${stepMarker(step, maxSteps, stepDecision)}`);
              ctx.emit({
                type: 'system',
                subtype: 'harness',
                session_id: sessionId,
                harness_subtype: 'autonomy',
                harness_detail: stepMarker(step, maxSteps, stepDecision),
              } satisfies RunEvent);
            }
            // An abort is re-checked here (not only inside the runtime) so a stop
            // pressed mid-step never buys the agent another one.
          } while (stepDecision.proceed && !ctx.signal.aborted);
        } catch (e) {
          errorMessage = e instanceof Error ? e.message : String(e);
          ctx.emit({ type: 'error', error: errorMessage, session_id: sessionId });
        } finally {
          // Every stdio MCP server is a CHILD PROCESS. Not closing them leaks
          // one process per chat turn, which on a long-lived desktop server is
          // a slow-motion resource exhaustion bug rather than a tidiness issue.
          // `finally` so it happens on the abort and throw paths too.
          await mcp?.closeAll();
        }

        // The stream can end without a result — an abort mid-iteration, or a
        // throw out of the engine. The client's turn only ends on `result`, so
        // one is always emitted.
        //
        // P3-M3c: the condition is `emittedResult`, NOT `sawResult`. An autonomous
        // run that was stopped (or threw) right after a step chose to continue HAS
        // seen results — every one of them suppressed on purpose — so keying on
        // `sawResult` would skip the fallback and leave the client's turn spinning.
        if (!emittedResult) {
          const aborted = ctx.signal.aborted;
          const message =
            errorMessage ?? (aborted ? 'Run stopped by user.' : 'Run ended without a result.');
          if (aborted && !errorMessage) {
            ctx.emit({ type: 'error', error: message, session_id: sessionId });
          }
          ctx.emit({
            type: 'result',
            subtype: 'error_during_execution',
            session_id: sessionId,
            is_error: true,
            // A stopped autonomous run still did work: report what it managed to
            // say, so the transcript is not just "stopped". Falls back to the
            // status line when there is nothing (the pre-M3c case).
            result: sawResult && assistantText ? `${assistantText}\n\n${message}` : message,
            usage: toSdkUsage(sawResult ? accUsage : usage),
            total_cost_usd: accCostUsd,
            duration_ms: Date.now() - startedAt,
            num_turns: turns,
          });
        }

        // ---- the final report (Phase 3, P3-M3b) --------------------------
        //
        // The other half of escalation: the user who approved a step from their
        // phone learns how the turn ENDED without opening the app. Awaited — the
        // turn's events are all emitted by now, and awaiting is what guarantees
        // the message is actually out before the run function returns (a
        // fire-and-forget send can lose the race against process teardown).
        // Never throws (sendTelegramMessage swallows), so it cannot fail a turn.
        //
        // P3-M3c: ONE report per goal, not per step — it is sent after the whole
        // loop, and it says how many steps the agent spent and why it stopped, so
        // "it hit its step cap" is distinguishable from "it finished".
        if (escalateToTelegram) {
          await sendFinalReport(store, {
            ok: emittedResult && sawResult && !errorMessage,
            text: assistantText,
            // Names the session so the sent message becomes a REPLY TARGET
            // (telegram-chat §1.3) — and so a turn the chat itself started is
            // recognized and not reported twice.
            sessionId,
            ...(errorMessage ? { error: errorMessage } : {}),
            ...(routedAgent ? { agentName: routedAgent.name } : {}),
            durationMs: Date.now() - startedAt,
            numTurns: turns,
            ...(autonomous
              ? { steps: step, stepsMax: maxSteps, stopReason: stepDecision.reason }
              : {}),
          });
        }
      },
      // No resolveTitle: titles come from Claude-SDK jsonl transcripts, which
      // this engine does not write.
    },
  };
}

export const nabySpec: EngineSpec = createNabySpec();
