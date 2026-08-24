import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SESSION_NAME_ANIMALS, defaultSessionName } from '@cockpit/shared-utils';
import { deriveTitle, userTexts } from './nabyBrowse';
import { buildRecentSessions, customTitleKey } from '../../state/recentSessions';
import type { RecentSessionsStore } from '../../state/recentSessions';
import { sessionTitle } from '../../lib/telegramChat';
import type { RuntimeMessage, SessionRef } from '../../../../../../../../dist/naby-runtime.mjs';

/**
 * THE THREE STAGES OF A SESSION'S NAME.
 *
 *   1. A new, EMPTY session is called `MMDD-HHmm-animal` — a placeholder, so
 *      that a session nobody has named is still something a person can read,
 *      say and tell apart from the next one.
 *   2. The moment it has a conversation, the conversation names it. The
 *      placeholder is not sticky, because it was never stored.
 *   3. A name the user gave outranks both, forever.
 *
 * The bug these replace is the placeholder LEAKING THE IDENTITY: `Untitled
 * Session` for every one of them at once, or a slice of `s-mt167djb-1-1jijoi7t`.
 */

// A local wall-clock moment, so the assertion does not depend on the runner's
// timezone (the name is formatted in the reader's own).
const CREATED_AT = new Date(2026, 7, 24, 15, 30).getTime();

function session(over: Partial<SessionRef> = {}): SessionRef {
  return {
    sessionId: 's-mt167djb-1-1jijoi7t',
    providerId: '',
    createdAt: CREATED_AT,
    lastUsedAt: CREATED_AT,
    ...over,
  } as SessionRef;
}

function userMsg(content: string): RuntimeMessage {
  return { role: 'user', content } as RuntimeMessage;
}

function fakeStore(
  sessions: SessionRef[],
  messages: Record<string, RuntimeMessage[]> = {},
  settings: Record<string, string> = {},
): RecentSessionsStore {
  return {
    listSessions: () => sessions,
    getMessages: (id: string) => messages[id] ?? [],
    getSetting: (key: string) => settings[key],
  };
}

describe('stage 1 — a new, empty session', () => {
  it('is named date, time, animal, and never after its id', () => {
    const name = deriveTitle(session(), []);
    expect(name).toBe(`0824-1530-${name.split('-')[2]}`);
    expect(name).not.toContain('mt167djb');
    expect(name).not.toContain('Untitled');
  });

  it('takes its animal from the published list', () => {
    const name = deriveTitle(session(), []);
    expect(SESSION_NAME_ANIMALS as readonly string[]).toContain(name.split('-')[2]);
  });

  it('is the same string the tab, the lists and Telegram would each produce', () => {
    // None of these asks the others. They agree because all three are the same
    // pure function of the same two facts on the session row.
    const ref = session();
    const expected = defaultSessionName(ref.sessionId, ref.createdAt);
    expect(deriveTitle(ref, [])).toBe(expected);
    expect(sessionTitle(ref)).toBe(expected);
    expect(buildRecentSessions(undefined, fakeStore([ref]))[0]!.title).toBe(expected);
  });

  it('two sessions minted in the same minute both get a name and neither throws', () => {
    const a = session({ sessionId: 's-aaa-1-aaa' });
    const b = session({ sessionId: 's-bbb-2-bbb' });
    expect(deriveTitle(a, [])).toMatch(/^0824-1530-[a-z]+$/);
    expect(deriveTitle(b, [])).toMatch(/^0824-1530-[a-z]+$/);
  });
});

describe('stage 2 — the conversation takes over', () => {
  it('the first user message replaces the default name', () => {
    const ref = session();
    expect(deriveTitle(ref, ['리팩터링 좀 도와줘'])).toBe('리팩터링 좀 도와줘');
    expect(deriveTitle(ref, ['리팩터링 좀 도와줘'])).not.toMatch(/^0824-1530-/);
  });

  it('and it does so in the recent list too, from the same builder', () => {
    const ref = session({ sessionId: 'a' });
    const rows = buildRecentSessions(undefined, fakeStore([ref], { a: [userMsg('첫 질문')] }));
    expect(rows[0]!.title).toBe('첫 질문');
  });

  it('a long first message is clipped, not replaced by the default', () => {
    const long = 'x'.repeat(200);
    const title = deriveTitle(session(), [long]);
    expect(title.endsWith('...')).toBe(true);
    expect(title).not.toMatch(/-[a-z]+$/);
  });
});

describe('stage 3 — the name the user gave', () => {
  it('a stored title outranks both the conversation and the default', () => {
    const ref = session({ title: '내가 붙인 이름' });
    expect(deriveTitle(ref, ['첫 질문'])).toBe('내가 붙인 이름');
    expect(deriveTitle(ref, [])).toBe('내가 붙인 이름');
  });

  it('a rename outranks the default in the recent list', () => {
    const ref = session({ sessionId: 'a' });
    const rows = buildRecentSessions(
      undefined,
      fakeStore([ref], {}, { [customTitleKey('a')]: '내가 붙인 이름' }),
    );
    expect(rows[0]!.title).toBe('내가 붙인 이름');
  });

  it('whitespace is not a name, so it still falls through to the default', () => {
    expect(deriveTitle(session({ title: '   ' }), [])).toMatch(/^0824-1530-[a-z]+$/);
  });
});

describe('the default name is a placeholder, not a stored label', () => {
  const SESSIONS_DIR = __dirname;
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const code = (path: string) => stripComments(readFileSync(path, 'utf8'));

  it('is never written back to the store by the module that derives it', () => {
    // If it were persisted to `sessions.title`, stage 2 could never happen:
    // `deriveTitle` prefers a stored title over the first message, so the animal
    // name would outlive the conversation it was standing in for.
    const src = code(join(SESSIONS_DIR, 'nabyBrowse.ts'));
    expect(src).not.toContain('setSetting');
    expect(src).not.toContain('createSession');
    expect(src).not.toContain('setSessionTitle');
  });

  it('Telegram /new still mints an UNTITLED session and only renders the name', () => {
    const tg = code(join(SESSIONS_DIR, '..', '..', 'lib', 'telegramChat.ts'));
    expect(tg).toContain("createSession('', undefined, cwd)");
    expect(tg).not.toContain('defaultSessionName(session');
  });

  it('leaves existing sessions alone — nothing here renames history', () => {
    // The whole feature is one fallback expression. A migration that relabelled
    // old rows would overwrite titles people rely on.
    const src = code(join(SESSIONS_DIR, 'nabyBrowse.ts'));
    expect(src.match(/defaultSessionName/g)?.length).toBe(2); // the import + the one use
  });

  it('userTexts still feeds the derivation, so stage 2 has something to read', () => {
    expect(userTexts([userMsg('첫 질문'), { role: 'assistant', content: 'ok' } as RuntimeMessage])).toEqual([
      '첫 질문',
    ]);
  });
});
