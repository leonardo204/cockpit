import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PARTICIPANT RECOMMENDATIONS — the actions (multi-agent-chat §8.13, MAC-M6):
 * `session.recommendations.list / dismiss / accept`, the `recommendations` field
 * on `session.participants.list`, and the `participants.recommendations.enabled`
 * setting. Every call goes through `runNabyAction` against the throwaway
 * database vitest.setup.ts points NABY_DB_PATH at.
 */
vi.mock('../engines/orchestrator', () => ({
  dispatchChat: async () => ({ ok: false as const, status: 503, error: 'no engine in tests' }),
}));

import { runNabyAction } from './naby';
import { getStore } from '../engines/naby';
import { defaultParticipantProfile } from '../../../../../../../dist/naby-runtime.mjs';
import { PARTICIPANTS_RECOMMENDATIONS_KEY, readParticipantSettings } from '../lib/participants';

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(seq += 1)}`;

function participant(name = uid('tr')) {
  return getStore().putAgent({
    name,
    kind: 'participant',
    description: 'Translates Korean and English.',
    systemPrompt: 'You translate.',
    toolRefs: [],
    memoryScope: 'session',
    autonomy: { escalation: 'inline' },
    profile: defaultParticipantProfile('Translator'),
  });
}

const draft = (name: string) => ({
  name,
  displayName: 'Release-note editor',
  description: 'Proofreads release notes.',
  instructions: 'You proofread release notes.',
  guardrailsPolicy: '',
  greeting: '',
  avatar: { kind: 'emoji' as const, value: '📝' },
  color: '#10b981',
});

function session() {
  return getStore().createSession('', 'recommend').sessionId;
}

beforeEach(() => {
  const store = getStore();
  for (const a of store.listAgents()) if (a.kind === 'participant') store.removeAgent(a.id);
  store.setSetting(PARTICIPANTS_RECOMMENDATIONS_KEY, '');
});

describe('session.participants.list carries the pending recommendations', () => {
  it('pending only, existing joined with its participant, new with its draft', async () => {
    const store = getStore();
    const tr = participant();
    const sid = session();
    const a = store.putParticipantRecommendation({ sessionId: sid, kind: 'existing', agentId: tr.id, specialty: 'translation', reason: 'Four translations.', evidence: [1, 2, 3] });
    const b = store.putParticipantRecommendation({ sessionId: sid, kind: 'new', draft: draft(uid('rn')), specialty: 'proofreading', reason: 'Release notes.', evidence: [1, 2, 4] });
    const c = store.putParticipantRecommendation({ sessionId: sid, kind: 'new', draft: draft(uid('gone')), specialty: 'x', reason: 'y', evidence: [1, 2, 3] });
    store.setParticipantRecommendationStatus(c.id, 'dismissed');
    const r = await runNabyAction({ action: 'session.participants.list', sessionId: sid });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recommendations?.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(r.recommendations?.[0]).toMatchObject({ kind: 'existing', agentId: tr.id, agent: { name: tr.name }, reason: 'Four translations.' });
    expect(r.recommendations?.[1]).toMatchObject({ kind: 'new', draft: { displayName: 'Release-note editor' }, specialty: 'proofreading' });
  });
});

describe('session.recommendations.list', () => {
  it('by session, or by the one id Settings opened on; needs one of them', async () => {
    const store = getStore();
    const sid = session();
    const rec = store.putParticipantRecommendation({ sessionId: sid, kind: 'new', draft: draft(uid('rn')), specialty: 's', reason: 'r', evidence: [1, 2, 3] });
    const bySession = await runNabyAction({ action: 'session.recommendations.list', sessionId: sid });
    expect(bySession.ok && bySession.recommendations?.map((x) => x.id)).toEqual([rec.id]);
    const byId = await runNabyAction({ action: 'session.recommendations.list', id: rec.id });
    expect(byId.ok && byId.recommendations?.[0]).toMatchObject({ id: rec.id, sessionId: sid });
    const unknown = await runNabyAction({ action: 'session.recommendations.list', id: 'no-such' });
    expect(unknown.ok && unknown.recommendations).toEqual([]);
    const neither = await runNabyAction({ action: 'session.recommendations.list' });
    expect(neither).toEqual({ ok: false, error: 'sessionId or id is required' });
  });
});

describe('session.recommendations.dismiss / accept', () => {
  it('dismiss: refuses an unknown id, closes a pending one, refuses it a second time', async () => {
    const store = getStore();
    const sid = session();
    const rec = store.putParticipantRecommendation({ sessionId: sid, kind: 'new', draft: draft(uid('rn')), specialty: 's', reason: 'r', evidence: [1, 2, 3] });
    expect(await runNabyAction({ action: 'session.recommendations.dismiss', id: 'no-such' })).toEqual({
      ok: false,
      error: 'no recommendation with that id',
    });
    const r = await runNabyAction({ action: 'session.recommendations.dismiss', id: rec.id });
    expect(r.ok && r.recommendations).toEqual([]);
    expect(store.getParticipantRecommendation(rec.id)?.status).toBe('dismissed');
    expect(await runNabyAction({ action: 'session.recommendations.dismiss', id: rec.id })).toEqual({
      ok: false,
      error: 'the recommendation is already dismissed',
    });
    expect(await runNabyAction({ action: 'session.recommendations.accept', id: rec.id })).toEqual({
      ok: false,
      error: 'the recommendation is already dismissed',
    });
  });

  it('accept: a new draft is closed with the participant it became; a non-participant agentId is refused', async () => {
    const store = getStore();
    const sid = session();
    const name = uid('rn');
    const rec = store.putParticipantRecommendation({ sessionId: sid, kind: 'new', draft: draft(name), specialty: 's', reason: 'r', evidence: [1, 2, 3] });
    const bad = await runNabyAction({ action: 'session.recommendations.accept', id: rec.id, agentId: 'naby-persona' });
    expect(bad.ok).toBe(false);
    expect(store.getParticipantRecommendation(rec.id)?.status).toBe('pending');
    // The client's "save and add": participant.put → session.participants.add → accept.
    const put = await runNabyAction({ action: 'participant.put', name, instructions: 'You proofread.', profile: defaultParticipantProfile('RN') });
    expect(put.ok).toBe(true);
    if (!put.ok) return;
    const add = await runNabyAction({ action: 'session.participants.add', sessionId: sid, agentId: put.participant!.id });
    expect(add.ok).toBe(true);
    const ok = await runNabyAction({ action: 'session.recommendations.accept', id: rec.id, agentId: put.participant!.id });
    expect(ok.ok && ok.recommendations).toEqual([]);
    expect(store.getParticipantRecommendation(rec.id)?.status).toBe('accepted');
    expect(await runNabyAction({ action: 'session.recommendations.accept', id: rec.id })).toEqual({
      ok: false,
      error: 'the recommendation is already accepted',
    });
  });

  it('existing from the chip: add, then accept — the roster then shows it, the chip is gone', async () => {
    const store = getStore();
    const tr = participant();
    const sid = session();
    const rec = store.putParticipantRecommendation({ sessionId: sid, kind: 'existing', agentId: tr.id, specialty: 's', reason: 'r', evidence: [1, 2, 3] });
    expect((await runNabyAction({ action: 'session.participants.add', sessionId: sid, agentId: tr.id })).ok).toBe(true);
    expect((await runNabyAction({ action: 'session.recommendations.accept', id: rec.id })).ok).toBe(true);
    const list = await runNabyAction({ action: 'session.participants.list', sessionId: sid });
    expect(list.ok && list.participants?.map((p) => p.id)).toEqual([tr.id]);
    expect(list.ok && list.recommendations).toEqual([]);
  });

  it('id is required', async () => {
    expect(await runNabyAction({ action: 'session.recommendations.dismiss' } as never)).toEqual({ ok: false, error: 'id is required' });
    expect(await runNabyAction({ action: 'session.recommendations.accept', id: '' })).toEqual({ ok: false, error: 'id is required' });
  });
});

describe('participants.recommendations.enabled', () => {
  it('defaults on; participants.set writes it; a mistyped value is refused', async () => {
    expect(readParticipantSettings(getStore()).recommendationsEnabled).toBe(true);
    const off = await runNabyAction({ action: 'participants.set', recommendationsEnabled: false });
    expect(off.ok && off.participantSettings?.recommendationsEnabled).toBe(false);
    expect(getStore().getSetting(PARTICIPANTS_RECOMMENDATIONS_KEY)).toBe('false');
    const bad = await runNabyAction({ action: 'participants.set', recommendationsEnabled: 'no' } as never);
    expect(bad.ok).toBe(false);
  });
});
