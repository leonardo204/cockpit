import { describe, it, expect } from 'vitest';
import {
  PARTICIPANT_LIMITS,
  blankParticipantForm,
  formFromParticipant,
  participantPutBody,
  validateParticipantForm,
  type ParticipantForm,
} from './participantForm';

/**
 * multi-agent-chat MAC-M3 — the participant editor's form (R1.1, R5.2). The
 * client checks MIRROR the server's (validateParticipantName, the runtime's
 * parseParticipantProfile) so a mistake is named beside its field; these pin
 * that mirror and the round trip that must not drop an import's fields.
 */

const valid = (over: Partial<ParticipantForm> = {}): ParticipantForm => ({
  ...blankParticipantForm(),
  name: 'translator',
  displayName: '번역가',
  instructions: 'Translate faithfully.',
  ...over,
});

const codes = (f: ParticipantForm) => validateParticipantForm(f).map((e) => e.code);

describe('validateParticipantForm', () => {
  it('a complete form passes', () => {
    expect(validateParticipantForm(valid())).toEqual([]);
  });

  it('mirrors the server name rules', () => {
    expect(codes(valid({ name: '' }))).toContain('name');
    expect(codes(valid({ name: 'two words' }))).toContain('nameSpace');
    expect(codes(valid({ name: 'a@b' }))).toContain('nameAt');
    expect(codes(valid({ name: '/root' }))).toContain('nameLead');
    expect(codes(valid({ name: '.hidden' }))).toContain('nameLead');
    expect(codes(valid({ name: '~home' }))).toContain('nameLead');
    // One leading @ is forgiven, as on the server.
    expect(codes(valid({ name: '@translator' }))).toEqual([]);
  });

  it('requires a display name, instructions, an avatar and a hex colour', () => {
    expect(codes(valid({ displayName: ' ' }))).toContain('displayName');
    expect(codes(valid({ instructions: '' }))).toContain('instructions');
    expect(codes(valid({ avatarEmoji: '' }))).toContain('avatar');
    expect(codes(valid({ avatarEmoji: '', avatarImage: 'data:image/png;base64,AAAA' }))).not.toContain('avatar');
    expect(codes(valid({ color: 'blue' }))).toContain('color');
    expect(codes(valid({ color: '#abc' }))).not.toContain('color');
  });

  it('caps examples at 5 and needs both sides', () => {
    const six = Array.from({ length: 6 }, () => ({ user: 'q', assistant: 'a' }));
    expect(codes(valid({ examples: six }))).toContain('examplesMax');
    expect(codes(valid({ examples: [{ user: 'q', assistant: '' }] }))).toContain('exampleEmpty');
    expect(PARTICIPANT_LIMITS.examples).toBe(5);
  });

  it('caps knowledge at 20 items and 16 KB of inline text, each with a title', () => {
    const item = (i: number, text = 'x') => ({
      id: `k${i}`,
      title: `t${i}`,
      inject: 'always' as const,
      keywords: '',
      source: { kind: 'inline' as const, text },
    });
    expect(codes(valid({ knowledge: Array.from({ length: 21 }, (_, i) => item(i)) }))).toContain('knowledgeMax');
    expect(codes(valid({ knowledge: [item(0, 'x'.repeat(16 * 1024))] }))).toEqual([]);
    // Bytes, not characters: 16 KB of Hangul is far fewer characters.
    expect(codes(valid({ knowledge: [item(0, '가'.repeat(6000))] }))).toContain('knowledgeSize');
    expect(codes(valid({ knowledge: [{ ...item(0), title: ' ' }] }))).toContain('knowledgeTitle');
  });

  it('temperature is 0..2 when given', () => {
    expect(codes(valid({ temperature: '0.7' }))).toEqual([]);
    expect(codes(valid({ temperature: '2.5' }))).toContain('temperature');
    expect(codes(valid({ temperature: '' }))).toEqual([]);
  });
});

describe('participantPutBody', () => {
  it('writes participant.put with the profile in R1.1 shape', () => {
    const body = participantPutBody(
      valid({
        description: '  Translates notes  ',
        avatarEmoji: '🌐',
        color: '#0EA5E9',
        greeting: 'hello',
        examples: [{ user: 'q', assistant: 'a' }],
        knowledge: [{ id: 'k1', title: 'Glossary', inject: 'on-demand', keywords: 'term, 용어 ,', source: { kind: 'inline', text: 'x' } }],
        policy: 'Never invent terms',
        permissionMode: 'plan',
        toolRefs: ['Read'],
        mcpServers: ['notion'],
        skills: ['glossary'],
        model: 'sonnet',
        temperature: '0.3',
        memoryScope: 'project',
      }),
    );
    expect(body).toMatchObject({
      action: 'participant.put',
      name: 'translator',
      description: 'Translates notes',
      instructions: 'Translate faithfully.',
      model: 'sonnet',
      toolRefs: ['Read'],
      memoryScope: 'project',
      profile: {
        displayName: '번역가',
        avatar: { kind: 'emoji', value: '🌐' },
        color: '#0EA5E9',
        greeting: 'hello',
        examples: [{ user: 'q', assistant: 'a' }],
        knowledge: [{ id: 'k1', title: 'Glossary', inject: 'on-demand', keywords: ['term', '용어'], source: { kind: 'inline', text: 'x' } }],
        guardrails: { policy: 'Never invent terms', permissionMode: 'plan' },
        mcpServers: ['notion'],
        skills: ['glossary'],
        params: { temperature: 0.3 },
      },
    });
    expect(body).not.toHaveProperty('id');
  });

  it('an edit round-trips what the editor does not show (an import’s origin, extensions, file knowledge)', () => {
    const row = {
      id: 'p1',
      name: 'minji',
      description: 'design feedback',
      systemPrompt: 'You are Minji.',
      model: 'opus',
      toolRefs: [],
      memoryScope: 'user',
      profile: {
        displayName: '민지',
        avatar: { kind: 'image', dataUrl: 'data:image/png;base64,AAAA' },
        color: '#EC4899',
        knowledge: [{ id: 'f1', title: 'Spec', inject: 'always', source: { kind: 'file', path: '/abs/spec.md' } }],
        guardrails: {},
        mcpServers: [],
        skills: [],
        params: { maxOutputTokens: 900 },
        origin: { format: 'chara_card_v2', importedAt: 1, sourceHash: 'abc' },
        extensions: { chara_card_v2: { name: 'Minji' } },
      },
    };
    const form = formFromParticipant(row);
    expect(form.id).toBe('p1');
    expect(form.avatarImage).toBe('data:image/png;base64,AAAA');
    const body = participantPutBody(form) as { id: string; profile: Record<string, unknown> };
    expect(body.id).toBe('p1');
    expect(body.profile.avatar).toEqual({ kind: 'image', dataUrl: 'data:image/png;base64,AAAA' });
    expect(body.profile.origin).toEqual(row.profile.origin);
    expect(body.profile.extensions).toEqual(row.profile.extensions);
    expect(body.profile.params).toEqual({ maxOutputTokens: 900 });
    expect(body.profile.knowledge).toEqual([
      { id: 'f1', title: 'Spec', inject: 'always', source: { kind: 'file', path: '/abs/spec.md' } },
    ]);
  });

  it('a blank model means "follow the session"', () => {
    expect(participantPutBody(valid()).model).toBe('');
  });
});
