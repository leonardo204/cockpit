import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildCallbackData,
  parseCallbackData,
  buildApprovalKeyboard,
  classifyTextReply,
  redactToken,
  isTelegramReady,
  buildCheckinKeyboard,
  parseCheckinCallbackData,
  classifyNumericReply,
  CALLBACK_DATA_MAX_BYTES,
  describeFetchError,
  sendTelegramMessage,
  pollTelegramUpdates,
  detectChatId,
  readTelegramConfig,
  writeTelegramConfig,
} from './telegram';

describe('telegram — approval callback data (P3-M3)', () => {
  it('round-trips decision + ref', () => {
    const ref = 'r2f';
    expect(parseCallbackData(buildCallbackData('allow', ref))).toEqual({ decision: 'allow', ref });
    expect(parseCallbackData(buildCallbackData('deny', ref))).toEqual({ decision: 'deny', ref });
  });

  it('preserves a ref that itself contains colons', () => {
    // Refs the bridge mints have no colons, but the parser must not silently
    // truncate one that does — a decision read from a half-parsed id would be
    // applied to the wrong pending question.
    const ref = 's-1:2:3:tc-9';
    expect(parseCallbackData(buildCallbackData('deny', ref))).toEqual({ decision: 'deny', ref });
  });

  it('rejects foreign / malformed callback data', () => {
    expect(parseCallbackData(undefined)).toBeUndefined();
    expect(parseCallbackData('')).toBeUndefined();
    expect(parseCallbackData('other:allow:x')).toBeUndefined();
    expect(parseCallbackData('nbapv:maybe:x')).toBeUndefined();
  });

  it('keyboard carries both decisions, keyed by the short ref', () => {
    const kb = buildApprovalKeyboard('r1');
    const [row] = kb.inline_keyboard;
    expect(parseCallbackData(row[0].callback_data)?.decision).toBe('allow');
    expect(parseCallbackData(row[1].callback_data)?.decision).toBe('deny');
    expect(parseCallbackData(row[0].callback_data)?.ref).toBe('r1');
  });

  it('every button fits Telegram\'s 64-byte callback_data limit', () => {
    // THE REASON REFS EXIST. Embedding the id directly measured 78 bytes with an
    // Agent-SDK UUID session, which makes the whole sendMessage fail — so the
    // buttons never appear and the escalation degrades to silence. A ref is
    // bounded whatever the ids grow into.
    const data = [
      ...buildApprovalKeyboard('rzzzz').inline_keyboard.flat(),
      ...buildCheckinKeyboard('rzzzz', 5).inline_keyboard.flat(),
    ].map((b) => b.callback_data);
    for (const d of data) {
      expect(Buffer.byteLength(d, 'utf8'), d).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
    }
  });

  it('check-in buttons are numbered 1..N and parse back to 0-based indices', () => {
    const kb = buildCheckinKeyboard('r7', 3);
    const flat = kb.inline_keyboard.flat();
    expect(flat.map((b) => b.text)).toEqual(['1', '2', '3']);
    // Two per row: option labels are sentences, and three across truncates them.
    expect(kb.inline_keyboard.map((r) => r.length)).toEqual([2, 1]);
    expect(parseCheckinCallbackData(flat[0].callback_data)).toEqual({ chosen: 0, ref: 'r7' });
    expect(parseCheckinCallbackData(flat[2].callback_data)).toEqual({ chosen: 2, ref: 'r7' });
    // An approval button is not a check-in button and vice versa.
    expect(parseCheckinCallbackData('nbapv:allow:r7')).toBeUndefined();
    expect(parseCallbackData(flat[0].callback_data)).toBeUndefined();
  });

  it('a bare number answers a check-in, and only inside the offered range', () => {
    expect(classifyNumericReply('2', 3)).toBe(1);
    expect(classifyNumericReply(' 1. ', 3)).toBe(0);
    expect(classifyNumericReply('3)', 3)).toBe(2);
    // Out of range, or not a bare number: NOT guessed at. A wrong guess would be
    // recorded as the user's own answer to a question the agent could not answer.
    expect(classifyNumericReply('4', 3)).toBeUndefined();
    expect(classifyNumericReply('0', 3)).toBeUndefined();
    expect(classifyNumericReply('the first one', 3)).toBeUndefined();
    expect(classifyNumericReply('2 please', 3)).toBeUndefined();
    expect(classifyNumericReply('2', 0)).toBeUndefined();
  });
});

