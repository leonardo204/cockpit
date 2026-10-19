import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  MemoryStore,
  defaultParticipantProfile,
  setActiveClaudeAccount,
  RECOMMEND_FAILURE_COOLDOWN_MS,
  type AgentInput,
  type Engine,
  type EngineEvent,
  type RuntimeMessage,
  type Store,
} from '../../../../../../../dist/naby-runtime.mjs';
import {
  analyzeSession,
  closeRecommendation,
  closeRecommendationsOnDecline,
  closeRecommendationsOnJoin,
  tidyPending,
  defaultRecommendationDeps,
  kickRecommendationSweep,
  modelRecommendationJudge,
  pendingRecommendationViews,
  recommendationSweepInFlight,
  runRecommendationSweep,
  RecommendationJudgeUnavailableError,
  sweepTargets,
  type RecommendationJudge,
} from './participantRecommend';
import { PARTICIPANTS_RECOMMENDATIONS_KEY } from './participants';
import { runParticipantRound, type RoundAgent, type RoundInput } from '../engines/participantRound';

/**
 * PARTICIPANT RECOMMENDATIONS — the shell's sweep (multi-agent-chat §8.13,
 * MAC-M6). Every test runs on an in-memory store with an INJECTED judge: no
 * model, no network, and the default judge is never reached (vitest.setup.ts
 * also sets NABY_PARTICIPANT_RECOMMEND=0, asserted below).
 */

const participant = (name: string, over: Partial<AgentInput> = {}): AgentInput => ({
  name,
  kind: 'participant',
  description: `${name}: translates Korean and English`,
  systemPrompt: `You are ${name}.`,
  toolRefs: [],
  memoryScope: 'session',
  autonomy: { escalation: 'inline' },
  profile: defaultParticipantProfile(name),
  ...over,
});

function talk(store: Store, sessionId: string, userMessages: number, from = 1): void {
  for (let i = from; i < from + userMessages; i += 1) {
    const m: RuntimeMessage[] = [
      { role: 'user', content: `Please translate paragraph ${i} into English.` },
      { role: 'assistant', content: `Paragraph ${i}, in English.` },
    ];
    for (const x of m) store.appendMessage(sessionId, x);
  }
}

/** A clock that moves 10 ms per read, so sessions touched in order have
 *  strictly increasing `lastUsedAt` (the sweep orders by it). */
function steppingClock() {
  let t = 1_700_000_000_000;
  return vi.spyOn(Date, 'now').mockImplementation(() => (t += 10));
}

function freshStore(): { store: MemoryStore; tr: ReturnType<MemoryStore['putAgent']> } {
  const store = new MemoryStore();
  const tr = store.putAgent(participant('translator'));
  return { store, tr };
}

const existingAnswer = (agentId: string, evidence = [1, 2, 3]) =>
  JSON.stringify({
    recommendations: [
      { kind: 'existing', agentId, specialty: 'translation', reason: 'You asked for translations again and again.', evidence },
    ],
  });

const newAnswer = (name: string) =>
  JSON.stringify({
    recommendations: [
      {
        kind: 'new',
        draft: {
          name,
          displayName: 'Release-note editor',
          description: 'Proofreads release notes.',
          instructions: 'You proofread release notes.',
          avatar: '📝',
          color: '#10b981',
        },
        specialty: 'release-note proofreading',
        reason: 'Release notes came up four times.',
        evidence: [1, 2, 4],
      },
    ],
  });

