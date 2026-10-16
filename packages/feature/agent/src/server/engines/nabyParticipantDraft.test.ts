import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createNabySpec, getStore } from './naby';
import { resolveApproval, type ApprovalExtras } from '../lib/approvalRegistry';
import { PARTICIPANT_DRAFT_RULE, PARTICIPANT_DRAFT_TOOL } from '../lib/participantDraft';
import type { ParticipantProfile } from '../../../../../../../dist/naby-runtime.mjs';
import type { RunCtx, RunEvent } from './types';

/**
 * NABY DRAFTS A PARTICIPANT, WIRED (multi-agent-chat §8.12, MAC-M5a) — through
 * the production `createNabySpec` with a scripted model. What is asserted is the
 * engine adapter's own wiring: which turns are offered the tool, that its line
 * is in naby's prompt exactly when the tool is, and that the gate lets NO policy
 * answer for it — allow-all, an `allow` rule and an `ask` rule all still end in
 * the one draft card, while a `deny` rule refuses it.
 *
 * No network, no keys; the store is the throwaway one vitest.setup.ts points
 * NABY_DB_PATH at.
 */

type Call = { system: string; tools: string[]; prompt: string; kind: 'route' | 'participant' | 'naby' };
type Step = { tool?: { id: string; name: string; input: Record<string, unknown> }; text?: string };

/** naby's calls follow `nabySteps` in order; a routing call answers `end`; a
 *  participant answers one line. */
function scriptedModel(nabySteps: Step[], calls: Call[]) {
  let i = 0;
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
      const usage = {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      };
      const text = (t: string) => ({
        content: [{ type: 'text' as const, text: t }],
        finishReason: { unified: 'stop' as const, raw: 'end_turn' },
        usage,
        warnings: [] as never[],
      });
      if (system.includes('Decide who should respond')) {
        calls.push({ system, tools, prompt: JSON.stringify(prompt), kind: 'route' });
        return text('{"action":"end","reason":"done"}');
      }
      if (/You are @\S+ \(/.test(system)) {
        calls.push({ system, tools, prompt: JSON.stringify(prompt), kind: 'participant' });
        return text('participant line');
      }
      calls.push({ system, tools, prompt: JSON.stringify(prompt), kind: 'naby' });
      const step = nabySteps[Math.min(i, Math.max(0, nabySteps.length - 1))] ?? { text: 'ok.' };
      i += 1;
      if (step.tool) {
        return {
          content: [
            { type: 'tool-call' as const, toolCallId: step.tool.id, toolName: step.tool.name, input: JSON.stringify(step.tool.input) },
          ],
          finishReason: { unified: 'tool-calls' as const, raw: 'tool_use' },
          usage,
          warnings: [] as never[],
        };
      }
      return text(step.text ?? 'ok.');
    },
    async doStream() {
      throw new Error('not used');
    },
  };
}