describe('telegram — free-text reply classification', () => {
  it('classifies affirmations (en/ko)', () => {
    for (const t of ['yes', 'Y', 'ok', 'approve', 'go', '승인', '네', '진행']) {
      expect(classifyTextReply(t)).toBe('allow');
    }
  });
  it('classifies negations (en/ko)', () => {
    for (const t of ['no', 'nope', 'deny', 'stop', '거부', '아니', '멈춰']) {
      expect(classifyTextReply(t)).toBe('deny');
    }
  });
  it('leaves ambiguous text undecided', () => {
    expect(classifyTextReply('maybe later')).toBeUndefined();
    expect(classifyTextReply('')).toBeUndefined();
    expect(classifyTextReply(undefined)).toBeUndefined();
  });
});

describe('telegram — config helpers', () => {
  it('redacts a token to a recognizable stub', () => {
    expect(redactToken('')).toBe('');
    expect(redactToken('12345678901234:AAExyz')).toMatch(/^1234….{4}$/);
    expect(redactToken('short')).toBe('••••');
  });
  it('isTelegramReady requires enabled + both creds', () => {
    expect(isTelegramReady({ enabled: true, botToken: 't', chatId: 'c' })).toBe(true);
    expect(isTelegramReady({ enabled: false, botToken: 't', chatId: 'c' })).toBe(false);
    expect(isTelegramReady({ enabled: true, botToken: '', chatId: 'c' })).toBe(false);
    expect(isTelegramReady({ enabled: true, botToken: 't', chatId: '' })).toBe(false);
  });

  // Delivery mode (telegram-chat §8.1): default manual, round-trip, and an
  // unknown stored value must read as manual — a typo or a downgrade can only
  // ever switch mirroring OFF.
  it('syncMode defaults to manual and round-trips', () => {
    const map = new Map<string, string>();
    const store = {
      getSetting: (k: string) => map.get(k),
      setSetting: (k: string, v: string) => void map.set(k, v),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    expect(readTelegramConfig(store).syncMode).toBe('manual');
    writeTelegramConfig(store, { syncMode: 'always' });
    expect(readTelegramConfig(store).syncMode).toBe('always');
    writeTelegramConfig(store, { syncMode: 'manual' });
    expect(readTelegramConfig(store).syncMode).toBe('manual');
  });

  it('an unknown stored syncMode reads as manual', () => {
    const map = new Map<string, string>([['telegram.syncMode', 'sometimes']]);
    const store = {
      getSetting: (k: string) => map.get(k),
      setSetting: (k: string, v: string) => void map.set(k, v),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    expect(readTelegramConfig(store).syncMode).toBe('manual');
  });
});

// ---------------------------------------------------------------------------
// Network failures must NAME themselves
// ---------------------------------------------------------------------------
//
// The bug these guard against cost a whole debugging session. Telegram sends
// began failing intermittently with `400 {"error":"fetch failed"}` — five words
// that say nothing — and the config was read as the suspect, because that is
// the only thing the message could plausibly be about. The real cause was the
// transport: Node's Happy Eyeballs abandons an IPv4 attempt that has not
// connected within 250ms (the default), and on the reporting network the
// handshake to api.telegram.org measured ~250-280ms with IPv6 unreachable, so
// `fetch` gave up on a connection that was about to succeed. The code was in
// `e.cause.code` the whole time: ETIMEDOUT.
//
// Two rules come out of it, and these tests hold both:
//   1. A transport failure must SHOW its code, so it cannot be mistaken for a
//      configuration error.
//   2. "The poll failed" must never be reported as "no message is waiting".

/** Node's real shape for a failed fetch: TypeError('fetch failed') + a coded cause. */
function fetchFailed(code: string): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
}

const CFG = { botToken: 'bot-token', chatId: '4242' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('telegram — a network failure names itself (Happy Eyeballs regression)', () => {
  it('describeFetchError appends the cause code', () => {
    expect(describeFetchError(fetchFailed('ETIMEDOUT'))).toBe('fetch failed (ETIMEDOUT)');
    expect(describeFetchError(fetchFailed('ENOTFOUND'))).toBe('fetch failed (ENOTFOUND)');
    expect(describeFetchError(fetchFailed('ECONNREFUSED'))).toBe('fetch failed (ECONNREFUSED)');
  });

  it('describeFetchError digs a code out of an AggregateError cause', () => {
    // The multi-address failure mode: Node wraps one error per address tried.
    const agg = Object.assign(new AggregateError([], 'all attempts failed'), {
      errors: [
        Object.assign(new Error('unreachable'), { code: 'EHOSTUNREACH' }),
        Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
      ],
    });
    const err = new TypeError('fetch failed', { cause: agg });
    expect(describeFetchError(err)).toBe('fetch failed (EHOSTUNREACH)');
  });

  it('describeFetchError leaves a codeless error alone (and never throws)', () => {
    expect(describeFetchError(new Error('boom'))).toBe('boom');
    expect(describeFetchError('plain string')).toBe('plain string');
    expect(describeFetchError(undefined)).toBe('undefined');
    // A self-referencing cause chain must not hang the error path.
    const loop = new Error('loop') as Error & { cause?: unknown };
    loop.cause = loop;
    expect(describeFetchError(loop)).toBe('loop');
  });

  it('sendTelegramMessage reports the code, so a network fault is not read as a config error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailed('ETIMEDOUT')));
    const res = await sendTelegramMessage(CFG, 'hello');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toContain('ETIMEDOUT');
    // The bare five words alone were the whole problem — never ship them naked.
    expect(res.error).not.toBe('fetch failed');
  });

  it('sendTelegramMessage still surfaces an API-level refusal verbatim', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ ok: false, description: 'Unauthorized' }),
      }),
    );
    const res = await sendTelegramMessage(CFG, 'hello');
    expect(res).toEqual({ ok: false, error: 'Unauthorized' });
  });

  it('pollTelegramUpdates turns a transport failure into a distinguishable error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailed('ETIMEDOUT')));
    const res = await pollTelegramUpdates(CFG, 17, { timeoutSec: 0 });
    expect(res.updates).toEqual([]);
    // The offset must NOT advance on a failed poll, or the listener would skip
    // updates it never actually read.
    expect(res.nextOffset).toBe(17);
    expect(res.error).toContain('ETIMEDOUT');
  });

  it('pollTelegramUpdates reports an API refusal too, and leaves error absent on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ ok: false, description: 'Conflict: terminated by other getUpdates' }),
      }),
    );
    expect((await pollTelegramUpdates(CFG, 0)).error).toContain('Conflict');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: [{ update_id: 8, message: { chat: { id: 5 } } }] }),
      }),
    );
    const good = await pollTelegramUpdates(CFG, 0);
    expect(good.error).toBeUndefined();
    expect(good.nextOffset).toBe(9);
    expect(good.updates).toHaveLength(1);
  });
});

