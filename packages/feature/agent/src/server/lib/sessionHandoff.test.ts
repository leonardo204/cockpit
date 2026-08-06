import { describe, it, expect } from 'vitest';
import {
  CONTINUED_TITLE_PREFIX,
  HANDOFF_BLOCK_HEADER,
  HANDOFF_MAX_CHARS,
  HANDOFF_SOURCE_MAX_MESSAGES,
  continueSessionInNewTab,
  continuedTitle,
  handoffInstruction,
  handoffSourceMessages,
  normalizeHandoff,
  type HandoffStore,
} from './sessionHandoff';
import { MemoryStore } from '../../../../../../../dist/naby-runtime.mjs';
import type { RuntimeMessage } from '../../../../../../../dist/naby-runtime.mjs';

/**
 * CONTINUE IN A NEW TAB (specs/session-context-management.md §2.2).
 *
 * The whole flow is exercised against a REAL store (the in-memory driver, which
 * implements the same `Store` interface the SQLite one does) with a FAKE
 * summarizer — so no test here can reach a model, on a signed-in laptop or a CI
 * box. The rule under test above all others: a summary that fails must not stop
 * the tab from opening.
 */

function seeded(): { store: HandoffStore & MemoryStore; sessionId: string } {
  const store = new MemoryStore();
  const { sessionId } = store.createSession('test-provider', 'Pricing work');
  store.appendMessage(sessionId, { role: 'user', content: 'we agreed to ship on Friday' });
  store.appendMessage(sessionId, { role: 'assistant', content: 'noted' });
  return { store, sessionId };
}

describe('handoffInstruction', () => {
  it('produces nothing at all for a session with no handoff', () => {
    // The no-op invariant: an ordinary session's system prompt is byte-for-byte
    // what it was before this feature existed.
    expect(handoffInstruction(undefined)).toBeUndefined();
    expect(handoffInstruction('')).toBeUndefined();
    expect(handoffInstruction('   \n ')).toBeUndefined();
  });

  it('labels the block and frames it as context rather than as a new request', () => {
    const block = handoffInstruction('AGREED: ship Friday. OPEN: pricing.')!;
    expect(block).toContain(HANDOFF_BLOCK_HEADER);
    expect(block).toContain('AGREED: ship Friday. OPEN: pricing.');
    // It must not read as something the user just said, and the live user must
    // outrank it — both are stated in the block itself.
    expect(block).toMatch(/do not answer it again/i);
    expect(block).toMatch(/the user now wins/i);
  });
});

describe('the source slice the summarizer reads', () => {
  it('takes the newest messages and caps how many', () => {
    const many: RuntimeMessage[] = Array.from({ length: 200 }, (_, i) => ({
      role: 'user' as const,
      content: `m${i}`,
    }));
    const slice = handoffSourceMessages(many);
    expect(slice.length).toBeLessThanOrEqual(HANDOFF_SOURCE_MAX_MESSAGES);
    expect(slice[slice.length - 1]).toEqual({ role: 'user', content: 'm199' });
  });

  it('caps by CHARACTERS too, so a session full of huge tool results cannot slip through', () => {
    const huge: RuntimeMessage[] = Array.from({ length: 10 }, (_, i) => ({
      role: 'tool' as const,
      toolCallId: `c${i}`,
      toolName: 'read',
      output: { content: 'x'.repeat(20_000) },
    }));
    const slice = handoffSourceMessages(huge);
    // One 20k message fits; the second would blow the 24k budget.
    expect(slice.length).toBe(1);
  });

  it('always keeps at least one message, however large it is', () => {
    const single: RuntimeMessage[] = [{ role: 'user', content: 'y'.repeat(500_000) }];
    expect(handoffSourceMessages(single).length).toBe(1);
  });
});

describe('normalizeHandoff / continuedTitle', () => {
  it('bounds the handoff, since it is injected into every later turn', () => {
    expect(normalizeHandoff(undefined)).toBe('');
    expect(normalizeHandoff('  spaced  ')).toBe('spaced');
    expect(normalizeHandoff('z'.repeat(HANDOFF_MAX_CHARS + 500)).length).toBe(HANDOFF_MAX_CHARS);
  });

  it("prefers the client's title, falls back to the source's name, then to the date", () => {
    const source = {
      sessionId: 's',
      providerId: 'p',
      title: 'Pricing work',
      createdAt: Date.UTC(2026, 7, 6),
      lastUsedAt: Date.now(),
    };
    expect(continuedTitle(source, '이어서 — 가격 정책')).toBe('이어서 — 가격 정책');
    expect(continuedTitle(source, undefined)).toBe(`${CONTINUED_TITLE_PREFIX}Pricing work`);
    const untitled = { ...source, title: undefined };
    expect(continuedTitle(untitled, undefined)).toMatch(/^Continued — \d{4}-\d{2}-\d{2}$/);
  });
});

