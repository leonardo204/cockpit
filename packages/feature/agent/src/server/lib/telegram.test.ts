import { describe, it, expect } from 'vitest';
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
});
