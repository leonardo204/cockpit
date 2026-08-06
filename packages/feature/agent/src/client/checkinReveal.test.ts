import { describe, it, expect } from 'vitest';
import { reduceReveal, type RevealBanner } from './checkinReveal';

/**
 * THE CHECK-IN REVEAL BANNER, AND WHEN IT GOES AWAY.
 *
 * THE REPORT. "🦋 나비도 같은 것을 추천했습니다: …" appeared after a check-in and
 * then stayed — for the rest of the session, above the input, unless the user
 * found its ✕. A banner about a question answered twenty minutes ago was still
 * sitting over a conversation that had long moved on.
 *
 * THE RULE PINNED HERE. The banner belongs to the exchange that earned it:
 *   1. it appears when the user answers, showing the guess they answered against;
 *   2. it SURVIVES the rest of that turn — the check-in pauses a turn that is
 *      still running, so the run it was born in must not dismiss it;
 *   3. it goes when the conversation moves on: the next turn starting, whoever
 *      started it (a send, a Telegram message, a scheduled task);
 *   4. the ✕ still works, for anyone who wants it gone sooner;
 *   5. a new check-in supersedes it;
 *   6. no timer anywhere — content is never taken from a user mid-read.
 */

const answered = (run: number, over = { hit: true }) =>
  ({
    kind: 'answered' as const,
    question: 'Which way?',
    recommendedOption: 'the careful one',
    hit: over.hit,
    run,
  });

describe('reduceReveal — appearing', () => {
  it('answering reveals the recommendation, tagged with its turn', () => {
    const b = reduceReveal(null, answered(3));
    expect(b).toEqual({
      question: 'Which way?',
      recommendedOption: 'the careful one',
      hit: true,
      bornAtRun: 3,
    });
  });

  it('a miss is still revealed — that is the point of the meter', () => {
    expect(reduceReveal(null, answered(1, { hit: false }))?.hit).toBe(false);
  });

  it('a check-in with no recorded recommendation reveals nothing', () => {
    // An empty banner reads as a bug rather than as an absence.
    const b = reduceReveal(null, {
      kind: 'answered',
      question: 'Which way?',
      recommendedOption: '',
      hit: false,
      run: 2,
    });
    expect(b).toBeNull();
  });
});

describe('reduceReveal — surviving its own turn', () => {
  it('the run it was born in does NOT dismiss it', () => {
    // The check-in PAUSES a turn that is still running; answering resumes it.
    // A signal from that same turn arriving late must not erase the reveal the
    // instant it appears.
    const b = reduceReveal(null, answered(4))!;
    expect(reduceReveal(b, { kind: 'run-start', run: 4 })).toBe(b);
  });

  it('a stale signal from an older turn does not dismiss it either', () => {
    const b = reduceReveal(null, answered(4))!;
    expect(reduceReveal(b, { kind: 'run-start', run: 3 })).toBe(b);
  });
});

describe('reduceReveal — dismissing on conversation progression', () => {
  it('THE FIX: the next turn takes it down, with no click', () => {
    const b = reduceReveal(null, answered(4))!;
    expect(reduceReveal(b, { kind: 'run-start', run: 5 })).toBeNull();
  });

  it('a turn nobody on this screen sent takes it down too', () => {
    // The signal is "a turn started on this session", so a Telegram message or
    // a scheduled task moves the conversation on exactly as a send does.
    const b = reduceReveal(null, answered(1))!;
    expect(reduceReveal(b, { kind: 'run-start', run: 9 })).toBeNull();
  });

  it('run-start with nothing showing stays nothing', () => {
    expect(reduceReveal(null, { kind: 'run-start', run: 7 })).toBeNull();
  });
});

describe('reduceReveal — the manual close', () => {
  it('the ✕ still works', () => {
    const b = reduceReveal(null, answered(2))!;
    expect(reduceReveal(b, { kind: 'dismiss' })).toBeNull();
  });

  it('a new check-in supersedes the last reveal', () => {
    const b = reduceReveal(null, answered(2))!;
    expect(reduceReveal(b, { kind: 'question' })).toBeNull();
  });
});

describe('reduceReveal — a whole session', () => {
  it('answer → same turn finishes → next turn clears it', () => {
    let b: RevealBanner | null = null;
    b = reduceReveal(b, { kind: 'run-start', run: 1 }); // turn 1 starts
    b = reduceReveal(b, { kind: 'question' }); // naby asks
    b = reduceReveal(b, answered(1)); // the user picks; turn 1 resumes
    expect(b).not.toBeNull();
    b = reduceReveal(b, { kind: 'run-start', run: 1 }); // late signal, same turn
    expect(b).not.toBeNull(); // still readable through the whole answer
    b = reduceReveal(b, { kind: 'run-start', run: 2 }); // the user sends again
    expect(b).toBeNull();
  });

  it('two check-ins in a row each show their own reveal', () => {
    let b: RevealBanner | null = reduceReveal(null, answered(1));
    b = reduceReveal(b, { kind: 'question' });
    expect(b).toBeNull();
    b = reduceReveal(b, {
      kind: 'answered',
      question: 'And then?',
      recommendedOption: 'ship it',
      hit: false,
      run: 1,
    });
    expect(b?.recommendedOption).toBe('ship it');
    expect(b?.hit).toBe(false);
  });
});
