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
  classifyPollFailure,
  describeFetchError,
  describePollTimeout,
  POLL_DEADLINE_FLOOR_MS,
  POLL_TIMEOUT_REASON,
  pollDeadlineMs,
  sendTelegramMessage,
  pollTelegramUpdates,
  detectChatId,
  editTelegramMessage,
  isNotModified,
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

// ---------------------------------------------------------------------------
// editMessageText — the progress reporter's transport (telegram-chat §4.1)
// ---------------------------------------------------------------------------

describe('telegram — editing a message in place', () => {
  it('calls editMessageText with the chat, the message and the new text', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', spy);
    expect(await editTelegramMessage(CFG, 77, 'still working')).toEqual({ ok: true });
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toContain('/editMessageText');
    expect(JSON.parse(init.body)).toEqual({ chat_id: '4242', message_id: 77, text: 'still working' });
  });

  it('treats "message is not modified" as success', async () => {
    // A progress refresh lands here routinely — nothing happened in the last
    // interval — and the caller stops editing on the first failure by design.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          ok: false,
          description: 'Bad Request: message is not modified: specified new message content...',
        }),
      }),
    );
    expect(await editTelegramMessage(CFG, 77, 'same text')).toEqual({ ok: true });
    expect(isNotModified('Bad Request: message is not modified')).toBe(true);
    expect(isNotModified('Bad Request: message to edit not found')).toBe(false);
  });

  it('reports a real API refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ ok: false, description: 'Bad Request: message to edit not found' }),
      }),
    );
    expect(await editTelegramMessage(CFG, 77, 'x')).toEqual({
      ok: false,
      error: 'Bad Request: message to edit not found',
    });
  });

  it('names the network code on a transport failure, like the send path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailed('ETIMEDOUT')));
    const res = await editTelegramMessage(CFG, 77, 'x');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toContain('ETIMEDOUT');
  });
});

// ---------------------------------------------------------------------------
// THE WALL CLOCK — the regression suite for the stall that took a user report
// to find (telegram-chat: "as long as naby is running, Telegram should work").
// ---------------------------------------------------------------------------
//
// The defect: `timeout=25` in the getUpdates query tells TELEGRAM how long to
// hold the request. It constrains nothing on our side, so a socket that went
// half-open — what a network transition at lock/sleep/wake produces — left the
// `await fetch` pending indefinitely. The listener is one single-threaded loop
// awaiting that call, so ONE hung poll stalled the whole channel, silently.
//
// Every test below fails if `pollTelegramUpdates` stops arming its own timer.

/** A fetch that never settles — the half-open socket, staged. */
function fetchThatNeverAnswers(): { mock: ReturnType<typeof vi.fn>; sawSignal: () => AbortSignal | undefined } {
  let seen: AbortSignal | undefined;
  const mock = vi.fn((_input: unknown, init?: { signal?: AbortSignal }) => {
    seen = init?.signal;
    // Settles ONLY on abort. Without our own timer this promise is forever, and
    // `await` on it is the bug.
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // no signal at all — hang, exactly as production did
      const fail = (): void =>
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail, { once: true });
    });
  });
  return { mock, sawSignal: () => seen };
}