describe('telegram — detectChatId tells a network failure from an empty inbox', () => {
  it('reports the network fault instead of "send a message"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailed('ETIMEDOUT')));
    const res = await detectChatId({ botToken: 'bot-token' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toContain('Could not reach Telegram');
    expect(res.error).toContain('ETIMEDOUT');
    // Sending the message AGAIN is the one instruction guaranteed not to help.
    expect(res.error).not.toContain('No message found');
  });

  it('reports an API refusal (a wrong token) rather than an empty inbox', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ ok: false, description: 'Unauthorized' }),
      }),
    );
    const res = await detectChatId({ botToken: 'bot-token' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toContain('Unauthorized');
    expect(res.error).not.toContain('No message found');
  });

  it('still says "no message" when the poll SUCCEEDED and nothing was waiting', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, result: [] }) }),
    );
    const res = await detectChatId({ botToken: 'bot-token' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toContain('No message found');
  });

  it('returns the newest chat id when one is waiting', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: [
            { update_id: 1, message: { chat: { id: 111 } } },
            { update_id: 2, callback_query: { id: 'q', message: { chat: { id: 222 } } } },
          ],
        }),
      }),
    );
    expect(await detectChatId({ botToken: 'bot-token' })).toEqual({ ok: true, chatId: '222' });
  });

  it('asks for the token first, without touching the network', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const res = await detectChatId({ botToken: '' });
    expect(res).toEqual({ ok: false, error: 'Set the bot token first.' });
    expect(spy).not.toHaveBeenCalled();
  });
});
