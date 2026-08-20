import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, SqliteStore } from '../../../../../../../dist/naby-runtime.mjs';
import type { RuntimeMessage, Store } from '../engines/naby';

/**
 * HOW LONG A TURN TOOK, WRITTEN DOWN.
 *
 * The measurement only exists once the turn is over, and by then its rows have
 * already been appended — so this is the one write-back in the store contract.
 * It matters that it is a write-back and not an extra row: `RuntimeMessage` has
 * a closed three-variant contract and every row is replayed to a provider, so a
 * row that existed only to carry a number would be a message with nothing in it.
 *
 * Run against a REAL SqliteStore, because the claim is about the database — the
 * payload is JSON in a TEXT column, which is exactly why this needed no
 * migration, and only actual SQL can show that a stamped row still parses.
 * MemoryStore is checked alongside it: the two drivers must stay observationally
 * identical (contract §6, spike:f105).
 */

const dir = mkdtempSync(join(tmpdir(), 'naby-turn-stamp-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TURN = { durationMs: 12_345, endedAt: Date.UTC(2026, 7, 19, 5, 15, 30) };

/** The last assistant row, which is the one the stamp is defined to land on. */
function lastAssistant(messages: RuntimeMessage[]): Extract<RuntimeMessage, { role: 'assistant' }> {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'assistant') return m;
  }
  throw new Error('no assistant row');
}

function seed(store: Store, sessionId: string): void {
  store.appendMessage(sessionId, { role: 'user', content: 'q' });
  store.appendMessage(sessionId, { role: 'assistant', content: 'first run of prose' });
  store.appendMessage(sessionId, {
    role: 'assistant',
    content: '',
    toolCalls: [{ toolCallId: 'c1', toolName: 'Read', input: { file_path: '/a.ts' } }],
  });
  store.appendMessage(sessionId, {
    role: 'tool',
    toolCallId: 'c1',
    toolName: 'Read',
    output: { content: 'contents' },
  });
  store.appendMessage(sessionId, { role: 'assistant', content: 'the answer' });
}

describe.each([
  ['SqliteStore', () => new SqliteStore({ path: join(dir, `${Math.random().toString(36).slice(2)}.db`) }) as Store],
  ['MemoryStore', () => new MemoryStore() as Store],
])('stampTurnEnd — %s', (_name, make) => {
  it('lands on the LAST assistant row and touches nothing else', () => {
    const store = make();
    seed(store, 's1');
    expect(store.stampTurnEnd('s1', TURN)).toBe(true);

    const messages = store.getMessages('s1');
    expect(messages).toHaveLength(5);
    expect(lastAssistant(messages).turn).toEqual(TURN);
    // The rows before it are untouched — the stamp describes the TURN, and a
    // second copy of it on an earlier row would draw a second closing line.
    const stampedCount = messages.filter((m) => m.role === 'assistant' && m.turn).length;
    expect(stampedCount).toBe(1);
    expect(messages[0]).toEqual({ role: 'user', content: 'q' });
  });

  it('leaves the row otherwise intact — content, tool calls and order all survive', () => {
    const store = make();
    seed(store, 's2');
    store.stampTurnEnd('s2', TURN);

    const messages = store.getMessages('s2');
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant', 'tool', 'assistant']);
    expect(lastAssistant(messages).content).toBe('the answer');
    const call = messages[2]!;
    expect(call.role === 'assistant' && call.toolCalls?.[0]?.toolCallId).toBe('c1');
  });

  it('stamps a turn that ENDED on a tool call, on the assistant row that made it', () => {
    // The `tool` row is last in append order, but a tool result is not something
    // the turn said — the closing line belongs to the assistant row above it.
    const store = make();
    store.appendMessage('s3', { role: 'assistant', content: 'checking' });
    store.appendMessage('s3', {
      role: 'assistant',
      content: '',
      toolCalls: [{ toolCallId: 'c9', toolName: 'Bash', input: {} }],
    });
    store.appendMessage('s3', { role: 'tool', toolCallId: 'c9', toolName: 'Bash', output: { content: 'ok' } });
    expect(store.stampTurnEnd('s3', TURN)).toBe(true);

    const messages = store.getMessages('s3');
    expect(messages[2]!.role).toBe('tool');
    expect(messages[2]).not.toHaveProperty('turn');
    const row = messages[1]!;
    expect(row.role === 'assistant' && row.turn).toEqual(TURN);
  });

  it('is last-writer-wins, so a retried stamp cannot leave two readings', () => {
    const store = make();
    seed(store, 's4');
    store.stampTurnEnd('s4', TURN);
    const later = { durationMs: 20_000, endedAt: TURN.endedAt + 7_655 };
    store.stampTurnEnd('s4', later);
    expect(lastAssistant(store.getMessages('s4')).turn).toEqual(later);
  });

  it('writes NOTHING when the turn never said anything', () => {
    // A turn that failed preflight has a user row and no assistant row. The
    // caller stamps unconditionally, so this has to be a no-op rather than a
    // throw — a store fault here would fail a turn that already answered.
    const store = make();
    store.appendMessage('s5', { role: 'user', content: 'q' });
    expect(store.stampTurnEnd('s5', TURN)).toBe(false);
    expect(store.getMessages('s5')).toEqual([{ role: 'user', content: 'q' }]);
  });

  it('is a no-op on a session that does not exist', () => {
    const store = make();
    expect(store.stampTurnEnd('never-seen', TURN)).toBe(false);
  });
});

describe('stampTurnEnd — SqliteStore durability', () => {
  it('survives a close and reopen, with no migration and nothing else disturbed', () => {
    // The whole reason this needed no schema change: the row is the
    // RuntimeMessage as JSON, so the stamp is one more key in a TEXT column.
    const path = join(dir, 'reopen.db');
    const first = new SqliteStore({ path }) as Store;
    seed(first, 's6');
    first.stampTurnEnd('s6', TURN);
    (first as unknown as { close?: () => void }).close?.();

    const second = new SqliteStore({ path }) as Store;
    const messages = second.getMessages('s6');
    expect(messages).toHaveLength(5);
    expect(lastAssistant(messages).turn).toEqual(TURN);
    (second as unknown as { close?: () => void }).close?.();
  });

  it('reads back rows written BEFORE the stamp existed, with the field simply absent', () => {
    // No back-fill, no default: an unstamped row is how every turn recorded
    // before this looks, and it must keep parsing exactly as it did.
    const path = join(dir, 'legacy.db');
    const store = new SqliteStore({ path }) as Store;
    seed(store, 's7');
    const messages = store.getMessages('s7');
    for (const m of messages) expect(m).not.toHaveProperty('turn');
    (store as unknown as { close?: () => void }).close?.();
  });
});
