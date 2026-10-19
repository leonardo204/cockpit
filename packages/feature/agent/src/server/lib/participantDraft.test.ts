import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * NABY'S PARTICIPANT DRAFT — the executor, the resolve path and the phone copy
 * (multi-agent-chat §8.12, R8.1–R8.4, MAC-M5a). The orchestrator is mocked so
 * nothing here can start a model turn; the store is the throwaway one
 * vitest.setup.ts points NABY_DB_PATH at.
 */
vi.mock('../engines/orchestrator', () => ({
  dispatchChat: async () => ({ ok: false as const, status: 503, error: 'no engine in tests' }),
}));

import type { Agent, ParticipantProfile, ToolCall } from '../../../../../../../dist/naby-runtime.mjs';
import { getStore } from '../engines/naby';
import { runNabyAction } from '../api/naby';
import {
  approvalMayRemember,
  hasPendingApproval,
  isParticipantDraftApproval,
  registerApproval,
  resolveApproval,
  type ApprovalExtras,
} from './approvalRegistry';
import {
  composeDraft,
  draftResultText,
  makeParticipantDraftTool,
  objectParticle,
  parseDraftToolInput,
  PARTICIPANT_DRAFT_SCHEMA,
  PARTICIPANT_DRAFT_TOOL,
} from './participantDraft';
import { participantMayUseTool } from './participantTurn';
import { formatApprovalMessage } from './telegramEscalation';

const profile: ParticipantProfile = {
  displayName: 'Translator',
  avatar: { kind: 'emoji', value: '🌐' },
  color: '#0ea5e9',
  knowledge: [],
  guardrails: { policy: 'Never invent facts.' },
  mcpServers: ['wiki'],
  skills: ['tone'],
};

function participant(name: string, over: Partial<Agent> = {}): Agent {
  return getStore().putAgent({
    name,
    kind: 'participant',
    description: 'Translates between Korean and English.',
    systemPrompt: 'You translate.',
    model: 'sonnet',
    toolRefs: ['read_file'],
    memoryScope: 'project',
    autonomy: { escalation: 'inline' },
    profile,
    ...over,
  });
}

afterEach(() => {
  const store = getStore();
  for (const a of store.listAgents()) if (a.kind === 'participant' || a.kind === 'custom') store.removeAgent(a.id);
  store.setSetting('participants.maxPerSession', '');
  for (const r of store.listPolicyRules('user', 'local')) {
    if (['participant.create', 'participant.update', PARTICIPANT_DRAFT_TOOL].includes(r.toolPattern)) {
      store.removePolicyRule(r.id);
    }
  }
});

let seq = 0;
const call = (): { toolCall: ToolCall; signal: AbortSignal } => ({
  toolCall: { toolCallId: `tc-${(seq += 1)}`, toolName: PARTICIPANT_DRAFT_TOOL, input: {} },
  signal: new AbortController().signal,
});

/** A draft tool over the real store, recording what it emits and logs. When
 *  `answer` is given, every approval request is answered with it. */
function tool(
  sessionId: string,
  opts: {
    answer?: { decision: 'allow' | 'deny'; extras?: ApprovalExtras };
    ttlMs?: number;
    signal?: AbortSignal;
    escalate?: boolean;
  } = {},
) {
  const events: Record<string, unknown>[] = [];
  const logs: { kind: string; payload: Record<string, unknown> }[] = [];
  const sent: unknown[] = [];
  const finished: unknown[] = [];
  const { executor, schema } = makeParticipantDraftTool({
    store: getStore(),
    sessionId,
    emit: (e) => {
      events.push(e);
      if (e.type === 'approval_request' && opts.answer) {
        const a = opts.answer;
        setTimeout(
          () =>
            resolveApproval(
              String(e.approvalId),
              a.decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', reason: 'you denied this tool call' },
              a.extras,
            ),
          0,
        );
      }
    },
    signal: opts.signal ?? new AbortController().signal,
    ttlMs: opts.ttlMs ?? 60_000,
    log: (kind, payload) => logs.push({ kind, payload }),
    hubAgentId: 'naby-persona',
    escalate: {
      enabled: () => opts.escalate ?? false,
      send: (i) => sent.push(i),
      finish: (i) => finished.push(i),
    },
  });
  return { executor, schema, events, logs, sent, finished };
}

