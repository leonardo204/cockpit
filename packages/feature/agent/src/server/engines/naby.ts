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
 *   - The gate is permissive: it allows everything, but EVERY call goes through
 *     it and is logged. The seam is real and exercised; the Phase 2 policy gate
 *     drops in by replacing the decision policy below and nothing else.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AiSdkEngine,
  buildToolset,
  makeGate,
  makeModelResolver,
  NO_CREDENTIAL_MESSAGE,
  Outbox,
  preflightProvider,
  resolveProviderCredential,
  runTurn,
  SqliteStore,
  apiKeyCredential,
  type EngineEvent,
  type Gate,
  type GateLogEntry,
  type ModelResolver,
  type ProviderProfile,
  type Store,
  type Usage,
} from '../../../../../../../dist/naby-runtime.mjs';
import type { DispatchParams, EngineSpec, RunCtx, RunEvent } from './types';

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

function getStore(): Store {
  if (!sharedStore) {
    const path = resolveDbPath();
    mkdirSync(dirname(path), { recursive: true });
    sharedStore = new SqliteStore({ path });
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
      // The message on the failure path is what a NON-DEVELOPER reads when the
      // app cannot answer, so it is written in the runtime next to the
      // resolution logic and points at the settings screen, not at an env var.
      const result = await preflightProvider({ requestedModel: model });
      if (!result.ok) {
        return { ok: false as const, status: result.status, error: result.error };
      }
      return { ok: true as const };
    },

    runner: {
      async run(ctx: RunCtx): Promise<void> {
        const startedAt = Date.now();
        // Resume when the shell hands us a session id; otherwise mint one and
        // rekey() to it below. providerId is left empty here — runTurn records
        // the provider that actually answers (it is a hint, not a constraint).
        const store = getStore();
        const sessionId = ctx.sessionId || store.createSession('').sessionId;
        const requestedModel =
          typeof ctx.params.model === 'string' ? ctx.params.model : undefined;

        // ---- provider + model resolver -----------------------------------
        let resolveModel: ModelResolver;
        let modelLabel: string;
        // The id of the provider that actually answers. Captured from the
        // resolution rather than re-derived later, so the ModelSelection can
        // never name a different provider than the one whose key was used.
        let providerId = 'injected';

        if (deps.resolveModel) {
          resolveModel = deps.resolveModel;
          modelLabel = requestedModel || 'injected-model';
        } else {
          const resolved = await resolveProvider(requestedModel);
          if (!resolved) {
            // preflight normally catches this; belt-and-braces for the
            // scheduled-task path, which may call run() directly.
            ctx.emit({ type: 'error', error: NO_CREDENTIAL_MESSAGE });
            ctx.emit({
              type: 'result',
              subtype: 'error_during_execution',
              session_id: sessionId,
              is_error: true,
              result: NO_CREDENTIAL_MESSAGE,
              usage: toSdkUsage(undefined),
              total_cost_usd: 0,
              duration_ms: Date.now() - startedAt,
              num_turns: 0,
            });
            return;
          }
          const { profile, apiKey } = resolved;
          modelLabel = profile.model;
          providerId = profile.id;
          const base = makeModelResolver([profile], () => apiKeyCredential(apiKey));
          // Our ModelResolver takes a ModelSelection; makeModelResolver's
          // signature is (providerId, model?). Bridge the two.
          resolveModel = (selection) => base(selection.providerId, selection.model);
        }

        // ---- runtime construction ----------------------------------------
        // The gate is PERMISSIVE for this milestone but structurally real: it
        // is the same makeGate() the runtime uses, every call passes through
        // it, and every decision is logged. Phase 2 replaces the policy
        // function; nothing else here changes.
        const gated = makeGate(() => ({ behavior: 'allow' }));
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

        const outbox = new Outbox();
        const { toolSchemas, executors } = buildToolset(outbox);

        // Session framing rides on EngineRunInput.system (contract §2), passed
        // through runTurn below. It is NOT a message and NOT an engine-level
        // option workaround — the runtime carries it on its own field and each
        // engine forwards it to its provider's dedicated system slot.
        const engine = new AiSdkEngine({ resolveModel });

        // ---- init --------------------------------------------------------
        ctx.rekey(sessionId);
        ctx.emit({
          type: 'system',
          subtype: 'init',
          session_id: sessionId,
          model: modelLabel,
          cwd: ctx.cwd,
          tools: toolSchemas.map((t) => t.name),
          mcp_servers: [],
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
            model: { providerId, model: modelLabel },
            userText: ctx.prompt ?? '',
            toolSchemas,
            gate,
            executors,
            signal: ctx.signal,
            ...(ctx.cwd
              ? {
                  system: `You are running inside the naby shell. Working directory: ${ctx.cwd}`,
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
