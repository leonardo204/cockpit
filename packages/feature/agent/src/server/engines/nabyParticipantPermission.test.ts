import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNabySpec, getStore } from './naby';
import { resolveApproval } from '../lib/approvalRegistry';
import { putParticipant } from '../lib/participants';
import type { Agent, ParticipantProfile } from '../../../../../../../dist/naby-runtime.mjs';
import type { RunCtx, RunEvent } from './types';

/**
 * PARTICIPANT PERMISSION TIERS, WIRED (multi-agent-chat §8.14, MAC-M7) — through
 * the production `createNabySpec` with a scripted model. What is asserted is the
 * engine adapter's wiring of the 2026-10-19 rule: a speech is OFFERED every tool
 * but naby's own; a call INSIDE the level runs without asking (even when the
 * baseline would refuse it); a call OUTSIDE it asks, naming the speaker; "ask me
 * every time" asks for every call; nobody to ask → refused; the user's own policy
 * `deny` beats everything; a policy `ask` is the one prompt, never two.
 *
 * No network, no keys; the store is the throwaway one vitest.setup.ts points
 * NABY_DB_PATH at, and the project folder is a mkdtemp directory.
 */

type Call = { system: string; tools: string[]; kind: 'route' | 'participant' | 'naby' };
type Step = { tool?: { id: string; name: string; input: Record<string, unknown> }; text?: string };

/** A participant's calls follow `participantSteps` in order; routing ends;
 *  naby answers one line. */
function scriptedModel(participantSteps: Step[], calls: Call[]) {
  let i = 0;
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
      if (system.includes('Decide who should respond')) {
        calls.push({ system, tools, kind: 'route' });
        return text('{"action":"end","reason":"done"}');
      }
      if (/You are @\S+ \(/.test(system)) {
        calls.push({ system, tools, kind: 'participant' });
        const step = participantSteps[i] ?? { text: 'done.' };
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
        return text(step.text ?? 'done.');
      }
      calls.push({ system, tools, kind: 'naby' });
      return text('naby here.');
    },
    async doStream() {
      throw new Error('not used');
    },
  };
}