const create = (name: string, extra: Record<string, unknown> = {}) => ({
  action: 'create',
  name,
  displayName: 'Translator',
  description: 'Translates between Korean and English.',
  instructions: 'You translate faithfully.',
  avatar: '🌐',
  ...extra,
});

describe('the tool schema (R8.1)', () => {
  it('has the R8.1 fields and nothing that widens a participant', () => {
    const props = Object.keys(PARTICIPANT_DRAFT_SCHEMA.parameters.properties ?? {});
    // `permission` is the §8.14 (R10.4) tier: a LEVEL, never a tool list.
    expect(props.sort()).toEqual(
      ['action', 'id', 'name', 'displayName', 'description', 'instructions', 'guardrailsPolicy', 'greeting', 'avatar', 'color', 'addToSession', 'permission'].sort(),
    );
    const perm = (PARTICIPANT_DRAFT_SCHEMA.parameters.properties as Record<string, { properties?: Record<string, { enum?: string[] }> }>)
      .permission!;
    expect(perm.properties?.level?.enum).toEqual(['none', 'read', 'write', 'elevated', 'all']);
    for (const absent of ['toolRefs', 'mcpServers', 'skills', 'model', 'memoryScope']) expect(props).not.toContain(absent);
    expect(PARTICIPANT_DRAFT_SCHEMA.description).toMatch(/not part of a draft/i);
  });

  it('a participant never gets it, even when its toolRefs name it', () => {
    expect(participantMayUseTool(PARTICIPANT_DRAFT_TOOL, { toolRefs: [PARTICIPANT_DRAFT_TOOL] }, new Set())).toBe(false);
  });
});

describe('validation before any card (R8.2)', () => {
  it('refuses bad input shapes', () => {
    expect(parseDraftToolInput(null)).toMatchObject({ ok: false });
    expect(parseDraftToolInput({ action: 'delete' })).toMatchObject({ ok: false });
    expect(parseDraftToolInput({ action: 'create', name: 3 })).toMatchObject({ ok: false, error: 'name must be a string' });
    expect(parseDraftToolInput({ action: 'create', addToSession: 'yes' })).toMatchObject({ ok: false });
  });

  it('refuses names the participant.put rule refuses', () => {
    const store = getStore();
    participant('draft-taken');
    for (const [name, error] of [
      ['two words', /spaces/],
      ['a@b', /'@'/],
      ['/path', /start with/],
      ['naby', /built-in/],
      ['나비', /built-in/],
      ['DRAFT-TAKEN', /already in use/],
      ['', /required/],
    ] as const) {
      const r = composeDraft(store, { action: 'create', name, instructions: 'x' });
      expect(r, name).toMatchObject({ ok: false });
      if (!r.ok) expect(r.error, name).toMatch(error);
    }
  });

  it('refuses sizes the profile gate and the draft limits refuse', () => {
    const store = getStore();
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ greeting: 'g'.repeat(3000) }, /greeting/],
      [{ guardrailsPolicy: 'p'.repeat(9000) }, /policy/],
      [{ avatar: '😀'.repeat(20) }, /emoji avatar is at most/],
      [{ color: 'blue' }, /hex colour/],
      [{ instructions: 'i'.repeat(33 * 1024) }, /instructions are larger/],
      [{ instructions: '   ' }, /instructions are required/],
      [{ description: 'd'.repeat(1001) }, /description is longer/],
      [{ displayName: 'n'.repeat(81) }, /displayName is longer/],
    ];
    for (const [extra, error] of cases) {
      const r = composeDraft(store, { ...create('draft-size'), ...extra } as never);
      expect(r, JSON.stringify(Object.keys(extra))).toMatchObject({ ok: false });
      if (!r.ok) expect(r.error).toMatch(error);
    }
  });

  it('an invalid draft never reaches the user: no card, an error result, an activity line', async () => {
    const { sessionId } = getStore().createSession('', 'draft-invalid');
    const t = tool(sessionId);
    const out = await t.executor(create('bad name'), call());
    expect(out.isError).toBe(true);
    expect(out.content).toContain('Draft rejected');
    expect(t.events).toHaveLength(0);
    expect(t.logs).toEqual([
      { kind: 'participant_draft', payload: expect.objectContaining({ action: 'create', decision: 'invalid' }) },
    ]);
  });

  it('update refuses an id that is not a participant (a custom agent, the persona, nothing)', async () => {
    const store = getStore();
    const custom = store.putAgent({
      name: 'draft-custom',
      kind: 'custom',
      systemPrompt: 'x',
      memoryScope: 'session',
      autonomy: { escalation: 'inline' },
    });
    const { sessionId } = store.createSession('', 'draft-update-bad');
    const t = tool(sessionId);
    for (const id of [custom.id, custom.name, 'naby', 'no-such-id']) {
      const out = await t.executor({ action: 'update', id, description: 'new' }, call());
      expect(out.isError, id).toBe(true);
      expect(out.content, id).toMatch(/not a conversation participant/);
    }
    expect(store.getAgent(custom.id)?.description).toBeUndefined();
    expect(t.events).toHaveLength(0);
  });

  it('update that changes nothing is refused', () => {
    const tr = participant('draft-same');
    expect(composeDraft(getStore(), { action: 'update', id: tr.id, description: tr.description })).toMatchObject({
      ok: false,
      error: 'the draft changes nothing',
    });
  });
});

