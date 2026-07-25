import { describe, it, expect } from 'vitest';
import {
  buildCallbackData,
  parseCallbackData,
  buildApprovalKeyboard,
  classifyTextReply,
  redactToken,
  isTelegramReady,
} from './telegram';

describe('telegram — approval callback data (P3-M3)', () => {
  it('round-trips decision + approvalId', () => {
    const id = 'sess-abc:tool-42';
    const allow = buildCallbackData('allow', id);
    const deny = buildCallbackData('deny', id);
    expect(parseCallbackData(allow)).toEqual({ decision: 'allow', approvalId: id });
    expect(parseCallbackData(deny)).toEqual({ decision: 'deny', approvalId: id });
  });

  it('preserves an approvalId that itself contains colons', () => {
    const id = 's-1:2:3:tc-9';
    expect(parseCallbackData(buildCallbackData('deny', id))).toEqual({ decision: 'deny', approvalId: id });
  });

  it('rejects foreign / malformed callback data', () => {
    expect(parseCallbackData(undefined)).toBeUndefined();
    expect(parseCallbackData('')).toBeUndefined();
    expect(parseCallbackData('other:allow:x')).toBeUndefined();
    expect(parseCallbackData('nbapv:maybe:x')).toBeUndefined();
  });

  it('keyboard carries both decisions for the approval', () => {
    const kb = buildApprovalKeyboard('sess:tc1');
    const [row] = kb.inline_keyboard;
    expect(parseCallbackData(row[0].callback_data)?.decision).toBe('allow');
    expect(parseCallbackData(row[1].callback_data)?.decision).toBe('deny');
    expect(parseCallbackData(row[0].callback_data)?.approvalId).toBe('sess:tc1');
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
