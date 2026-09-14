import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_USER_ID,
  MemoryStore,
  engineEnvironmentNotes,
} from '../../../../../../../dist/naby-runtime.mjs';
import { gatherSubagents } from './naby';

/**
 * WHO MAY BE DELEGATED TO, WHAT THE TURN IS TOLD ABOUT IT, AND WHAT CAME BACK
 * (specs/subagent-delegation.md §4.1-§4.4, milestone M2).
 *
 * The M2 seam is four wires between a runtime that already works (M1) and a
 * client that already reads the events (M3). Three of the four are ORDER and
 * ARGUMENT facts inside a two-thousand-line turn body, and each fails silently:
 *
 *   * THE ROSTER FILTER. Without the `engineId` argument, `explorer` and
 *     `implementer` are offered on the AI-SDK engine too — where their tools
 *     (`Read`/`Glob`/`Grep`) match nothing in naby's toolset and `haiku` is asked
 *     of whichever provider is selected. Nothing throws; the delegation just
 *     returns a useless answer.
 *   * THE POLICY'S PLACE. `turnSystem` is an ORDERED array: the handoff is
 *     context and the delegation policy is policy, so context must not be able to
 *     talk the turn out of it (§4.2). Swap the two and every assertion an
 *     end-to-end run could make still passes.
 *   * THE MUTATION FLAG. `canMutate` is `allowChanges && !planMode` in TWO
 *     places — the ai-sdk sink's tool description and the dev-claude system
 *     block. If they drift, one engine tells a read-only turn to hand code
 *     changes to `implementer` and the gate refuses every one of them.
 *
 * So those three are SOURCE assertions, for the reason `nabyAutoModel.test.ts`
 * gives about itself: what is being asserted is an order and an argument, neither
 * observable from outside a live turn. The filter ALSO gets a real unit test
 * below, because its behaviour — which rows survive for which engine — is a pure
 * function of the store and can simply be run.
 */

const SRC = readFileSync(join(__dirname, 'naby.ts'), 'utf8');
const API_SRC = readFileSync(join(__dirname, '..', 'api', 'naby.ts'), 'utf8');

/** Index of the single occurrence of `needle`, with a readable failure when the
 *  text moved or was duplicated (the helper `nabyAutoModel.test.ts` uses). */
function only(src: string, needle: string): number {
  const matches = [...src.matchAll(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))];
  expect(matches.length, `expected exactly one \`${needle}\``).toBe(1);
  return matches[0]!.index!;
}

