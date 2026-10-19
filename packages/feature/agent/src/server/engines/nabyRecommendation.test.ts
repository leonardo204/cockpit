import { describe, it, expect, afterEach } from 'vitest';
import { createNabySpec, getStore } from './naby';
import { resolveApproval } from '../lib/approvalRegistry';
import type { Agent, ParticipantProfile } from '../../../../../../../dist/naby-runtime.mjs';
import type { RunCtx, RunEvent } from './types';

/**
 * PARTICIPANT RECOMMENDATIONS, WIRED INTO THE TURN (multi-agent-chat §8.13,
 * MAC-M6) — through the production `createNabySpec` with a scripted model (the
 * harness of nabyParticipantRound.test.ts):
 *
 *   * the finished turn kicks the sweep for ITS session, once, after the turn's
 *     `result` is out — and what the sweep does (even throwing) changes nothing
 *     in the turn's events;
 *   * a scripted-model run kicks nothing by default (no real provider behind
 *     the script);
 *   * an approved proposal (R3.9) closes a pending recommendation of the same
 *     participant as accepted.
 */

type Call = { system: string; tools: string[]; kind: 'route' | 'participant' | 'naby' };

function scriptedModel(script: { routes?: string[]; participant?: string; naby?: string }, calls: Call[]) {
  const routes = [...(script.routes ?? [])];
  return {
    specificationVersion: 'v4' as const,
    provider: 'mock',
    modelId: 'claude-sonnet-4-5',
    supportedUrls: {},
    async doGenerate(options: { prompt: unknown; tools?: { name: string }[] }) {
      const prompt = options.prompt as { role: string; content: unknown }[];
      const sys = prompt.find((m) => m.role === 'system');
      const system = sys && typeof sys.content === 'string' ? sys.content : '';
      const tools = (options.tools ?? []).map((t) => t.name);
      let text: string;
      let kind: Call['kind'];
      if (system.includes('Decide who should respond')) {
        kind = 'route';
        text = routes.shift() ?? '{"action":"end","reason":"done"}';
      } else if (/You are @\S+ \(/.test(system)) {
        kind = 'participant';
        text = script.participant ?? 'Hello from the participant.';
      } else {
        kind = 'naby';
        text = script.naby ?? 'naby here.';
      }
      calls.push({ system, tools, kind });
      return {
        content: [{ type: 'text' as const, text }],
        finishReason: { unified: 'stop' as const, raw: 'end_turn' },
        usage: {
          inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [] as never[],
      };
    },
    async doStream() {
      throw new Error('not used');
    },
  };
}

/** One model instance for the whole turn — `resolveModel` is asked once per
 *  engine call, and the scripted routing answers are consumed in order. */
function once<T>(model: T): () => T {
  return () => model;
}

function harness(sessionId: string, prompt: string, onEmit?: (e: RunEvent) => void) {
  const events: RunEvent[] = [];
  const controller = new AbortController();
  let key = sessionId;
  const ctx: RunCtx = {
    prompt,
    images: undefined,
    cwd: '',
    sessionId,
    params: { prompt, engine: 'naby', model: 'claude-sonnet-4-5' },
    signal: controller.signal,
    emit(event: RunEvent) {
      events.push(event);
      onEmit?.(event);
    },
    rekey(id: string) {
      key = id;
    },
    currentKey() {
      return key;
    },
  };
  return { ctx, events, controller };
}

const profile: ParticipantProfile = {
  displayName: 'Translator',
  avatar: { kind: 'emoji', value: '🌐' },
  color: '#0ea5e9',
  knowledge: [],
  guardrails: {},
  mcpServers: [],
  skills: [],
};

let seq = 0;
function participant(name = `tr${(seq += 1)}`, over: Partial<Agent> = {}): Agent {
  return getStore().putAgent({
    name,
    kind: 'participant',
    description: 'Translates between Korean and English.',
    systemPrompt: 'You translate.',
    toolRefs: [],
    memoryScope: 'user',
    autonomy: { escalation: 'inline' },
    profile,
    ...over,
  });
}

afterEach(() => {
  const store = getStore();
  for (const a of store.listAgents()) if (a.kind === 'participant') store.removeAgent(a.id);
  store.setSetting('participants.proposals.enabled', '');
});

const shape = (events: RunEvent[]) => events.map((e) => `${e.type}/${(e as { subtype?: string }).subtype ?? ''}`);

describe('naby engine — the recommendation kick', () => {
  it('kicks once for the turn\'s own session, after the result is out', async () => {
    const store = getStore();
    const { sessionId } = store.createSession('', 'kick');
    const calls: Call[] = [];
    const kicks: { sessionId: string; eventsSoFar: number; sawResult: boolean }[] = [];
    let events: RunEvent[] = [];
    const spec = createNabySpec({
      resolveModel: once(scriptedModel({ naby: 'hello' }, calls) as never),
      recommendationSweep: (_s, o) => {
        kicks.push({ sessionId: o.sessionId, eventsSoFar: events.length, sawResult: events.some((e) => e.type === 'result') });
      },
    });
    const h = harness(sessionId, 'hi there');
    events = h.events;
    await spec.runner.run(h.ctx);
    expect(kicks).toEqual([{ sessionId, eventsSoFar: h.events.length, sawResult: true }]);
  });

  it('a stopped turn kicks no sweep', async () => {
    const store = getStore();
    const { sessionId } = store.createSession('', 'kick');
    const kicks: string[] = [];
    const spec = createNabySpec({
      resolveModel: once(scriptedModel({ naby: 'hello' }, []) as never),
      recommendationSweep: (_s, o) => {
        kicks.push(o.sessionId);
      },
    });
    const h = harness(sessionId, 'hi there', (e) => {
      // Stop as soon as the turn has started.
      if (e.type === 'system') h.controller.abort();
    });
    await spec.runner.run(h.ctx);
    expect(h.controller.signal.aborted).toBe(true);
    expect(kicks).toEqual([]);
  });

  it('a sweep that throws leaves the turn\'s events exactly as they are', async () => {
    const store = getStore();
    const run = async (sweep: (s: unknown, o: { sessionId: string }) => void) => {
      const { sessionId } = store.createSession('', 'kick');
      const spec = createNabySpec({ resolveModel: once(scriptedModel({ naby: 'same answer' }, []) as never), recommendationSweep: sweep });
      const h = harness(sessionId, 'hi there');
      await spec.runner.run(h.ctx);
      return h.events;
    };
    const quiet = await run(() => {});
    const loud = await run(() => {
      throw new Error('sweep exploded');
    });
    expect(shape(loud)).toEqual(shape(quiet));
    expect(loud.some((e) => e.type === 'error')).toBe(false);
    const result = loud.find((e) => e.type === 'result') as { is_error?: boolean; result?: string };
    expect(result).toMatchObject({ is_error: false, result: 'same answer' });
  });

  it('an approved proposal closes the pending recommendation of the same participant', async () => {
    const store = getStore();
    const tr = participant();
    const { sessionId } = store.createSession('', 'round');
    const rec = store.putParticipantRecommendation({
      sessionId,
      kind: 'existing',
      agentId: tr.id,
      specialty: 'translation',
      reason: 'Translations keep coming.',
      evidence: [1, 2, 3],
    });
    const calls: Call[] = [];
    const spec = createNabySpec({
      resolveModel: once(scriptedModel({ routes: [`{"action":"propose","target":"${tr.name}","reason":"needs a translator"}`] }, calls) as never),
      recommendationSweep: () => {},
    });
    const { ctx } = harness(sessionId, 'translate this please', (e) => {
      if (e.type === 'approval_request') setTimeout(() => resolveApproval(String(e.approvalId), { behavior: 'allow' }), 0);
    });
    await spec.runner.run(ctx);
    expect(store.listSessionParticipants(sessionId)).toEqual([expect.objectContaining({ agentId: tr.id, status: 'active' })]);
    expect(store.getParticipantRecommendation(rec.id)?.status).toBe('accepted');
  });
});
