import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatSegmentTime } from './elapsed';
import { appendTextSegment, appendToolCallSegment } from '../shared/turnSegments';
import { toChatMessages } from '../server/api/session/toChatMessages';

/**
 * A TIME UNDER THE BUBBLES IN THE MIDDLE OF A TURN.
 *
 * Only the turn's last bubble used to carry a time (duration · end time). Now
 * every earlier bubble shows the clock time it was written, and the last one
 * keeps the closing line exactly as it was.
 */

describe('segment time', () => {
  it('formats a clock time and nothing for a missing one', () => {
    const at = new Date(2026, 10, 12, 9, 5, 7).getTime();
    expect(formatSegmentTime(at)).toBe('09:05:07');
    expect(formatSegmentTime(undefined)).toBe('');
    expect(formatSegmentTime(NaN)).toBe('');
  });

  it('a text segment keeps the time of its LAST delta, and a new segment after tools gets its own', () => {
    let s = appendTextSegment(undefined, 'let me look', 1000);
    s = appendTextSegment(s, ' at it', 2000);
    expect(s[0]).toMatchObject({ kind: 'text', at: 2000 });
    s = appendToolCallSegment(s, 'c1');
    s = appendTextSegment(s, 'done', 5000);
    expect(s[2]).toMatchObject({ kind: 'text', text: 'done', at: 5000 });
  });

  it('no time given → no field, as before', () => {
    const s = appendTextSegment(undefined, 'x');
    expect('at' in s[0]).toBe(false);
  });

  it('reload: each row carries its written time as the bubble timestamp', () => {
    const at1 = Date.UTC(2026, 10, 12, 1, 0, 0);
    const at2 = Date.UTC(2026, 10, 12, 1, 0, 30);
    const out = toChatMessages([
      { role: 'user', content: 'q', at: at1 - 1000 },
      { role: 'assistant', content: 'let me look', at: at1, toolCalls: [{ toolCallId: 'c1', toolName: 'read', input: {} }] },
      { role: 'tool', toolCallId: 'c1', toolName: 'read', output: { content: 'ok' } },
      { role: 'assistant', content: 'done', at: at2, turn: { durationMs: 31_000, endedAt: at2 } },
    ] as never);
    const user = out.find((m) => m.role === 'user')!;
    expect(user.timestamp).toBe(new Date(at1 - 1000).toISOString());
    const assistants = out.filter((m) => m.role === 'assistant');
    expect(assistants[0].timestamp).toBe(new Date(at1).toISOString());
    expect(assistants[0].segments?.[0]).toMatchObject({ kind: 'text', at: at1 });
    // The last one still carries the turn's measurement.
    expect(assistants[1].durationMs).toBe(31_000);
  });

  it('the bubble draws the time under every finished text bubble except the last, which keeps turn-meta', () => {
    const src = readFileSync(join(__dirname, 'MessageBubble.tsx'), 'utf8');
    expect(src).toMatch(
      /\(message\.isStreaming \? seg\.id !== lastSegmentId : seg\.id !== lastTextId\)\s*\?\s*formatSegmentTime\(seg\.at\)/,
    );
    expect(src).toContain('data-testid="segment-time"');
    expect(src).toContain('data-testid="turn-meta"');
  });
});
