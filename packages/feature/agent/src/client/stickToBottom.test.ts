import { describe, it, expect } from 'vitest';
import {
  BOTTOM_TOLERANCE_PX,
  distanceFromBottom,
  isAtBottom,
  initialStickState,
  reduceStick,
  shouldShowJumpChip,
  type ScrollMetrics,
  type StickState,
} from './stickToBottom';

/**
 * STICK TO BOTTOM — the transcript following a streamed answer.
 *
 * THE REPORT. "스크롤이 중간에 멈춰 있어서 새로운 응답이 온지 아닌지 헷갈림."
 *
 * THE BUG BEING PINNED. The old MessageList scrolled only when
 * `messages.length` grew. A streamed answer never grows the array — it rewrites
 * the LAST message, delta after delta — so the list scrolled once, when the
 * empty assistant bubble appeared, and then never again. Case 2 below is that
 * exact scenario, and it is the one that used to fail.
 *
 * What is pinned here is the whole user-visible contract:
 *   1. at the bottom → stay at the bottom, on every growth;
 *   2. growth WITHOUT a message-count change still scrolls (the report);
 *   3. scrolled up → the viewport is never moved for them;
 *   4. new content while scrolled up → the chip, and only then;
 *   5. the chip re-engages the stick; so does scrolling back down by hand;
 *   6. send always pins, whatever the user was reading;
 *   7. a hidden tab (every metric 0) is not measured at all.
 */

/** A container 500px tall whose content is `height`, scrolled to `top`. */
function metrics(top: number, height: number, client = 500): ScrollMetrics {
  return { scrollTop: top, scrollHeight: height, clientHeight: client };
}

/** Run a sequence of events from a starting state, returning the last decision. */
function run(start: StickState, ...events: Parameters<typeof reduceStick>[1][]) {
  let state = start;
  let write: ReturnType<typeof reduceStick>['write'] = 'none';
  for (const ev of events) {
    const d = reduceStick(state, ev);
    state = d.state;
    write = d.write;
  }
  return { state, write };
}

describe('distanceFromBottom / isAtBottom', () => {
  it('measures the content still below the fold', () => {
    expect(distanceFromBottom(metrics(0, 2000))).toBe(1500);
    expect(distanceFromBottom(metrics(1500, 2000))).toBe(0);
  });

  it('never reports a negative distance (overscroll / rubber-banding)', () => {
    expect(distanceFromBottom(metrics(1600, 2000))).toBe(0);
  });

  it('content shorter than the viewport is always at the bottom', () => {
    expect(isAtBottom(metrics(0, 200))).toBe(true);
  });

  it('a few pixels short still counts as the bottom', () => {
    // Sub-pixel layout, a late-measuring code block, an image that just
    // decoded — an exact test would unstick a user who never scrolled.
    expect(isAtBottom(metrics(1500 - (BOTTOM_TOLERANCE_PX - 1), 2000))).toBe(true);
  });

  it('a screenful up is not the bottom', () => {
    expect(isAtBottom(metrics(1000, 2000))).toBe(false);
  });
});

describe('reduceStick — pinned at the bottom', () => {
  it('starts pinned', () => {
    expect(initialStickState.stuck).toBe(true);
    expect(shouldShowJumpChip(initialStickState)).toBe(false);
  });

  it('THE REPORT: a growth with no new message still scrolls', () => {
    // One assistant bubble, already on screen, now being filled token by token.
    // The array length is identical across all of these; only the box grows.
    let state: StickState = { stuck: true, pending: false, height: 900 };
    for (const h of [980, 1100, 1400, 2000]) {
      const d = reduceStick(state, { kind: 'content', metrics: metrics(h - 500, h) });
      expect(d.write).toBe('instant');
      expect(d.state.stuck).toBe(true);
      state = d.state;
    }
    expect(shouldShowJumpChip(state)).toBe(false);
  });

  it('writes instantly, never smoothly, while streaming', () => {
    // A smooth scroll restarted by every 50ms delta flush never arrives —
    // which looks exactly like the bug being fixed.
    const d = reduceStick({ stuck: true, pending: false, height: 900 }, {
      kind: 'content',
      metrics: metrics(400, 1000),
    });
    expect(d.write).toBe('instant');
  });

  it('a re-measure of unchanged content writes nothing', () => {
    // A reconcile that swaps live ids for canonical uuids changes the array
    // but not the layout; scrolling for it would be a pointless write.
    const d = reduceStick({ stuck: true, pending: false, height: 1000 }, {
      kind: 'content',
      metrics: metrics(500, 1000),
    });
    expect(d.write).toBe('none');
    expect(d.state.stuck).toBe(true);
  });
});

