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
 * MILESTONE LIMITATIONS (deliberate, tracked)
 *   - Single-turn: the shell's history lives in Claude-SDK jsonl transcripts we
 *     do not write, so each run starts from `ctx.prompt` alone. Multi-turn
 *     needs our own transcript store; it is not wired here.
 *   - `ctx.images` are ignored (the runtime's RuntimeMessage is text-only).
 *   - The gate is permissive: it allows everything, but EVERY call goes through
 *     it and is logged. The seam is real and exercised; the Phase 2 policy gate
 *     drops in by replacing the decision policy below and nothing else.
 */

import { randomUUID } from 'node:crypto';
import {
  AiSdkEngine,
  buildToolset,
  makeGate,
  makeModelResolver,
  MemoryStore,
  Outbox,
  apiKeyCredential,
  type EngineEvent,
  type Gate,
  type GateLogEntry,
  type ModelResolver,
  type ProviderProfile,
  type Usage,
} from '../../../../../../../dist/naby-runtime.mjs';
import type { DispatchParams, EngineSpec, RunCtx, RunEvent } from './types';

// ---------------------------------------------------------------------------
// Credentials — read ONLY here, at the engine boundary.
// ---------------------------------------------------------------------------

/** Env var → provider profile. First match wins; NABY_PROVIDER forces one. */
const PROVIDERS = [
  {
    id: 'anthropic',
    kind: 'anthropic' as const,
    envVar: 'NABY_ANTHROPIC_API_KEY',
    defaultModel: 'claude-sonnet-4-5',
    label: 'Anthropic',
  },
  {
    id: 'openai',
    kind: 'openai' as const,
    envVar: 'NABY_OPENAI_API_KEY',
    defaultModel: 'gpt-4o',
    label: 'OpenAI',
  },
];

type ResolvedProvider = { profile: ProviderProfile; apiKey: string };

/**
 * Pick a configured provider from the environment. Returns null when nothing is
 * configured — preflight turns that into a 400 instead of a mid-run crash.
 * The key is read here and nowhere else; it is passed straight into the
 * runtime's credential resolver and never stored, logged or emitted.
 */
function resolveProvider(requestedModel?: string): ResolvedProvider | null {
  const forced = process.env.NABY_PROVIDER;
  const candidates = forced ? PROVIDERS.filter((p) => p.id === forced) : PROVIDERS;

  for (const p of candidates) {
    const apiKey = process.env[p.envVar];
    if (!apiKey) continue;
    return {
      apiKey,
      profile: {
        id: p.id,
        label: p.label,
        kind: p.kind,
        config: { kind: p.kind },
        model: requestedModel || process.env.NABY_MODEL || p.defaultModel,
        // Opaque handle. The runtime's CredentialResolver maps it back to the
        // secret we captured above; the profile itself never holds one.
        credentialRef: `env:${p.envVar}`,
      },
    };
  }
  return null;
}

const MISSING_KEY_ERROR =
  'naby engine: no provider API key configured. Set NABY_ANTHROPIC_API_KEY or ' +
  'NABY_OPENAI_API_KEY in the server environment (optionally NABY_PROVIDER to ' +
  'pick one, NABY_MODEL to override the model).';

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
      if (!resolveProvider(model)) {
        return { ok: false as const, status: 400, error: MISSING_KEY_ERROR };
      }
      return { ok: true as const };
    },

    runner: {
      async run(ctx: RunCtx): Promise<void> {
        const startedAt = Date.now();
        const sessionId = ctx.sessionId || `naby-${randomUUID()}`;
        const requestedModel =
          typeof ctx.params.model === 'string' ? ctx.params.model : undefined;

        // ---- provider + model resolver -----------------------------------
        let resolveModel: ModelResolver;
        let modelLabel: string;

        if (deps.resolveModel) {
          resolveModel = deps.resolveModel;
          modelLabel = requestedModel || 'injected-model';
        } else {
          const resolved = resolveProvider(requestedModel);
          if (!resolved) {
            // preflight normally catches this; belt-and-braces for the
            // scheduled-task path, which may call run() directly.
            ctx.emit({ type: 'error', error: MISSING_KEY_ERROR });
            ctx.emit({
              type: 'result',
              subtype: 'error_during_execution',
              session_id: sessionId,
              is_error: true,
              result: MISSING_KEY_ERROR,
              usage: toSdkUsage(undefined),
              total_cost_usd: 0,
              duration_ms: Date.now() - startedAt,
              num_turns: 0,
            });
            return;
          }
          const { profile, apiKey } = resolved;
          modelLabel = profile.model;
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

        const store = new MemoryStore();
        store.appendMessage(sessionId, {
          role: 'user',
          content: ctx.prompt ?? '',
        });

        // Session framing goes through the engine's `system` OPTION, not as a
        // system message in the history: `ai@7` rejects `role:'system'` inside
        // `messages` outright ("System messages are not allowed in the prompt
        // or messages fields"). The engine forwards this to the provider's
        // dedicated system slot.
        const engine = new AiSdkEngine({
          resolveModel,
          ...(ctx.cwd
            ? {
                system: `You are running inside the naby shell. Working directory: ${ctx.cwd}`,
              }
            : {}),
        });

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
          for await (const ev of engine.run({
            model: {
              providerId: deps.resolveModel ? 'injected' : resolveProviderId(),
              model: modelLabel,
            },
            messages: store.session(sessionId).messages,
            toolSchemas,
            gate,
            executors,
            signal: ctx.signal,
          }) as AsyncIterable<EngineEvent>) {
            // Cancellation: stop translating the moment the run is stopped.
            // The signal is also handed to the engine (and through it to the
            // provider call), so this is a second, immediate barrier rather
            // than the only one.
            if (ctx.signal.aborted) break;

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
          }
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

/** Provider id for the run's ModelSelection; falls back to the first candidate
 *  so the selection is well-formed even on the (preflight-blocked) no-key path. */
function resolveProviderId(): string {
  return process.env.NABY_PROVIDER || resolveProvider()?.profile.id || 'anthropic';
}

export const nabySpec: EngineSpec = createNabySpec();
