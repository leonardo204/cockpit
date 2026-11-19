import { describe, it, expect } from 'vitest';
import { takeSnapshot, readingPositionAfter } from './readingPosition';
import { reconcileTurnLimit, RECONCILE_MIN_TURNS } from './reconcileWindow';

/**
 * Field report 2026-11-19, reproduced in an isolated build: a reader scrolled up
 * a little while a reply streamed; the turn-end reconcile replaced 132 rendered
 * messages with the whole 491-message transcript; scrollTop stayed at 34,596
 * while scrollHeight went 35,450 → 137,691, and the reader was looking at
 * message 1002 of 3756.
 */
describe('a detached reader stays put when the top of the list changes', () => {
  const before = takeSnapshot('user-2675', { scrollTop: 34596, scrollHeight: 35450 });

  it('the field case: history prepended above keeps the same text in view', () => {
    const top = readingPositionAfter(before, { firstId: 'user-0', scrollHeight: 137691, clientHeight: 629 }, false);
    // Same distance from the content's end as before: 35450 - 34596 = 854.
    expect(top).toBe(137691 - 854);
  });

  it('a pinned reader is left to the stick-to-bottom machine', () => {
    expect(readingPositionAfter(before, { firstId: 'user-0', scrollHeight: 137691, clientHeight: 629 }, true)).toBeNull();
  });

  it('a streamed delta (same first message) is left alone', () => {
    expect(readingPositionAfter(before, { firstId: 'user-2675', scrollHeight: 36000, clientHeight: 629 }, false)).toBeNull();
  });

  it('no snapshot yet (first render) is left alone', () => {
    expect(readingPositionAfter(null, { firstId: 'user-0', scrollHeight: 1000, clientHeight: 600 }, false)).toBeNull();
  });

  it('a list that shrank is clamped into range, never negative', () => {
    const far = takeSnapshot('user-50', { scrollTop: 100, scrollHeight: 90000 });
    expect(readingPositionAfter(far, { firstId: 'user-80', scrollHeight: 5000, clientHeight: 600 }, false)).toBe(0);
    const near = takeSnapshot('user-50', { scrollTop: 8000, scrollHeight: 8500 });
    expect(readingPositionAfter(near, { firstId: 'user-80', scrollHeight: 3000, clientHeight: 600 }, false)).toBe(2400);
  });
});

describe('the turn-end reconcile asks for what the tab shows', () => {
  const turns = (n: number) => Array.from({ length: n }, (_, i) => [{ role: 'user' }, { role: 'assistant' }]).flat();

  it('never less than the first page', () => {
    expect(reconcileTurnLimit([])).toBe(RECONCILE_MIN_TURNS);
    expect(reconcileTurnLimit(turns(3))).toBe(RECONCILE_MIN_TURNS);
  });

  it('the rendered turns plus the one that just ended, after older pages were loaded', () => {
    expect(reconcileTurnLimit(turns(25))).toBe(26);
  });

  it('counts turns the way the server does: one per user-role message', () => {
    expect(reconcileTurnLimit([...turns(12), { role: 'system' }, { role: 'assistant' }])).toBe(13);
  });
});
