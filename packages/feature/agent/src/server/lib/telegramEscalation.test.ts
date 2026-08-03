import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  truncate,
  formatApprovalMessage,
  formatCheckinMessage,
  escalateCheckin,
  finishCheckinEscalation,
  formatFinalReport,
  interpretUpdate,
  pickTextReplyTarget,
  telegramDecision,
  escalateApproval,
  finishEscalation,
  pendingEscalations,
  ensureListener,
  pauseTelegramListener,
  rememberChatMessage,
  resetBotCommandRegistration,
  resumeTelegramListener,
  sendFinalReport,
  sessionForChatMessage,
  stopTelegramListener,
  telegramListenerRunning,
  TELEGRAM_OFFSET_KEY,
} from './telegramEscalation';
import { registerApproval, hasPendingApproval } from './approvalRegistry';
import { registerCheckin, hasPendingCheckin } from './checkinRegistry';
import type { TelegramUpdate } from './telegram';

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe('telegramEscalation — message formatting (P3-M3b)', () => {
  it('truncates only when over the limit', () => {
    expect(truncate('abc', 5)).toBe('abc');
    expect(truncate('abcdef', 3)).toBe('abc…');
  });

  it('names the agent, the tool and the input in the approval message', () => {
    const msg = formatApprovalMessage({
      toolName: 'Bash',
      input: { command: 'rm -rf build' },
      agentName: 'nabi',
      cwd: '/tmp/x',
    });
    expect(msg).toContain('@nabi');
    expect(msg).toContain('Bash');
    expect(msg).toContain('rm -rf build');
    expect(msg).toContain('/tmp/x');
    expect(msg.toLowerCase()).toContain('reply yes');
  });

  it('omits the input block when there is nothing to show', () => {
    const msg = formatApprovalMessage({ toolName: 'Read', input: {} });
    expect(msg).toContain('Read');
    expect(msg).not.toContain('{}');
  });

  it('caps a huge input instead of sending a wall of JSON', () => {
    const msg = formatApprovalMessage({ toolName: 'Write', input: { body: 'x'.repeat(5000) } });
    expect(msg.length).toBeLessThan(700);
    expect(msg).toContain('…');
  });

  it('numbers the check-in options so a button and a bare reply mean the same thing', () => {
    const msg = formatCheckinMessage({
      question: 'Migrate the column, or add a new one?',
      options: ['migrate in place', 'add a new column'],
      agentName: 'nabi',
      cwd: '/repo',
    });
    expect(msg).toContain('@nabi');
    expect(msg).toContain('Migrate the column');
    expect(msg).toContain('1. migrate in place');
    expect(msg).toContain('2. add a new column');
    expect(msg).toContain('/repo');
    // THE RECOMMENDATION IS ABSENT ON PURPOSE. The in-app prompt hides it until
    // after the answer so the meter measures knowledge rather than how agreeable
    // the UI is; leaking it to a phone would reopen that hole where the user is
    // least able to think it over.
    expect(msg.toLowerCase()).not.toContain('recommend');
  });

  it('reports success with the answer, failure with the error', () => {
    const ok = formatFinalReport({ ok: true, text: 'all done', agentName: 'nabi', durationMs: 4200, numTurns: 3 });
    expect(ok).toContain('✅');
    expect(ok).toContain('@nabi');
    expect(ok).toContain('all done');
    expect(ok).toContain('4s');
    expect(ok).toContain('3 turns');

    const bad = formatFinalReport({ ok: false, error: 'model refused', text: 'partial' });
    expect(bad).toContain('⚠️');
    expect(bad).toContain('model refused');
    expect(bad).not.toContain('partial');
  });

  it('reports the autonomous step spend and why the loop ended (P3-M3c)', () => {
    // Ran out of budget — the reason belongs in the header, it changes what the
    // user should do next.
    const capped = formatFinalReport({ ok: true, text: 'progress', steps: 5, stepsMax: 5, stopReason: 'max-steps' });
    expect(capped).toContain('5/5 steps');
    expect(capped).toContain('max-steps');
    // Finished on its own: the step count is informative, the reason is not.
    const done = formatFinalReport({ ok: true, text: 'done', steps: 2, stepsMax: 5, stopReason: 'done-marker' });
    expect(done).toContain('2/5 steps');
    expect(done).not.toContain('done-marker');
    // A single-turn run reports no steps at all (autonomy off).
    expect(formatFinalReport({ ok: true, text: 'hi', numTurns: 1 })).not.toContain('steps');
  });
});