function judgeOf(answer: string | ((system: string) => string), calls: string[] = [], usage = true): RecommendationJudge {
  return async ({ system }) => {
    calls.push(system);
    return {
      text: typeof answer === 'string' ? answer : answer(system),
      ...(usage
        ? {
            usage: {
              engine: 'ai-sdk',
              providerId: 'anthropic',
              model: 'claude-sonnet-4-5',
              inputTokens: 1200,
              outputTokens: 40,
              cachedInputTokens: 0,
              costBasis: 'metered' as const,
            },
          }
        : {}),
    };
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('analyzeSession', () => {
  it('is not due below 4 user messages: the judge is not asked, no cursor', async () => {
    const { store } = freshStore();
    const s = store.createSession('p');
    talk(store, s.sessionId, 3);
    const calls: string[] = [];
    const r = await analyzeSession(store, s.sessionId, judgeOf('{"recommendations":[]}', calls));
    expect(r.status).toBe('not-due');
    expect(calls).toHaveLength(0);
    expect(store.getRecommendationCursor(s.sessionId)).toBeUndefined();
  });

  it('at 4: asks once, writes a pending existing recommendation, moves the cursor, bills the session', async () => {
    const { store, tr } = freshStore();
    const s = store.createSession('p');
    talk(store, s.sessionId, 4);
    const calls: string[] = [];
    const r = await analyzeSession(store, s.sessionId, judgeOf(existingAnswer(tr.id), calls));
    expect(r.status).toBe('analyzed');
    expect(calls).toHaveLength(1);
    // The prompt carries the registry and the numbered user lines.
    expect(calls[0]).toContain(`@translator (id: ${tr.id})`);
    expect(calls[0]).toContain('[#4 user]');
    const rows = store.listParticipantRecommendations(s.sessionId);
    expect(rows).toEqual([
      expect.objectContaining({ kind: 'existing', agentId: tr.id, status: 'pending', specialty: 'translation', evidence: [1, 2, 3] }),
    ]);
    expect(store.getRecommendationCursor(s.sessionId)?.userMessageCount).toBe(4);
    const usage = store.listUsage(s.sessionId);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ inputTokens: 1200, outputTokens: 40, model: 'claude-sonnet-4-5', costBasis: 'metered' });
  });

  it('"nothing" still moves the cursor (R9.7); no usage row when the judge measured none', async () => {
    const { store } = freshStore();
    const s = store.createSession('p');
    talk(store, s.sessionId, 5);
    const r = await analyzeSession(store, s.sessionId, judgeOf('{"recommendations": []}', [], false));
    expect(r).toMatchObject({ status: 'analyzed', created: [], cursor: 5 });
    expect(store.getRecommendationCursor(s.sessionId)?.userMessageCount).toBe(5);
    expect(store.listUsage(s.sessionId)).toHaveLength(0);
    // Not due again until 8 more.
    talk(store, s.sessionId, 7, 6);
    expect((await analyzeSession(store, s.sessionId, judgeOf('{"recommendations": []}'))).status).toBe('not-due');
    talk(store, s.sessionId, 1, 13);
    expect((await analyzeSession(store, s.sessionId, judgeOf('{"recommendations": []}'))).status).toBe('analyzed');
  });

  it('a broken answer is "nothing" too, and the cursor moves', async () => {
    const { store } = freshStore();
    const s = store.createSession('p');
    talk(store, s.sessionId, 4);
    const r = await analyzeSession(store, s.sessionId, judgeOf('Sure! here you go'));
    expect(r.malformed).toBe('invalid-json');
    expect(store.listParticipantRecommendations(s.sessionId)).toHaveLength(0);
    expect(store.getRecommendationCursor(s.sessionId)?.userMessageCount).toBe(4);
  });

  it('a judge that throws leaves the cursor where it was', async () => {
    const { store } = freshStore();
    const s = store.createSession('p');
    talk(store, s.sessionId, 4);
    const boom: RecommendationJudge = async () => {
      throw new Error('provider 401');
    };
    await expect(analyzeSession(store, s.sessionId, boom)).rejects.toThrow('provider 401');
    expect(store.getRecommendationCursor(s.sessionId)).toBeUndefined();
  });

  it('writes a valid new draft; a draft whose name a custom agent holds is dropped by the full draft check', async () => {
    const { store } = freshStore();
    store.putAgent({ ...participant('scout'), kind: 'custom', profile: undefined } as AgentInput);
    const s = store.createSession('p');
    talk(store, s.sessionId, 4);
    await analyzeSession(store, s.sessionId, judgeOf(newAnswer('relnotes')));
    const [row] = store.listParticipantRecommendations(s.sessionId);
    expect(row).toMatchObject({ kind: 'new', status: 'pending' });
    expect(row!.draft).toMatchObject({ name: 'relnotes', displayName: 'Release-note editor', avatar: { kind: 'emoji', value: '📝' } });

    const s2 = store.createSession('p');
    talk(store, s2.sessionId, 4);
    await analyzeSession(store, s2.sessionId, judgeOf(newAnswer('Scout')));
    expect(store.listParticipantRecommendations(s2.sessionId)).toHaveLength(0);
    expect(store.getRecommendationCursor(s2.sessionId)?.userMessageCount).toBe(4);
  });

  it('two pending already: the cursor moves and the judge is not asked', async () => {
    const { store, tr } = freshStore();
    const s = store.createSession('p');
    talk(store, s.sessionId, 4);
    for (const name of ['aa', 'bb']) {
      store.putParticipantRecommendation({
        sessionId: s.sessionId,
        kind: 'new',
        draft: {
          name,
          displayName: name,
          description: '',
          instructions: 'You help.',
          guardrailsPolicy: '',
          greeting: '',
          avatar: { kind: 'emoji', value: '🤖' },
          color: '#10b981',
        },
        specialty: name,
        reason: 'r',
        evidence: [1, 2, 3],
      });
    }
    const calls: string[] = [];
    const r = await analyzeSession(store, s.sessionId, judgeOf(existingAnswer(tr.id), calls));
    expect(r.status).toBe('full');
    expect(calls).toHaveLength(0);
    expect(store.getRecommendationCursor(s.sessionId)?.userMessageCount).toBe(4);
  });

  it('a participant already in the session, or declined in it, is never recommended', async () => {
    const { store, tr } = freshStore();
    const rv = store.putAgent(participant('reviewer'));
    const s = store.createSession('p');
    talk(store, s.sessionId, 4);
    store.putSessionParticipant(s.sessionId, tr.id, { status: 'active', addedBy: 'user' });
    store.putSessionParticipant(s.sessionId, rv.id, { status: 'declined', addedBy: 'naby' });
    const both = JSON.stringify({
      recommendations: [
        { kind: 'existing', agentId: tr.id, specialty: 'translation', reason: 'r', evidence: [1, 2, 3] },
        { kind: 'existing', agentId: rv.id, specialty: 'review', reason: 'r', evidence: [1, 2, 3] },
      ],
    });
    const calls: string[] = [];
    await analyzeSession(store, s.sessionId, judgeOf(both, calls));
    expect(store.listParticipantRecommendations(s.sessionId)).toHaveLength(0);
    expect(calls[0]).toContain('Already in this conversation');
    expect(calls[0]).toContain('@reviewer');
  });

  it('a temporary session is never read', async () => {
    const { store } = freshStore();
    const s = store.createSession('p');
    talk(store, s.sessionId, 6);
    store.setSessionNoLearn(s.sessionId, true);
    const calls: string[] = [];
    expect((await analyzeSession(store, s.sessionId, judgeOf('{"recommendations":[]}', calls))).status).toBe('temporary');
    expect(calls).toHaveLength(0);
  });
});

