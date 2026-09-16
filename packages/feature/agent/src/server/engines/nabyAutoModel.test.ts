import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * WHERE `auto` IS INTERCEPTED, AND THAT NOTHING SENDS THE WORD TO A PROVIDER
 * (specs/model-auto-routing.md §4.5, §4.6).
 *
 * SOURCE ASSERTIONS, DELIBERATELY, and the reason is the same one
 * `usageLimitsTranscript.test.ts` gives about itself: what is being asserted is
 * an ORDER and an ABSENCE, and neither is observable from the outside.
 *
 *   * THE ORDER. `resolveAutoModel` reads `turnText`, the routed stage and plan
 *     mode, and it must assign `modelForEngine` before the init event names a
 *     model. Move the call above the `turnText` binding and it routes on an empty
 *     string — every turn becomes a `chat` turn, the chip says "Auto · Sonnet"
 *     forever, and nothing throws. Move it below the emit and the chip shows
 *     `auto` while the engine runs something else. BOTH FAILURES ARE SILENT, and
 *     both produce a passing end-to-end run.
 *   * THE ABSENCE. The claim is "no path sends the string `auto` to the SDK's
 *     model option". Exercising it would need a live Agent SDK, an agent row with
 *     a hand-typed model, and a subagent imported from a file — and the symptom
 *     would be a vendor error message, not a value this suite could inspect.
 *
 * The `runner.run` body is over a thousand lines, so the positional assertions
 * slice it out first: `indexOf` over the whole file would happily match a comment
 * in the header.
 */

const SRC = readFileSync(join(__dirname, 'naby.ts'), 'utf8');

/** Index of the single occurrence of `needle`, with a readable failure when the
 *  text moved or was duplicated. */
function only(needle: string | RegExp): number {
  const matches = [...SRC.matchAll(new RegExp(typeof needle === 'string'
    ? needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    : needle.source, 'g'))];
  expect(matches.length, `expected exactly one \`${needle}\` in engines/naby.ts`).toBe(1);
  return matches[0]!.index!;
}