describe('continueSessionInNewTab', () => {
  it('stores the handoff on the NEW session and leaves the old one alone', async () => {
    const { store, sessionId } = seeded();
    const asked: RuntimeMessage[][] = [];
    const out = await continueSessionInNewTab(
      {
        store,
        summarize: async ({ messages }) => {
          asked.push([...messages]);
          return 'AGREED: ship on Friday.';
        },
      },
      { sessionId, cwd: '/tmp/project', title: '이어서 — Pricing work' },
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.handoff).toBe(true);
    expect(out.sessionId).not.toBe(sessionId);
    expect(out.title).toBe('이어서 — Pricing work');

    // The handoff is on the new row, readable exactly where the engine reads it.
    expect(store.getSession(out.sessionId)?.handoff).toBe('AGREED: ship on Friday.');
    // …and the SOURCE session is untouched: no handoff, and its transcript is
    // still only what was actually said (the summary turn left no trace).
    expect(store.getSession(sessionId)?.handoff).toBeUndefined();
    expect(store.getMessages(sessionId).length).toBe(2);
    expect(store.getMessages(out.sessionId).length).toBe(0);

    // The summarizer was asked about the conversation, not about nothing.
    expect(asked[0]?.length).toBe(2);
    // The new session is linked to the project it was continued in.
    expect(store.getSession(out.sessionId)?.cwd).toBe('/tmp/project');
  });

  it('still creates the session when the summary FAILS — the tab must open', async () => {
    const { store, sessionId } = seeded();
    const out = await continueSessionInNewTab(
      {
        store,
        summarize: async () => {
          throw new Error('provider is down');
        },
      },
      { sessionId },
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.sessionId).toBeTruthy();
    expect(out.handoff).toBe(false);
    expect(out.reason).toBe('summary-failed');
    expect(store.getSession(out.sessionId)).toBeDefined();
    expect(store.getSession(out.sessionId)?.handoff).toBeUndefined();
  });

  it('treats an EMPTY summary the same way — no empty block is ever injected', async () => {
    const { store, sessionId } = seeded();
    const out = await continueSessionInNewTab(
      { store, summarize: async () => '   ' },
      { sessionId },
    );
    expect(out.ok && out.handoff).toBe(false);
    if (!out.ok) return;
    expect(store.getSession(out.sessionId)?.handoff).toBeUndefined();
    expect(handoffInstruction(store.getSession(out.sessionId)?.handoff)).toBeUndefined();
  });

  it('does not call the summarizer for an empty conversation', async () => {
    const store = new MemoryStore();
    const { sessionId } = store.createSession('test-provider', 'Empty');
    let calls = 0;
    const out = await continueSessionInNewTab(
      {
        store,
        summarize: async () => {
          calls += 1;
          return 'should not happen';
        },
      },
      { sessionId },
    );
    expect(calls).toBe(0);
    expect(out.ok && out.reason).toBe('empty-source');
  });

  it('refuses only when there is no such session', async () => {
    const store = new MemoryStore();
    const out = await continueSessionInNewTab(
      { store, summarize: async () => 'x' },
      { sessionId: 'no-such-session' },
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/not found/);
  });

  it('records the name in both places a name can live', async () => {
    const { store, sessionId } = seeded();
    const titles: [string, string][] = [];
    const out = await continueSessionInNewTab(
      {
        store,
        summarize: async () => 'S',
        setCustomTitle: (id, title) => titles.push([id, title]),
      },
      { sessionId, title: '이어서 — Pricing work' },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // sessions.title (the project browser) …
    expect(store.getSession(out.sessionId)?.title).toBe('이어서 — Pricing work');
    // … and the custom-title setting (the Recent list and the tab bar).
    expect(titles).toEqual([[out.sessionId, '이어서 — Pricing work']]);
  });
});
