import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rateLimitRefusalActive } from './contextGauge';

/**
 * A REFUSAL IS A FACT ABOUT A MOMENT, NOT ABOUT THE SESSION.
 *
 * `rejected` says the backend turned a request away. Nothing ever arrives to say
 * it is over, so the state was set once and kept — and the red "Rate Limited"
 * indicator ended up on screen next to a plan chip reading 16% and 54%. Two
 * contradictory claims about one account, and the alarming one was the stale one.
 *
 * The reader cannot tell which to believe, and the honest answer is that the
 * indicator was simply out of date.
 */

const NOW = 1_700_000_000_000;
/** The event's own unit: UNIX SECONDS (runtime/engine.ts). */
const secs = (ms: number) => Math.floor(ms / 1000);

describe('while the refusal is in force', () => {
  it('shows a rejection whose reset is still ahead', () => {
    expect(rateLimitRefusalActive({ status: 'rejected', resetsAt: secs(NOW + 60_000) }, NOW)).toBe(
      true,
    );
  });

  it('shows a rejection that named no reset at all', () => {
    // Nothing to measure against, and guessing a duration would replace a stale
    // truth with an invented one. A completed turn retires this one instead.
    expect(rateLimitRefusalActive({ status: 'rejected' }, NOW)).toBe(true);
  });
});

describe('once it is over', () => {
  it('stops showing a rejection whose reset has passed', () => {
    // The clock can already disprove it, which is exactly the rule
    // `usageWindowView` applies to a plan window.
    expect(rateLimitRefusalActive({ status: 'rejected', resetsAt: secs(NOW - 1000) }, NOW)).toBe(
      false,
    );
  });

  it('treats the reset instant itself as over', () => {
    expect(rateLimitRefusalActive({ status: 'rejected', resetsAt: secs(NOW) }, NOW)).toBe(false);
  });
});

describe('what it never claims', () => {
  it('says nothing for the states that are not a refusal', () => {
    // `allowed_warning` is a warning, not a refusal, and the plan chip already
    // says the same thing better — the row stopped drawing it for that reason.
    for (const status of ['allowed', 'allowed_warning', undefined]) {
      expect(rateLimitRefusalActive({ status, resetsAt: secs(NOW + 60_000) }, NOW)).toBe(false);
    }
  });

  it('says nothing when there is no reading at all', () => {
    expect(rateLimitRefusalActive(null, NOW)).toBe(false);
    expect(rateLimitRefusalActive(undefined, NOW)).toBe(false);
  });
});

describe('the wiring', () => {
  const BAR = readFileSync(join(__dirname, 'TokenUsageBar.tsx'), 'utf8');
  const STREAM = readFileSync(join(__dirname, 'useChatStream.ts'), 'utf8');

  it('the row asks the rule rather than reading the status directly', () => {
    expect(BAR).toContain('rateLimitRefusalActive(rateLimitInfo, now)');
    expect(BAR).not.toContain("rateLimitInfo?.status === 'rejected'");
  });

  it('it expires against the SAME clock the plan windows use', () => {
    // A second clock would let the chip and the indicator disagree about when
    // the window rolled over.
    expect(BAR).toContain('usageWindowView(usage?.limits?.fiveHour, now)');
  });

  it('a completed turn retires a refusal', () => {
    // The half the clock cannot do: a rejection that named no reset.
    expect(STREAM).toContain(
      "setRateLimitInfo((prev) => (prev?.status === 'rejected' ? null : prev));",
    );
  });

  it('a completed turn keeps a WARNING, which is still true', () => {
    // Dropping the whole reading would lose a warning the user should still see.
    const onResult = /if \(eventType === 'result'\)[\s\S]*?flushStreamBuffer\(\);/.exec(
      STREAM,
    )?.[0];
    expect(onResult, 'the result handler changed shape').toBeDefined();
    expect(onResult).not.toContain('setRateLimitInfo(null)');
  });
});