describe('the router runs after the signals are bound and before the init event', () => {
  it('every signal it reads is already bound at the call site', () => {
    const call = only('resolveAutoModel({');
    // §3 lists these four bindings as the reason the call site is where it is.
    for (const binding of [
      'const turnText = addressedAgent ?',
      'const planMode = ctx.params.permissionMode',
      'const subjectGrowth = growthSubject',
      'const routedStage = routedGrowth?.stage',
    ]) {
      const at = SRC.indexOf(binding);
      expect(at, `binding not found: ${binding}`).toBeGreaterThan(-1);
      expect(at, `\`${binding}\` must be bound before resolveAutoModel runs`).toBeLessThan(call);
    }
  });

  it('and it assigns the model before the init event names one', () => {
    const call = only('resolveAutoModel({');
    const init = SRC.indexOf("subtype: 'init'");
    expect(init).toBeGreaterThan(-1);
    expect(call, 'resolveAutoModel must run before the init emit').toBeLessThan(init);
    // The assignment itself, not just the call: a routed value that is computed
    // and dropped is the same bug with extra steps.
    const assign = SRC.indexOf('modelForEngine = routed.value', call);
    expect(assign).toBeGreaterThan(call);
    expect(assign).toBeLessThan(init);
    // `ctx.rekey` is the statement the init block opens with; routing has to be
    // settled before the turn is keyed and announced.
    expect(call).toBeLessThan(SRC.indexOf('ctx.rekey(sessionId)'));
  });

  it('both readers of modelForEngine see the routed value', () => {
    // The premise §3 rests on: between the dev-claude branch and the init event
    // NOTHING READS `modelForEngine` EAGERLY, so assigning here is enough and no
    // captured copy can go stale. The two readers hold it in two different ways,
    // so they are checked in two different ways.
    const assign = only('modelForEngine = routed.value');

    // (1) `runTurn`'s model is TEXTUALLY BELOW the assignment — ordinary
    //     straight-line execution, nothing subtle about it. Matched on the whole
    //     expression: `effectiveAgentModel(routedAgent?.model)` also appears
    //     ABOVE, in the pinned-agent branch, and that one is a different site.
    expect(
      SRC.indexOf('const m = effectiveAgentModel(routedAgent?.model) ?? modelForEngine;'),
    ).toBeGreaterThan(assign);

    // (2) The delegation sink is textually ABOVE it and still correct, because
    //     the read sits INSIDE `run`'s arrow body — evaluated when a delegation
    //     actually happens, which is inside the turn. Hoisting it out of that
    //     body (a tempting "compute it once" refactor) would read the `let`
    //     while it is still undefined and silently delegate on the provider
    //     default. So the assertion is about CONTAINMENT, not about order.
    const sinkAt = SRC.indexOf('run: (input: { spec: SubagentSpec; task: string }) =>');
    expect(sinkAt, 'the delegation sink moved — re-derive this test').toBeGreaterThan(-1);
    const readAt = SRC.indexOf('effectiveAgentModel(modelForEngine)');
    expect(readAt, 'the nested turn no longer guards its model').toBeGreaterThan(sinkAt);
    expect(readAt, 'the nested turn reads modelForEngine outside the lazy `run` body')
      .toBeLessThan(assign);
    // And the sink's whole payload is inside that arrow: the object literal is an
    // argument to `runNestedTurn`, which is the arrow's single expression body.
    expect(SRC.slice(sinkAt, readAt)).not.toContain('\n        };');
  });

  it('nothing between the interception and the router READS the model eagerly', () => {
    // THE PREMISE THE WHOLE DESIGN RESTS ON (§3), checked rather than quoted: in
    // the span where `modelForEngine` is deliberately `undefined`, the only reads
    // are lazy ones. A straight-line read added later — a log line is harmless, a
    // `contextWindowFor(engineId, modelForEngine)` or a captured `const` is not —
    // would silently size, label or send on `undefined` for every `auto` turn,
    // and no runtime test would notice.
    const lines = SRC.split('\n');
    const from = lines.findIndex((l) => l.includes('autoRequested = selection.model ==='));
    const to = lines.findIndex((l) => l.includes('const routed = resolveAutoModel({'));
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const reads = lines
      .slice(from, to)
      .map((l) => l.trim())
      // Writes are fine (they are the mutually exclusive provider branches), and
      // prose about the variable is not a read.
      .filter((l) => l.includes('modelForEngine'))
      .filter((l) => !/^(\/\/|\*|\/\*)/.test(l))
      .filter((l) => !/^modelForEngine\s*=/.test(l))
      .filter((l) => !/^:\s*modelForEngine\s*\?\?/.test(l));
    expect(reads, `unexpected eager read(s) of modelForEngine:\n${reads.join('\n')}`).toEqual([
      'const m = effectiveAgentModel(modelForEngine);',
    ]);
  });

  it('the interception itself leaves the model empty and marks the turn', () => {
    // `NABY_DEV_MODEL` still outranks: `selection.model` is only ever set from
    // that env var, so the flag is conditioned on it being absent.
    expect(SRC).toContain(
      'autoRequested = selection.model === undefined && requestedModel === AUTO_MODEL_VALUE',
    );
    expect(SRC).toContain('modelForEngine = autoRequested ? undefined : selection.model ?? requestedModel');
  });

  it('logs the decision as one line, with the tier, the reason and the value', () => {
    expect(SRC).toContain('[engine:naby] auto → ${routed.tier} (${routed.reason}) as ${routed.value}');
  });
});

describe('the init event carries the routing (§4.6)', () => {
  it('`model_route` is on the init emit, and only when the turn was routed', () => {
    const init = SRC.indexOf("subtype: 'init'");
    expect(init).toBeGreaterThan(-1);
    const field = SRC.indexOf('...(modelRoute ? { model_route: modelRoute } : {})', init);
    expect(field, '`model_route` is not on the init emit').toBeGreaterThan(init);
    // Spread-on-a-condition, not `model_route: modelRoute` — a pinned-model turn
    // must not carry the key at all, because the client reads its PRESENCE as
    // "this turn was routed".
    expect(SRC).not.toMatch(/^\s*model_route: modelRoute,$/m);
  });

  it('the init `model` stays the functional value, which is what auto assigns', () => {
    // `contextWindowFor` measures the gauge's denominator off this string, so a
    // friendly label here sizes the turn as an unknown model (§4.5). NOT the
    // "thinking" bubble's brand, which does not depend on it: `deriveEngineName`
    // answers "Claude" off the engine id and never reaches its model sniff on
    // dev-claude.
    expect(SRC).toContain('modelLabel = routed.value');
    expect(SRC).toContain('model: modelLabel,');
  });
});

