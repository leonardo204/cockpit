import { describe, it, expect } from 'vitest';
import { buildRecentSessions, statusKey, customTitleKey } from './recentSessions';
import type { RecentSessionsStore } from './recentSessions';
import { CLEARED_BEFORE_KEY } from './recentFilter';
import type { RuntimeMessage, SessionRef } from '../../../../../../../dist/naby-runtime.mjs';

/**
 * The two recent views — the sidebar dropdown and the maximized search panel —
 * differ in UI only. They used to differ in STORE too (state.json vs app.db),
 * and every bug in this area came from that: an empty panel beside a full
 * dropdown, an unread badge that would not clear. These tests pin the property
 * that replaced the syncing: one builder, one store, one answer.
 */

function session(over: Partial<SessionRef> = {}): SessionRef {
  return {
    sessionId: 's1',
    providerId: 'dev-claude',
    createdAt: 1_000,
    lastUsedAt: 2_000,
    ...over,
  } as SessionRef;
}

function userMsg(content: string): RuntimeMessage {
  return { role: 'user', content } as RuntimeMessage;
}

/** A store that answers from plain objects — the builder's whole contract. */
function fakeStore(
  sessions: SessionRef[],
  messages: Record<string, RuntimeMessage[]> = {},
  settings: Record<string, string> = {},
): RecentSessionsStore & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    listSessions: () => sessions,
    getMessages: (id: string) => {
      reads.push(id);
      return messages[id] ?? [];
    },
    getSetting: (key: string) => settings[key],
  };
}

describe('buildRecentSessions — the one source both recent views read', () => {
  it('gives the dropdown and the panel the same rows, differing only in the search corpus', () => {
    const store = fakeStore(
      [session({ sessionId: 'a', lastUsedAt: 9 }), session({ sessionId: 'b', lastUsedAt: 8 })],
      { a: [userMsg('first thing')], b: [userMsg('second thing')] },
    );

    const dropdown = buildRecentSessions({ limit: 15 }, store);
    const panel = buildRecentSessions({ limit: 100, includeSearchText: true }, store);

    // Same sessions, same order, same rendered fields.
    expect(dropdown.map((s) => s.sessionId)).toEqual(panel.map((s) => s.sessionId));
    expect(dropdown.map((s) => s.title)).toEqual(panel.map((s) => s.title));
    expect(dropdown.map((s) => s.lastUserMessage)).toEqual(panel.map((s) => s.lastUserMessage));
    expect(dropdown.map((s) => s.status)).toEqual(panel.map((s) => s.status));

    // The only difference is the corpus the dropdown never searches.
    expect(panel.every((s) => typeof s.searchText === 'string')).toBe(true);
    expect(dropdown.every((s) => s.searchText === undefined)).toBe(true);
  });

  it('takes status from the setting the engine writes, never from the lifecycle column', () => {
    // `SessionRef.status` is 'active' | 'ended' — a different vocabulary from the
    // 'loading' | 'unread' the views paint. Letting it through drew a dot that
    // meant nothing.
    const store = fakeStore([session({ sessionId: 'a', status: 'ended' } as Partial<SessionRef>)]);
    expect(buildRecentSessions(undefined, store)[0]!.status).toBe('normal');

    const running = fakeStore(
      [session({ sessionId: 'a', status: 'ended' } as Partial<SessionRef>)],
      {},
      { [statusKey('a')]: 'loading' },
    );
    expect(buildRecentSessions(undefined, running)[0]!.status).toBe('loading');
  });

  it('hides sessions at or before the "clear recents" watermark, in both views alike', () => {
    const store = fakeStore(
      [session({ sessionId: 'old', lastUsedAt: 100 }), session({ sessionId: 'new', lastUsedAt: 300 })],
      {},
      { [CLEARED_BEFORE_KEY]: '200' },
    );

    expect(buildRecentSessions({ limit: 15 }, store).map((s) => s.sessionId)).toEqual(['new']);
    expect(
      buildRecentSessions({ limit: 100, includeSearchText: true }, store).map((s) => s.sessionId),
    ).toEqual(['new']);
  });

  it('applies the limit before reading messages, so the dropdown does not pay for the tail', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      session({ sessionId: `s${i}`, lastUsedAt: 1_000 - i }),
    );
    const store = fakeStore(many);

    const rows = buildRecentSessions({ limit: 15 }, store);

    expect(rows).toHaveLength(15);
    // The expensive per-session read happened fifteen times, not forty.
    expect(store.reads).toHaveLength(15);
  });

  it('keeps a projectless session, and hands the client an empty cwd rather than dropping it', () => {
    // Skipping these was the bug that left the maximized panel empty.
    const store = fakeStore([session({ sessionId: 'a', cwd: undefined })], {
      a: [userMsg('no project here')],
    });
    const rows = buildRecentSessions(undefined, store);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.cwd).toBe('');
    expect(rows[0]!.sessionId).toBe('a');
  });

  it('prefers a user rename over the derived title', () => {
    const store = fakeStore(
      [session({ sessionId: 'a' })],
      { a: [userMsg('what the first message was')] },
      { [customTitleKey('a')]: 'My renamed session' },
    );
    expect(buildRecentSessions(undefined, store)[0]!.title).toBe('My renamed session');
  });
});