describe('the roster is filtered by the engine that will run the turn', () => {
  it('gatherSubagents takes the engine and asks the runtime, once', () => {
    expect(SRC).toContain('export function gatherSubagents(');
    expect(SRC).toContain('  engineId: string | undefined,');
    // The runtime owns the rule (a row with no `engines` runs everywhere); the
    // shell must not re-implement it, which is why the only mention here is a call.
    only(SRC, 'if (!subagentAllowedForEngine(it.subagent, engineId)) continue;');
  });

  it('gathers it ONCE and gives the same list to the sink, the prompt and the engine', () => {
    // Three consumers, one computation: a prompt that names a subagent the engine
    // input leaves out is the failure this prevents.
    const bound = only(SRC, 'const turnSubagents = gatherSubagents(store, projectCwd, engineId);');
    // The two consumers that pass the roster on — the delegation sink and the
    // engine input — anchored by the ARGUMENT, not by the comment that happens to
    // follow it or the indentation it happens to sit at.
    const passes = [...SRC.matchAll(/subagents: turnSubagents,/g)];
    expect(passes, 'the sink and the engine input, and nothing else').toHaveLength(2);
    const prompt = only(SRC, 'turnSubagents.map((s) => s.name),');
    for (const [label, at] of [
      ['first `subagents: turnSubagents`', passes[0]!.index!],
      ['second `subagents: turnSubagents`', passes[1]!.index!],
      ['prompt', prompt],
    ] as const) {
      expect(at, `the ${label} must read a roster that is already bound`).toBeGreaterThan(bound);
    }
    // And nothing gathers a SECOND roster behind their backs.
    expect([...SRC.matchAll(/gatherSubagents\(/g)]).toHaveLength(2); // the definition + the one call
  });
});

describe('the delegation policy block in the dev-claude system prompt', () => {
  it('sits after the handoff (context) and before the stage instruction (§4.2)', () => {
    const handoff = only(SRC, 'handoffInstruction(sessionRef?.handoff),');
    const policy = only(SRC, '? delegationPolicyFor(');
    const stage = only(SRC, '? stageInstruction(routedStage, stageProgressSummary(routedGrowth!))');
    expect(policy, 'policy must follow the handoff — context cannot outrank policy').toBeGreaterThan(
      handoff,
    );
    expect(policy, 'policy must precede the stage instruction').toBeLessThan(stage);
  });

  it('is built from the turn mutation allowance, the same expression the sink uses', () => {
    // Two occurrences, deliberately: the sink (every other engine, via the
    // `naby_delegate` description) and this block (dev-claude, via the prompt).
    // Written out in full in both so a reader can see they agree.
    expect([...SRC.matchAll(/canMutate: allowChanges && !planMode/g)]).toHaveLength(2);
    // Both are bound before either is read.
    const allowChanges = only(SRC, 'const allowChanges =');
    const planMode = only(SRC, 'const planMode = ctx.params.permissionMode');
    const firstUse = SRC.indexOf('canMutate: allowChanges && !planMode');
    expect(firstUse).toBeGreaterThan(allowChanges);
    expect(firstUse).toBeGreaterThan(planMode);
  });

  it('is dev-claude only, so no turn states the policy twice', () => {
    // Every other engine gets the SAME sentences appended to `naby_delegate`'s
    // description by the runtime. Without this guard, a user-authored subagent
    // named `explorer` with no `engines` would produce both on an ai-sdk turn.
    const policy = only(SRC, '? delegationPolicyFor(');
    expect(SRC.slice(policy - 200, policy)).toContain('nativeSubagents');
  });

  it('gives the sink the flag too, so the tool description matches the prompt', () => {
    const sinkAt = only(SRC, 'const delegationSink = nativeSubagents');
    const flagAt = SRC.indexOf('canMutate: allowChanges && !planMode', sinkAt);
    expect(flagAt, 'the sink carries canMutate').toBeGreaterThan(sinkAt);
    // Inside the sink literal, not somewhere after it: the sink ends at the
    // delegation policy block, which is thousands of characters later.
    expect(flagAt - sinkAt).toBeLessThan(2000);
  });
});

describe('what model actually answered a delegation (§4.3)', () => {
  it('is forwarded under the same attribution key as the subagent text', () => {
    const at = only(SRC, "case 'subagent_model': {");
    const emitted = SRC.slice(at, at + 1400);
    expect(emitted).toContain("type: 'subagent_model',");
    expect(emitted).toContain('session_id: sessionId,');
    // `agent_tool_call_id` is what the client matches the block on — the same key
    // `subagent_text` uses (client/applyStreamEvent.ts).
    expect(emitted).toContain('agent_tool_call_id: ev.agentToolCallId,');
    expect(emitted).toContain('model: ev.model,');
  });

  it('is translated in the same switch that translates subagent text', () => {
    // The shell's own `RunEvent` is an open `{ type: string }`, so nothing else
    // needs extending and nothing would have complained had the case been missing.
    const text = only(SRC, "type: 'subagent_text',");
    const model = only(SRC, "case 'subagent_model': {");
    expect(Math.abs(model - text)).toBeLessThan(4000);
  });
});

describe('gatherSubagents, run for real against a store', () => {
  /** One enabled user-scope subagent, optionally narrowed to some engines. */
  function put(store: MemoryStore, name: string, engines?: string[]): void {
    store.putHarnessItem({
      item: {
        scope: 'user',
        scopeKey: DEFAULT_USER_ID,
        kind: 'subagent',
        name,
        description: `${name} description`,
        provenance: { source: 'user' },
        subagent: {
          systemPrompt: `You are ${name}.`,
          ...(engines ? { engines } : {}),
        },
      },
      requestedStatus: 'enabled',
    });
  }

  function names(store: MemoryStore, engineId: string): string[] {
    return gatherSubagents(store, undefined, engineId)
      .map((s) => s.name)
      .sort();
  }

  it('excludes a dev-claude-only row from an ai-sdk turn and keeps it on dev-claude', () => {
    const store = new MemoryStore();
    put(store, 'explorer', ['dev-claude']);
    expect(names(store, 'ai-sdk')).toEqual([]);
    expect(names(store, 'dev-claude')).toEqual(['explorer']);
  });

  it('keeps a row that declares no engines on both — every subagent written before §4.1', () => {
    const store = new MemoryStore();
    put(store, 'anywhere');
    expect(names(store, 'ai-sdk')).toEqual(['anywhere']);
    expect(names(store, 'dev-claude')).toEqual(['anywhere']);
  });

  it('mixes them per engine, which is what the policy block then sees', () => {
    const store = new MemoryStore();
    put(store, 'explorer', ['dev-claude']);
    put(store, 'implementer', ['dev-claude']);
    put(store, 'confluence-researcher');
    expect(names(store, 'dev-claude')).toEqual(['confluence-researcher', 'explorer', 'implementer']);
    // On ai-sdk only the engine-neutral one survives, so `delegationPolicyFor`
    // gets a roster naming neither built-in and returns nothing (§4.2).
    expect(names(store, 'ai-sdk')).toEqual(['confluence-researcher']);
  });
});

describe('the engine-environment diagnostic in the GET payload (§4.4)', () => {
  it('is read from the process environment at the one call site, explicitly', () => {
    // The argument is passed although it is also the default: it keeps "this
    // reads the environment" visible at the call site, and it is the seam the
    // masking test below uses.
    only(API_SRC, 'engineEnv: engineEnvironmentNotes(process.env),');
    expect(API_SRC).toContain('engineEnv: EngineEnvNote[];');
  });

  it('never reports the VALUE of a credential variable', () => {
    // A token on a settings screen is a token in every screenshot of it. The
    // length assertion is the real claim: `set` is four characters, and any
    // implementation that let a prefix or a suffix through would fail it.
    const notes = engineEnvironmentNotes({
      // `NODE_ENV` only because Next's type augmentation makes it required on
      // `ProcessEnv`; nothing in the table looks at it.
      NODE_ENV: 'test',
      CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-${'x'.repeat(90)}`,
      ANTHROPIC_API_KEY: `sk-ant-api03-${'y'.repeat(90)}`,
      CLAUDE_CODE_SUBAGENT_MODEL: 'opus',
    });
    const byName = Object.fromEntries(notes.map((n) => [n.name, n]));
    for (const secret of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
      expect(byName[secret], `${secret} must be reported`).toBeDefined();
      expect(byName[secret]!.value).toBe('set');
      expect(byName[secret]!.value.length).toBeLessThanOrEqual(4);
      expect(byName[secret]!.effect.length).toBeGreaterThan(0);
    }
    // A non-secret one DOES show its value — that is the whole point of the list:
    // the user has to see which model their shell is forcing.
    expect(byName['CLAUDE_CODE_SUBAGENT_MODEL']!.value).toBe('opus');
  });

  it('says nothing about a variable that is not set', () => {
    expect(engineEnvironmentNotes({ NODE_ENV: 'test' })).toEqual([]);
    // Exported-but-empty is what a shell leaves behind; it changes nothing.
    expect(engineEnvironmentNotes({ NODE_ENV: 'test', ANTHROPIC_MODEL: '  ' })).toEqual([]);
  });
});