function harness(
  sessionId: string,
  prompt: string,
  opts: { cwd?: string; onEmit?: (e: RunEvent) => void; params?: Record<string, unknown> } = {},
) {
  const events: RunEvent[] = [];
  const controller = new AbortController();
  let key = sessionId;
  const ctx: RunCtx = {
    prompt,
    images: undefined,
    cwd: opts.cwd ?? '',
    sessionId,
    params: { prompt, engine: 'naby', model: 'claude-sonnet-4-5', ...(opts.params ?? {}) },
    signal: controller.signal,
    emit(event: RunEvent) {
      events.push(event);
      opts.onEmit?.(event);
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

/** Answer every tool approval request with `decision`, as the card would. */
function answering(decision: 'allow' | 'deny') {
  return (e: RunEvent) => {
    if (e.type !== 'approval_request') return;
    setTimeout(
      () =>
        resolveApproval(
          String(e.approvalId),
          decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', reason: 'you denied this tool call' },
        ),
      0,
    );
  };
}

const baseProfile: ParticipantProfile = {
  displayName: 'Helper',
  avatar: { kind: 'emoji', value: '🛠' },
  color: '#0ea5e9',
  knowledge: [],
  guardrails: {},
  mcpServers: [],
  skills: [],
};

let seq = 0;
function participant(over: { permission?: ParticipantProfile['permission']; toolRefs?: string[] } = {}): Agent {
  // (R10.7 tests pass `permission.approvedTools` through here as well.)
  seq += 1;
  return getStore().putAgent({
    name: `perm${seq}`,
    kind: 'participant',
    description: 'Helps.',
    systemPrompt: 'You help.',
    toolRefs: over.toolRefs ?? [],
    memoryScope: 'session',
    autonomy: { escalation: 'inline' },
    profile: { ...baseProfile, ...(over.permission ? { permission: over.permission } : {}) },
  });
}

function sessionWith(p: Agent, title: string): string {
  const store = getStore();
  const { sessionId } = store.createSession('', title);
  store.putSessionParticipant(sessionId, p.id, { status: 'active', addedBy: 'user' });
  return sessionId;
}

const toolRows = (sessionId: string) =>
  getStore()
    .getMessages(sessionId)
    .filter((m): m is Extract<typeof m, { role: 'tool' }> => m.role === 'tool');

const echoCall: Step = { tool: { id: 'echo-1', name: 'echo_note', input: { text: 'hi' } } };
const sendCall: Step = { tool: { id: 'send-1', name: 'send_message', input: { text: 'hi' } } };

const ruleIds: string[] = [];
function rule(toolPattern: string, effect: 'allow' | 'ask' | 'deny') {
  ruleIds.push(getStore().putPolicyRule({ scope: 'user', scopeKey: 'local', toolPattern, effect }).id);
}

afterEach(() => {
  const store = getStore();
  for (const a of store.listAgents()) if (a.kind === 'participant') store.removeAgent(a.id);
  store.setSetting('participants.proposals.enabled', '');
  store.setSetting('gate.allowChanges', '');
  store.setSetting('persona.autonomy.escalation', '');
  for (const id of ruleIds.splice(0)) store.removePolicyRule(id);
});

async function speak(p: Agent, step: Step, opts: { answer?: 'allow' | 'deny'; cwd?: string; params?: Record<string, unknown> } = {}) {
  const sessionId = sessionWith(p, 'speak');
  const spec = createNabySpec({ resolveModel: () => scriptedModel([step, { text: 'ok' }], []) as never });
  const { ctx, events } = harness(sessionId, `@${p.name} go`, {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.params ? { params: opts.params } : {}),
    ...(opts.answer ? { onEmit: answering(opts.answer) } : {}),
  });
  await spec.runner.run(ctx);
  return { requests: events.filter((e) => e.type === 'approval_request'), rows: toolRows(sessionId) };
}

describe('participant permission — what a speech is offered', () => {
  const project = mkdtempSync(join(tmpdir(), 'naby-perm-'));
  it('every level is offered every tool but naby’s own (out-of-level ones ask when called)', async () => {
    for (const permission of [
      { level: 'none' as const, approval: 'auto' as const },
      { level: 'read' as const, approval: 'auto' as const },
    ]) {
      const p = participant({ permission });
      const sessionId = sessionWith(p, 'offered');
      const calls: Call[] = [];
      const spec = createNabySpec({ resolveModel: () => scriptedModel([], calls) as never });
      await spec.runner.run(harness(sessionId, `@${p.name} hi`, { cwd: project }).ctx);
      const tools = calls.find((c) => c.kind === 'participant')!.tools;
      expect(tools).toEqual(expect.arrayContaining(['read_file', 'write_file', 'run_command', 'send_message']));
      for (const t of ['naby_remember', 'naby_checkin', 'naby_delegate', 'naby_participant_draft']) {
        expect(tools).not.toContain(t);
      }
    }
  });
});

describe('participant permission — inside the level runs, outside asks (2026-10-19)', () => {
  it('in level: runs with no card, even where the baseline (allowChanges off → floor) would refuse it', async () => {
    getStore().setSetting('gate.allowChanges', 'false');
    const project = mkdtempSync(join(tmpdir(), 'naby-perm-w-'));
    const p = participant({ permission: { level: 'write', approval: 'auto' } });
    const { requests, rows } = await speak(
      p,
      { tool: { id: 'w-1', name: 'write_file', input: { path: join(project, 'a.txt'), content: 'x' } } },
      { cwd: project },
    );
    expect(requests).toHaveLength(0);
    expect(rows[0]?.output.isError ?? false).toBe(false);
  });

  it('a legacy participant’s chips are its level: a listed tool runs without asking', async () => {
    const p = participant({ toolRefs: ['echo_note'] });
    const { requests, rows } = await speak(p, echoCall);
    expect(requests).toHaveLength(0);
    expect(rows[0]?.output.isError ?? false).toBe(false);
  });

  it('out of level: asks, naming the speaker, with no "always" buttons; allow runs it', async () => {
    const p = participant({ permission: { level: 'read', approval: 'auto' } });
    const { requests, rows } = await speak(p, sendCall, { answer: 'allow' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ tool_name: 'send_message', source: 'participant_outside', speaker: { id: p.id } });
    expect(rows).toHaveLength(1);
  });

  it('none: every call asks; a refusal refuses it', async () => {
    const p = participant({ permission: { level: 'none', approval: 'auto' } });
    const { requests, rows } = await speak(p, echoCall, { answer: 'deny' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ source: 'participant_outside' });
    expect(rows[0]?.output.isError).toBe(true);
  });

  it('out of level with nobody to ask (Telegram, escalation in the app): refused, no card', async () => {
    const p = participant({ permission: { level: 'read', approval: 'auto' } });
    const { requests, rows } = await speak(p, sendCall, { params: { source: 'telegram' } });
    expect(requests).toHaveLength(0);
    expect(rows[0]?.output.isError).toBe(true);
    expect(JSON.stringify(rows[0]?.output)).toContain('outside what @perm7 may do');
  });
});

describe('participant permission — "ask me every time" and the user’s own rules', () => {
  it('switch on: an in-level read asks too; allow runs it', async () => {
    const p = participant({ permission: { level: 'read', approval: 'always' } });
    const { requests, rows } = await speak(p, echoCall, { answer: 'allow' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ tool_name: 'echo_note', source: 'participant_always', speaker: { id: p.id, name: p.name } });
    expect(rows[0]?.output.isError ?? false).toBe(false);
  });

  it('switch on with nobody to ask: refused, no card', async () => {
    const p = participant({ permission: { level: 'read', approval: 'always' } });
    const { requests, rows } = await speak(p, echoCall, { params: { source: 'telegram' } });
    expect(requests).toHaveLength(0);
    expect(JSON.stringify(rows[0]?.output)).toContain('set to ask before every tool it uses');
  });

  it('a policy deny beats everything: in level, out of level, switch on — refused, nobody asked', async () => {
    rule('echo_note', 'deny');
    rule('send_message', 'deny');
    for (const [permission, step] of [
      [{ level: 'all' as const, approval: 'auto' as const }, echoCall],
      [{ level: 'read' as const, approval: 'auto' as const }, sendCall],
      [{ level: 'read' as const, approval: 'always' as const }, echoCall],
    ] as const) {
      const { requests, rows } = await speak(participant({ permission }), step, { answer: 'allow' });
      expect(requests).toHaveLength(0);
      expect(rows[0]?.output.isError).toBe(true);
    }
  });

  it('a policy ask is the one prompt: in level it asks (the user’s rule); out of level / switch on it is not doubled', async () => {
    rule('echo_note', 'ask');
    rule('send_message', 'ask');
    for (const [permission, step] of [
      [{ level: 'read' as const, approval: 'auto' as const }, echoCall],
      [{ level: 'read' as const, approval: 'auto' as const }, sendCall],
      [{ level: 'read' as const, approval: 'always' as const }, echoCall],
    ] as const) {
      const { requests, rows } = await speak(participant({ permission }), step, { answer: 'allow' });
      expect(requests).toHaveLength(1);
      expect(requests[0]).not.toHaveProperty('source');
      expect(rows[0]?.output.isError ?? false).toBe(false);
    }
  });

  it('a policy allow rule does not skip the out-of-level question', async () => {
    rule('send_message', 'allow');
    const { requests } = await speak(participant({ permission: { level: 'read', approval: 'auto' } }), sendCall, { answer: 'allow' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ source: 'participant_outside' });
  });
});

describe('participant permission — once allowed, not asked again (R10.7, 2026-10-19)', () => {
  /** Run one turn in `sessionId` with the participant's steps. */
  async function turn(p: Agent, sessionId: string, steps: Step[], opts: { answer?: 'allow' | 'deny'; params?: Record<string, unknown> } = {}) {
    const spec = createNabySpec({ resolveModel: () => scriptedModel([...steps, { text: 'ok' }], []) as never });
    const { ctx, events } = harness(sessionId, `@${p.name} go`, {
      ...(opts.params ? { params: opts.params } : {}),
      ...(opts.answer ? { onEmit: answering(opts.answer) } : {}),
    });
    await spec.runner.run(ctx);
    return events.filter((e) => e.type === 'approval_request');
  }
  const send = (n: number): Step => ({ tool: { id: `send-${n}`, name: 'send_message', input: { text: 'hi' } } });
  const approved = (p: Agent) => getStore().getAgent(p.id)?.profile?.permission?.approvedTools ?? [];

  it('allow → remembered; the next call (same speech, next turn) runs with no card', async () => {
    const p = participant({ permission: { level: 'read', approval: 'auto' } });
    const sessionId = sessionWith(p, 'remember');
    expect(await turn(p, sessionId, [send(1), send(2)], { answer: 'allow' })).toHaveLength(1);
    expect(approved(p)).toEqual(['send_message']);
    expect(await turn(p, sessionId, [send(3)], { answer: 'allow' })).toHaveLength(0);
    expect(toolRows(sessionId).every((r) => !(r.output.isError ?? false))).toBe(true);
  });

  it('deny → not remembered; asks again next time', async () => {
    const p = participant({ permission: { level: 'read', approval: 'auto' } });
    const sessionId = sessionWith(p, 'deny');
    expect(await turn(p, sessionId, [send(1)], { answer: 'deny' })).toHaveLength(1);
    expect(approved(p)).toEqual([]);
    expect(await turn(p, sessionId, [send(2)], { answer: 'deny' })).toHaveLength(1);
  });

  it('switch on → every call asks, and nothing is recorded', async () => {
    const p = participant({ permission: { level: 'read', approval: 'always' } });
    const sessionId = sessionWith(p, 'always');
    expect(await turn(p, sessionId, [send(1), send(2)], { answer: 'allow' })).toHaveLength(2);
    expect(approved(p)).toEqual([]);
  });

  it('switch on overrides a remembered tool: it still asks', async () => {
    const p = participant({ permission: { level: 'read', approval: 'always', approvedTools: ['send_message'] } });
    expect(await turn(p, sessionWith(p, 'always-remembered'), [send(1)], { answer: 'allow' })).toHaveLength(1);
  });

  it('revoking the chip (an explicit list without it) asks again; an edit that omits the list keeps it', async () => {
    const p = participant({ permission: { level: 'read', approval: 'auto', approvedTools: ['send_message'] } });
    const sessionId = sessionWith(p, 'revoke');
    expect(await turn(p, sessionId, [send(1)], { answer: 'allow' })).toHaveLength(0);
    const profile = getStore().getAgent(p.id)!.profile!;
    const keep = putParticipant(getStore(), {
      id: p.id,
      name: p.name,
      instructions: 'You help.',
      profile: { ...profile, permission: { level: 'read', approval: 'auto' } },
    });
    expect(keep.ok && keep.participant.profile?.permission?.approvedTools).toEqual(['send_message']);
    const revoked = putParticipant(getStore(), {
      id: p.id,
      name: p.name,
      instructions: 'You help.',
      profile: { ...profile, permission: { level: 'read', approval: 'auto', approvedTools: [] } },
    });
    expect(revoked.ok && revoked.participant.profile?.permission?.approvedTools).toBeUndefined();
    expect(await turn(p, sessionId, [send(2)], { answer: 'allow' })).toHaveLength(1);
  });

  it('a Telegram turn (naby escalates to Telegram) asks there, and its allow is remembered the same', async () => {
    getStore().setSetting('persona.autonomy.escalation', 'telegram');
    const p = participant({ permission: { level: 'read', approval: 'auto' } });
    const sessionId = sessionWith(p, 'telegram');
    // Telegram is not configured in tests, so the send is skipped; the answer
    // lands on the same approval registry the Telegram bridge settles.
    const asked = await turn(p, sessionId, [send(1)], { answer: 'allow', params: { source: 'telegram' } });
    expect(asked).toHaveLength(1);
    expect(approved(p)).toEqual(['send_message']);
  });

  it('a legacy participant: its chips still run without asking; an allowed extra tool is written down as custom', async () => {
    const p = participant({ toolRefs: ['echo_note'] });
    const sessionId = sessionWith(p, 'legacy');
    expect(await turn(p, sessionId, [echoCall], { answer: 'allow' })).toHaveLength(0);
    expect(getStore().getAgent(p.id)?.profile?.permission).toBeUndefined();
    expect(await turn(p, sessionId, [send(1)], { answer: 'allow' })).toHaveLength(1);
    expect(getStore().getAgent(p.id)?.profile?.permission).toEqual({
      level: 'custom',
      approval: 'auto',
      approvedTools: ['send_message'],
    });
    expect(await turn(p, sessionId, [echoCall], { answer: 'allow' })).toHaveLength(0);
  });

  it('a policy deny still wins over a remembered tool', async () => {
    rule('send_message', 'deny');
    const p = participant({ permission: { level: 'read', approval: 'auto', approvedTools: ['send_message'] } });
    const sessionId = sessionWith(p, 'deny-wins');
    expect(await turn(p, sessionId, [send(1)], { answer: 'allow' })).toHaveLength(0);
    expect(toolRows(sessionId)[0]?.output.isError).toBe(true);
  });
});