describe('the sweep (R9.4)', () => {
  it('sees only 3 cursor-less sessions per sweep, newest first, and back-fills no further than the 30 most recent', async () => {
    steppingClock();
    const { store } = freshStore();
    const ids: string[] = [];
    for (let i = 0; i < 35; i += 1) {
      const s = store.createSession('p');
      talk(store, s.sessionId, 4);
      store.touchSession(s.sessionId);
      ids.push(s.sessionId);
    }
    const newestFirst = [...ids].reverse();
    const seen: string[] = [];
    const judge: RecommendationJudge = async ({ system }) => {
      seen.push(system);
      return { text: '{"recommendations": []}' };
    };
    const deps = { judge, available: async () => true };
    const first = await runRecommendationSweep(store, {}, deps);
    expect(first.analyzed).toEqual(newestFirst.slice(0, 3));
    expect(seen).toHaveLength(3);
    let total = first.analyzed.length;
    for (let k = 0; k < 15; k += 1) total += (await runRecommendationSweep(store, {}, deps)).analyzed.length;
    expect(total).toBe(30);
    // The five oldest were never read.
    for (const old of ids.slice(0, 5)) expect(store.getRecommendationCursor(old)).toBeUndefined();
    expect((await runRecommendationSweep(store, {}, deps)).skipped).toBe('nothing-due');
  });

  it('the turn\'s own session goes first when it is due; a session below 4 messages is skipped', async () => {
    steppingClock();
    const { store } = freshStore();
    const older = store.createSession('p');
    talk(store, older.sessionId, 4);
    store.touchSession(older.sessionId);
    const small = store.createSession('p');
    talk(store, small.sessionId, 2);
    store.touchSession(small.sessionId);
    const current = store.createSession('p');
    talk(store, current.sessionId, 4);
    store.touchSession(older.sessionId); // older is now the most recently used
    expect(sweepTargets(store, { sessionId: current.sessionId })).toEqual([current.sessionId, older.sessionId]);
    expect(sweepTargets(store, { excludeSessionId: older.sessionId })).toEqual([current.sessionId]);
  });

  it('setting off → no judge call; no provider → no judge call', async () => {
    const { store } = freshStore();
    const s = store.createSession('p');
    talk(store, s.sessionId, 4);
    const calls: string[] = [];
    store.setSetting(PARTICIPANTS_RECOMMENDATIONS_KEY, 'false');
    const off = await runRecommendationSweep(store, { sessionId: s.sessionId }, { judge: judgeOf('{}', calls), available: async () => true });
    expect(off.skipped).toBe('disabled');
    store.setSetting(PARTICIPANTS_RECOMMENDATIONS_KEY, 'true');
    let asked = 0;
    const none = await runRecommendationSweep(
      store,
      { sessionId: s.sessionId },
      {
        judge: judgeOf('{}', calls),
        available: async () => {
          asked += 1;
          return false;
        },
      },
    );
    expect(none.skipped).toBe('no-provider');
    expect(asked).toBe(1);
    expect(calls).toHaveLength(0);
    expect(store.getRecommendationCursor(s.sessionId)).toBeUndefined();
  });

  it('the default dependencies answer "no provider" under test (NABY_PARTICIPANT_RECOMMEND=0)', async () => {
    expect(process.env.NABY_PARTICIPANT_RECOMMEND).toBe('0');
    const { store } = freshStore();
    expect(await defaultRecommendationDeps(store).available()).toBe(false);
  });

  it('one sweep in flight: a second kick is dropped; failures are warned, never thrown', async () => {
    const { store } = freshStore();
    for (let i = 0; i < 2; i += 1) {
      const s = store.createSession('p');
      talk(store, s.sessionId, 4);
    }
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const slow: RecommendationJudge = async () => {
      calls += 1;
      await gate;
      return { text: '{"recommendations": []}' };
    };
    const deps = { judge: slow, available: async () => true };
    const first = kickRecommendationSweep(store, {}, deps);
    expect(first).toBeDefined();
    expect(recommendationSweepInFlight()).not.toBeNull();
    expect(kickRecommendationSweep(store, {}, deps)).toBeUndefined();
    release();
    const r = await first!;
    expect(r?.analyzed).toHaveLength(2);
    expect(calls).toBe(2);
    expect(recommendationSweepInFlight()).toBeNull();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s3 = store.createSession('p');
    talk(store, s3.sessionId, 4);
    const failing = kickRecommendationSweep(store, {}, {
      judge: async () => {
        throw new RecommendationJudgeUnavailableError('no judge');
      },
      available: async () => true,
    });
    const out = await failing!;
    expect(out?.failed).toEqual([s3.sessionId]);
    expect(warn).toHaveBeenCalled();
    const broken = { ...store, listSessionsForRecommendation: () => { throw new Error('db gone'); } } as unknown as Store;
    expect(() => kickRecommendationSweep(broken, {}, deps)).not.toThrow();
    await recommendationSweepInFlight();
  });
});

