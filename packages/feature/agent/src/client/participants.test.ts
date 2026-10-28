import { describe, it, expect } from 'vitest';
import type { ChatMessage } from './types';
import {
  FALLBACK_AVATAR,
  addableParticipants,
  approvalSpeakerName,
  chatSettingsFrom,
  handleSet,
  mentionGroupOf,
  mentionPickPlan,
  orderMentionAgents,
  participantInfoFrom,
  participantInfosFrom,
  proposalFromApproval,
  relayedMessageIds,
  resolveSpeaker,
  rosterLayout,
  roundProgress,
  routingChipKind,
  routingChipVisible,
  type ParticipantInfo,
} from './participants';

/**
 * multi-agent-chat MAC-M3 — the pure rules behind the participant UI (§8.5,
 * R6.1–R6.7). The components only read these answers, so the rules that are
 * invisible to the type checker (which routing rows show by default, which
 * bubble gets "relayed by naby", when the roster folds) are pinned here.
 */

const P = (id: string, name: string, extra: Partial<ParticipantInfo> = {}): ParticipantInfo => ({
  id,
  name,
  displayName: name.toUpperCase(),
  description: `${name} does things`,
  avatar: { kind: 'emoji', value: '🌐' },
  color: '#0EA5E9',
  ...extra,
});

