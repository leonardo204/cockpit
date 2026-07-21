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
 *   - `ctx.images` are ignored (the runtime's RuntimeMessage is text-only).
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
  ClaudeAgentSdkEngine,
  DEV_ENGINE_LABEL,
  loadMcpToolset,
  makeGate,
  phase1HarnessFloor,
  makeModelResolver,
  Outbox,
  preflightEngine,
  readSettings,
  resolveProviderCredential,
  runTurn,
  selectEngine,
  SqliteStore,
  toSelectOptions,
  apiKeyCredential,
  type Engine,
  type EngineEvent,
  type Executor,
  type Gate,
  type GateLogEntry,
  type McpLoadResult,
  type ModelResolver,
  type Project,
  type ProviderProfile,
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

// ---------------------------------------------------------------------------
// Where the database lives.
// ---------------------------------------------------------------------------

/**
 * Resolution order, most specific first — never a hardcoded absolute path:
 *   NABY_DB_PATH   full path to the db file (tests point this at a temp dir)
 *   NABY_HOME      our own home dir; db is <NABY_HOME>/app.db
 *   COCKPIT_HOME   the shell's home dir, when running inside cockpit
 *   default        ~/.naby/app.db
 * In the packaged app this becomes Electron's `userData` (contract §6), which
 * is passed in as NABY_HOME rather than compiled in here.
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

function toSdkUsage(u: Usage | undefined): Record<string, number> {
  return {
    input_tokens: u?.inputTokens ?? 0,
    output_tokens: u?.outputTokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: u?.cachedInputTokens ?? 0,
  };
}

export function createNabySpec(deps: NabyEngineDeps = {}): EngineSpec {
  return {
    name: 'naby',

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
          const selection = await selectEngine({
            requestedModel,
            ...toSelectOptions(readSettings(store)),
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

        // ---- runtime construction ----------------------------------------
        const outbox = new Outbox();
        const builtin = buildToolset(outbox);

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
          mcp = await loadMcpToolset(store.listMcpEntries());
          for (const failure of mcp.failures) {
            console.warn(`[engine:naby] MCP server "${failure.name}" unavailable: ${failure.message}`);
          }
        } catch (e) {
          console.warn(
            `[engine:naby] MCP registry could not be loaded: ${e instanceof Error ? e.message : String(e)}`,
          );
        }

        const toolSchemas: ToolSchema[] = [
          ...builtin.toolSchemas,
          ...(mcp?.toolSchemas ?? []),
        ];
        const executors: Record<string, Executor> = {
          ...builtin.executors,
          ...(mcp?.executors ?? {}),
        };

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
        // Read per turn so flipping the toggle takes effect on the next message.
        const allowChanges =
          (getStore().getSetting('gate.allowChanges') ?? 'true') !== 'false';
        const gated = makeGate(
          allowChanges
            ? () => ({ behavior: 'allow' as const })
            : phase1HarnessFloor(runtimeToolNames),
        );
        // Thin observer around the runtime's gate. The decision is still made
        // (and logged) by makeGate; this only reports it. Because it sits on
        // the return path, an observation is proof the gate ran — and the
        // runtime does not invoke an executor until this returns.
        const gate: Gate = async (call) => {
          const decision = await gated.gate(call);
          const entry = gated.log[gated.log.length - 1];
          console.log(
            `[engine:naby] gate: ${call.toolName} (${call.toolCallId}) → ${decision.behavior}`,
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
          cwd: ctx.cwd,
          tools: toolSchemas.map((t) => t.name),
          // F1-08. What actually connected — a server that failed to start is
          // absent here AND logged, so "my MCP server is not working" is
          // visible rather than silent.
          mcp_servers: (mcp?.connections ?? []).map((c) => ({
            name: c.entry.name,
            status: 'connected',
          })),
          permissionMode: 'default',
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
          await runTurn({
            engine,
            store,
            sessionId,
            model: { providerId, ...(modelForEngine ? { model: modelForEngine } : {}) },
            userText: ctx.prompt ?? '',
            toolSchemas,
            gate,
            executors,
            signal: ctx.signal,
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
            ...(ctx.cwd
              ? {
                  system: `You are running inside the naby shell. Working directory: ${ctx.cwd}`,
                  cwd: ctx.cwd,
                }
              : {}),
            onEvent: (ev: EngineEvent) => {
            // Cancellation: stop translating the moment the run is stopped.
            // The signal is also handed to the engine (and through it to the
            // provider call), so this is a second, immediate barrier rather
            // than the only one.
            if (ctx.signal.aborted) return;

            switch (ev.kind) {
              case 'init':
                break; // already emitted our own init above

              case 'text': {
                if (ev.role !== 'assistant' || !ev.text) break;
                assistantText += ev.text;
                turns += 1;
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
                break;
              }

              case 'tool_request': {
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
                ctx.emit({
                  type: 'result',
                  subtype: ev.ok ? 'success' : 'error_during_execution',
                  session_id: sessionId,
                  is_error: !ev.ok,
                  result: ev.ok ? assistantText : (errorMessage ?? 'run failed'),
                  usage: toSdkUsage(ev.usage),
                  total_cost_usd: ev.costUsd ?? 0,
                  duration_ms: Date.now() - startedAt,
                  num_turns: turns,
                });
                break;
              }
            }
            },
          });
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
        if (!sawResult) {
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
            result: message,
            usage: toSdkUsage(usage),
            total_cost_usd: 0,
            duration_ms: Date.now() - startedAt,
            num_turns: turns,
          });
        }
      },
      // No resolveTitle: titles come from Claude-SDK jsonl transcripts, which
      // this engine does not write.
    },
  };
}

export const nabySpec: EngineSpec = createNabySpec();