describe('closing recommendations', () => {
  it('accepted / dismissed once; unknown and already-closed ids are refused', () => {
    const { store, tr } = freshStore();
    const rec = store.putParticipantRecommendation({ sessionId: 's', kind: 'existing', agentId: tr.id, specialty: 'x', reason: 'y', evidence: [1, 2, 3] });
    expect(closeRecommendation(store, 'nope', 'accepted')).toEqual({ ok: false, error: 'no recommendation with that id' });
    expect(closeRecommendation(store, rec.id, 'dismissed').ok).toBe(true);
    expect(closeRecommendation(store, rec.id, 'accepted')).toEqual({ ok: false, error: 'the recommendation is already dismissed' });
  });

  it('a participant joining through a proposal closes its pending recommendation as accepted', () => {
    const { store, tr } = freshStore();
    const other = store.putAgent(participant('other'));
    const a = store.putParticipantRecommendation({ sessionId: 's', kind: 'existing', agentId: tr.id, specialty: 'x', reason: 'y', evidence: [1, 2, 3] });
    const b = store.putParticipantRecommendation({ sessionId: 's', kind: 'existing', agentId: other.id, specialty: 'x', reason: 'y', evidence: [1, 2, 3] });
    expect(closeRecommendationsOnJoin(store, 's', tr.id)).toBe(1);
    expect(store.getParticipantRecommendation(a.id)?.status).toBe('accepted');
    expect(store.getParticipantRecommendation(b.id)?.status).toBe('pending');
  });

  it('the round loop calls onJoined after an approved proposal, onDeclined after a refused one', async () => {
    const { store, tr } = freshStore();
    const rec = store.putParticipantRecommendation({ sessionId: 'S', kind: 'existing', agentId: tr.id, specialty: 'x', reason: 'y', evidence: [1, 2, 3] });
    const agent: RoundAgent = { id: tr.id, name: tr.name, displayName: 'Translator', description: 'translates' };
    const run = (outcome: 'allow' | 'deny', sessionId: string) =>
      runParticipantRound({
        store,
        sessionId,
        hub: { id: 'naby', name: 'naby', displayName: 'naby', description: '' },
        userText: 'translate this',
        mentions: [],
        registered: [agent],
        settings: { proposalsEnabled: true, maxPerSession: 5, maxSpeechesPerRound: 6, maxRoundTrips: 3 },
        recent: () => [],
        runNabyTurn: async () => ({ text: 'ok', ok: true }),
        runParticipantTurn: async () => ({ text: 'done', ok: true }),
        writeUserRow: () => {},
        routeCall: (() => {
          let n = 0;
          return async () => ({
            text: n++ === 0 ? `{"action":"propose","target":"${tr.name}","reason":"translation"}` : '{"action":"end","reason":"done"}',
          });
        })(),
        propose: async () => outcome,
        onJoined: (agentId) => {
          closeRecommendationsOnJoin(store, sessionId, agentId);
        },
        onDeclined: (agentId) => {
          closeRecommendationsOnDecline(store, sessionId, agentId);
        },
        emit: () => {},
        log: () => {},
        signal: new AbortController().signal,
      } satisfies RoundInput);
    const declinedRec = store.putParticipantRecommendation({ sessionId: 'D', kind: 'existing', agentId: tr.id, specialty: 'x', reason: 'y', evidence: [1, 2, 3] });
    await run('deny', 'D');
    // Declining the proposal answers the recommendation too (review finding 5a).
    expect(store.getParticipantRecommendation(declinedRec.id)?.status).toBe('dismissed');
    expect(store.getParticipantRecommendation(rec.id)?.status).toBe('pending');
    await run('allow', 'S');
    expect(store.getParticipantRecommendation(rec.id)?.status).toBe('accepted');
  });

  it('the pending view hides an existing recommendation whose participant already joined', () => {
    const { store, tr } = freshStore();
    store.putParticipantRecommendation({ sessionId: 's', kind: 'existing', agentId: tr.id, specialty: 'x', reason: 'y', evidence: [1, 2, 3] });
    expect(pendingRecommendationViews(store, 's')).toHaveLength(1);
    expect(pendingRecommendationViews(store, 's')[0]!.agent?.name).toBe('translator');
    store.putSessionParticipant('s', tr.id, { status: 'active', addedBy: 'user' });
    expect(pendingRecommendationViews(store, 's')).toHaveLength(0);
  });
});