describe('participantInfoFrom', () => {
  it('reads an agent row with its profile', () => {
    const p = participantInfoFrom({
      id: 'a1',
      name: 'translator',
      description: 'translates',
      activeSessions: 2,
      profile: { displayName: '번역가', avatar: { kind: 'emoji', value: '🌐' }, color: '#0EA5E9' },
    });
    expect(p).toEqual({
      id: 'a1',
      name: 'translator',
      displayName: '번역가',
      description: 'translates',
      avatar: { kind: 'emoji', value: '🌐' },
      color: '#0EA5E9',
      activeSessions: 2,
    });
  });

  it('falls back for a missing or broken profile, and drops unusable rows', () => {
    const p = participantInfoFrom({ id: 'a1', name: 'x', profile: { color: 'red', avatar: { kind: 'video' } } });
    expect(p?.displayName).toBe('x');
    expect(p?.avatar).toEqual(FALLBACK_AVATAR);
    expect(p?.color).toMatch(/^#/);
    expect(participantInfoFrom({ name: 'no-id' })).toBeNull();
    expect(participantInfosFrom([null, { id: 'b', name: 'b' }, 'x'])).toHaveLength(1);
    expect(participantInfosFrom('not a list')).toEqual([]);
  });
});

describe('chatSettingsFrom', () => {
  it('keeps the stored values and defaults the rest', () => {
    expect(chatSettingsFrom({ showRouting: true, maxPerSession: 3 })).toEqual({
      showRouting: true,
      maxPerSession: 3,
    });
    // The speech / round-trip limits are gone (§8.15 R11.1): a stale server
    // value is not carried.
    expect(chatSettingsFrom({ maxSpeechesPerRound: 6, maxRoundTrips: 3 })).not.toHaveProperty('maxSpeechesPerRound');
    expect(chatSettingsFrom(undefined).showRouting).toBe(false);
  });
});

describe('resolveSpeaker', () => {
  const reg = [P('a1', 'translator')];
  const lookup = (id: string) => reg.find((p) => p.id === id);

  it('a live speaker keeps its own display fields', () => {
    const r = resolveSpeaker(
      { agentId: 'a1', name: 'translator', displayName: 'Live', color: '#111111', avatar: { kind: 'emoji', value: '🛠' } },
      lookup,
    );
    expect(r.displayName).toBe('Live');
    expect(r.color).toBe('#111111');
    expect(r.avatar).toEqual({ kind: 'emoji', value: '🛠' });
  });

  it('a reloaded speaker (id + handle only) is filled from the registry', () => {
    const r = resolveSpeaker({ agentId: 'a1', name: 'translator' }, lookup);
    expect(r.displayName).toBe('TRANSLATOR');
    expect(r.color).toBe('#0EA5E9');
  });

  it('a deleted participant still reads sensibly', () => {
    const r = resolveSpeaker({ agentId: 'gone', name: 'old' }, lookup);
    expect(r.displayName).toBe('old');
    expect(r.avatar).toEqual(FALLBACK_AVATAR);
  });
});

describe('routing chips (R6.4)', () => {
  const hub = { id: 'naby-id', name: 'naby' };

  it('classifies every routing step', () => {
    expect(routingChipKind({ kind: 'delegate', targetAgentId: 'a1', decision: 'route' }, hub)).toBe('delegate');
    expect(routingChipKind({ kind: 'delegate', targetAgentId: 'a1', decision: 'user-mention' }, hub)).toBe('user-mention');
    // A reloaded row has no decision; the stored reason says it.
    expect(routingChipKind({ kind: 'delegate', targetAgentId: 'a1', reason: 'user-mention' }, hub)).toBe('user-mention');
    expect(routingChipKind({ kind: 'delegate', targetAgentId: 'naby-id' }, hub)).toBe('to-naby');
    expect(routingChipKind({ kind: 'delegate', targetName: '나비' }, null)).toBe('to-naby');
    expect(routingChipKind({ kind: 'return', targetAgentId: 'naby-id' }, hub)).toBe('return');
    expect(routingChipKind({ kind: 'propose', targetAgentId: 'a1' }, hub)).toBe('propose');
    expect(routingChipKind({ kind: 'end', decision: 'ignored-mention' }, hub)).toBe('ignored-mention');
    expect(routingChipKind({ kind: 'end', decision: 'cap', reason: 'speeches' }, hub)).toBe('cap');
    expect(routingChipKind({ kind: 'delegate', targetAgentId: 'a1', decision: 'not-in-session' }, hub)).toBe('not-in-session');
  });

  it('hides routing internals by default; not-in-session and cap always show', () => {
    for (const k of ['delegate', 'user-mention', 'to-naby', 'return', 'propose', 'ignored-mention', 'end'] as const) {
      expect(routingChipVisible(k, false)).toBe(false);
      expect(routingChipVisible(k, true)).toBe(true);
    }
    expect(routingChipVisible('not-in-session', false)).toBe(true);
    expect(routingChipVisible('cap', false)).toBe(true);
  });
});

const user = (id: string, content = 'hi'): ChatMessage => ({ id, role: 'user', content });
const marker = (id: string, routing: ChatMessage['routing']): ChatMessage => ({
  id,
  role: 'system',
  content: '',
  systemEvent: { kind: 'meta' },
  routing,
} as ChatMessage);
const said = (id: string, content: string, speaker?: { agentId: string; name: string }): ChatMessage => ({
  id,
  role: 'assistant',
  content,
  ...(speaker ? { speaker } : {}),
});

describe('relayedMessageIds (R6.4a)', () => {
  it('marks a participant bubble whose preceding marker handed it the turn', () => {
    const msgs = [
      user('u1'),
      marker('r1', { kind: 'delegate', targetAgentId: 'a1' }),
      said('m1', 'translated', { agentId: 'a1', name: 'translator' }),
      said('m2', 'naby adds', undefined),
      said('m3', 'unprompted', { agentId: 'a2', name: 'reviewer' }),
    ];
    const ids = relayedMessageIds(msgs);
    expect([...ids]).toEqual(['m1']);
  });

  it('does not mark a bubble whose marker targeted someone else, nor across a user line', () => {
    const msgs = [
      marker('r1', { kind: 'delegate', targetAgentId: 'a2' }),
      said('m1', 'x', { agentId: 'a1', name: 'translator' }),
      marker('r2', { kind: 'delegate', targetAgentId: 'a1' }),
      user('u2'),
      said('m2', 'y', { agentId: 'a1', name: 'translator' }),
    ];
    expect(relayedMessageIds(msgs).size).toBe(0);
  });

  it('matches by handle when the marker has no id', () => {
    const msgs = [marker('r1', { kind: 'delegate', targetName: 'translator' }), said('m1', 'x', { agentId: 'a1', name: 'translator' })];
    expect(relayedMessageIds(msgs).has('m1')).toBe(true);
  });
});

describe('roundProgress (R6.5)', () => {
  it('an ordinary turn has no strip', () => {
    expect(roundProgress([user('u1'), said('a', 'answer')])).toBeNull();
  });

  it('a round reports its speech count and the announced next speaker', () => {
    const msgs = [
      user('u1'),
      marker('r1', { kind: 'delegate', targetAgentId: 'a1', targetName: 'translator' }),
      said('m1', 'done', { agentId: 'a1', name: 'translator' }),
      marker('r2', { kind: 'delegate', targetAgentId: 'a2', targetName: 'reviewer' }),
    ];
    expect(roundProgress(msgs)).toEqual({ speech: 1, next: { agentId: 'a2', name: 'reviewer' } });
  });

  it('a target that already took the (empty) live bubble is speaking, not next', () => {
    const msgs = [
      user('u1'),
      marker('r1', { kind: 'delegate', targetAgentId: 'a1', targetName: 'translator' }),
      said('live', '', { agentId: 'a1', name: 'translator' }),
    ];
    expect(roundProgress(msgs)).toEqual({ speech: 1 });
  });

  it('only the turn after the last user message counts', () => {
    const msgs = [
      marker('old', { kind: 'delegate', targetAgentId: 'a1' }),
      said('m0', 'old', { agentId: 'a1', name: 'translator' }),
      user('u2'),
      said('live', ''),
    ];
    expect(roundProgress(msgs)).toBeNull();
  });
});

describe('rosterLayout (R6.2 idle collapse)', () => {
  const five = ['a', 'b', 'c', 'd', 'e'].map((x) => P(x, x));

  it('shows up to four in full', () => {
    const { shown, folded } = rosterLayout(five.slice(0, 4), null);
    expect(shown.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(folded).toEqual([]);
  });

  it('folds idle participants past four into +N', () => {
    const { shown, folded } = rosterLayout(five, null);
    expect(shown.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(folded.map((p) => p.id)).toEqual(['e']);
  });

  it('never folds the one speaking, and keeps join order', () => {
    const { shown, folded } = rosterLayout(five, 'e');
    expect(shown.map((p) => p.id)).toEqual(['a', 'b', 'c', 'e']);
    expect(folded.map((p) => p.id)).toEqual(['d']);
  });

  it('the + menu offers only the registered participants not here', () => {
    expect(addableParticipants(five, five.slice(0, 2)).map((p) => p.id)).toEqual(['c', 'd', 'e']);
  });
});

describe('the @ palette (R6.3)', () => {
  const rows = [
    { name: '@naby', agent: { stage: 'butterfly' } },
    { name: '@reviewer', agent: { participant: true, inSession: false } },
    { name: '@imported', agent: { stage: 'egg' } },
    { name: '@translator', agent: { participant: true, inSession: false } },
  ];
  const here = handleSet([{ name: 'Translator' }]);

  it('puts session participants first and outside participants last', () => {
    expect(orderMentionAgents(rows, here).map((r) => r.name)).toEqual(['@translator', '@naby', '@imported', '@reviewer']);
    expect(mentionGroupOf(rows[1]!, here)).toBe('outside');
    expect(mentionGroupOf(rows[3]!, here)).toBe('session');
    expect(mentionGroupOf(rows[0]!, here)).toBe('agents');
  });

  it('picking an outside participant adds it first; anything else only inserts', () => {
    const registered = [{ id: 'r-id', name: 'reviewer' }, { id: 't-id', name: 'translator' }];
    expect(mentionPickPlan(rows[1]!, here, registered, 'sess')).toEqual({ kind: 'add-then-insert', agentId: 'r-id' });
    expect(mentionPickPlan(rows[3]!, here, registered, 'sess')).toEqual({ kind: 'insert' });
    expect(mentionPickPlan(rows[0]!, here, registered, 'sess')).toEqual({ kind: 'insert' });
    // No session yet: nothing to add it to.
    expect(mentionPickPlan(rows[1]!, here, registered, null)).toEqual({ kind: 'insert' });
  });
});

describe('the proposal approval (R6.7)', () => {
  const lookup = (id: string) => (id === 'a1' ? P('a1', 'translator', { color: '#F59E0B' }) : undefined);

  it('reads a participant proposal off approval_request', () => {
    const p = proposalFromApproval(
      {
        approvalId: 'x',
        source: 'participant_proposal',
        tool_name: 'participant.add',
        input: {
          agentId: 'a1',
          name: 'translator',
          displayName: '번역가',
          avatar: { kind: 'emoji', value: '🌐' },
          description: 'translates',
          reason: 'the user asked for English',
        },
      },
      lookup,
    );
    expect(p).toEqual({
      agentId: 'a1',
      name: 'translator',
      displayName: '번역가',
      avatar: { kind: 'emoji', value: '🌐' },
      color: '#F59E0B',
      description: 'translates',
      reason: 'the user asked for English',
    });
  });

  it('any other approval is not a proposal', () => {
    expect(proposalFromApproval({ approvalId: 'x', tool_name: 'Bash', input: {} })).toBeNull();
    expect(proposalFromApproval({ approvalId: 'x', source: 'hook', input: { agentId: 'a1', name: 'n' } })).toBeNull();
  });

  it("names the participant behind a tool approval (§8.9)", () => {
    expect(approvalSpeakerName({ speaker: { id: 'a1', name: 'translator', displayName: '번역가' } })).toBe('번역가');
    expect(approvalSpeakerName({ speaker: { name: 'translator' } })).toBe('translator');
    expect(approvalSpeakerName({})).toBeUndefined();
  });
});