describe('the approval (R8.2–R8.4)', () => {
  it('asks with the draft card payload, then create-only writes a participant with the safe defaults', async () => {
    const store = getStore();
    const { sessionId } = store.createSession('', 'draft-create-only');
    const t = tool(sessionId, { answer: { decision: 'allow', extras: { addToSession: false } } });
    // Whatever the model tries to slip in is not part of a draft.
    const out = await t.executor(
      { ...create('draft-create-only'), toolRefs: ['run_command'], memoryScope: 'user', model: 'opus', mcpServers: ['x'] },
      call(),
    );
    const req = t.events.find((e) => e.type === 'approval_request')!;
    expect(req).toMatchObject({
      tool_name: 'participant.create',
      source: 'participant_draft',
      session_id: sessionId,
      input: {
        draft: {
          action: 'create',
          name: 'draft-create-only',
          displayName: 'Translator',
          description: 'Translates between Korean and English.',
          instructions: 'You translate faithfully.',
          avatar: { kind: 'emoji', value: '🌐' },
          addToSession: true,
        },
        addToSession: true,
      },
    });
    expect(String(req.approvalId)).toContain(':participant.create:');
    const saved = store.getAgentByName('draft-create-only')!;
    expect(saved).toMatchObject({ kind: 'participant', toolRefs: [], memoryScope: 'session' });
    expect(saved.model).toBeUndefined();
    expect(saved.profile).toMatchObject({ mcpServers: [], skills: [] });
    // The card said "create only".
    expect(store.listSessionParticipants(sessionId)).toEqual([]);
    expect(out.content).toBe('@draft-create-only를 만들었어요. 이 대화에는 추가하지 않았어요.');
    expect(t.events.map((e) => e.type)).toEqual(['approval_request', 'approval_resolved']);
    expect(t.events[1]).toMatchObject({ decision: 'allow', agentId: saved.id, addedToSession: false });
    expect(t.logs.map((l) => l.kind)).toEqual(['approval_requested', 'participant_draft', 'approval_resolved']);
    expect(t.logs[1]!.payload).toMatchObject({ action: 'create', decision: 'allow', agentId: saved.id, addedToSession: false });
    expect(hasPendingApproval(String(req.approvalId))).toBe(false);
  });

  it('create and add joins the session as added by naby', async () => {
    const store = getStore();
    const { sessionId } = store.createSession('', 'draft-create-add');
    const t = tool(sessionId, { answer: { decision: 'allow' } });
    const out = await t.executor(create('draft-create-add'), call());
    const saved = store.getAgentByName('draft-create-add')!;
    expect(store.listSessionParticipants(sessionId)).toEqual([
      expect.objectContaining({ agentId: saved.id, status: 'active', addedBy: 'naby' }),
    ]);
    expect(out.content).toBe('@draft-create-add를 만들고 이 대화에 추가했어요.');
  });

  it('the session cap still applies: saved, not added, and naby is told why', async () => {
    const store = getStore();
    store.setSetting('participants.maxPerSession', '1');
    const { sessionId } = store.createSession('', 'draft-cap');
    const other = participant('draft-cap-other');
    store.putSessionParticipant(sessionId, other.id, { status: 'active', addedBy: 'user' });
    const t = tool(sessionId, { answer: { decision: 'allow', extras: { addToSession: true } } });
    const out = await t.executor(create('draft-capped'), call());
    expect(store.getAgentByName('draft-capped')?.kind).toBe('participant');
    expect(store.listSessionParticipants(sessionId).map((r) => r.agentId)).toEqual([other.id]);
    expect(out.content).toContain('참가자 상한(1명)');
  });

  it('the user’s edits are merged and validated again before the write', async () => {
    const store = getStore();
    const { sessionId } = store.createSession('', 'draft-edits');
    const t = tool(sessionId, {
      answer: {
        decision: 'allow',
        extras: {
          edits: { name: '@draft-edited', displayName: '번역가', description: '한영 번역을 맡는다.', avatar: '🧪', color: '#10B981' },
          addToSession: true,
        },
      },
    });
    const out = await t.executor(create('draft-original'), call());
    expect(store.getAgentByName('draft-original')).toBeUndefined();
    const saved = store.getAgentByName('draft-edited')!;
    expect(saved.description).toBe('한영 번역을 맡는다.');
    expect(saved.profile).toMatchObject({ displayName: '번역가', avatar: { kind: 'emoji', value: '🧪' }, color: '#10B981' });
    expect(out.content).toContain('@draft-edited를 만들고 이 대화에 추가했어요.');
    expect(out.content).toContain('사용자가 핸들, 표시 이름, 설명, 아바타, 색을 고쳐서 승인했어요');
    expect(t.logs.find((l) => l.kind === 'participant_draft')!.payload).toMatchObject({
      edited: ['name', 'displayName', 'description', 'avatar', 'color'],
    });
  });

  it('an edit the server refuses writes nothing and says so', async () => {
    const store = getStore();
    participant('draft-holder');
    const { sessionId } = store.createSession('', 'draft-bad-edit');
    for (const edits of [{ name: 'has space' }, { name: 'Draft-Holder' }, { avatar: '' }, { color: 'red' }]) {
      const t = tool(sessionId, { answer: { decision: 'allow', extras: { edits } } });
      const out = await t.executor(create('draft-will-fail'), call());
      expect(out.isError, JSON.stringify(edits)).toBe(true);
      expect(out.content).toContain('승인됐지만 저장하지 못했어요');
      expect(t.events.find((e) => e.type === 'approval_resolved')).toMatchObject({ decision: 'allow', error: expect.any(String) });
    }
    expect(store.getAgentByName('draft-will-fail')).toBeUndefined();
  });

  it('a name taken while the card was up is refused at the write, not overwritten', async () => {
    const store = getStore();
    const { sessionId } = store.createSession('', 'draft-race');
    let holder: Agent | undefined;
    const t = tool(sessionId);
    const pending = t.executor(create('draft-race'), call());
    await new Promise((r) => setTimeout(r, 0));
    holder = participant('draft-race');
    const req = t.events.find((e) => e.type === 'approval_request')!;
    resolveApproval(String(req.approvalId), { behavior: 'allow' });
    const out = await pending;
    expect(out.isError).toBe(true);
    expect(store.getAgentByName('draft-race')?.id).toBe(holder.id);
    expect(store.getAgent(holder.id)?.systemPrompt).toBe('You translate.');
  });

  it('deny writes nothing and tells naby not to retry', async () => {
    const store = getStore();
    const { sessionId } = store.createSession('', 'draft-deny');
    const t = tool(sessionId, { answer: { decision: 'deny' } });
    const out = await t.executor(create('draft-denied'), call());
    expect(store.getAgentByName('draft-denied')).toBeUndefined();
    expect(out.content).toMatch(/^거절됐어요 — .*다시 시도하지 말고/);
    expect(t.events[1]).toMatchObject({ type: 'approval_resolved', decision: 'deny' });
    expect(t.logs.find((l) => l.kind === 'participant_draft')!.payload).toMatchObject({ decision: 'deny' });
  });

  it('timeout declines and frees the registry entry', async () => {
    const store = getStore();
    const { sessionId } = store.createSession('', 'draft-timeout');
    const t = tool(sessionId, { ttlMs: 10 });
    const out = await t.executor(create('draft-timeout'), call());
    expect(store.getAgentByName('draft-timeout')).toBeUndefined();
    expect(out.content).toContain('시간이 지나');
    expect(hasPendingApproval(String(t.events[0]!.approvalId))).toBe(false);
    expect(t.logs.find((l) => l.kind === 'participant_draft')!.payload).toMatchObject({ decision: 'timeout' });
  });

  it('abort declines (and an already-stopped turn never shows a card)', async () => {
    const store = getStore();
    const { sessionId } = store.createSession('', 'draft-abort');
    const ac = new AbortController();
    const t = tool(sessionId, { signal: ac.signal });
    const pending = t.executor(create('draft-abort'), call());
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    const out = await pending;
    expect(out.content).toContain('중단');
    expect(store.getAgentByName('draft-abort')).toBeUndefined();
    expect(t.logs.find((l) => l.kind === 'participant_draft')!.payload).toMatchObject({ decision: 'abort' });
  });

  it('update changes only the drafted fields and keeps model, tools, MCP, skills and memory scope', async () => {
    const store = getStore();
    const tr = participant('draft-upd');
    const { sessionId } = store.createSession('', 'draft-update');
    const t = tool(sessionId, { answer: { decision: 'allow' } });
    const out = await t.executor(
      { action: 'update', id: '@draft-upd', description: 'Translates Korean, English and Japanese.', instructions: 'You translate three languages.', toolRefs: [] },
      call(),
    );
    const req = t.events.find((e) => e.type === 'approval_request')!;
    expect(req).toMatchObject({
      tool_name: 'participant.update',
      input: {
        draft: { action: 'update', id: tr.id, description: 'Translates Korean, English and Japanese.' },
        before: { description: 'Translates between Korean and English.', instructions: 'You translate.' },
        changed: ['description', 'instructions'],
        addToSession: false,
      },
    });
    const after = store.getAgent(tr.id)!;
    expect(after).toMatchObject({
      name: 'draft-upd',
      description: 'Translates Korean, English and Japanese.',
      systemPrompt: 'You translate three languages.',
      model: 'sonnet',
      toolRefs: ['read_file'],
      memoryScope: 'project',
    });
    expect(after.profile).toMatchObject({ mcpServers: ['wiki'], skills: ['tone'], guardrails: { policy: 'Never invent facts.' } });
    expect(out.content).toBe('@draft-upd의 설명, 지시를 고쳤어요.');
    expect(store.listSessionParticipants(sessionId)).toEqual([]);
  });

  it('escalates to Telegram when asked, and closes it there when answered', async () => {
    const { sessionId } = getStore().createSession('', 'draft-telegram');
    const t = tool(sessionId, { escalate: true, answer: { decision: 'deny' } });
    await t.executor(create('draft-tg'), call());
    expect(t.sent).toEqual([expect.objectContaining({ toolName: 'participant.create' })]);
    expect(t.finished).toEqual([expect.objectContaining({ decision: 'deny' })]);
    expect(t.logs[0]!.payload).toMatchObject({ escalatedToTelegram: true, askedBy: 'participant_draft' });
  });
});

