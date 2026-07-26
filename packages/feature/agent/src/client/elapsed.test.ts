import { describe, it, expect } from 'vitest';
import { formatElapsed, isLongTurn, LONG_TURN_SECONDS } from './elapsed';

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