describe('modelRecommendationJudge', () => {
  function fakeEngine(events: EngineEvent[], seen: unknown[]): Engine {
    return {
      async *run(input: unknown) {
        seen.push(input);
        for (const e of events) yield e;
      },
    } as unknown as Engine;
  }

  it('one tool-less call: deny-all gate, no tools, the text and the usage come back', async () => {
    const store = new MemoryStore();
    const seen: Record<string, unknown>[] = [];
    const engine = fakeEngine(
      [
        { kind: 'init', model: 'claude-sonnet-4-5-20250929' } as EngineEvent,
        { kind: 'text', role: 'assistant', text: '{"recommendations": []}' } as EngineEvent,
        { kind: 'result', ok: true, usage: { inputTokens: 900, outputTokens: 12, cachedInputTokens: 0 }, costUsd: 0.003 } as EngineEvent,
      ],
      seen,
    );
    const judge = modelRecommendationJudge(store, {
      resolveBackend: async () => ({ engine, model: { providerId: 'anthropic', model: 'claude-x' }, label: 'ai-sdk (anthropic)' }),
    });
    const out = await judge({ system: 'SYS', user: 'USER' });
    expect(out.text).toBe('{"recommendations": []}');
    expect(out.usage).toMatchObject({
      engine: 'ai-sdk',
      providerId: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      inputTokens: 900,
      outputTokens: 12,
      costBasis: 'metered',
      reportedCostUsd: 0.003,
    });
    const input = seen[0] as { toolSchemas: unknown[]; system: string; gate: (c: unknown) => Promise<{ behavior: string }> };
    expect(input.toolSchemas).toEqual([]);
    expect(input.system).toBe('SYS');
    expect((await input.gate({})).behavior).toBe('deny');
  });

  it('on the Claude sign-in it runs at RECOMMEND_TIER (sonnet) and is billed as subscription', async () => {
    const store = new MemoryStore();
    const seen: Record<string, unknown>[] = [];
    const engine = fakeEngine([{ kind: 'result', ok: true } as EngineEvent], seen);
    const judge = modelRecommendationJudge(store, {
      resolveBackend: async () => ({ engine, model: { providerId: 'dev-claude' }, label: 'claude-agent-sdk (subscription)' }),
    });
    const out = await judge({ system: 's', user: 'u' });
    expect((seen[0] as { model: { model?: string } }).model.model).toMatch(/sonnet/i);
    expect(out.usage).toMatchObject({ engine: 'dev-claude', costBasis: 'subscription' });
  });

  it('under NABY_PARTICIPANT_RECOMMEND=0 the default judge refuses to build a real backend', async () => {
    const judge = modelRecommendationJudge(new MemoryStore());
    await expect(judge({ system: 's', user: 'u' })).rejects.toBeInstanceOf(RecommendationJudgeUnavailableError);
  });

  it('no backend → RecommendationJudgeUnavailableError', async () => {
    const judge = modelRecommendationJudge(new MemoryStore(), { resolveBackend: async () => undefined });
    await expect(judge({ system: 's', user: 'u' })).rejects.toBeInstanceOf(RecommendationJudgeUnavailableError);
  });
});

