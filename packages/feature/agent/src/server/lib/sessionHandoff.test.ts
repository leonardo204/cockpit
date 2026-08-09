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
  sessionPlanModeKey,
  type HandoffStore,
} from './sessionHandoff';
// The prompt lives next door; importing it here costs nothing, because every
// model-reaching import inside it is dynamic.
import { HANDOFF_SUMMARY_SYSTEM } from './handoffSummary';
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

function seeded(cwd?: string): { store: HandoffStore & MemoryStore; sessionId: string } {
  const store = new MemoryStore();
  const { sessionId } = store.createSession('test-provider', 'Pricing work', cwd);
  store.appendMessage(sessionId, { role: 'user', content: 'we agreed to ship on Friday' });
  store.appendMessage(sessionId, { role: 'assistant', content: 'noted' });
  return { store, sessionId };
}

/**
 * The same store with ONE method replaced by a thrower.
 *
 * Written out rather than proxied: the point of these cases is that a single
 * broken store call is survivable, so the test says exactly which call breaks and
 * leaves every other one real.
 */
function storeWhereMemoryReadFails(store: HandoffStore & MemoryStore): HandoffStore {
  return {
    getSession: (id) => store.getSession(id),
    getMessages: (id) => store.getMessages(id),
    createSession: (providerId, title, cwd) => store.createSession(providerId, title, cwd),
    setSessionHandoff: (id, handoff) => store.setSessionHandoff(id, handoff),
    setSetting: (key, value) => store.setSetting(key, value),
    getSetting: (key) => store.getSetting(key),
    setSessionNoLearn: (id, noLearn) => store.setSessionNoLearn(id, noLearn),
    getAllMemory: () => {
      throw new Error('the memory table is locked');
    },
    setMemory: (id, key, value) => store.setMemory(id, key, value),
  };
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

/**
 * THE ENVIRONMENT CARRY.
 *
 * A continuation is only "the same conversation somewhere else" if the things
 * that were true of the SESSION are true of the new one. Each case below is a
 * thing that was silently lost before, and every one of them is also forgiving:
 * a carry that throws still leaves the user with the tab they clicked for.
 */
describe('continueSessionInNewTab — the session-scoped environment', () => {
  it('falls back to the SOURCE project when the caller names none, and answers with it', async () => {
    const { store, sessionId } = seeded('/tmp/pricing');
    const out = await continueSessionInNewTab(
      { store, summarize: async () => 'S' },
      { sessionId },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The new row is linked to the same project …
    expect(store.getSession(out.sessionId)?.cwd).toBe('/tmp/pricing');
    // … and the caller is TOLD, because a tab with no cwd of its own has nothing
    // else to navigate with.
    expect(out.cwd).toBe('/tmp/pricing');
  });

  it('prefers the project the caller asked for over the source one', async () => {
    const { store, sessionId } = seeded('/tmp/pricing');
    const out = await continueSessionInNewTab(
      { store, summarize: async () => 'S' },
      { sessionId, cwd: '/tmp/elsewhere' },
    );
    expect(out.ok && out.cwd).toBe('/tmp/elsewhere');
    if (!out.ok) return;
    expect(store.getSession(out.sessionId)?.cwd).toBe('/tmp/elsewhere');
  });

  it('carries the TEMPORARY mark, so a no-learn conversation cannot become a learning one', async () => {
    const { store, sessionId } = seeded();
    store.setSessionNoLearn(sessionId, true);
    const out = await continueSessionInNewTab(
      { store, summarize: async () => 'S' },
      { sessionId },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(store.getSession(out.sessionId)?.noLearn).toBe(true);
    expect(out.carried.noLearn).toBe(true);
  });

  it('leaves an ordinary conversation ordinary', async () => {
    const { store, sessionId } = seeded();
    const out = await continueSessionInNewTab(
      { store, summarize: async () => 'S' },
      { sessionId },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(store.getSession(out.sessionId)?.noLearn).toBeFalsy();
    expect(out.carried.noLearn).toBe(false);
  });

  it('copies the session-scoped memory rows onto the new session', async () => {
    const { store, sessionId } = seeded();
    store.setMemory(sessionId, 'release.date', 'Friday');
    store.setMemory(sessionId, 'release.owner', '지수');
    const out = await continueSessionInNewTab(
      { store, summarize: async () => 'S' },
      { sessionId },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(store.getAllMemory(out.sessionId)).toEqual({
      'release.date': 'Friday',
      'release.owner': '지수',
    });
    expect(out.carried.memoryKeys).toBe(2);
    // The source keeps its own rows — this is a copy, not a move.
    expect(store.getAllMemory(sessionId)['release.date']).toBe('Friday');
  });

  it('a memory copy that THROWS does not fail the continuation', async () => {
    const { store, sessionId } = seeded();
    const out = await continueSessionInNewTab(
      { store: storeWhereMemoryReadFails(store), summarize: async () => 'S' },
      { sessionId },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The tab opens, with its handoff, and the failure is recorded rather than raised.
    expect(store.getSession(out.sessionId)?.handoff).toBe('S');
    expect(out.carried.memoryKeys).toBe(0);
    expect(out.carried.failed).toContain('memory');
  });

  it('carries PLAN MODE, under the key /api/project-state reads', async () => {
    const { store, sessionId } = seeded();
    store.setSetting(sessionPlanModeKey(sessionId), 'true');
    const out = await continueSessionInNewTab(
      { store, summarize: async () => 'S' },
      { sessionId },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(store.getSetting(sessionPlanModeKey(out.sessionId))).toBe('true');
    expect(out.carried.planMode).toBe(true);
  });

  it('does not invent plan mode for a session that was not in it', async () => {
    const { store, sessionId } = seeded();
    const out = await continueSessionInNewTab(
      { store, summarize: async () => 'S' },
      { sessionId },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(store.getSetting(sessionPlanModeKey(out.sessionId))).toBeFalsy();
    expect(out.carried.planMode).toBe(false);
  });

  it('hands both rebind seams the old id and the new one', async () => {
    const { store, sessionId } = seeded();
    const telegram: [string, string][] = [];
    const scheduled: [string, string][] = [];
    const out = await continueSessionInNewTab(
      {
        store,
        summarize: async () => 'S',
        rebindTelegramLink: (from, to) => void telegram.push([from, to]),
        rebindScheduledTasks: async (from, to) => void scheduled.push([from, to]),
      },
      { sessionId },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(telegram).toEqual([[sessionId, out.sessionId]]);
    expect(scheduled).toEqual([[sessionId, out.sessionId]]);
  });

  it('a rebind that throws is recorded, not raised — the tab still opens', async () => {
    const { store, sessionId } = seeded();
    const out = await continueSessionInNewTab(
      {
        store,
        summarize: async () => 'S',
        rebindTelegramLink: () => {
          throw new Error('no bot configured');
        },
        rebindScheduledTasks: async () => {
          throw new Error('task file is unreadable');
        },
      },
      { sessionId },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.carried.failed).toEqual(['telegram', 'scheduled-tasks']);
    expect(store.getSession(out.sessionId)?.handoff).toBe('S');
  });

  it('does NOT carry the things that belong to the old session alone', async () => {
    const { store, sessionId } = seeded();
    store.setSessionPinned(sessionId, true);
    store.setSessionFastGrowth(sessionId, true);
    const out = await continueSessionInNewTab(
      { store, summarize: async () => 'S' },
      { sessionId },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const ref = store.getSession(out.sessionId)!;
    // Pinning is a gesture on ONE conversation, and a drill has its own kickoff
    // lifecycle — inheriting either would be the continuation claiming something
    // the user never gave it.
    expect(ref.pinnedAt).toBeFalsy();
    expect(ref.fastGrowth).toBeFalsy();
    // And nothing derived from a transcript follows an empty one.
    expect(store.getMessages(out.sessionId)).toEqual([]);
  });
});

describe('the handoff prompt', () => {
  it('asks for the WORKING ENVIRONMENT, not only what was decided', () => {
    // Without this the continuation knows what was agreed but not where it was
    // being done, and reaches for a different branch/service than the sitting it
    // continues.
    expect(HANDOFF_SUMMARY_SYSTEM).toMatch(/tools, services, files and branches/i);
    expect(HANDOFF_SUMMARY_SYSTEM).toMatch(/reaches for the same ones/i);
    // The instruction that keeps a handoff from restating general memory stays.
    expect(HANDOFF_SUMMARY_SYSTEM).toMatch(/do NOT restate general facts/);
  });
});