describe('telegram — the poll wall clock', () => {
  it('pollDeadlineMs sits past the long-poll window, with a floor for timeout=0', () => {
    // 25s long-poll + grace = the ~30s the loop runs under. Comfortably past
    // what Telegram was asked to hold, so a NORMAL idle poll never trips it.
    expect(pollDeadlineMs(25)).toBe(30_000);
    expect(pollDeadlineMs(25)).toBeGreaterThan(25_000);
    // The backlog drain asks Telegram to answer at once — but "at once" over a
    // wedged socket is still forever, so it gets the floor rather than nothing.
    expect(pollDeadlineMs(0)).toBe(POLL_DEADLINE_FLOOR_MS);
    expect(pollDeadlineMs(-1)).toBe(POLL_DEADLINE_FLOOR_MS);
    expect(pollDeadlineMs(Number.NaN)).toBe(POLL_DEADLINE_FLOOR_MS);
  });

  it('THE REGRESSION: a poll that never answers is aborted and REPORTED, not awaited forever', async () => {
    const { mock, sawSignal } = fetchThatNeverAnswers();
    vi.stubGlobal('fetch', mock);

    const started = Date.now();
    const res = await pollTelegramUpdates(CFG, 17, { timeoutSec: 25, deadlineMs: 120 });
    const elapsed = Date.now() - started;

    // It came back at all. That is the entire point: before the wall clock this
    // await never resolved and the channel was dead until the app restarted.
    expect(elapsed).toBeLessThan(5_000);
    expect(res.failure).toBe('timeout');
    expect(res.error).toContain('wall clock');
    expect(res.updates).toEqual([]);
    // The watermark must NOT advance on a poll that read nothing, or the next
    // poll would skip updates nobody ever saw.
    expect(res.nextOffset).toBe(17);
    // And the transport passed a signal of its own — production used to hand
    // fetch nothing at all when the caller supplied no signal.
    expect(sawSignal()).toBeDefined();
  });

  it('the drain poll (timeoutSec 0, NO caller signal) is bounded too', async () => {
    // The call that runs at start and after a resume — exactly when a socket is
    // likeliest to be half-open — and it is awaited before the loop even exists.
    const { mock, sawSignal } = fetchThatNeverAnswers();
    vi.stubGlobal('fetch', mock);
    const res = await pollTelegramUpdates(CFG, 3, { timeoutSec: 0, deadlineMs: 100 });
    expect(res.failure).toBe('timeout');
    expect(sawSignal()).toBeDefined();
  });

  it('a stalled BODY read times out as a timeout, not as an API refusal', async () => {
    // The status line arrives and the bytes never do. Filing that as "Telegram
    // said no" would send the loop down the wrong branch AND hide the stall.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: { signal?: AbortSignal }) => ({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_r, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
              { once: true },
            );
          }),
      })),
    );
    const res = await pollTelegramUpdates(CFG, 0, { timeoutSec: 25, deadlineMs: 100 });
    expect(res.failure).toBe('timeout');
    expect(res.error).toContain('wall clock');
  });

  it('a DELIBERATE abort is reported as an abort, never as a timeout or a network fault', async () => {
    // This is the distinction a shutdown depends on: `interruptLoop()` aborting
    // the poll must not be logged as "the network failed".
    const { mock } = fetchThatNeverAnswers();
    vi.stubGlobal('fetch', mock);
    const ac = new AbortController();
    const inflight = pollTelegramUpdates(CFG, 9, { timeoutSec: 25, deadlineMs: 10_000, signal: ac.signal });
    ac.abort();
    const res = await inflight;
    expect(res.failure).toBe('aborted');
    expect(res.nextOffset).toBe(9);
  });

  it('a signal already aborted before the call never reaches the network', async () => {
    const { mock } = fetchThatNeverAnswers();
    vi.stubGlobal('fetch', mock);
    const ac = new AbortController();
    ac.abort();
    const res = await pollTelegramUpdates(CFG, 1, { signal: ac.signal, deadlineMs: 10_000 });
    expect(res.failure).toBe('aborted');
  });

  it('an ordinary network fault is still a network fault', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailed('ECONNRESET')));
    const res = await pollTelegramUpdates(CFG, 0, { timeoutSec: 0 });
    expect(res.failure).toBe('network');
    expect(res.error).toContain('ECONNRESET');
  });

  it('an API refusal keeps its own kind', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ ok: false, description: 'Conflict: terminated by other getUpdates' }),
      }),
    );
    expect((await pollTelegramUpdates(CFG, 0)).failure).toBe('api');
  });

  it('a successful poll carries no failure at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: [] }),
      }),
    );
    const res = await pollTelegramUpdates(CFG, 4);
    expect(res.failure).toBeUndefined();
    expect(res.error).toBeUndefined();
  });

  it('classifyPollFailure honours the FIRST cause, so a shutdown racing the clock is not a network error', () => {
    // Reading `signal.aborted` after the fact cannot tell these apart: a
    // shutdown landing one tick after the wall clock fired would make a real
    // timeout look deliberate, and a deadline landing during a shutdown would
    // log the shutdown as a fault. Whichever fired first is the honest answer.
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(classifyPollFailure(abortErr, 'timeout')).toBe('timeout');
    expect(classifyPollFailure(abortErr, 'aborted')).toBe('aborted');
    // No recorded cause: an abort we did not raise is still an abort, and
    // anything else is the network.
    expect(classifyPollFailure(abortErr, undefined)).toBe('aborted');
    expect(classifyPollFailure(POLL_TIMEOUT_REASON, undefined)).toBe('aborted');
    expect(classifyPollFailure(fetchFailed('EAI_AGAIN'), undefined)).toBe('network');
  });

  it('the timeout message is CONSTANT for a given deadline, so a run of them logs once', () => {
    // The loop reports failure transitions only. A message carrying an elapsed
    // time would differ every poll and turn a wedged connection into one warning
    // line every thirty seconds, forever.
    expect(describePollTimeout(30_000)).toBe(describePollTimeout(30_000));
    expect(describePollTimeout(30_000)).not.toBe(describePollTimeout(10_000));
  });
});