function harness(sessionId: string, prompt: string, onEmit?: (e: RunEvent) => void, params: Record<string, unknown> = {}) {
  const events: RunEvent[] = [];
  const controller = new AbortController();
  let key = sessionId;
  const ctx: RunCtx = {
    prompt,
    images: undefined,
    cwd: '',
    sessionId,
    params: { prompt, engine: 'naby', model: 'claude-sonnet-4-5', ...params },
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

/** Answer every approval request with `decision` (+ extras), as the card would. */
function answering(decision: 'allow' | 'deny', extras?: ApprovalExtras) {
  return (e: RunEvent) => {
    if (e.type !== 'approval_request') return;
    setTimeout(
      () =>
        resolveApproval(
          String(e.approvalId),
          decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', reason: 'you denied this tool call' },
          extras,
        ),
      0,
    );
  };
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

const draftCall = (name: string, extra: Record<string, unknown> = {}): Step => ({
  tool: {
    id: `call-${name}`,
    name: PARTICIPANT_DRAFT_TOOL,
    input: {
      action: 'create',
      name,
      displayName: 'Translator',
      description: 'Translates between Korean and English.',
      instructions: 'You translate faithfully between Korean and English.',
      avatar: '🌐',
      ...extra,
    },
  },
});

afterEach(() => {
  const store = getStore();
  for (const a of store.listAgents()) if (a.kind === 'participant' || a.kind === 'custom') store.removeAgent(a.id);
  for (const r of store.listPolicyRules('user', 'local')) {
    if (r.toolPattern === PARTICIPANT_DRAFT_TOOL) store.removePolicyRule(r.id);
  }
  store.setSetting('participants.proposals.enabled', '');
});

describe('naby_participant_draft — which turns get it (R8.1)', () => {
  it('a plain naby turn with no participants has the tool and the R8.5 line', async () => {
    const store = getStore();
    const { sessionId } = store.createSession('', 'plain');
    const calls: Call[] = [];
    const spec = createNabySpec({ resolveModel: () => scriptedModel([{ text: 'hi' }], calls) as never });
    await spec.runner.run(harness(sessionId, '안녕').ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tools).toContain(PARTICIPANT_DRAFT_TOOL);
    expect(calls[0]!.system).toContain(PARTICIPANT_DRAFT_RULE);
    expect(calls[0]!.system.split('## Creating or changing participants')).toHaveLength(2);
  });

  it('in a round naby’s speech has it; the participant’s speech does not', async () => {
    const store = getStore();
    const tr = store.putAgent({
      name: 'draft-tr',
      kind: 'participant',
      description: 'Translates.',
      systemPrompt: 'You translate.',
      toolRefs: [PARTICIPANT_DRAFT_TOOL, 'naby_remember'],
      memoryScope: 'session',
      autonomy: { escalation: 'inline' },
      profile,
    });
    const { sessionId } = store.createSession('', 'round');
    store.putSessionParticipant(sessionId, tr.id, { status: 'active', addedBy: 'user' });
    const calls: Call[] = [];
    // The routing call delegates nothing, so naby answers; the participant is
    // named explicitly in the second turn.
    const spec = createNabySpec({ resolveModel: () => scriptedModel([{ text: 'naby' }], calls) as never });
    await spec.runner.run(harness(sessionId, `@${tr.name} hi`).ctx);
    const participantCall = calls.find((c) => c.kind === 'participant')!;
    // Even a participant whose toolRefs NAME the tool does not get it.
    expect(participantCall.tools).not.toContain(PARTICIPANT_DRAFT_TOOL);
    expect(participantCall.system).not.toContain('## Creating or changing participants');

    calls.length = 0;
    await spec.runner.run(harness(sessionId, '@naby 정리해줘').ctx);
    const naby = calls.find((c) => c.kind === 'naby')!;
    expect(naby.tools).toContain(PARTICIPANT_DRAFT_TOOL);
    expect(naby.system).toContain(PARTICIPANT_DRAFT_RULE);
  });

  it('a turn addressed to a custom agent is that agent’s — no draft tool, no line', async () => {
    const store = getStore();
    const custom = store.putAgent({
      name: 'draft-custom',
      kind: 'custom',
      systemPrompt: 'You are a reviewer.',
      memoryScope: 'session',
      autonomy: { escalation: 'inline' },
    });
    const { sessionId } = store.createSession('', 'custom');
    const calls: Call[] = [];
    const spec = createNabySpec({ resolveModel: () => scriptedModel([{ text: 'ok' }], calls) as never });
    await spec.runner.run(harness(sessionId, `@${custom.name} look at this`).ctx);
    expect(calls[0]!.tools).not.toContain(PARTICIPANT_DRAFT_TOOL);
    expect(calls[0]!.system).not.toContain('## Creating or changing participants');
  });

  it('a scheduled turn has nobody to approve a card — no tool', async () => {
    const store = getStore();
    const { sessionId } = store.createSession('', 'scheduled');
    const calls: Call[] = [];
    const spec = createNabySpec({ resolveModel: () => scriptedModel([{ text: 'ok' }], calls) as never });
    await spec.runner.run(harness(sessionId, 'daily report', undefined, { source: 'scheduled' }).ctx);
    expect(calls[0]!.tools).not.toContain(PARTICIPANT_DRAFT_TOOL);
  });
});

describe('naby_participant_draft — end to end through the turn (R8.2–R8.4)', () => {
  it('create and add: one draft card, the participant is saved and joins, naby reads the result', async () => {
    const store = getStore();
    const { sessionId } = store.createSession('', 'draft');
    const calls: Call[] = [];
    const spec = createNabySpec({
      resolveModel: () => scriptedModel([draftCall('draft-translator'), { text: '만들었어요' }], calls) as never,
    });
    const { ctx, events } = harness(sessionId, '번역가 참가자 만들어 줘', answering('allow', { addToSession: true }));
    await spec.runner.run(ctx);

    const requests = events.filter((e) => e.type === 'approval_request');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      tool_name: 'participant.create',
      source: 'participant_draft',
      session_id: sessionId,
      input: {
        draft: { action: 'create', name: 'draft-translator', displayName: 'Translator', addToSession: true },
        addToSession: true,
      },
    });
    const saved = store.getAgentByName('draft-translator')!;
    expect(saved).toMatchObject({ kind: 'participant', toolRefs: [], memoryScope: 'session' });
    expect(saved.profile).toMatchObject({ mcpServers: [], skills: [], avatar: { kind: 'emoji', value: '🌐' } });
    expect(store.listSessionParticipants(sessionId)).toEqual([
      expect.objectContaining({ agentId: saved.id, status: 'active', addedBy: 'naby' }),
    ]);
    // The resolved event comes after the write and names the participant, so a
    // roster refreshing on it reads the new row.
    expect(events.find((e) => e.type === 'approval_resolved')).toMatchObject({
      decision: 'allow',
      tool_name: 'participant.create',
      source: 'participant_draft',
      agentId: saved.id,
      addedToSession: true,
    });
    // naby's next call sees the Korean tool result.
    const last = calls.filter((c) => c.kind === 'naby').pop()!;
    expect(last.prompt).toContain('@draft-translator를 만들고 이 대화에 추가했어요');
  });

  it('allow-all baseline and an `allow` rule do not skip the card; an `ask` rule does not add a second one', async () => {
    const store = getStore();
    for (const effect of ['allow', 'ask'] as const) {
      const rule = store.putPolicyRule({ scope: 'user', scopeKey: 'local', toolPattern: PARTICIPANT_DRAFT_TOOL, effect });
      const { sessionId } = store.createSession('', `draft-${effect}`);
      const spec = createNabySpec({
        resolveModel: () => scriptedModel([draftCall(`draft-${effect}`), { text: 'ok' }], []) as never,
      });
      const { ctx, events } = harness(sessionId, 'make one', answering('allow'));
      await spec.runner.run(ctx);
      const requests = events.filter((e) => e.type === 'approval_request');
      expect(requests, effect).toHaveLength(1);
      expect(requests[0]!.source, effect).toBe('participant_draft');
      expect(store.getAgentByName(`draft-${effect}`)?.kind, effect).toBe('participant');
      store.removePolicyRule(rule.id);
    }
  });

  it('a `deny` rule tightens: no card, nothing written', async () => {
    const store = getStore();
    store.putPolicyRule({ scope: 'user', scopeKey: 'local', toolPattern: PARTICIPANT_DRAFT_TOOL, effect: 'deny' });
    const { sessionId } = store.createSession('', 'draft-deny-rule');
    const calls: Call[] = [];
    const spec = createNabySpec({
      resolveModel: () => scriptedModel([draftCall('draft-denied'), { text: 'ok' }], calls) as never,
    });
    const { ctx, events } = harness(sessionId, 'make one');
    await spec.runner.run(ctx);
    expect(events.filter((e) => e.type === 'approval_request')).toHaveLength(0);
    expect(store.getAgentByName('draft-denied')).toBeUndefined();
  });

  it('declined on the card: nothing written, naby is told not to retry', async () => {
    const store = getStore();
    const { sessionId } = store.createSession('', 'draft-declined');
    const calls: Call[] = [];
    const spec = createNabySpec({
      resolveModel: () => scriptedModel([draftCall('draft-no'), { text: 'ok' }], calls) as never,
    });
    const { ctx, events } = harness(sessionId, 'make one', answering('deny'));
    await spec.runner.run(ctx);
    expect(store.getAgentByName('draft-no')).toBeUndefined();
    expect(events.find((e) => e.type === 'approval_resolved')).toMatchObject({ decision: 'deny' });
    expect(calls.filter((c) => c.kind === 'naby').pop()!.prompt).toContain('거절됐어요');
  });

  it('stopping the turn while the card is up declines the draft', async () => {
    const store = getStore();
    const { sessionId } = store.createSession('', 'draft-abort');
    let controller: AbortController | undefined;
    const spec = createNabySpec({
      resolveModel: () => scriptedModel([draftCall('draft-aborted'), { text: 'ok' }], []) as never,
    });
    const h = harness(sessionId, 'make one', (e) => {
      if (e.type === 'approval_request') setTimeout(() => controller?.abort(), 0);
    });
    controller = h.controller;
    await spec.runner.run(h.ctx);
    expect(store.getAgentByName('draft-aborted')).toBeUndefined();
    expect(h.events.find((e) => e.type === 'approval_resolved')).toMatchObject({ decision: 'deny' });
  });
});

describe('naby_participant_draft — source facts a live turn cannot show', () => {
  const SRC = readFileSync(join(__dirname, 'naby.ts'), 'utf8');

  it('the gate refuses the tool to a subagent and to a turn that was not given it', () => {
    expect(SRC).toContain('if (normalizeToolName(call.toolName) === PARTICIPANT_DRAFT_TOOL) {');
    expect(SRC).toContain('if (!draftTool || call.subagent) {');
  });

  it('the special case sits BEFORE the policy engine, so no rule can answer for it', () => {
    const special = SRC.indexOf('if (normalizeToolName(call.toolName) === PARTICIPANT_DRAFT_TOOL) {');
    const policy = SRC.indexOf('const decision = await gated.gate(call).finally(() => hookOpinions.delete(call.toolCallId));');
    expect(special).toBeGreaterThan(0);
    expect(policy).toBeGreaterThan(special);
  });

  it('an ai-sdk delegated subagent is handed the toolset WITHOUT the draft tool', () => {
    expect(SRC).toContain('toolSchemas: toolSchemas.filter((t) => t.name !== PARTICIPANT_DRAFT_TOOL),');
    expect(SRC).toContain('Object.entries(executors).filter(([name]) => name !== PARTICIPANT_DRAFT_TOOL),');
  });

  it('the R8.5 line is tied to the tool’s presence', () => {
    expect(SRC).toContain('draftTool ? PARTICIPANT_DRAFT_RULE : undefined,');
  });
});