describe('no stored `auto` reaches a provider (§4.5)', () => {
  it('the routed agent’s model goes through the guard', () => {
    // Without it, an agent saved with `auto` would both outrank the router on the
    // very turn the user asked it to decide AND be rejected by the SDK.
    expect(SRC).toContain('const m = effectiveAgentModel(routedAgent?.model) ?? modelForEngine;');
    // And the unguarded form is gone.
    expect(SRC).not.toContain('const m = routedAgent?.model ?? modelForEngine;');
  });

  it('the subagent roster goes through the guard', () => {
    // `gatherSubagents` is the ONE place a stored subagent model becomes an
    // engine input, and it feeds both consumers: the Agent SDK's native `agents`
    // map on dev-claude and `naby_delegate`'s nested turns everywhere else.
    const at = SRC.indexOf('const subagentModel = effectiveAgentModel(it.subagent.model);');
    expect(at, 'the subagent roster does not neutralize a stored `auto`').toBeGreaterThan(-1);
    expect(SRC).toContain('...(subagentModel ? { model: subagentModel } : {}),');
    expect(SRC).not.toContain('...(it.subagent.model ? { model: it.subagent.model } : {}),');
  });

  it('the nested turn inherits a guarded model too', () => {
    expect(SRC).toContain('const m = effectiveAgentModel(modelForEngine);');
  });

  it('the test-injected resolver reads `auto` as no model', () => {
    // The SPIKE-02 seam. Unguarded, `modelLabel = requestedModel || …` makes the
    // word itself the label AND the functional model (the next line copies it),
    // so a spike or a scheduled task carrying an `auto` pick asks the injected
    // resolver for a model called "auto".
    expect(SRC).toContain(`modelLabel = effectiveAgentModel(requestedModel) ?? 'injected-model';`);
  });

  it('the ChatGPT subscription branch reads `auto` as no model', () => {
    // `auto` is the Claude scope's row, but the pick is stored per scope and the
    // engine can change between the pick and the send. Unguarded it becomes this
    // turn's `profile.model` and OpenAI is asked for a model named "auto".
    expect(SRC).toContain(
      'const model = effectiveAgentModel(requestedModel) ?? CHATGPT_OAUTH_DEFAULT_MODEL;',
    );
  });

  it('the metered provider branch reads `auto` as no override', () => {
    // `resolveMeteredProvider`'s second argument OVERRIDES the profile's own
    // model. Passing the raw request sends "auto" to Azure/Gemini/Anthropic as a
    // model id instead of letting the configured profile answer.
    expect(SRC).toContain('effectiveAgentModel(requestedModel),');
    expect(SRC).not.toContain('await resolveMeteredProvider(settings, requestedModel)');
  });

  it('every model field that can hold a stored value is guarded — seven sites', () => {
    // An eighth site added later without the guard is exactly the regression this
    // count exists to catch. Raise it deliberately, with its own assertion above.
    //
    // FOUR ARE STORED MODELS (the routed agent, the subagent roster, the nested
    // turn, `runTurn`'s pick) and THREE ARE REQUESTED ONES — the three provider
    // branches that are not dev-claude. The router only runs on dev-claude, so on
    // those branches `auto` is not a policy anything will execute; it is just a
    // string no provider answers to, which is precisely what this guard turns
    // into "no model".
    expect(SRC.match(/effectiveAgentModel\(/g)).toHaveLength(7);
  });
});

describe('a routed agent’s own model is answered without consulting the router', () => {
  /**
   * §4.5 says the routed agent's model wins, and `runTurn` already honoured that.
   * WINNING AT `runTurn` IS TOO LATE FOR THE INIT EVENT: run the router anyway and
   * its pick goes out as `model`, its tier and reason go out as `model_route`, and
   * the chip says "Auto · Haiku" for a turn opus is about to answer — until the
   * result's `context_model` arrives to contradict it. The init event must never
   * describe a model that is not the one running (§4.6).
   */
  it('the router call is guarded by the routed-agent-model check', () => {
    const pin = SRC.indexOf('const pinnedAgentModel = effectiveAgentModel(routedAgent?.model);');
    expect(pin, 'the routed-agent model is no longer read before the router').toBeGreaterThan(-1);
    // The pinned branch comes FIRST and the router is the `else`, so there is no
    // ordering in which both run.
    expect(SRC).toContain('if (autoRequested && pinnedAgentModel) {');
    expect(SRC).toContain('} else if (autoRequested) {');
    const guard = SRC.indexOf('} else if (autoRequested) {');
    const call = SRC.indexOf('const routed = resolveAutoModel({');
    expect(guard).toBeGreaterThan(pin);
    expect(call, 'resolveAutoModel escaped the else branch').toBeGreaterThan(guard);
  });

  it('it fills both fields from that model and claims no routing', () => {
    expect(SRC).toContain('modelForEngine = pinnedAgentModel;');
    expect(SRC).toContain('modelLabel = pinnedAgentModel;');
    // `modelRoute` is assigned in exactly one place — the router branch — so the
    // pinned branch cannot report a routing that did not happen.
    expect(SRC.match(/^\s*modelRoute = /gm)).toHaveLength(1);
    const assign = SRC.indexOf('modelRoute = { requested: AUTO_MODEL_VALUE');
    expect(assign).toBeGreaterThan(SRC.indexOf('const routed = resolveAutoModel({'));
  });

  it('and says so in one line', () => {
    expect(SRC).toContain(
      '[engine:naby] auto → agent model ${pinnedAgentModel} (routed agent pins it)',
    );
  });
});
