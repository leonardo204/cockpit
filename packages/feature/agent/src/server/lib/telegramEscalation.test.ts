import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  truncate,
  formatApprovalMessage,
  formatFinalReport,
  interpretUpdate,
  pickTextReplyTarget,
  telegramDecision,
  escalateApproval,
  finishEscalation,
  pendingEscalations,
  TELEGRAM_OFFSET_KEY,
} from './telegramEscalation';
import { registerApproval, hasPendingApproval } from './approvalRegistry';
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
  const watched = (id: string) => id === 'sess:tc1';

  it('reads one of our buttons as a decision for its approval', () => {
    const u: TelegramUpdate = {
      update_id: 5,
      callback_query: { id: 'cq1', data: 'nbapv:allow:sess:tc1' },
    };
    expect(interpretUpdate(u, watched)).toEqual({
      kind: 'callback',
      callbackQueryId: 'cq1',
      approvalId: 'sess:tc1',
      decision: 'allow',
      watched: true,
    });
  });

  it('still acknowledges a button whose approval is no longer pending', () => {
    const u: TelegramUpdate = {
      update_id: 6,
      callback_query: { id: 'cq2', data: 'nbapv:deny:sess:gone' },
    };
    const seen = interpretUpdate(u, watched);
    expect(seen).toMatchObject({ kind: 'callback', watched: false, decision: 'deny' });
  });

  it('ignores a foreign callback and ordinary chatter', () => {
    expect(interpretUpdate({ update_id: 7, callback_query: { id: 'x', data: 'other:allow:a' } }, watched)).toBeUndefined();
    expect(interpretUpdate({ update_id: 8, message: { text: 'what is up' } }, watched)).toBeUndefined();
    expect(interpretUpdate({ update_id: 9 }, watched)).toBeUndefined();
  });

  it('reads a bare yes/no reply as a decision without an approvalId', () => {
    expect(interpretUpdate({ update_id: 10, message: { text: '승인' } }, watched)).toEqual({
      kind: 'text',
      decision: 'allow',
    });
    expect(interpretUpdate({ update_id: 11, message: { text: 'no' } }, watched)).toEqual({
      kind: 'text',
      decision: 'deny',
    });
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
function stubTelegram(updateQueue: TelegramUpdate[][]) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    const reply = (json: unknown) => ({ ok: true, status: 200, json: async () => json });
    if (url.includes('/getUpdates')) {
      const batch = updateQueue.shift() ?? [];
      return reply({ ok: true, result: batch });
    }
    if (url.includes('/sendMessage')) return reply({ ok: true, result: { message_id: 1 } });
    return reply({ ok: true, result: true });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('telegramEscalation — bridge (send → poll → resolveApproval)', () => {
  it('a button press resolves the paused approval and confirms in chat', async () => {
    const approvalId = 'sess-btn:tc1';
    const { calls } = stubTelegram([
      [], // the drain poll
      [{ update_id: 42, callback_query: { id: 'cq1', data: `nbapv:allow:${approvalId}` } }],
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
    expect(askBody.reply_markup.inline_keyboard[0][0].callback_data).toBe(`nbapv:allow:${approvalId}`);

    await vi.waitFor(() => expect(decided).toEqual({ behavior: 'allow' }), { timeout: 4000 });
    // Settled, unwatched, acknowledged, and reported back to the chat.
    expect(hasPendingApproval(approvalId)).toBe(false);
    expect(pendingEscalations().some((w) => w.approvalId === approvalId)).toBe(false);
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

  it('does not escalate (and does not watch) when Telegram is not configured', async () => {
    const { calls } = stubTelegram([[]]);
    const store = fakeStore({ 'telegram.enabled': 'false' });
    await escalateApproval({ store, approvalId: 'sess-off:tc1', toolName: 'Bash', now: 3 });
    expect(calls).toHaveLength(0);
    expect(pendingEscalations().some((w) => w.approvalId === 'sess-off:tc1')).toBe(false);
  });

  it('stops watching and says so when the app answered first', async () => {
    const approvalId = 'sess-app:tc2';
    const { calls } = stubTelegram([[], []]);
    const store = fakeStore({ ...READY });
    registerApproval(approvalId, () => {}, 4);
    await escalateApproval({ store, approvalId, toolName: 'Edit', now: 4 });
    expect(pendingEscalations().some((w) => w.approvalId === approvalId)).toBe(true);

    await finishEscalation({ store, approvalId, decision: 'deny', reason: 'approval request timed out' });
    expect(pendingEscalations().some((w) => w.approvalId === approvalId)).toBe(false);
    const texts = calls.filter((c) => c.url.includes('/sendMessage')).map((c) => (c.body as { text: string }).text);
    expect(texts.some((t) => t.includes('❌ Denied') && t.includes('Edit') && t.includes('timed out'))).toBe(true);

    // Idempotent: the turn's settle path may call it again (or Telegram may have
    // resolved it) — a second call must not send a duplicate.
    const before = calls.length;
    await finishEscalation({ store, approvalId, decision: 'deny' });
    expect(calls.length).toBe(before);
  });
});