// ---------------------------------------------------------------------------
// Review fixes (MAC-M6 code review, findings 1–9)
// ---------------------------------------------------------------------------

describe('review fixes — analyzeSession after the await', () => {
  it('finding 1: the session is deleted while the judge runs → nothing is written, the row is not resurrected', async () => {
    const { store, tr } = freshStore();
    const s = store.createSession('p');
    talk(store, s.sessionId, 4);
    const judge: RecommendationJudge = async () => {
      store.deleteSession(s.sessionId);
      return {
        text: existingAnswer(tr.id),
        usage: { engine: 'ai-sdk', providerId: 'anthropic', model: 'm', inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, costBasis: 'metered' },
      };
    };
    const r = await analyzeSession(store, s.sessionId, judge);
    expect(r).toEqual({ status: 'no-session', created: [] });
    expect(store.getSession(s.sessionId)).toBeUndefined();
    expect(store.listParticipantRecommendations(s.sessionId)).toEqual([]);
    expect(store.getRecommendationCursor(s.sessionId)).toBeUndefined();
    expect(store.listSessions().some((x) => x.sessionId === s.sessionId)).toBe(false);
  });

  it('finding 8: a participant that joined during the call is not recommended; a draft whose name got taken is dropped', async () => {
    const { store, tr } = freshStore();
    const s = store.createSession('p');
    talk(store, s.sessionId, 4);
    const both = JSON.stringify({
      recommendations: [
        JSON.parse(existingAnswer(tr.id)).recommendations[0],
        JSON.parse(newAnswer('relnotes')).recommendations[0],
      ],
    });
    const judge: RecommendationJudge = async () => {
      store.putSessionParticipant(s.sessionId, tr.id, { status: 'active', addedBy: 'user' });
      store.putAgent(participant('RelNotes'));
      return { text: both };
    };
    const r = await analyzeSession(store, s.sessionId, judge);
    expect(r.status).toBe('analyzed');
    expect(r.created).toEqual([]);
    expect(store.listParticipantRecommendations(s.sessionId)).toEqual([]);
    expect(store.getRecommendationCursor(s.sessionId)?.userMessageCount).toBe(4);
  });
});

