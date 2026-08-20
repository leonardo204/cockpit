import { describe, it, expect, vi } from 'vitest';
import type { SessionRef } from '../../../../../../../dist/naby-runtime.mjs';
import {
  TELEGRAM_LINK_IDLE_MS,
  TELEGRAM_LINK_KEY,
  TELEGRAM_PROJECT_LIST_KEY,
  TELEGRAM_SESSION_LIST_KEY,
  chatRuntimeDeps,
  clearLink,
  extractRunAnswer,
  formatChatAnswer,
  handleChatUpdate,
  isLinkExpired,
  parseIndexArg,
  parseTelegramCommand,
  projectLabel,
  readLink,
  renderProjectList,
  repointLink,
  renderSessionList,
  resolveListPick,
  sessionTitle,
  writeLink,
  type ChatDeps,
  type TurnResult,
} from './telegramChat';
import { BOT_COMMANDS, STR } from './telegramChatStrings';
import type { TelegramUpdate } from './telegram';

// ---------------------------------------------------------------------------
// the parser (telegram-chat §2)
// ---------------------------------------------------------------------------

describe('telegramChat — command parsing', () => {
  it('reads every command in the set', () => {
    for (const name of ['sessions', 'use', 'new', 'projects', 'status', 'stop', 'start', 'help']) {
      expect(parseTelegramCommand(`/${name}`)).toEqual({ cmd: name, args: [] });
    }
  });

  it('keeps the arguments of /use 3', () => {
    expect(parseTelegramCommand('/use 3')).toEqual({ cmd: 'use', args: ['3'] });
    expect(parseIndexArg(['3'])).toBe(3);
    // Not a plain number: refused rather than guessed at.
    expect(parseIndexArg(['three'])).toBeUndefined();
    expect(parseIndexArg([])).toBeUndefined();
    expect(parseIndexArg(['0'])).toBeUndefined();
  });

  it('strips the @botname Telegram appends in group chats', () => {
    expect(parseTelegramCommand('/sessions@naby_bot')).toEqual({ cmd: 'sessions', args: [] });
  });

  it('is case-insensitive on the verb and tolerant of surrounding space', () => {
    expect(parseTelegramCommand('  /STATUS  ')).toEqual({ cmd: 'status', args: [] });
  });

  it('reports an unknown "/" verb instead of sending it to the model', () => {
    expect(parseTelegramCommand('/wat now')).toEqual({ cmd: 'unknown', name: 'wat', args: ['now'] });
  });

  it('leaves ordinary text alone — that is the conversation', () => {
    expect(parseTelegramCommand('세션 목록 보여줘')).toBeUndefined();
    expect(parseTelegramCommand('status')).toBeUndefined();
    expect(parseTelegramCommand('')).toBeUndefined();
    expect(parseTelegramCommand(undefined)).toBeUndefined();
    // A pasted absolute path starts with a slash and is NOT a command attempt —
    // answering it with a help hint would swallow the message.
    expect(parseTelegramCommand('/Users/me/x 이거 봐줘')).toBeUndefined();
    expect(parseTelegramCommand('/')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// link + list state (§2, §3)
// ---------------------------------------------------------------------------

describe('telegramChat — link state', () => {
  it('expires exactly at the idle window, judged on arrival', () => {
    const link = { sessionId: 's1', linkedAt: 0, lastActivityAt: 1000 };
    expect(isLinkExpired(link, 1000 + TELEGRAM_LINK_IDLE_MS - 1)).toBe(false);
    expect(isLinkExpired(link, 1000 + TELEGRAM_LINK_IDLE_MS)).toBe(true);
  });

  it('round-trips through the store and survives a corrupt value', () => {
    const store = fakeStore();
    expect(readLink(store)).toBeUndefined();
    writeLink(store, { sessionId: 's1', linkedAt: 5, lastActivityAt: 7 });
    expect(readLink(store)).toEqual({ sessionId: 's1', linkedAt: 5, lastActivityAt: 7 });
    clearLink(store);
    expect(readLink(store)).toBeUndefined();
    store.setSetting(TELEGRAM_LINK_KEY, '{not json');
    expect(readLink(store)).toBeUndefined();
  });

  // A session continued in a new tab takes the conversation with it. The phone
  // must follow, or replies land in the session the user just left (§2.2).
  it('repoints a link that names the CONTINUED session, keeping when it was made', () => {
    const store = fakeStore();
    writeLink(store, { sessionId: 'old', linkedAt: 5, lastActivityAt: 7 });
    expect(repointLink(store, 'old', 'new', 1234)).toBe(true);
    expect(readLink(store)).toEqual({ sessionId: 'new', linkedAt: 5, lastActivityAt: 1234 });
  });

  it('leaves a link that names some OTHER session alone', () => {
    const store = fakeStore();
    writeLink(store, { sessionId: 'other', linkedAt: 5, lastActivityAt: 7 });
    expect(repointLink(store, 'old', 'new', 1234)).toBe(false);
    expect(readLink(store)?.sessionId).toBe('other');
    // And with no link at all there is simply nothing to move.
    clearLink(store);
    expect(repointLink(store, 'old', 'new', 1234)).toBe(false);
    expect(readLink(store)).toBeUndefined();
  });
});

describe('telegramChat — list picks', () => {
  const stored = { ids: ['a', 'b', 'c'], epoch: 2 };

  it('resolves a number against the list that was shown', () => {
    expect(resolveListPick(stored, ['a', 'b', 'c'], 2)).toEqual({ ok: true, id: 'b' });
  });

  it('refuses a number when the list has moved since', () => {
    expect(resolveListPick(stored, ['c', 'a', 'b'], 2)).toEqual({ ok: false, reason: 'stale', max: 3 });
  });

  it('refuses a number nobody was shown, and one with no list at all', () => {
    expect(resolveListPick(stored, ['a', 'b', 'c'], 9)).toEqual({ ok: false, reason: 'range', max: 3 });
    expect(resolveListPick(undefined, ['a'], 1)).toEqual({ ok: false, reason: 'none', max: 1 });
  });
});

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

describe('telegramChat — rendering', () => {
  it('numbers the sessions with title, project and age', () => {
    const now = 10 * 60_000;
    const out = renderSessionList(
      [
        session('s1', { title: '리팩터링', cwd: '/Users/me/naby', lastUsedAt: now - 5 * 60_000 }),
        session('s2', { lastUsedAt: now }),
      ],
      now,
    );
    expect(out).toContain('1. 리팩터링 · naby · 5분 전');
    // No title and no project: still identifiable by a short id.
    expect(out).toContain('2. (제목 없음) s2');
    expect(out).toContain('방금');
    expect(out).toContain('/use N');
  });

  it('says so plainly when there is nothing to list', () => {
    expect(renderSessionList([], 0)).toContain('/new');
    expect(renderProjectList([])).toContain('프로젝트가 없다');
  });

  it('numbers projects with their path', () => {
    const out = renderProjectList([{ cwd: '/Users/me/naby' }, { cwd: '/tmp/x', title: '실험' }]);
    expect(out).toContain('1. naby — /Users/me/naby');
    expect(out).toContain('2. 실험 — /tmp/x');
  });

  it('labels a project by its directory name', () => {
    expect(projectLabel('/Users/me/naby')).toBe('naby');
    expect(projectLabel(undefined)).toBeUndefined();
  });

  it('titles an unnamed session by a short id', () => {
    expect(sessionTitle({ sessionId: 'abcdef123456', title: '  ' })).toBe('(제목 없음) abcdef12');
  });
});

// ---------------------------------------------------------------------------
// the answer, read back out of a finished run
// ---------------------------------------------------------------------------

describe('telegramChat — reading a run answer', () => {
  it('takes the LAST result event as the turn answer', () => {
    const answer = extractRunAnswer([
      { type: 'assistant' },
      { type: 'result', is_error: false, result: 'first step', duration_ms: 10 },
      { type: 'result', is_error: false, result: 'the answer', duration_ms: 4200, num_turns: 3 },
    ]);
    expect(answer).toEqual({ ok: true, text: 'the answer', durationMs: 4200, numTurns: 3 });
  });

  it('reports a failed run with its error', () => {
    const answer = extractRunAnswer([
      { type: 'error', error: 'model refused' },
      { type: 'result', is_error: true, result: '' },
    ]);
    expect(answer.ok).toBe(false);
    expect(answer.error).toBe('model refused');
  });

  it('does not claim success when the run produced no result at all', () => {
    expect(extractRunAnswer([]).ok).toBe(false);
  });

  it('truncates a huge answer to the report cap', () => {
    const out = formatChatAnswer({ ok: true, text: 'x'.repeat(5000) });
    expect(out.length).toBeLessThan(1400);
    expect(out).toContain('…');
  });
});

// ---------------------------------------------------------------------------
// the handler, over fake deps (§1, §4, §6)
// ---------------------------------------------------------------------------

const CHAT = { chatId: '4242' };

function session(sessionId: string, over: Partial<SessionRef> = {}): SessionRef {
  return {
    sessionId,
    providerId: 'naby',
    createdAt: 0,
    lastUsedAt: 0,
    ...over,
  } as SessionRef;
}

function fakeStore(seed?: {
  sessions?: SessionRef[];
  projects?: { cwd: string; title?: string }[];
  settings?: Record<string, string>;
}) {
  const settings = new Map(Object.entries(seed?.settings ?? {}));
  const sessions = [...(seed?.sessions ?? [])];
  const projects = [...(seed?.projects ?? [])];
  let minted = 0;
  return {
    getSetting: (k: string) => settings.get(k) || undefined,
    setSetting: (k: string, v: string) => void settings.set(k, v),
    listSessions: () => sessions,
    listProjects: () => projects,
    getSession: (id: string) => sessions.find((s) => s.sessionId === id),
    createSession: (providerId: string, title?: string, cwd?: string) => {
      minted += 1;
      const s = session(`new-${minted}`, {
        providerId,
        ...(title ? { title } : {}),
        ...(cwd ? { cwd } : {}),
      });
      sessions.unshift(s);
      return s;
    },
    deleteSession: (id: string) => {
      const i = sessions.findIndex((s) => s.sessionId === id);
      if (i >= 0) sessions.splice(i, 1);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

type Harness = {
  deps: ChatDeps;
  sent: string[];
  turns: { sessionId: string; text: string; cwd?: string }[];
  remembered: Map<number, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store: any;
};

function harness(opts?: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store?: any;
  now?: number;
  busy?: (sessionId: string) => boolean;
  turn?: (o: { sessionId: string; text: string; cwd?: string }) => Promise<TurnResult>;
  interimMs?: number;
  liveProgress?: boolean;
}): Harness {
  const sent: string[] = [];
  const turns: { sessionId: string; text: string; cwd?: string }[] = [];
  const remembered = new Map<number, string>();
  const store = opts?.store ?? fakeStore();
  let messageId = 100;
  const deps: ChatDeps = {
    store,
    send: async (text: string) => {
      sent.push(text);
      messageId += 1;
      return { ok: true as const, messageId };
    },
    runTurn: async (o) => {
      turns.push(o);
      return opts?.turn ? opts.turn(o) : { ok: true, text: '답변이다', durationMs: 1200, numTurns: 1 };
    },
    isBusy: opts?.busy ?? (() => false),
    rememberMessage: (id: number, sessionId: string) => void remembered.set(id, sessionId),
    sessionForMessage: (id: number) => remembered.get(id),
    now: () => opts?.now ?? 1_000_000,
    ...(opts?.interimMs !== undefined ? { interimMs: opts.interimMs } : {}),
    ...(opts?.liveProgress ? { liveProgress: true } : {}),
  };
  return { deps, sent, turns, remembered, store };
}

function incoming(text: string, over: Partial<NonNullable<TelegramUpdate['message']>> = {}): TelegramUpdate {
  return {
    update_id: 1,
    message: { message_id: 9, chat: { id: 4242 }, text, ...over },
  };
}

describe('telegramChat — chat_id is the only authentication (§6)', () => {
  it('ignores everything from a chat that is not the configured one', async () => {
    const h = harness();
    const out = await handleChatUpdate(
      h.deps,
      CHAT,
      { update_id: 1, message: { message_id: 1, chat: { id: 999 }, text: '/sessions' } },
    );
    expect(out).toEqual({ kind: 'ignored' });
    expect(h.sent).toHaveLength(0);
  });

  it('ignores an update that names no chat at all', async () => {
    const h = harness();
    expect(await handleChatUpdate(h.deps, CHAT, { update_id: 1, message: { text: 'hi' } })).toEqual({
      kind: 'ignored',
    });
    expect(h.sent).toHaveLength(0);
  });
});

describe('telegramChat — commands (§2)', () => {
  it('/help and /start answer with the usage', async () => {
    const h = harness();
    await handleChatUpdate(h.deps, CHAT, incoming('/start'));
    expect(h.sent[0]).toContain('/sessions');
    expect(h.sent[0]).toContain('/use N');
  });

  it('an unknown command points at /help instead of starting a turn', async () => {
    const h = harness();
    const out = await handleChatUpdate(h.deps, CHAT, incoming('/nope'));
    expect(out.kind).toBe('command');
    expect(h.sent[0]).toContain('/help');
    expect(h.turns).toHaveLength(0);
  });

  it('/sessions lists and /use N links the one that number named', async () => {
    const store = fakeStore({
      sessions: [session('s1', { title: 'A' }), session('s2', { title: 'B', cwd: '/x/proj' })],
    });
    const h = harness({ store });
    await handleChatUpdate(h.deps, CHAT, incoming('/sessions'));
    expect(h.sent[0]).toContain('1. A');
    // The ids behind the numbers are stored, so the number cannot drift.
    expect(JSON.parse(store.getSetting(TELEGRAM_SESSION_LIST_KEY)).ids).toEqual(['s1', 's2']);

    await handleChatUpdate(h.deps, CHAT, incoming('/use 2'));
    expect(h.sent[1]).toContain('연결했다');
    expect(h.sent[1]).toContain('B');
    expect(readLink(store)?.sessionId).toBe('s2');
  });

  it('/use without a number says which number, and out of range says the range', async () => {
    const store = fakeStore({ sessions: [session('s1', { title: 'A' })] });
    const h = harness({ store });
    await handleChatUpdate(h.deps, CHAT, incoming('/use'));
    expect(h.sent[0]).toContain('/use 2');
    await handleChatUpdate(h.deps, CHAT, incoming('/sessions'));
    await handleChatUpdate(h.deps, CHAT, incoming('/use 5'));
    expect(h.sent[2]).toContain('1~1');
  });

  it('/use against a list that has moved re-lists instead of linking the wrong session', async () => {
    const store = fakeStore({ sessions: [session('s1', { title: 'A' }), session('s2', { title: 'B' })] });
    const h = harness({ store });
    await handleChatUpdate(h.deps, CHAT, incoming('/sessions'));
    // Another session was used in the app: the order the user is looking at is
    // no longer the order the numbers mean.
    store.listSessions().unshift(session('s3', { title: 'C' }));
    await handleChatUpdate(h.deps, CHAT, incoming('/use 1'));
    expect(h.sent[1]).toContain('다시');
    expect(h.sent[1]).toContain('1. C');
    expect(readLink(store)).toBeUndefined();
    // The re-listed numbers are immediately usable.
    await handleChatUpdate(h.deps, CHAT, incoming('/use 1'));
    expect(readLink(store)?.sessionId).toBe('s3');
  });

  it('/projects lists and /new N opens a session in that project', async () => {
    const store = fakeStore({ projects: [{ cwd: '/a/one' }, { cwd: '/b/two' }] });
    const h = harness({ store });
    await handleChatUpdate(h.deps, CHAT, incoming('/projects'));
    expect(h.sent[0]).toContain('1. one — /a/one');
    expect(JSON.parse(store.getSetting(TELEGRAM_PROJECT_LIST_KEY)).ids).toEqual(['/a/one', '/b/two']);

    await handleChatUpdate(h.deps, CHAT, incoming('/new 2'));
    expect(h.sent[1]).toContain('새 세션');
    const linked = readLink(store)!;
    expect(store.getSession(linked.sessionId).cwd).toBe('/b/two');
  });

  it('/new with no argument takes the most recent project', async () => {
    const store = fakeStore({ projects: [{ cwd: '/a/one' }, { cwd: '/b/two' }] });
    const h = harness({ store });
    await handleChatUpdate(h.deps, CHAT, incoming('/new'));
    expect(store.getSession(readLink(store)!.sessionId).cwd).toBe('/a/one');
  });

  it('/status reports the link, its idle time and whether it is running', async () => {
    const store = fakeStore({ sessions: [session('s1', { title: 'A', cwd: '/x/proj' })] });
    const h = harness({ store, busy: () => true });
    writeLink(store, { sessionId: 's1', linkedAt: 0, lastActivityAt: 1_000_000 - 5 * 60_000 });
    await handleChatUpdate(h.deps, CHAT, incoming('/status'));
    expect(h.sent[0]).toContain('A');
    expect(h.sent[0]).toContain('proj');
    expect(h.sent[0]).toContain('5분 전');
    expect(h.sent[0]).toContain('작업 중');
  });

  it('/status with no link, and /stop, both say where to go next', async () => {
    const h = harness();
    await handleChatUpdate(h.deps, CHAT, incoming('/status'));
    expect(h.sent[0]).toContain('/use N');
    await handleChatUpdate(h.deps, CHAT, incoming('/stop'));
    expect(h.sent[1]).toContain('해제');
  });

  it('/stop unlinks so plain text stops being a turn', async () => {
    const store = fakeStore({ sessions: [session('s1')] });
    const h = harness({ store });
    writeLink(store, { sessionId: 's1', linkedAt: 0, lastActivityAt: 1_000_000 });
    await handleChatUpdate(h.deps, CHAT, incoming('/stop'));
    await handleChatUpdate(h.deps, CHAT, incoming('안녕'));
    expect(h.turns).toHaveLength(0);
    expect(h.sent[1]).toContain('연결된 세션이 없다');
  });
});

describe('telegramChat — plain text is a turn (§4)', () => {
  function linked(over?: Partial<SessionRef>) {
    const store = fakeStore({ sessions: [session('s1', { cwd: '/x/proj', ...over })] });
    writeLink(store, { sessionId: 's1', linkedAt: 0, lastActivityAt: 1_000_000 });
    return store;
  }

  it('runs the message verbatim on the linked session and sends the answer back', async () => {
    const store = linked();
    const h = harness({ store });
    const out = await handleChatUpdate(h.deps, CHAT, incoming('테스트 좀 돌려줘'));
    expect(out.kind).toBe('turn');
    // `project` rides along so the progress reporter can name it without a
    // second store read (§0).
    expect(h.turns).toEqual([
      { sessionId: 's1', cwd: '/x/proj', text: '테스트 좀 돌려줘', project: 'proj' },
    ]);
    expect(h.sent[0]).toContain('답변이다');
    // The answer is now a reply target for §1.3 routing.
    expect([...h.remembered.values()]).toEqual(['s1']);
  });

  it('reports a failed turn rather than going quiet', async () => {
    const h = harness({ store: linked(), turn: async () => ({ ok: false, error: '모델이 거절했다' }) });
    await handleChatUpdate(h.deps, CHAT, incoming('해줘'));
    expect(h.sent[0]).toContain('⚠️');
    expect(h.sent[0]).toContain('모델이 거절했다');
  });

  it('sends ONE interim message when the turn outlives the window', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({
      store: linked(),
      interimMs: 5,
      turn: async () => {
        await gate;
        return { ok: true, text: '끝' };
      },
    });
    const running = handleChatUpdate(h.deps, CHAT, incoming('오래 걸리는 일'));
    await vi.waitFor(() => expect(h.sent.some((t) => t.includes('작업 중'))).toBe(true));
    release();
    await running;
    expect(h.sent.filter((t) => t.includes('작업 중'))).toHaveLength(1);
    expect(h.sent.some((t) => t.includes('끝'))).toBe(true);
  });

  it('does not send the interim message for a turn that finishes first', async () => {
    const h = harness({ store: linked(), interimMs: 60_000 });
    await handleChatUpdate(h.deps, CHAT, incoming('빠른 일'));
    expect(h.sent.some((t) => t.includes('작업 중'))).toBe(false);
  });

  it('refuses to queue onto a session that is already running (§4)', async () => {
    const h = harness({ store: linked(), busy: () => true });
    const out = await handleChatUpdate(h.deps, CHAT, incoming('또 하나'));
    expect(out.kind).toBe('notice');
    expect(h.turns).toHaveLength(0);
    expect(h.sent[0]).toContain('작업 중');
  });

  it('answers an expired link with the notice and forgets it (§3)', async () => {
    const store = linked();
    writeLink(store, { sessionId: 's1', linkedAt: 0, lastActivityAt: 1_000_000 - TELEGRAM_LINK_IDLE_MS });
    const h = harness({ store });
    await handleChatUpdate(h.deps, CHAT, incoming('계속하자'));
    expect(h.sent[0]).toContain('오래되어');
    expect(readLink(store)).toBeUndefined();
    expect(h.turns).toHaveLength(0);
  });

  it('answers a deleted session with the notice and unlinks (§3)', async () => {
    const store = linked();
    store.deleteSession('s1');
    const h = harness({ store });
    await handleChatUpdate(h.deps, CHAT, incoming('있나?'));
    expect(h.sent[0]).toContain('사라졌다');
    expect(readLink(store)).toBeUndefined();
    expect(h.turns).toHaveLength(0);
  });

  it('keeps the link alive across a long turn (the turn IS activity)', async () => {
    const store = linked();
    writeLink(store, { sessionId: 's1', linkedAt: 0, lastActivityAt: 1 });
    const h = harness({ store });
    await handleChatUpdate(h.deps, CHAT, incoming('해줘'));
    expect(readLink(store)?.lastActivityAt).toBe(1_000_000);
  });

  it('says it takes text only when a photo arrives (§8)', async () => {
    const h = harness({ store: linked() });
    await handleChatUpdate(h.deps, CHAT, {
      update_id: 3,
      message: { message_id: 4, chat: { id: 4242 }, photo: [{}] },
    });
    expect(h.sent[0]).toContain('텍스트만');
    expect(h.turns).toHaveLength(0);
  });
});

describe('telegramChat — reply routing (§1.3)', () => {
  it('a reply to a bot message goes to that message’s session, not the linked one', async () => {
    const store = fakeStore({ sessions: [session('s1'), session('s2')] });
    writeLink(store, { sessionId: 's1', linkedAt: 0, lastActivityAt: 1_000_000 });
    const h = harness({ store });
    h.remembered.set(555, 's2');
    await handleChatUpdate(h.deps, CHAT, incoming('여기 이어서', { reply_to_message: { message_id: 555 } }));
    expect(h.turns.map((t) => t.sessionId)).toEqual(['s2']);
    // The link is untouched: the reply was a detour, not a re-link.
    expect(readLink(store)?.sessionId).toBe('s1');
  });

  it('falls back to the linked session when the replied-to message is forgotten', async () => {
    const store = fakeStore({ sessions: [session('s1')] });
    writeLink(store, { sessionId: 's1', linkedAt: 0, lastActivityAt: 1_000_000 });
    const h = harness({ store });
    await handleChatUpdate(h.deps, CHAT, incoming('이거 계속', { reply_to_message: { message_id: 1 } }));
    expect(h.turns.map((t) => t.sessionId)).toEqual(['s1']);
  });

  it('tells the user when the replied-to session is gone', async () => {
    const store = fakeStore({ sessions: [] });
    const h = harness({ store });
    h.remembered.set(7, 'deleted');
    await handleChatUpdate(h.deps, CHAT, incoming('계속', { reply_to_message: { message_id: 7 } }));
    expect(h.sent[0]).toContain('사라졌다');
    expect(h.turns).toHaveLength(0);
  });
});

describe('telegramChat — the command menu', () => {
  it('registers exactly the commands the spec lists', () => {
    expect(BOT_COMMANDS.map((c) => c.command)).toEqual([
      'sessions',
      'use',
      'new',
      'projects',
      'status',
      'stop',
      'help',
    ]);
    // Every one of them is a command the parser actually accepts.
    for (const c of BOT_COMMANDS) expect(parseTelegramCommand(`/${c.command}`)).toBeDefined();
  });
});

describe('telegramChat — the production deps', () => {
  it('exposes a busy check and a turn runner over the real engine seam', async () => {
    const deps = await chatRuntimeDeps();
    expect(typeof deps.isBusy).toBe('function');
    expect(typeof deps.runTurn).toBe('function');
    // Nothing is running in a fresh test process.
    expect(deps.isBusy('nobody')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// every answer names its project (telegram-chat §0)
// ---------------------------------------------------------------------------

describe('telegramChat — the project line', () => {
  it('opens the chat answer with the project', () => {
    const answer = formatChatAnswer({ ok: true, text: '끝났다' }, 'naby');
    expect(answer.split('\n')[0]).toBe('📁 naby');
  });

  it('prints the no-project marker rather than a gap', () => {
    expect(formatChatAnswer({ ok: true, text: '끝' }, '').split('\n')[0]).toBe(`📁 ${STR.noProject}`);
  });

  it('leaves the line off when no project was resolved at all', () => {
    expect(formatChatAnswer({ ok: true, text: '끝' }).split('\n')[0]).toContain('✅');
  });

  it('names the project in the answer to a linked-session turn', async () => {
    const store = fakeStore({
      sessions: [session('s1', { cwd: '/Users/me/work/naby', lastUsedAt: 1_000_000 })],
    });
    writeLink(store, { sessionId: 's1', linkedAt: 0, lastActivityAt: 1_000_000 });
    const h = harness({ store });
    await handleChatUpdate(h.deps, CHAT, incoming('해줘'));
    expect(h.sent[0]!.split('\n')[0]).toBe('📁 naby');
  });

  it('lets a title the user set beat the folder name, in the answer and in /use', async () => {
    const store = fakeStore({
      sessions: [session('s1', { cwd: '/Users/me/work/dash-v2', lastUsedAt: 1_000_000 })],
      projects: [{ cwd: '/Users/me/work/dash-v2', title: '고객 대시보드' }],
    });
    writeLink(store, { sessionId: 's1', linkedAt: 0, lastActivityAt: 1_000_000 });
    const h = harness({ store });
    await handleChatUpdate(h.deps, CHAT, incoming('/sessions'));
    expect(h.sent[0]).toContain('고객 대시보드');
    await handleChatUpdate(h.deps, CHAT, incoming('/use 1'));
    expect(h.sent[1]).toContain('고객 대시보드');
    await handleChatUpdate(h.deps, CHAT, incoming('/status'));
    expect(h.sent[2]).toContain('고객 대시보드');
    await handleChatUpdate(h.deps, CHAT, incoming('해줘'));
    expect(h.sent[3]!.split('\n')[0]).toBe('📁 고객 대시보드');
  });

  it('marks a session with no directory as having no project', async () => {
    const store = fakeStore({ sessions: [session('s1', { lastUsedAt: 1_000_000 })] });
    writeLink(store, { sessionId: 's1', linkedAt: 0, lastActivityAt: 1_000_000 });
    const h = harness({ store });
    await handleChatUpdate(h.deps, CHAT, incoming('해줘'));
    expect(h.sent[0]!.split('\n')[0]).toBe(`📁 ${STR.noProject}`);
  });

  it('falls back to the folder name in a list when nobody renamed the project', () => {
    const list = renderSessionList([session('s1', { cwd: '/Users/me/work/naby', lastUsedAt: 0 })], 0);
    expect(list).toContain('naby');
  });
});

describe('telegramChat — live progress replaces the one-shot interim (§4.1)', () => {
  it('sends no "작업 중" message when the turn reports itself live', async () => {
    const store = fakeStore({ sessions: [session('s1', { lastUsedAt: 1_000_000 })] });
    writeLink(store, { sessionId: 's1', linkedAt: 0, lastActivityAt: 1_000_000 });
    const h = harness({
      store,
      liveProgress: true,
      interimMs: 1,
      turn: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { ok: true, text: '끝' };
      },
    });
    await handleChatUpdate(h.deps, CHAT, incoming('해줘'));
    expect(h.sent.some((t) => t === STR.working)).toBe(false);
  });

  it('still sends it when there is no live channel (regression)', async () => {
    const store = fakeStore({ sessions: [session('s1', { lastUsedAt: 1_000_000 })] });
    writeLink(store, { sessionId: 's1', linkedAt: 0, lastActivityAt: 1_000_000 });
    const h = harness({
      store,
      interimMs: 1,
      turn: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { ok: true, text: '끝' };
      },
    });
    await handleChatUpdate(h.deps, CHAT, incoming('해줘'));
    expect(h.sent.some((t) => t === STR.working)).toBe(true);
  });
});