describe('telegramEscalation — update interpretation', () => {
  // The bridge resolves a short ref to the id it names; an unknown ref is a stale
  // or foreign button, which the caller acknowledges rather than acts on.
  const ctx = { idForRef: (r: string) => (r === 'r1' ? 'sess:tc1' : undefined), pendingOptionCount: 0 };
  const withOptions = { ...ctx, pendingOptionCount: 3 };

  it('reads one of our approval buttons as a decision for its approval', () => {
    const u: TelegramUpdate = {
      update_id: 5,
      callback_query: { id: 'cq1', data: 'nbapv:allow:r1' },
    };
    expect(interpretUpdate(u, ctx)).toEqual({
      kind: 'approvalCallback',
      callbackQueryId: 'cq1',
      id: 'sess:tc1',
      decision: 'allow',
    });
  });

  it('still surfaces a button whose question is no longer pending, without an id', () => {
    const u: TelegramUpdate = {
      update_id: 6,
      callback_query: { id: 'cq2', data: 'nbapv:deny:rgone' },
    };
    const seen = interpretUpdate(u, ctx);
    expect(seen).toEqual({ kind: 'approvalCallback', callbackQueryId: 'cq2', decision: 'deny' });
  });

  it('reads a check-in button as an option index', () => {
    const u: TelegramUpdate = { update_id: 12, callback_query: { id: 'cq3', data: 'nbchk:1:r1' } };
    expect(interpretUpdate(u, ctx)).toEqual({
      kind: 'checkinCallback',
      callbackQueryId: 'cq3',
      id: 'sess:tc1',
      chosen: 1,
    });
  });

  it('ignores a foreign callback and ordinary chatter', () => {
    expect(interpretUpdate({ update_id: 7, callback_query: { id: 'x', data: 'other:allow:a' } }, ctx)).toBeUndefined();
    expect(interpretUpdate({ update_id: 8, message: { text: 'what is up' } }, ctx)).toBeUndefined();
    expect(interpretUpdate({ update_id: 9 }, ctx)).toBeUndefined();
  });

  it('reads a bare yes/no reply as an approval decision', () => {
    expect(interpretUpdate({ update_id: 10, message: { text: '승인' } }, ctx)).toEqual({
      kind: 'approvalText',
      decision: 'allow',
    });
    expect(interpretUpdate({ update_id: 11, message: { text: 'no' } }, ctx)).toEqual({
      kind: 'approvalText',
      decision: 'deny',
    });
  });

  it('reads a bare number as a check-in answer, but only when one is pending', () => {
    expect(interpretUpdate({ update_id: 13, message: { text: '2' } }, withOptions)).toEqual({
      kind: 'checkinText',
      chosen: 1,
    });
    // Out of the offered range, or nothing pending: a number means nothing and is
    // NOT reinterpreted as an approval.
    expect(interpretUpdate({ update_id: 14, message: { text: '9' } }, withOptions)).toBeUndefined();
    expect(interpretUpdate({ update_id: 15, message: { text: '2' } }, ctx)).toBeUndefined();
  });

  it('applies a bare reply to the NEWEST pending approval, or none', () => {
    const a = { approvalId: 'a', escalatedAt: 100 };
    const b = { approvalId: 'b', escalatedAt: 300 };
    const c = { approvalId: 'c', escalatedAt: 200 };
    expect(pickTextReplyTarget([a, b, c])?.approvalId).toBe('b');
    expect(pickTextReplyTarget([])).toBeUndefined();
  });

  it('marks a remote decision as coming from Telegram', () => {
    expect(telegramDecision('allow')).toEqual({ behavior: 'allow' });
    const deny = telegramDecision('deny');
    expect(deny.behavior).toBe('deny');
    expect(deny.behavior === 'deny' && deny.reason).toMatch(/Telegram/);
  });
});

// ---------------------------------------------------------------------------
// the bridge, end to end against a faked Telegram API
// ---------------------------------------------------------------------------

type Call = { url: string; body: unknown };

