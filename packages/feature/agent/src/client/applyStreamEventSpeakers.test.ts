import { describe, it, expect } from 'vitest';
import { applyStreamEvent, type StreamEvent } from './applyStreamEvent';
import { actingAgentFromSpeaker, thinkingDisplayName } from './actingAgent';
import type { ChatMessage } from './types';

/**
 * A ROUND IN THE LIVE STREAM (multi-agent-chat §8.4, MAC-M2). The reducer is
 * scoped to ONE live bubble, and a round has several speakers; these pin how
 * `system/speaker` and `system/routing` split and label the bubbles so MAC-M3 has
 * something stable to draw — and that nothing breaks when the fields appear.
 */

const A = 'asst-1';
const base = (): ChatMessage[] => [
  { id: 'u1', role: 'user', content: 'hi' },
  { id: A, role: 'assistant', content: '', toolCalls: [], isStreaming: true },
];
const run = (msgs: ChatMessage[], ...evs: StreamEvent[]) =>
  evs.reduce((m, ev) => applyStreamEvent(m, ev, { assistantId: A }), msgs);
const text = (t: string): StreamEvent => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } },
});
const speaker = (n: number, agent: StreamEvent['agent']): StreamEvent => ({ type: 'system', subtype: 'speaker', speech: n, agent });
const TR = { id: 'p-tr', name: '번역가', displayName: 'Translator', avatar: { kind: 'emoji' as const, value: '🌐' }, color: '#0ea5e9', persona: false };
const NABY = { id: 'agent-persona-builtin', name: 'naby', displayName: '나비', persona: true };

describe('system/speaker', () => {
  it('labels an empty live bubble with the participant', () => {
    const out = run(base(), speaker(1, TR));
    expect(out).toHaveLength(2);
    expect(out[1]!.speaker).toEqual({ agentId: 'p-tr', name: '번역가', displayName: 'Translator', avatar: { kind: 'emoji', value: '🌐' }, color: '#0ea5e9' });
  });

  it('naby’s speech carries no speaker (its bubble keeps today’s look)', () => {
    const out = run(base(), speaker(1, NABY));
    expect(out[1]!.speaker).toBeUndefined();
  });

  it('a new speaker after a finished speech freezes it into its own bubble', () => {
    const out = run(base(), speaker(1, TR), text('Hello.'), speaker(2, NABY), text('Anything else?'));
    expect(out.map((m) => m.id)).toEqual(['u1', `${A}-speech-1`, A]);
    expect(out[1]).toMatchObject({ content: 'Hello.', isStreaming: false, speaker: { agentId: 'p-tr' } });
    expect(out[2]).toMatchObject({ content: 'Anything else?', isStreaming: true });
    expect(out[2]!.speaker).toBeUndefined();
  });

  it('is idempotent on replay', () => {
    const once = run(base(), speaker(1, TR), text('Hello.'), speaker(2, NABY));
    const twice = run(once, speaker(2, NABY));
    expect(twice).toBe(once);
  });

  it('the result finalizes only the live bubble and keeps the frozen speech', () => {
    const out = run(base(), speaker(1, TR), text('Hello.'), speaker(2, NABY), text('Done.'), {
      type: 'result',
      result: 'Translator:\nHello.\n\nDone.',
      duration_ms: 5,
      ended_at: 10,
    });
    expect(out[1]!.content).toBe('Hello.');
    expect(out[2]).toMatchObject({ content: 'Done.', isStreaming: false, durationMs: 5 });
  });

  it('a malformed agent does not crash and changes nothing visible', () => {
    const out = run(base(), { type: 'system', subtype: 'speaker', agent: { persona: false } });
    expect(out[1]!.speaker).toBeUndefined();
  });
});

describe('system/routing', () => {
  const routing = (seq: number, r: StreamEvent['routing']): StreamEvent => ({ type: 'system', subtype: 'routing', seq, routing: r });

  it('a hand-off before anyone spoke sits just above the live bubble', () => {
    const out = run(base(), routing(1, { kind: 'delegate', targetAgentId: 'p-tr', targetName: '번역가', brief: 'Translate.', decision: 'route' }));
    expect(out.map((m) => m.id)).toEqual(['u1', `routing-${A}-1`, A]);
    expect(out[1]).toMatchObject({
      role: 'system',
      routing: { kind: 'delegate', targetName: '번역가', decision: 'route' },
      systemEvent: { kind: 'meta', detail: 'Translate.' },
    });
  });

  it('a step after a speech (ignored mention, return) follows that speech', () => {
    const out = run(
      base(),
      speaker(1, TR),
      text('@critic look. @naby ok?'),
      routing(2, { kind: 'end', targetName: 'critic', decision: 'ignored-mention' }),
      routing(3, { kind: 'return', targetName: 'naby', reason: 'asked', decision: 'route' }),
      speaker(2, NABY),
    );
    expect(out.map((m) => m.id)).toEqual(['u1', `${A}-speech-1`, `routing-${A}-2`, `routing-${A}-3`, A]);
  });

  it('is idempotent on seq', () => {
    const ev = routing(1, { kind: 'delegate', targetName: 'x', decision: 'user-mention' });
    const once = run(base(), ev);
    expect(run(once, ev)).toBe(once);
  });
});

describe('acting agent from system/speaker', () => {
  it('reads a participant with its display fields', () => {
    expect(actingAgentFromSpeaker({ agent: TR })).toEqual({
      name: '번역가',
      persona: false,
      id: 'p-tr',
      displayName: 'Translator',
      avatar: { kind: 'emoji', value: '🌐' },
      color: '#0ea5e9',
      participant: true,
    });
  });
  it('reads naby as the persona', () => {
    expect(actingAgentFromSpeaker({ agent: NABY })).toMatchObject({ name: 'naby', persona: true });
    expect(actingAgentFromSpeaker({ agent: NABY })?.participant).toBeUndefined();
  });
  it('rejects garbage', () => {
    expect(actingAgentFromSpeaker({ agent: 'x' })).toBeNull();
    expect(actingAgentFromSpeaker({ agent: { name: '' } })).toBeNull();
    expect(actingAgentFromSpeaker(undefined)).toBeNull();
  });
  it('the loading bubble names a participant by its display name', () => {
    const acting = actingAgentFromSpeaker({ agent: TR });
    expect(thinkingDisplayName({ acting, personaLabel: '나비', engineName: 'Claude' })).toBe('Translator');
    expect(thinkingDisplayName({ acting: actingAgentFromSpeaker({ agent: NABY }), personaLabel: '나비', engineName: 'Claude' })).toBe('나비');
  });
});
