import { describe, it, expect } from 'vitest';
import { toChatMessages } from './toChatMessages';
import type { RuntimeMessage } from '../../engines/naby';

/**
 * A ROUND, RELOADED (multi-agent-chat §8.4, MAC-M2): `speaker` and `routing`
 * survive the trip from the store to the chat list, a hand-off is never a user
 * bubble, and a participant's tool call never folds into naby's bubble.
 */

const NABY = { agentId: 'agent-persona-builtin', name: 'naby' };
const TR = { agentId: 'p-tr', name: '번역가' };

describe('toChatMessages — speakers and routing', () => {
  const rows: RuntimeMessage[] = [
    { role: 'user', content: '번역해줘' },
    { role: 'assistant', content: 'On it.' },
    {
      role: 'user',
      content: 'Translate it.',
      speaker: NABY,
      routing: { kind: 'delegate', targetAgentId: TR.agentId, targetName: TR.name, reason: 'translation', brief: 'Translate it.' },
    },
    { role: 'assistant', content: '', speaker: TR, toolCalls: [{ toolCallId: 't1', toolName: 'read_file', input: {} }] },
    { role: 'tool', toolCallId: 't1', toolName: 'read_file', output: { content: 'body', isError: false } },
    { role: 'assistant', content: 'Done. @naby ok?', speaker: TR, routing: { kind: 'return', reason: 'asked' } },
  ];
  const chat = toChatMessages(rows);

  it('the hand-off is a system routing marker, not a user bubble', () => {
    expect(chat.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['번역해줘']);
    const marker = chat.find((m) => m.routing?.kind === 'delegate')!;
    expect(marker).toMatchObject({
      role: 'system',
      content: 'naby → @번역가',
      systemEvent: { kind: 'meta', detail: 'Translate it.' },
      speaker: NABY,
      routing: { targetAgentId: 'p-tr', reason: 'translation' },
    });
  });

  it('a participant’s tool call does not fold into naby’s bubble', () => {
    const naby = chat.find((m) => m.content === 'On it.')!;
    expect(naby.toolCalls).toBeUndefined();
    expect(naby.speaker).toBeUndefined();
  });

  it('the participant’s bubbles carry its speaker, and the return marker', () => {
    const p = chat.filter((m) => m.role === 'assistant' && m.speaker?.agentId === 'p-tr');
    expect(p.length).toBeGreaterThanOrEqual(1);
    const last = p[p.length - 1]!;
    expect(last.routing).toEqual({ kind: 'return', reason: 'asked' });
    expect(p.flatMap((m) => m.toolCalls ?? []).map((t) => t.result)).toEqual(['body']);
  });

  it('a transcript with no participant maps exactly as before (no speaker/routing keys)', () => {
    const plain = toChatMessages([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]);
    expect(plain).toEqual([
      { id: 'user-0', role: 'user', content: 'a' },
      { id: 'assistant-1', role: 'assistant', content: 'b', segments: plain[1]!.segments },
    ]);
  });
});