describe('approval.resolve for a draft (R8.2, R8.3)', () => {
  it('never remembers a draft, by registered name or by pattern', () => {
    registerApproval('d1', () => {}, 1, { toolName: 'participant.create' });
    expect(approvalMayRemember('d1', 'anything')).toBe(false);
    registerApproval('d2', () => {}, 1, { toolName: 'participant.update' });
    expect(approvalMayRemember('d2', 'anything')).toBe(false);
    expect(approvalMayRemember('d3', 'participant.create')).toBe(false);
    expect(approvalMayRemember('d3', PARTICIPANT_DRAFT_TOOL)).toBe(false);
    expect(approvalMayRemember('d3', 'Bash')).toBe(true);
    expect(isParticipantDraftApproval('participant.create')).toBe(true);
    expect(isParticipantDraftApproval('participant.add')).toBe(false);
    resolveApproval('d1', { behavior: 'deny', reason: 'x' });
    resolveApproval('d2', { behavior: 'deny', reason: 'x' });
  });

  it('carries the edits and the session choice to the paused draft, and writes no rule', async () => {
    let got: { behavior: string; extras?: ApprovalExtras } | undefined;
    registerApproval('d4', (d, extras) => (got = { behavior: d.behavior, ...(extras ? { extras } : {}) }), 1, {
      toolName: 'participant.create',
    });
    const res = (await runNabyAction({
      action: 'approval.resolve',
      approvalId: 'd4',
      decision: 'allow',
      remember: true,
      scope: 'user',
      toolPattern: 'participant.create',
      edits: { displayName: 'Y', name: 'y', bogus: 'x', color: 5 },
      addToSession: false,
    } as never)) as { ok: boolean; resolved?: boolean };
    expect(res).toMatchObject({ ok: true, resolved: true });
    expect(got).toEqual({ behavior: 'allow', extras: { edits: { displayName: 'Y', name: 'y' }, addToSession: false } });
    expect(getStore().listPolicyRules('user', 'local').some((r) => r.toolPattern === 'participant.create')).toBe(false);
  });

  it('a plain tool approval is unchanged (no extras)', async () => {
    let extrasSeen: unknown = 'unset';
    registerApproval('d5', (_d, extras) => (extrasSeen = extras), 1);
    await runNabyAction({ action: 'approval.resolve', approvalId: 'd5', decision: 'deny' } as never);
    expect(extrasSeen).toBeUndefined();
  });
});

