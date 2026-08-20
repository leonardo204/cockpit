import { describe, it, expect, beforeEach } from 'vitest';
import i18n from '@cockpit/shared-i18n';
import {
  formatElapsed,
  formatTurnDuration,
  formatTurnEndTime,
  isLongTurn,
  LONG_TURN_SECONDS,
} from './elapsed';

describe('formatElapsed', () => {
  it('reads as seconds under a minute', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(1)).toBe('1s');
    expect(formatElapsed(59)).toBe('59s');
  });

  it('rolls over at exactly 60, and pads so the width does not jump', () => {
    // The boundary an off-by-one makes obvious: 60 must not read "60s".
    expect(formatElapsed(60)).toBe('1m 00s');
    expect(formatElapsed(61)).toBe('1m 01s');
    expect(formatElapsed(200)).toBe('3m 20s');
    expect(formatElapsed(3599)).toBe('59m 59s');
  });

  it('drops seconds past an hour, where they are only jitter', () => {
    expect(formatElapsed(3600)).toBe('1h 00m');
    expect(formatElapsed(3660)).toBe('1h 01m');
    expect(formatElapsed(7380)).toBe('2h 03m');
  });

  it('never renders a negative or fractional clock', () => {
    // A clock that reads "-1s" or "3.7s" tells the user the app is confused.
    expect(formatElapsed(-5)).toBe('0s');
    expect(formatElapsed(12.9)).toBe('12s');
  });

  it('flags a long turn without cancelling anything', () => {
    expect(isLongTurn(LONG_TURN_SECONDS - 1)).toBe(false);
    expect(isLongTurn(LONG_TURN_SECONDS)).toBe(true);
  });
});

// THE SETTLED MEASUREMENT — what a finished turn says it cost.
//
// Different requirements from the ticking clock above, which is why it is a
// different function: tenths matter here (a 400ms turn must not read "0초"),
// and the units are words in the user's language. The boundaries are where a
// carry would print an impossible clock.
describe('formatTurnDuration', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('ko');
  });

  it('keeps a tenth under a minute, where most turns land', () => {
    expect(formatTurnDuration(0)).toBe('0.0초');
    expect(formatTurnDuration(400)).toBe('0.4초');
    expect(formatTurnDuration(12_340)).toBe('12.3초');
    expect(formatTurnDuration(59_900)).toBe('59.9초');
  });

  it('rolls into minutes without ever printing "60.0초"', () => {
    // 59.97s rounds to 60.0 at one decimal. The branch is chosen from the
    // ROUNDED value precisely so this cannot leak.
    expect(formatTurnDuration(59_970)).toBe('1분 0초');
    expect(formatTurnDuration(60_000)).toBe('1분 0초');
    expect(formatTurnDuration(65_000)).toBe('1분 5초');
    expect(formatTurnDuration(3_599_000)).toBe('59분 59초');
  });

  it('drops seconds past an hour, and never prints "59분 60초"', () => {
    expect(formatTurnDuration(3_599_700)).toBe('1시간 0분');
    expect(formatTurnDuration(3_600_000)).toBe('1시간 0분');
    expect(formatTurnDuration(3_780_000)).toBe('1시간 3분');
    expect(formatTurnDuration(7_380_000)).toBe('2시간 3분');
  });

  it('never renders a negative measurement', () => {
    // A negative value means two clocks disagreed, not that time ran backwards.
    expect(formatTurnDuration(-5_000)).toBe('0.0초');
  });

  it('has real English copy, not the Korean units transliterated', async () => {
    await i18n.changeLanguage('en');
    expect(formatTurnDuration(12_340)).toBe('12.3s');
    expect(formatTurnDuration(65_000)).toBe('1m 5s');
    expect(formatTurnDuration(3_780_000)).toBe('1h 3m');
    // Guards against a missing en key falling through to a Korean value.
    expect(formatTurnDuration(12_340)).not.toContain('초');
  });
});

describe('formatTurnEndTime', () => {
  // 14:15 local, built from local parts so the assertion does not depend on the
  // machine's timezone — the point under test is the FORMAT, not the offset.
  const at = (h: number, m: number) => new Date(2026, 7, 19, h, m, 0).toISOString();

  it('follows the active UI language — not a hardcoded locale', async () => {
    // `UserMessagesModal.formatTime` hardcodes 'zh-CN'; this app ships Korean
    // and English, and that literal is deliberately not copied here.
    await i18n.changeLanguage('ko');
    expect(formatTurnEndTime(at(14, 15))).toBe('오후 2:15');
    await i18n.changeLanguage('en');
    expect(formatTurnEndTime(at(14, 15))).toBe('2:15 PM');
  });

  it('keeps the minute’s leading zero and drops the hour’s', async () => {
    await i18n.changeLanguage('en');
    expect(formatTurnEndTime(at(9, 5))).toBe('9:05 AM');
  });

  it('is empty — never a stray string — for a missing or unparseable value', () => {
    expect(formatTurnEndTime(undefined)).toBe('');
    expect(formatTurnEndTime('')).toBe('');
    expect(formatTurnEndTime('not a date')).toBe('');
  });
});
