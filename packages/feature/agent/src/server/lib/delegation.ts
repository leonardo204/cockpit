// packages/feature/agent/src/server/lib/delegation.ts
//
// Phase 2.5 M4b — RUNNING a subagent as a nested turn.
//
// The runtime owns the `naby_delegate` tool, its validation and the depth cap
// (`runtime/delegate.ts`); this owns the one thing only the shell can do — drive
// an actual engine turn — and the three decisions that go with it.
//
// 1. A NESTED TURN GETS ITS OWN SESSION. `runTurn` persists messages, and writing
//    a subagent's internal exchange into the parent session would put words in the
//    transcript that the user never said and never saw — the same honesty rule the
//    autonomy loop follows when it labels its continuation prompts. A child session
//    keeps the exchange auditable (it is real work someone may need to read) while
//    leaving the parent's history exactly what happened in it.
//
// 2. THE PARENT'S GATE IS PASSED DOWN UNCHANGED. Not a copy, not a fresh one: the
//    same function. A subagent's Bash call is then decided by the same policy and
//    can suspend for the same human approval. Building a permissive gate for the
//    nested run would be a hole large enough to drive all of Phase 2 through.
//
// 3. `toolRefs` FILTERS THE PARENT'S TOOLSET, so the nested set is a subset by
//    construction. A subagent limited to Read cannot acquire Write by being
//    delegated to, and it cannot acquire a tool the parent turn did not have.
//
// 4. THE NESTED TURN NEVER GETS `naby_delegate`. This one is not an optimisation,
//    it closes a hole the first version had: the nested run inherits the PARENT's
//    executors, and the parent's delegate executor is bound to a sink saying
//    `depth: 0`. A subagent calling it would therefore pass the depth check
//    forever and recurse until something ran out — each level a real model call.
//    Stripping the tool makes the effective limit one level of hand-off. The
//    runtime's `MAX_DELEGATION_DEPTH` stays as the guard for a future caller that
//    rebuilds the sink with depth + 1 instead.

import {
  runTurn,
  DELEGATE_TOOL_NAME,
  type EngineEvent,
  type DelegationResult,
  type Executor,
  type Gate,
  type Store,
  type SubagentSpec,
  type ToolSchema,
} from '../../../../../../../dist/naby-runtime.mjs';

/** Title given to a delegated child session, so it is recognisable in the session
 *  list rather than looking like a conversation the user forgot having. */
export function delegatedSessionTitle(name: string, task: string): string {
  const gist = task.replace(/\s+/g, ' ').trim().slice(0, 60);
  return `[delegated] @${name}: ${gist}`;
}

/** Keep only the tools a subagent is allowed. `toolRefs` undefined = inherit the
 *  turn's tools; set = exactly those, intersected with what the turn actually has.
 *  The intersection is the point: a spec naming a tool the parent lacks does not
 *  conjure it. */
export function restrictToolset(
  spec: SubagentSpec,
  toolSchemas: readonly ToolSchema[],
  executors: Readonly<Record<string, Executor>>,
): { toolSchemas: ToolSchema[]; executors: Record<string, Executor> } {
  // `naby_delegate` is removed FIRST and unconditionally — header note 4. The
  // parent's executor carries the parent's depth, so re-offering it would let a
  // subagent recurse past the cap.
  const offered = toolSchemas.filter((t) => t.name !== DELEGATE_TOOL_NAME);
  const runnable: Record<string, Executor> = {};
  for (const name of Object.keys(executors)) {
    if (name !== DELEGATE_TOOL_NAME) runnable[name] = executors[name]!;
  }
  if (!spec.toolRefs) return { toolSchemas: offered, executors: runnable };

  const allowed = new Set(spec.toolRefs.map((t) => t.trim()).filter(Boolean));
  const keptExecutors: Record<string, Executor> = {};
  for (const name of Object.keys(runnable)) {
    if (allowed.has(name)) keptExecutors[name] = runnable[name]!;
  }
  return { toolSchemas: offered.filter((t) => allowed.has(t.name)), executors: keptExecutors };
}

/**
 * Pull the subagent's answer out of a nested run's events.
 *
 * The discriminant is `kind`, not `type` — `EngineEvent` is the RUNTIME's event
 * union, not the shell's Agent-SDK-shaped `RunEvent`, and the two use different
 * field names for the same idea. Reading the wrong one produced an empty answer
 * on every delegation, reported as "the subagent produced no answer".
 *
 * Only ASSISTANT text counts: a nested run's events include the user message it
 * was given, and folding that in would hand the parent its own task back as the
 * answer. Partial deltas are skipped when a final chunk for the same span
 * follows, which the runtime signals with `partial`.
 */
export function textFromEvents(events: readonly EngineEvent[]): {
  text: string;
  ok: boolean;
  error?: string;
} {
  let answer = '';
  let ok = true;
  let error: string | undefined;
  for (const ev of events) {
    const e = ev as unknown as Record<string, unknown>;
    if (e.kind === 'text' && e.role === 'assistant' && typeof e.text === 'string' && !e.partial) {
      answer += e.text;
    }
    if (e.kind === 'result' && e.ok === false) ok = false;
    if (e.kind === 'error') {
      ok = false;
      if (typeof e.message === 'string' && e.message) error = e.message;
    }
  }
  const text = answer.trim();
  // A run that produced nothing at all is a failure even when no error was
  // emitted: handing the parent an empty answer as a success would have it build
  // on air.
  if (!text && ok) {
    ok = false;
    error = error ?? 'the subagent produced no answer';
  }
  return { text, ok, ...(error ? { error } : {}) };
}

export interface NestedRunDeps {
  store: Store;
  engine: Parameters<typeof runTurn>[0]['engine'];
  model: Parameters<typeof runTurn>[0]['model'];
  /** The PARENT's gate, passed down unchanged (see the header). */
  gate: Gate;
  /** The parent turn's tools, which `toolRefs` then narrows. */
  toolSchemas: readonly ToolSchema[];
  executors: Readonly<Record<string, Executor>>;
  signal: AbortSignal;
  cwd?: string;
  /** Called with the child session id so the caller can log or surface it. */
  onSession?: (sessionId: string, spec: SubagentSpec) => void;
}

/** Run one subagent as a nested turn. Never throws: a failure is a
 *  `DelegationResult` the tool turns into a tool error the model can react to. */
export async function runNestedTurn(
  deps: NestedRunDeps,
  input: { spec: SubagentSpec; task: string },
): Promise<DelegationResult> {
  const { spec, task } = input;
  const restricted = restrictToolset(spec, deps.toolSchemas, deps.executors);
  let childSessionId: string;
  try {
    childSessionId = deps.store.createSession(
      deps.model.providerId,
      delegatedSessionTitle(spec.name, task),
      deps.cwd,
    ).sessionId;
  } catch (e) {
    return { ok: false, text: '', error: `could not open a session: ${e instanceof Error ? e.message : String(e)}` };
  }
  deps.onSession?.(childSessionId, spec);

  try {
    const events = await runTurn({
      engine: deps.engine,
      store: deps.store,
      sessionId: childSessionId,
      // The subagent's own model when it has one; otherwise the parent's.
      model: spec.model ? { ...deps.model, model: spec.model } : deps.model,
      userText: task,
      system: spec.systemPrompt,
      toolSchemas: restricted.toolSchemas,
      executors: restricted.executors,
      gate: deps.gate,
      signal: deps.signal,
      ...(deps.cwd ? { cwd: deps.cwd } : {}),
    });
    return textFromEvents(events);
  } catch (e) {
    return { ok: false, text: '', error: e instanceof Error ? e.message : String(e) };
  }
}