describe('Telegram copy (R8.3)', () => {
  const draft = {
    action: 'create',
    name: 'translator',
    displayName: 'Translator',
    description: 'Translates Korean and English.',
    avatar: { kind: 'emoji', value: '🌐' },
    color: '#0ea5e9',
    addToSession: true,
  };
  it('create: a short Korean summary with approve / decline', () => {
    const msg = formatApprovalMessage({ toolName: 'participant.create', input: { draft, addToSession: true }, project: 'naby' });
    expect(msg).toContain('🦋 나비의 초안: 새 참가자 @translator를 만들까요?');
    expect(msg).toContain('🌐 Translator');
    expect(msg).toContain('Translates Korean and English.');
    expect(msg).toContain('· 승인하면 이 대화에 추가합니다');
    expect(msg).toContain('승인하거나 거절하세요');
    expect(msg).not.toContain('Tool:');
    expect(msg).not.toContain('instructions');
  });
  it('update: names what changes', () => {
    const msg = formatApprovalMessage({
      toolName: 'participant.update',
      input: { draft: { ...draft, action: 'update' }, changed: ['description', 'instructions'], addToSession: false },
    });
    expect(msg).toContain('🦋 나비의 초안: 참가자 @translator를 고칠까요?');
    expect(msg).toContain('· 바뀌는 것: 설명, 지시');
    expect(msg).not.toContain('이 대화에 추가');
  });
});

describe('result wording (R8.4)', () => {
  it('picks 을/를 by the last syllable', () => {
    expect(objectParticle('translator')).toBe('를');
    expect(objectParticle('번역가')).toBe('를');
    expect(objectParticle('번역')).toBe('을');
  });
  it('declined / timeout / abort tell naby not to retry', () => {
    expect(draftResultText({ kind: 'deny' })).toContain('다시 시도하지 말고');
    expect(draftResultText({ kind: 'timeout' })).toContain('다시 시도하지 말고');
    expect(draftResultText({ kind: 'abort' })).toContain('저장하지 않았어요');
  });
});