describe('review fixes — closing what can no longer be acted on (finding 5)', () => {
  it('(a) a declined participant closes its pending recommendation and hides the chip', () => {
    const { store, tr } = freshStore();
    const rec = store.putParticipantRecommendation({ sessionId: 's', kind: 'existing', agentId: tr.id, specialty: 'x', reason: 'y', evidence: [1, 2, 3] });
    store.putSessionParticipant('s', tr.id, { status: 'declined', addedBy: 'naby' });
    expect(pendingRecommendationViews(store, 's')).toEqual([]);
    tidyPending(store, 's');
    expect(store.getParticipantRecommendation(rec.id)?.status).toBe('dismissed');
  });

  it('(b) a pending draft whose handle is now taken is hidden and dismissed', () => {
    const { store } = freshStore();
    const rec = store.putParticipantRecommendation({
      sessionId: 's',
      kind: 'new',
      draft: {
        name: 'relnotes',
        displayName: 'RN',
        description: '',
        instructions: 'You proofread.',
        guardrailsPolicy: '',
        greeting: '',
        avatar: { kind: 'emoji', value: '📝' },
        color: '#10b981',
      },
      specialty: 'x',
      reason: 'y',
      evidence: [1, 2, 3],
    });
    expect(pendingRecommendationViews(store, 's')).toHaveLength(1);
    store.putAgent({ ...participant('RELNOTES'), kind: 'custom', profile: undefined } as AgentInput);
    expect(pendingRecommendationViews(store, 's')).toEqual([]);
    tidyPending(store, 's');
    expect(store.getParticipantRecommendation(rec.id)?.status).toBe('dismissed');
  });
});