describe('reduceStick — the user scrolled up', () => {
  it('scrolling up detaches the stick and moves nothing', () => {
    const d = reduceStick(initialStickState, { kind: 'scroll', metrics: metrics(200, 2000) });
    expect(d.state.stuck).toBe(false);
    expect(d.write).toBe('none');
  });

  it('READING HISTORY IS SACRED: growth while detached never writes', () => {
    const { state, write } = run(
      initialStickState,
      { kind: 'scroll', metrics: metrics(200, 2000) },
      { kind: 'content', metrics: metrics(200, 2600) },
      { kind: 'content', metrics: metrics(200, 3200) },
    );
    expect(write).toBe('none');
    expect(state.stuck).toBe(false);
  });

  it('growth while detached raises the chip', () => {
    const { state } = run(
      initialStickState,
      { kind: 'scroll', metrics: metrics(200, 2000) },
      { kind: 'content', metrics: metrics(200, 2600) },
    );
    expect(shouldShowJumpChip(state)).toBe(true);
  });

  it('scrolled up with NOTHING new offers no chip', () => {
    // There is nothing to jump TO yet — the plain jump-to-latest control still
    // covers "take me back down", but a "new response" chip would be a lie.
    const { state } = run(initialStickState, { kind: 'scroll', metrics: metrics(200, 2000) });
    expect(shouldShowJumpChip(state)).toBe(false);
  });

  it('a scroll that does not reach the bottom keeps the chip up', () => {
    const { state } = run(
      initialStickState,
      { kind: 'scroll', metrics: metrics(200, 2000) },
      { kind: 'content', metrics: metrics(200, 2600) },
      { kind: 'scroll', metrics: metrics(900, 2600) },
    );
    expect(state.stuck).toBe(false);
    expect(shouldShowJumpChip(state)).toBe(true);
  });

  it('scrolling back down by hand re-engages the stick and clears the chip', () => {
    const { state } = run(
      initialStickState,
      { kind: 'scroll', metrics: metrics(200, 2000) },
      { kind: 'content', metrics: metrics(200, 2600) },
      { kind: 'scroll', metrics: metrics(2100, 2600) },
    );
    expect(state.stuck).toBe(true);
    expect(shouldShowJumpChip(state)).toBe(false);
  });

  it('the chip re-engages the stick, and travels smoothly', () => {
    const detached = run(
      initialStickState,
      { kind: 'scroll', metrics: metrics(200, 2000) },
      { kind: 'content', metrics: metrics(200, 2600) },
    ).state;
    const d = reduceStick(detached, { kind: 'jump' });
    expect(d.write).toBe('smooth');
    expect(d.state.stuck).toBe(true);
    expect(shouldShowJumpChip(d.state)).toBe(false);
    // …and from there the next delta follows the answer again.
    expect(reduceStick(d.state, { kind: 'content', metrics: metrics(2200, 3000) }).write).toBe('instant');
  });
});

describe('reduceStick — send', () => {
  it('sending pins, whatever the user was reading', () => {
    const detached = run(
      initialStickState,
      { kind: 'scroll', metrics: metrics(0, 4000) },
      { kind: 'content', metrics: metrics(0, 4400) },
    ).state;
    expect(detached.stuck).toBe(false);
    const d = reduceStick(detached, { kind: 'send' });
    // Their own action states the intent; nothing to infer.
    expect(d.write).toBe('instant');
    expect(d.state.stuck).toBe(true);
    expect(shouldShowJumpChip(d.state)).toBe(false);
  });
});

describe('reduceStick — a hidden tab is not measured', () => {
  // TabManager keeps every chat tab mounted and hides the inactive ones with
  // `display:none`, where scrollTop/scrollHeight/clientHeight all read 0 — and
  // 0/0/0 satisfies "at bottom". Measuring one would silently re-pin a
  // conversation the user had scrolled up in.
  const hidden = metrics(0, 0, 0);

  it('a content event from a hidden tab changes nothing', () => {
    const detached: StickState = { stuck: false, pending: true, height: 2600 };
    const d = reduceStick(detached, { kind: 'content', metrics: hidden });
    expect(d.state).toEqual(detached);
    expect(d.write).toBe('none');
  });

  it('a scroll event from a hidden tab changes nothing', () => {
    const detached: StickState = { stuck: false, pending: true, height: 2600 };
    const d = reduceStick(detached, { kind: 'scroll', metrics: hidden });
    expect(d.state).toEqual(detached);
    expect(d.write).toBe('none');
  });
});

describe('reduceStick — reset', () => {
  it('a fresh transcript lands at the newest message', () => {
    const d = reduceStick({ stuck: false, pending: true, height: 9000 }, { kind: 'reset' });
    expect(d.state).toEqual(initialStickState);
    expect(d.write).toBe('instant');
  });
});