/** Minimal Store stand-in: the bridge only reads/writes settings. */
function fakeStore(settings: Record<string, string>) {
  const map = new Map(Object.entries(settings));
  return {
    getSetting: (k: string) => map.get(k),
    setSetting: (k: string, v: string) => void map.set(k, v),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const READY = {
  'telegram.enabled': 'true',
  'telegram.botToken': 'TOKEN',
  'telegram.chatId': 'CHAT',
};

/** Fake Bot API. `updateQueue` is drained one poll at a time, so the loop sees an
 *  empty backlog first (the drain) and the queued update next. */
/** A queued batch may be a THUNK, so a test can echo back the short ref that the
 *  escalation actually minted — the ref is process-local and not knowable before
 *  the send. */
type Batch = TelegramUpdate[] | (() => TelegramUpdate[]);

function stubTelegram(updateQueue: Batch[]) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    const reply = (json: unknown) => ({ ok: true, status: 200, json: async () => json });
    if (url.includes('/getUpdates')) {
      const next = updateQueue.shift();
      const batch = typeof next === 'function' ? next() : (next ?? []);
      return reply({ ok: true, result: batch });
    }
    if (url.includes('/sendMessage')) return reply({ ok: true, result: { message_id: 1 } });
    return reply({ ok: true, result: true });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

// The loop is ALWAYS-ON now (telegram-chat §5): it no longer exits when the last
// escalation settles, so every test has to hand the bot's single getUpdates slot
// back before the next one stubs a new fetch. Awaiting the exit (not just asking
// for it) is the point — a surviving loop would consume the NEXT test's queued
// updates.
afterEach(async () => {
  stopTelegramListener();
  await vi.waitFor(() => expect(telegramListenerRunning()).toBe(false), { timeout: 5000 });
  vi.unstubAllGlobals();
});

describe('telegramEscalation — bridge (send → poll → resolveApproval)', () => {
  it('a button press resolves the paused approval and confirms in chat', async () => {
    const approvalId = 'sess-btn:tc1';
    const { calls } = stubTelegram([
      [], // the drain poll
      // Pressed AFTER the send, so it carries the ref the bridge actually minted.
      () => [
        {
          update_id: 42,
          callback_query: { id: 'cq1', data: `nbapv:allow:${pendingEscalations()[0]!.ref}` },
        },
      ],
    ]);
    const store = fakeStore({ ...READY });

    let decided: unknown;
    registerApproval(approvalId, (d) => void (decided = d), 1);

    await escalateApproval({ store, approvalId, toolName: 'Bash', input: { command: 'ls' }, now: 1 });

    // The question went out with the inline keyboard for THIS approval.
    const ask = calls.find((c) => c.url.includes('/sendMessage'));
    expect(ask).toBeDefined();
    const askBody = ask!.body as { text: string; reply_markup: { inline_keyboard: { callback_data: string }[][] } };
    expect(askBody.text).toContain('Bash');
    // Keyed by a short ref, not the id: `nbapv:allow:<id>` would be 78 bytes
    // with a UUID session and Telegram would reject the whole send.
    expect(askBody.reply_markup.inline_keyboard[0][0].callback_data).toMatch(/^nbapv:allow:r[0-9a-z]+$/);

    await vi.waitFor(() => expect(decided).toEqual({ behavior: 'allow' }), { timeout: 4000 });
    // Settled, unwatched, acknowledged, and reported back to the chat.
    expect(hasPendingApproval(approvalId)).toBe(false);
    expect(pendingEscalations().some((w) => w.id === approvalId)).toBe(false);
    expect(calls.some((c) => c.url.includes('/answerCallbackQuery'))).toBe(true);
    expect(
      calls.filter((c) => c.url.includes('/sendMessage')).some((c) => String((c.body as { text: string }).text).includes('✅ Approved')),
    ).toBe(true);
    // The watermark advanced past the update it consumed.
    expect(store.getSetting(TELEGRAM_OFFSET_KEY)).toBe('43');
  });

  it('a bare "no" reply denies the newest pending approval', async () => {
    const approvalId = 'sess-txt:tc9';
    // `[]` first so the test does not depend on whether this process already
    // drained its backlog (the drain happens once per process, in whichever test
    // escalates first).
    stubTelegram([[], [{ update_id: 77, message: { text: 'no thanks' } }]]);
    const store = fakeStore({ ...READY });

    let decided: { behavior: string; reason?: string } | undefined;
    registerApproval(approvalId, (d) => void (decided = d), 2);

    await escalateApproval({ store, approvalId, toolName: 'Write', now: 2, agentName: 'nabi' });
    await vi.waitFor(() => expect(decided?.behavior).toBe('deny'), { timeout: 4000 });
    expect(decided?.reason).toMatch(/Telegram/);
  });

  it('a check-in option button resolves the paused check-in and confirms in chat', async () => {
    const checkinId = 'sess-chk:tc1';
    const { calls } = stubTelegram([
      [],
      () => [
        {
          update_id: 91,
          callback_query: { id: 'cq9', data: `nbchk:1:${pendingEscalations()[0]!.ref}` },
        },
      ],
    ]);
    const store = fakeStore({ ...READY });

    let answered: { chosen: number } | undefined;
    registerCheckin(checkinId, (a) => void (answered = a), 1);

    await escalateCheckin({
      store,
      checkinId,
      question: 'Migrate the column, or add a new one?',
      options: ['migrate in place', 'add a new column'],
      now: 1,
      agentName: 'nabi',
    });

    const ask = calls.find((c) => c.url.includes('/sendMessage'));
    const askBody = ask!.body as { text: string; reply_markup: { inline_keyboard: { text: string }[][] } };
    expect(askBody.text).toContain('1. migrate in place');
    expect(askBody.reply_markup.inline_keyboard.flat().map((b) => b.text)).toEqual(['1', '2']);

    await vi.waitFor(() => expect(answered).toEqual({ chosen: 1 }), { timeout: 4000 });
    expect(hasPendingCheckin(checkinId)).toBe(false);
    expect(pendingEscalations().some((w) => w.id === checkinId)).toBe(false);
    // The chat is told which option won, by number AND text — a bare "2" on a
    // phone is meaningless a day later.
    expect(
      calls
        .filter((c) => c.url.includes('/sendMessage'))
        .some((c) => String((c.body as { text: string }).text).includes('2. add a new column')),
    ).toBe(true);
  });

  it('a bare number answers the newest pending check-in', async () => {
    const checkinId = 'sess-num:tc2';
    stubTelegram([[], [{ update_id: 92, message: { text: '1' } }]]);
    const store = fakeStore({ ...READY });
    let answered: { chosen: number } | undefined;
    registerCheckin(checkinId, (a) => void (answered = a), 2);
    await escalateCheckin({ store, checkinId, question: 'A or B?', options: ['a', 'b'], now: 2 });
    await vi.waitFor(() => expect(answered).toEqual({ chosen: 0 }), { timeout: 4000 });
  });

  it('an out-of-range option is refused rather than recorded as an answer', async () => {
    const checkinId = 'sess-bad:tc3';
    const { calls } = stubTelegram([
      [],
      () => [
        {
          update_id: 93,
          // Only two options were offered; index 7 can only come from a tampered
          // or stale button, and must NOT become the user's recorded choice.
          callback_query: { id: 'cq7', data: `nbchk:7:${pendingEscalations()[0]!.ref}` },
        },
      ],
      [],
    ]);
    const store = fakeStore({ ...READY });
    let answered: unknown;
    registerCheckin(checkinId, (a) => void (answered = a), 3);
    await escalateCheckin({ store, checkinId, question: 'A or B?', options: ['a', 'b'], now: 3 });
    await vi.waitFor(
      () => expect(calls.some((c) => c.url.includes('/answerCallbackQuery'))).toBe(true),
      { timeout: 4000 },
    );
    expect(answered).toBeUndefined();
    // Still waiting — the in-app prompt (and the TTL) still governs it.
    expect(hasPendingCheckin(checkinId)).toBe(true);
    await finishCheckinEscalation({ store, checkinId });
  });

  it('closes a check-in in chat when the app answered first', async () => {
    const checkinId = 'sess-appchk:tc4';
    const { calls } = stubTelegram([[], []]);
    const store = fakeStore({ ...READY });
    registerCheckin(checkinId, () => {}, 4);
    await escalateCheckin({ store, checkinId, question: 'A or B?', options: ['a', 'b'], now: 4 });
    await finishCheckinEscalation({ store, checkinId, chosen: 0 });
    expect(pendingEscalations().some((w) => w.id === checkinId)).toBe(false);
    expect(
      calls
        .filter((c) => c.url.includes('/sendMessage'))
        .some((c) => String((c.body as { text: string }).text).includes('answered in the app')),
    ).toBe(true);
    // A second call is a no-op: the loop and the turn must never double-report.
    const before = calls.length;
    await finishCheckinEscalation({ store, checkinId, chosen: 0 });
    expect(calls).toHaveLength(before);
  });

  it('does not escalate (and does not watch) when Telegram is not configured', async () => {
    const { calls } = stubTelegram([[]]);
    const store = fakeStore({ 'telegram.enabled': 'false' });
    await escalateApproval({ store, approvalId: 'sess-off:tc1', toolName: 'Bash', now: 3 });
    expect(calls).toHaveLength(0);
    expect(pendingEscalations().some((w) => w.id === 'sess-off:tc1')).toBe(false);
  });

  it('ignores an update from a chat that is not the configured one', async () => {
    const approvalId = 'sess-foreign:tc1';
    stubTelegram([
      [],
      // A stranger who found the bot presses deny. The token alone is not
      // authorization: chat_id is (telegram-chat §6).
      () => [
        {
          update_id: 4242,
          callback_query: {
            id: 'cqx',
            data: `nbapv:deny:${pendingEscalations()[0]!.ref}`,
            message: { chat: { id: 999999 } },
          },
        },
      ],
      [],
    ]);
    const store = fakeStore({ ...READY, 'telegram.chatId': '4242' });
    let decided: unknown;
    registerApproval(approvalId, (d) => void (decided = d), 9);
    await escalateApproval({ store, approvalId, toolName: 'Bash', now: 9 });
    // Give the loop two iterations to prove it did NOT act on it.
    await vi.waitFor(() => expect(store.getSetting(TELEGRAM_OFFSET_KEY)).toBe('4243'), { timeout: 4000 });
    expect(decided).toBeUndefined();
    expect(hasPendingApproval(approvalId)).toBe(true);
    await finishEscalation({ store, approvalId, decision: 'deny', reason: 'test cleanup' });
  });

  it('stops watching and says so when the app answered first', async () => {
    const approvalId = 'sess-app:tc2';
    const { calls } = stubTelegram([[], []]);
    const store = fakeStore({ ...READY });
    registerApproval(approvalId, () => {}, 4);
    await escalateApproval({ store, approvalId, toolName: 'Edit', now: 4 });
    expect(pendingEscalations().some((w) => w.id === approvalId)).toBe(true);

    await finishEscalation({ store, approvalId, decision: 'deny', reason: 'approval request timed out' });
    expect(pendingEscalations().some((w) => w.id === approvalId)).toBe(false);
    const texts = calls.filter((c) => c.url.includes('/sendMessage')).map((c) => (c.body as { text: string }).text);
    expect(texts.some((t) => t.includes('❌ Denied') && t.includes('Edit') && t.includes('timed out'))).toBe(true);

    // Idempotent: the turn's settle path may call it again (or Telegram may have
    // resolved it) — a second call must not send a duplicate.
    const before = calls.length;
    await finishEscalation({ store, approvalId, decision: 'deny' });
    expect(calls.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// the always-on loop and the chat it now carries (telegram-chat §1, §5)
// ---------------------------------------------------------------------------

const CHAT_READY = {
  'telegram.enabled': 'true',
  'telegram.botToken': 'TOKEN',
  'telegram.chatId': '4242',
};

/** A plain message from the configured chat. */
function chatMessage(update_id: number, text: string): TelegramUpdate {
  return { update_id, message: { message_id: update_id, chat: { id: 4242 }, text } };
}

describe('telegramEscalation — the promoted loop (telegram-chat §5)', () => {
  it('keeps polling with nothing pending, and publishes the command menu', async () => {
    const { calls } = stubTelegram([[], []]);
    const store = fakeStore({ ...CHAT_READY });
    // The menu is published once per process; an earlier test already spent that
    // one. A new bot token does the same in production (`telegram.set`).
    resetBotCommandRegistration();

    ensureListener(store);

    // Before the promotion this loop would have exited at once: there is no
    // pending approval anywhere.
    await vi.waitFor(() => expect(calls.filter((c) => c.url.includes('/getUpdates')).length).toBeGreaterThan(1), {
      timeout: 4000,
    });
    expect(telegramListenerRunning()).toBe(true);

    const menu = calls.find((c) => c.url.includes('/setMyCommands'));
    expect(menu).toBeDefined();
    const registered = (menu!.body as { commands: { command: string }[] }).commands.map((c) => c.command);
    expect(registered).toContain('sessions');
    expect(registered).toContain('use');
  });

  it('hands the getUpdates slot to Detect and takes it back (the 409 handshake)', async () => {
    stubTelegram([[], [], []]);
    const store = fakeStore({ ...CHAT_READY });
    ensureListener(store);
    await vi.waitFor(() => expect(telegramListenerRunning()).toBe(true), { timeout: 4000 });

    // Resolves only once the loop is actually gone — a caller that starts its own
    // getUpdates on a request that has not landed yet gets the 409 this prevents.
    await pauseTelegramListener();
    expect(telegramListenerRunning()).toBe(false);

    resumeTelegramListener(store);
    await vi.waitFor(() => expect(telegramListenerRunning()).toBe(true), { timeout: 4000 });
  });

  it('stops when Telegram is disabled mid-flight (the existing contract)', async () => {
    stubTelegram([[], [], []]);
    const store = fakeStore({ ...CHAT_READY });
    ensureListener(store);
    await vi.waitFor(() => expect(telegramListenerRunning()).toBe(true), { timeout: 4000 });
    store.setSetting('telegram.enabled', 'false');
    await vi.waitFor(() => expect(telegramListenerRunning()).toBe(false), { timeout: 6000 });
  });
});

describe('telegramEscalation — routing priority (telegram-chat §1)', () => {
  it('an answer to a pending approval outranks the chat', async () => {
    const approvalId = 'sess-prio:tc1';
    const { calls } = stubTelegram([[], [chatMessage(500, '네')], []]);
    const store = fakeStore({ ...CHAT_READY });
    let decided: { behavior: string } | undefined;
    registerApproval(approvalId, (d) => void (decided = d), 11);

    await escalateApproval({ store, approvalId, toolName: 'Bash', now: 11 });
    await vi.waitFor(() => expect(decided?.behavior).toBe('allow'), { timeout: 4000 });
    // It resolved the approval and did NOT also start a turn / answer as chat.
    const texts = calls.filter((c) => c.url.includes('/sendMessage')).map((c) => (c.body as { text: string }).text);
    expect(texts.some((t) => t.includes('✅ Approved'))).toBe(true);
    expect(texts.some((t) => t.includes('연결된 세션이 없다'))).toBe(false);
  });

  it('a "/" command reaches the chat when nothing is pending', async () => {
    const { calls } = stubTelegram([[], [chatMessage(600, '/help')], []]);
    const store = fakeStore({ ...CHAT_READY });
    ensureListener(store);
    await vi.waitFor(
      () =>
        expect(
          calls
            .filter((c) => c.url.includes('/sendMessage'))
            .some((c) => String((c.body as { text: string }).text).includes('/sessions')),
        ).toBe(true),
      { timeout: 6000 },
    );
  });

  it('plain text with no link is answered, not swallowed', async () => {
    const { calls } = stubTelegram([[], [chatMessage(700, '오늘 뭐 했지')], []]);
    const store = fakeStore({ ...CHAT_READY });
    ensureListener(store);
    await vi.waitFor(
      () =>
        expect(
          calls
            .filter((c) => c.url.includes('/sendMessage'))
            .some((c) => String((c.body as { text: string }).text).includes('연결된 세션이 없다')),
        ).toBe(true),
      { timeout: 6000 },
    );
  });

  it('a bare "yes" with nothing pending is a message, not a lost approval', async () => {
    const { calls } = stubTelegram([[], [chatMessage(800, '응')], []]);
    const store = fakeStore({ ...CHAT_READY });
    ensureListener(store);
    await vi.waitFor(
      () =>
        expect(
          calls
            .filter((c) => c.url.includes('/sendMessage'))
            .some((c) => String((c.body as { text: string }).text).includes('연결된 세션이 없다')),
        ).toBe(true),
      { timeout: 6000 },
    );
  });
});

describe('telegramEscalation — reply routing map (telegram-chat §1.3)', () => {
  it('a final report becomes replyable to its own session', async () => {
    const { calls } = stubTelegram([[]]);
    const store = fakeStore({ ...CHAT_READY });
    await sendFinalReport(store, { ok: true, text: 'done', sessionId: 'sess-report' });
    expect(calls.some((c) => c.url.includes('/sendMessage'))).toBe(true);
    // stubTelegram answers every send with message_id 1.
    expect(sessionForChatMessage(1)).toBe('sess-report');
  });

  it('keeps only the most recent messages routable', () => {
    for (let i = 1; i <= 60; i += 1) rememberChatMessage(10_000 + i, `s${i}`);
    // The oldest fell off; the newest is still there.
    expect(sessionForChatMessage(10_001)).toBeUndefined();
    expect(sessionForChatMessage(10_060)).toBe('s60');
  });
});
