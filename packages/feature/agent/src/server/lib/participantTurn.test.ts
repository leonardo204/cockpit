import { describe, it, expect } from 'vitest';
import type { ParticipantProfile } from '../../../../../../../dist/naby-runtime.mjs';
import { readParticipantProfile } from './participantTurn';

/**
 * The tolerant profile read a participant's speech is built from (multi-agent-chat
 * §8.1, review finding 6): a stored value is put through the same gate a write
 * is, and anything that fails reads as the default profile — never a throw.
 */
const good: ParticipantProfile = {
  displayName: 'Translator',
  avatar: { kind: 'emoji', value: '🌐' },
  color: '#0ea5e9',
  knowledge: [],
  guardrails: {},
  mcpServers: [],
  skills: [],
};

describe('readParticipantProfile', () => {
  it('passes a valid stored profile through, with no fallback', () => {
    const r = readParticipantProfile({ name: 'tr', profile: good });
    expect(r.fallback).toBeUndefined();
    expect(r.profile).toEqual(good);
  });

  it('a missing profile reads as the default and says why', () => {
    const r = readParticipantProfile({ name: 'tr', profile: undefined });
    expect(r.profile.displayName).toBe('tr');
    expect(r.profile.avatar.kind).toBe('emoji');
    expect(r.fallback).toMatch(/missing/);
  });

  it.each([
    ['a non-list knowledge', { knowledge: 'oops' }],
    ['an emoji avatar over 16 characters', { avatar: { kind: 'emoji', value: 'x'.repeat(40) } }],
    ['a greeting over 2 KB', { greeting: 'g'.repeat(3000) }],
    ['a policy over 8 KB', { guardrails: { policy: 'p'.repeat(9000) } }],
    ['extensions over 128 KB', { extensions: { raw: 'e'.repeat(129 * 1024) } }],
  ])('a stored profile with %s reads as the default, without throwing', (_label, over) => {
    const r = readParticipantProfile({ name: 'tr', profile: { ...good, ...over } as never });
    expect(r.profile.displayName).toBe('tr');
    expect(r.profile.knowledge).toEqual([]);
    expect(typeof r.fallback).toBe('string');
    expect(r.fallback!.length).toBeLessThanOrEqual(200);
  });
});