describe('review fixes — the sweep', () => {
  it('finding 2: the first judge error stops the sweep, records failed_at, and the session cools down for 6 hours', async () => {
    steppingClock();
    const { store } = freshStore();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const s = store.createSession('p');
      talk(store, s.sessionId, 4);
      store.touchSession(s.sessionId);
      ids.push(s.sessionId);
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    const failing = {
      judge: async () => {
        calls += 1;
        throw new Error('provider 529 overloaded');
      },
      available: async () => true,
    };
    const T = 1_800_000_000_000;
    const first = await runRecommendationSweep(store, { now: () => T }, failing);
    expect(calls).toBe(1);
    expect(first).toMatchObject({ stopped: 'judge-error', failed: [ids[2]], analyzed: [] });
    expect(store.getRecommendationCursor(ids[2]!)).toEqual({ sessionId: ids[2], failedAt: T });

    // Within the cooldown the failed session is skipped (the others are next).
    calls = 0;
    const seen: string[] = [];
    const ok = {
      judge: async ({ system }: { system: string }) => {
        calls += 1;
        seen.push(system);
        return { text: '{"recommendations": []}' };
      },
      available: async () => true,
    };
    const second = await runRecommendationSweep(store, { now: () => T + 60_000 }, ok);
    expect(second.analyzed).toEqual([ids[1], ids[0]]);
    const third = await runRecommendationSweep(store, { sessionId: ids[2], now: () => T + 120_000 }, ok);
    expect(third.skipped).toBe('nothing-due');
    expect(calls).toBe(2);

    // After the cooldown it is tried again, and success clears the failure.
    const later = await runRecommendationSweep(store, { now: () => T + RECOMMEND_FAILURE_COOLDOWN_MS + 1 }, ok);
    expect(later.analyzed).toEqual([ids[2]]);
    expect(store.getRecommendationCursor(ids[2]!)?.failedAt).toBeUndefined();
  });

  it('finding 7: switching the setting off mid-sweep stops it before the next session', async () => {
    steppingClock();
    const { store } = freshStore();
    for (let i = 0; i < 3; i += 1) {
      const s = store.createSession('p');
      talk(store, s.sessionId, 4);
      store.touchSession(s.sessionId);
    }
    let calls = 0;
    const r = await runRecommendationSweep(store, {}, {
      judge: async () => {
        calls += 1;
        store.setSetting(PARTICIPANTS_RECOMMENDATIONS_KEY, 'false');
        return { text: '{"recommendations": []}' };
      },
      available: async () => true,
    });
    expect(calls).toBe(1);
    expect(r).toMatchObject({ stopped: 'disabled' });
    expect(r.analyzed).toHaveLength(1);
  });

  it('finding 3: the kick reads no transcript on the caller\'s tick, and none at all when off', async () => {
    const { store } = freshStore();
    const s = store.createSession('p');
    talk(store, s.sessionId, 4);
    const getMessages = vi.spyOn(store, 'getMessages');
    const listDue = vi.spyOn(store, 'listSessionsForRecommendation');
    const deps = { judge: judgeOf('{"recommendations": []}'), available: async () => true };

    // The env switch (default deps) — vitest.setup.ts sets it.
    expect(kickRecommendationSweep(store, { sessionId: s.sessionId })).toBeUndefined();
    // The setting.
    store.setSetting(PARTICIPANTS_RECOMMENDATIONS_KEY, 'false');
    expect(kickRecommendationSweep(store, { sessionId: s.sessionId }, deps)).toBeUndefined();
    expect(getMessages).not.toHaveBeenCalled();
    expect(listDue).not.toHaveBeenCalled();

    // On: the kick returns before any read; the sweep runs on a later tick.
    store.setSetting(PARTICIPANTS_RECOMMENDATIONS_KEY, 'true');
    const p = kickRecommendationSweep(store, { sessionId: s.sessionId }, deps);
    expect(p).toBeDefined();
    expect(getMessages).not.toHaveBeenCalled();
    expect(listDue).not.toHaveBeenCalled();
    const r = await p!;
    expect(r?.analyzed).toEqual([s.sessionId]);
    expect(getMessages).toHaveBeenCalled();
  });
});

describe('review fixes — the subscription judge bills the chosen Claude account (finding 9)', () => {
  it('builds the Agent SDK engine with activeClaudeAccountId(store)', async () => {
    const store = new MemoryStore();
    store.setSetting('claude.accounts', JSON.stringify([{ id: 'acct-0123456789ab', addedAt: 1 }]));
    setActiveClaudeAccount(store as unknown as Store, 'acct-0123456789ab');
    const built: (string | undefined)[] = [];
    const engine = {
      async *run() {
        yield { kind: 'text', role: 'assistant', text: '{"recommendations": []}' } as EngineEvent;
      },
    } as unknown as Engine;
    const unusedDefault = {
      async *run() {
        throw new Error('the default (account-less) engine must not be used');
      },
    } as unknown as Engine;
    const judge = modelRecommendationJudge(store, {
      resolveBackend: async () => ({ engine: unusedDefault, model: { providerId: 'dev-claude' }, label: 'sdk' }),
      claudeEngine: (accountId) => {
        built.push(accountId);
        return engine;
      },
    });
    const out = await judge({ system: 's', user: 'u' });
    expect(built).toEqual(['acct-0123456789ab']);
    expect(out.text).toBe('{"recommendations": []}');
  });
});
