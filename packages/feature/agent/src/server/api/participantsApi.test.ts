import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * CONVERSATION PARTICIPANTS — the MAC-M1 actions (specs/multi-agent-chat.md §8.4).
 *
 * Every test goes through `runNabyAction` against the throwaway database
 * vitest.setup.ts points NABY_DB_PATH at — never ~/.naby/app.db. No action here
 * reaches an engine; the orchestrator is mocked anyway so a future change that
 * makes one do so fails loudly instead of starting a real model turn.
 */
vi.mock('../engines/orchestrator', () => ({
  dispatchChat: async () => ({ ok: false as const, status: 503, error: 'no engine in tests' }),
}));

import { runNabyAction } from './naby';
import { getStore } from '../engines/naby';
import {
  BUILTIN_PERSONA_ID,
  type ParticipantProfile,
} from '../../../../../../../dist/naby-runtime.mjs';
import {
  PARTICIPANTS_MAX_PER_SESSION_KEY,
  PARTICIPANTS_PROPOSALS_KEY,
  PARTICIPANT_SETTINGS_DEFAULTS,
  clampParticipantInt,
  readParticipantSettings,
  uniqueCopyName,
} from '../lib/participants';

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq += 1)}`;

const profile = (over: Partial<ParticipantProfile> = {}): ParticipantProfile => ({
  displayName: 'Translator',
  avatar: { kind: 'emoji', value: '🌐' },
  color: '#0ea5e9',
  knowledge: [],
  guardrails: {},
  mcpServers: [],
  skills: [],
  ...over,
});

async function createParticipant(name = uid('tr'), over: Record<string, unknown> = {}) {
  const r = await runNabyAction({
    action: 'participant.put',
    name,
    description: 'Translates Korean and English. Call for translation.',
    instructions: 'You translate.',
    profile: profile(),
    ...over,
  } as never);
  expect(r.ok, r.ok ? '' : r.error).toBe(true);
  if (!r.ok) throw new Error(r.error);
  return r.participant!;
}

/** Clear every participant and the settings this file writes, so tests do not
 *  see each other's rows through the shared per-worker database. */
beforeEach(() => {
  const store = getStore();
  for (const a of store.listAgents()) if (a.kind === 'participant') store.removeAgent(a.id);
  for (const key of [
    PARTICIPANTS_PROPOSALS_KEY,
    PARTICIPANTS_MAX_PER_SESSION_KEY,
    'participants.maxSpeechesPerRound',
    'participants.maxRoundTrips',
    'participants.showRouting',
    'participants.recommendations.enabled',
  ]) {
    store.setSetting(key, '');
  }
});

describe('participant.put', () => {
  it('creates a kind=participant row with the profile, instructions as systemPrompt, inline autonomy and no tools', async () => {
    const p = await createParticipant('translator-a');
    expect(p.kind).toBe('participant');
    expect(p.systemPrompt).toBe('You translate.');
    expect(p.autonomy).toEqual({ escalation: 'inline' });
    expect(p.toolRefs).toEqual([]);
    // A new participant's memory is session-scoped unless the request widens it.
    expect(p.memoryScope).toBe('session');
    expect(p.profile?.displayName).toBe('Translator');
    expect(getStore().getAgent(p.id)?.profile?.color).toBe('#0ea5e9');
  });

  it('edits an existing participant, keeping toolRefs and profile when they are omitted', async () => {
    const p = await createParticipant(uid('ed'), { toolRefs: ['read_file'], profile: profile({ color: '#111111' }) });
    const r = await runNabyAction({
      action: 'participant.put',
      id: p.id,
      name: p.name,
      description: 'changed',
      instructions: 'New instructions.',
    });
    expect(r.ok).toBe(true);
    const after = getStore().getAgent(p.id)!;
    expect(after.description).toBe('changed');
    expect(after.systemPrompt).toBe('New instructions.');
    expect(after.toolRefs).toEqual(['read_file']);
    expect(after.profile?.color).toBe('#111111');
    expect(after.createdAt).toBe(p.createdAt);
  });

  it('keeps an explicit memoryScope, and an edit that omits it keeps the stored scope', async () => {
    const p = await createParticipant(uid('scope'), { memoryScope: 'user' });
    expect(p.memoryScope).toBe('user');
    const r = await runNabyAction({ action: 'participant.put', id: p.id, name: p.name, instructions: 'Edited.' });
    expect(r.ok).toBe(true);
    expect(getStore().getAgent(p.id)?.memoryScope).toBe('user');
  });

  it('defaults the profile on create when none is sent', async () => {
    const r = await runNabyAction({ action: 'participant.put', name: uid('bare'), instructions: 'Be brief.' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.participant?.profile?.avatar.kind).toBe('emoji');
    expect(r.participant?.profile?.knowledge).toEqual([]);
  });

  it('strips one leading @ from the name', async () => {
    const r = await runNabyAction({ action: 'participant.put', name: '@at-name', instructions: 'x', profile: profile() });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.participant?.name).toBe('at-name');
  });

  it.each([
    ['an empty name', { name: '  ' }, /name is required/],
    ['a name with spaces', { name: 'two words' }, /spaces/],
    ['a name with @ inside', { name: 'a@b' }, /'@'/],
    ['a path-like name', { name: './x' }, /cannot start/],
    ['the built-in name', { name: 'naby' }, /built-in/],
    ['the built-in name in another case (Naby)', { name: 'Naby' }, /built-in/],
    ['the built-in name in capitals (NABY)', { name: 'NABY' }, /built-in/],
    ['the Korean hub alias (나비)', { name: '나비' }, /built-in/],
    ['the hub alias with an @ (@Naby)', { name: '@Naby' }, /built-in/],
    ['an emoji avatar over 16 characters', { profile: profile({ avatar: { kind: 'emoji', value: 'x'.repeat(17) } }) }, /16 characters/],
    ['a greeting over 2 KB', { profile: profile({ greeting: 'g'.repeat(2049) }) }, /greeting/],
    ['missing instructions', { instructions: '   ' }, /instructions/],
    ['a profile over the knowledge limit', {
      profile: profile({
        knowledge: Array.from({ length: 21 }, (_, i) => ({
          id: `k${i}`, title: 't', inject: 'always' as const, source: { kind: 'inline' as const, text: 'x' },
        })),
      }),
    }, /at most 20/],
    ['a profile with a non-hex colour', { profile: profile({ color: 'red' }) }, /hex/],
    ['a profile with a relative file path', {
      profile: profile({
        knowledge: [{ id: 'k', title: 't', inject: 'always', source: { kind: 'file', path: 'rel/a.md' } }],
      }),
    }, /absolute/],
    ['a profile with an unknown avatar kind', { profile: { ...profile(), avatar: { kind: 'svg', value: 'x' } } }, /avatar\.kind/],
  ])('rejects %s', async (_label, over, error) => {
    const before = getStore().listAgents().length;
    const r = await runNabyAction({
      action: 'participant.put',
      name: uid('bad'),
      instructions: 'x',
      profile: profile(),
      ...over,
    } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(error);
    expect(getStore().listAgents().length).toBe(before);
  });

  it('rejects a name already held by another agent', async () => {
    const p = await createParticipant(uid('dup'));
    const r = await runNabyAction({ action: 'participant.put', name: p.name, instructions: 'x', profile: profile() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already in use/);
  });

  it('rejects a name that differs from another agent\'s only in case (Reviewer vs custom reviewer)', async () => {
    const custom = await runNabyAction({ action: 'agent.put', name: 'reviewer', systemPrompt: 'c' });
    expect(custom.ok).toBe(true);
    if (!custom.ok) return;
    try {
      const before = getStore().listAgents().length;
      const r = await runNabyAction({ action: 'participant.put', name: 'Reviewer', instructions: 'x', profile: profile() });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/already in use/);
      expect(getStore().listAgents().length).toBe(before);
      // Against another participant too, and on a rename.
      const p = await createParticipant('critic-x');
      const clash = await runNabyAction({ action: 'participant.put', name: 'CRITIC-X', instructions: 'x', profile: profile() });
      expect(clash.ok).toBe(false);
      const rename = await runNabyAction({ action: 'participant.put', id: p.id, name: 'REVIEWER', instructions: 'x' });
      expect(rename.ok).toBe(false);
      // A case-only rename of the participant itself is fine.
      const self = await runNabyAction({ action: 'participant.put', id: p.id, name: 'Critic-X', instructions: 'x' });
      expect(self.ok).toBe(true);
    } finally {
      getStore().removeAgent(custom.agent!.id);
    }
  });

  it('refuses to edit the persona or a custom agent, and refuses an unknown id', async () => {
    const persona = await runNabyAction({
      action: 'participant.put', id: BUILTIN_PERSONA_ID, name: 'naby', instructions: 'x', profile: profile(),
    });
    expect(persona.ok).toBe(false);
    if (!persona.ok) expect(persona.error).toMatch(/read-only/);

    const custom = await runNabyAction({ action: 'agent.put', name: uid('custom'), systemPrompt: 'c' });
    expect(custom.ok).toBe(true);
    if (!custom.ok) return;
    const asParticipant = await runNabyAction({
      action: 'participant.put', id: custom.agent!.id, name: custom.agent!.name, instructions: 'x', profile: profile(),
    });
    expect(asParticipant.ok).toBe(false);
    expect(getStore().getAgent(custom.agent!.id)?.kind).toBe('custom');
    getStore().removeAgent(custom.agent!.id);

    const ghost = await runNabyAction({ action: 'participant.put', id: 'no-such-id', name: uid('g'), instructions: 'x' });
    expect(ghost.ok).toBe(false);
  });

  it('agent.put refuses to rewrite a participant as a custom agent', async () => {
    const p = await createParticipant(uid('guard'));
    const r = await runNabyAction({ action: 'agent.put', id: p.id, name: p.name, systemPrompt: 'hijack' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/participant/);
    expect(getStore().getAgent(p.id)?.kind).toBe('participant');
    expect(getStore().getAgent(p.id)?.profile).toBeDefined();
  });
});

describe('participant.list / remove / duplicate', () => {
  it('lists participants only, each with its active-session count', async () => {
    const custom = await runNabyAction({ action: 'agent.put', name: uid('c'), systemPrompt: 'c' });
    const a = await createParticipant(uid('a'));
    const b = await createParticipant(uid('b'));
    const store = getStore();
    const s1 = store.createSession('fake').sessionId;
    const s2 = store.createSession('fake').sessionId;
    await runNabyAction({ action: 'session.participants.add', sessionId: s1, agentId: a.id });
    await runNabyAction({ action: 'session.participants.add', sessionId: s2, agentId: a.id });
    await runNabyAction({ action: 'session.participants.add', sessionId: s2, agentId: b.id });
    await runNabyAction({ action: 'session.participants.remove', sessionId: s2, agentId: b.id });

    const r = await runNabyAction({ action: 'participant.list' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.participants?.every((p) => p.kind === 'participant')).toBe(true);
    expect(r.participants?.map((p) => p.name)).toEqual([a.name, b.name]);
    expect(r.participants?.find((p) => p.id === a.id)?.activeSessions).toBe(2);
    expect(r.participants?.find((p) => p.id === b.id)?.activeSessions).toBe(0);

    // agent.list still returns every kind (the Settings page reads it).
    const all = await runNabyAction({ action: 'agent.list' });
    expect(all.ok).toBe(true);
    if (all.ok) {
      const kinds = new Set(all.agents?.map((x) => x.kind));
      expect(kinds.has('persona') && kinds.has('custom') && kinds.has('participant')).toBe(true);
    }
    expect(custom.ok).toBe(true);
    if (custom.ok) store.removeAgent(custom.agent!.id);
  });

  it('remove deletes the participant and its session rows; refuses persona and custom', async () => {
    const p = await createParticipant(uid('rm'));
    const store = getStore();
    const s = store.createSession('fake').sessionId;
    await runNabyAction({ action: 'session.participants.add', sessionId: s, agentId: p.id });
    const r = await runNabyAction({ action: 'participant.remove', id: p.id });
    expect(r.ok).toBe(true);
    expect(store.getAgent(p.id)).toBeUndefined();
    expect(store.listSessionParticipants(s)).toEqual([]);

    const persona = await runNabyAction({ action: 'participant.remove', id: BUILTIN_PERSONA_ID });
    expect(persona.ok).toBe(false);
    expect(store.getAgent(BUILTIN_PERSONA_ID)).toBeDefined();
    const missing = await runNabyAction({ action: 'participant.remove', id: '' });
    expect(missing.ok).toBe(false);
  });

  it('duplicate copies the row under <name>-copy, then -copy-2', async () => {
    const p = await createParticipant(uid('orig'), { toolRefs: ['read_file'], profile: profile({ color: '#222222' }) });
    const one = await runNabyAction({ action: 'participant.duplicate', id: p.id });
    expect(one.ok).toBe(true);
    if (!one.ok) return;
    expect(one.participant?.name).toBe(`${p.name}-copy`);
    expect(one.participant?.id).not.toBe(p.id);
    expect(one.participant?.kind).toBe('participant');
    expect(one.participant?.systemPrompt).toBe(p.systemPrompt);
    expect(one.participant?.toolRefs).toEqual(['read_file']);
    expect(one.participant?.profile?.color).toBe('#222222');
    const two = await runNabyAction({ action: 'participant.duplicate', id: p.id });
    expect(two.ok && two.participant?.name).toBe(`${p.name}-copy-2`);
    // Duplicating a copy does not stack suffixes.
    const three = await runNabyAction({ action: 'participant.duplicate', id: one.participant!.id });
    expect(three.ok && three.participant?.name).toBe(`${p.name}-copy-3`);

    const persona = await runNabyAction({ action: 'participant.duplicate', id: BUILTIN_PERSONA_ID });
    expect(persona.ok).toBe(false);
  });
});

describe('session.participants.*', () => {
  it('list always reports naby and only active participants joined with their agent', async () => {
    const a = await createParticipant(uid('ra'));
    const b = await createParticipant(uid('rb'));
    const s = getStore().createSession('fake').sessionId;
    const empty = await runNabyAction({ action: 'session.participants.list', sessionId: s });
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(empty.naby?.id).toBe(BUILTIN_PERSONA_ID);
    expect(empty.naby?.name).toBe(getStore().getAgent(BUILTIN_PERSONA_ID)?.name);
    expect(empty.participants).toEqual([]);

    await runNabyAction({ action: 'session.participants.add', sessionId: s, agentId: a.id });
    getStore().putSessionParticipant(s, b.id, { status: 'declined', addedBy: 'naby' });
    const r = await runNabyAction({ action: 'session.participants.list', sessionId: s });
    if (!r.ok) throw new Error(r.error);
    expect(r.participants?.map((p) => p.id)).toEqual([a.id]);
    expect(r.participants?.[0]?.status).toBe('active');
    expect(r.participants?.[0]?.addedBy).toBe('user');
    expect(r.participants?.[0]?.profile?.displayName).toBe('Translator');
    expect(r.participants?.[0]?.description).toMatch(/Translates/);

    const noSession = await runNabyAction({ action: 'session.participants.list', sessionId: '' });
    expect(noSession.ok).toBe(false);
  });

  it('add sets active/user even over declined or removed, and is idempotent', async () => {
    const p = await createParticipant(uid('re'));
    const store = getStore();
    const s = store.createSession('fake').sessionId;
    store.putSessionParticipant(s, p.id, { status: 'declined', addedBy: 'naby' });
    await runNabyAction({ action: 'session.participants.add', sessionId: s, agentId: p.id });
    expect(store.listSessionParticipants(s)[0]).toMatchObject({ status: 'active', addedBy: 'user' });
    await runNabyAction({ action: 'session.participants.remove', sessionId: s, agentId: p.id });
    expect(store.listSessionParticipants(s)[0]?.status).toBe('removed');
    await runNabyAction({ action: 'session.participants.add', sessionId: s, agentId: p.id });
    const again = await runNabyAction({ action: 'session.participants.add', sessionId: s, agentId: p.id });
    expect(again.ok).toBe(true);
    expect(store.listSessionParticipants(s)).toHaveLength(1);
    expect(store.listSessionParticipants(s)[0]?.status).toBe('active');
  });

  it('add rejects the persona, a custom agent and an unknown id', async () => {
    const s = getStore().createSession('fake').sessionId;
    const persona = await runNabyAction({ action: 'session.participants.add', sessionId: s, agentId: BUILTIN_PERSONA_ID });
    expect(persona.ok).toBe(false);
    const custom = await runNabyAction({ action: 'agent.put', name: uid('cc'), systemPrompt: 'c' });
    expect(custom.ok).toBe(true);
    if (custom.ok) {
      const r = await runNabyAction({ action: 'session.participants.add', sessionId: s, agentId: custom.agent!.id });
      expect(r.ok).toBe(false);
      getStore().removeAgent(custom.agent!.id);
    }
    const ghost = await runNabyAction({ action: 'session.participants.add', sessionId: s, agentId: 'nope' });
    expect(ghost.ok).toBe(false);
    const noAgent = await runNabyAction({ action: 'session.participants.add', sessionId: s, agentId: '' });
    expect(noAgent.ok).toBe(false);
    expect(getStore().listSessionParticipants(s)).toEqual([]);
  });

  it('add enforces participants.maxPerSession', async () => {
    await runNabyAction({ action: 'participants.set', maxPerSession: 2 });
    const s = getStore().createSession('fake').sessionId;
    const ps = [await createParticipant(uid('m1')), await createParticipant(uid('m2')), await createParticipant(uid('m3'))];
    expect((await runNabyAction({ action: 'session.participants.add', sessionId: s, agentId: ps[0]!.id })).ok).toBe(true);
    expect((await runNabyAction({ action: 'session.participants.add', sessionId: s, agentId: ps[1]!.id })).ok).toBe(true);
    const third = await runNabyAction({ action: 'session.participants.add', sessionId: s, agentId: ps[2]!.id });
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.error).toMatch(/at most 2/);
    // Re-adding someone already active is not a new seat.
    expect((await runNabyAction({ action: 'session.participants.add', sessionId: s, agentId: ps[0]!.id })).ok).toBe(true);
    // A removed participant frees its seat.
    await runNabyAction({ action: 'session.participants.remove', sessionId: s, agentId: ps[1]!.id });
    expect((await runNabyAction({ action: 'session.participants.add', sessionId: s, agentId: ps[2]!.id })).ok).toBe(true);
  });

  it('remove refuses naby', async () => {
    const s = getStore().createSession('fake').sessionId;
    const r = await runNabyAction({ action: 'session.participants.remove', sessionId: s, agentId: BUILTIN_PERSONA_ID });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/naby/);
    const noSession = await runNabyAction({ action: 'session.participants.remove', sessionId: '', agentId: 'x' });
    expect(noSession.ok).toBe(false);
  });
});

describe('participants.get / participants.set', () => {
  it('reads the defaults when nothing is stored', async () => {
    const r = await runNabyAction({ action: 'participants.get' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.participantSettings).toEqual(PARTICIPANT_SETTINGS_DEFAULTS);
    expect(PARTICIPANT_SETTINGS_DEFAULTS).toEqual({
      proposalsEnabled: true,
      maxPerSession: 5,
      maxSpeechesPerRound: 6,
      maxRoundTrips: 3,
      showRouting: false,
      recommendationsEnabled: true,
    });
  });

  it('writes only the fields sent, and clamps integers into 1..20 before storing', async () => {
    const r = await runNabyAction({ action: 'participants.set', showRouting: true, maxPerSession: 99 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.participantSettings).toMatchObject({ showRouting: true, maxPerSession: 20, maxRoundTrips: 3 });
    expect(getStore().getSetting(PARTICIPANTS_MAX_PER_SESSION_KEY)).toBe('20');

    const low = await runNabyAction({ action: 'participants.set', maxSpeechesPerRound: 0, maxRoundTrips: 2.6 });
    expect(low.ok).toBe(true);
    if (low.ok) {
      expect(low.participantSettings?.maxSpeechesPerRound).toBe(1);
      expect(low.participantSettings?.maxRoundTrips).toBe(3);
      expect(low.participantSettings?.showRouting).toBe(true);
    }
    const off = await runNabyAction({ action: 'participants.set', proposalsEnabled: false });
    expect(off.ok && off.participantSettings?.proposalsEnabled).toBe(false);
    expect(getStore().getSetting(PARTICIPANTS_PROPOSALS_KEY)).toBe('false');
  });

  it('rejects mistyped fields without writing', async () => {
    const a = await runNabyAction({ action: 'participants.set', proposalsEnabled: 'yes' } as never);
    expect(a.ok).toBe(false);
    const b = await runNabyAction({ action: 'participants.set', maxPerSession: Number.NaN });
    expect(b.ok).toBe(false);
    const c = await runNabyAction({ action: 'participants.set', maxRoundTrips: '4' } as never);
    expect(c.ok).toBe(false);
    expect(readParticipantSettings(getStore())).toEqual(PARTICIPANT_SETTINGS_DEFAULTS);
  });

  it('a garbage stored value reads as its default (clamped when numeric)', () => {
    const fake = new Map<string, string>([
      ['participants.maxPerSession', 'lots'],
      ['participants.maxRoundTrips', '500'],
      ['participants.proposals.enabled', 'maybe'],
    ]);
    const s = readParticipantSettings({ getSetting: (k) => fake.get(k) });
    expect(s.maxPerSession).toBe(5);
    expect(s.maxRoundTrips).toBe(20);
    expect(s.proposalsEnabled).toBe(true);
    expect(clampParticipantInt(Number.POSITIVE_INFINITY, 4)).toBe(4);
  });
});

describe('lib/participants — uniqueCopyName', () => {
  it('walks -copy, -copy-2, … and never stacks suffixes', () => {
    const taken = new Set(['a-copy', 'a-copy-2']);
    expect(uniqueCopyName('a', (n) => taken.has(n))).toBe('a-copy-3');
    expect(uniqueCopyName('b', () => false)).toBe('b-copy');
    expect(uniqueCopyName('a-copy-2', (n) => taken.has(n))).toBe('a-copy-3');
  });
});
