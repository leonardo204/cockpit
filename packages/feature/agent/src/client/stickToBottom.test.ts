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
    let state: StickState = { stuck: true, pending: false, height: 900, scrollTop: 400, travelling: false };
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
    const d = reduceStick({ stuck: true, pending: false, height: 900, scrollTop: 400, travelling: false }, {
      kind: 'content',
      metrics: metrics(400, 1000),
    });
    expect(d.write).toBe('instant');
  });

  it('a re-measure of unchanged content writes nothing', () => {
    // A reconcile that swaps live ids for canonical uuids changes the array
    // but not the layout; scrolling for it would be a pointless write.
    const d = reduceStick({ stuck: true, pending: false, height: 1000, scrollTop: 500, travelling: false }, {
      kind: 'content',
      metrics: metrics(500, 1000),
    });
    expect(d.write).toBe('none');
    expect(d.state.stuck).toBe(true);
  });
});

describe('reduceStick — the user scrolled up', () => {
  // Pinned at the bottom of a 2000px transcript and MEASURED there — the state
  // every scroll-up below starts from. (The pristine `initialStickState` has
  // never been measured, and a scroll away from it cannot be told from the
  // reset write landing.)
  const AT_BOTTOM: StickState = { ...initialStickState, height: 2000, scrollTop: 1500 };

  it('scrolling up detaches the stick and moves nothing', () => {
    const d = reduceStick(AT_BOTTOM, { kind: 'scroll', metrics: metrics(200, 2000) });
    expect(d.state.stuck).toBe(false);
    expect(d.write).toBe('none');
  });

  it('READING HISTORY IS SACRED: growth while detached never writes', () => {
    const { state, write } = run(
      AT_BOTTOM,
      { kind: 'scroll', metrics: metrics(200, 2000) },
      { kind: 'content', metrics: metrics(200, 2600) },
      { kind: 'content', metrics: metrics(200, 3200) },
    );
    expect(write).toBe('none');
    expect(state.stuck).toBe(false);
  });

  it('growth while detached raises the chip', () => {
    const { state } = run(
      AT_BOTTOM,
      { kind: 'scroll', metrics: metrics(200, 2000) },
      { kind: 'content', metrics: metrics(200, 2600) },
    );
    expect(shouldShowJumpChip(state)).toBe(true);
  });

  it('scrolled up with NOTHING new offers no chip', () => {
    // There is nothing to jump TO yet — the plain jump-to-latest control still
    // covers "take me back down", but a "new response" chip would be a lie.
    const { state } = run(AT_BOTTOM, { kind: 'scroll', metrics: metrics(200, 2000) });
    expect(shouldShowJumpChip(state)).toBe(false);
  });

  it('a scroll that does not reach the bottom keeps the chip up', () => {
    const { state } = run(
      AT_BOTTOM,
      { kind: 'scroll', metrics: metrics(200, 2000) },
      { kind: 'content', metrics: metrics(200, 2600) },
      { kind: 'scroll', metrics: metrics(900, 2600) },
    );
    expect(state.stuck).toBe(false);
    expect(shouldShowJumpChip(state)).toBe(true);
  });

  it('scrolling back down by hand re-engages the stick and clears the chip', () => {
    const { state } = run(
      AT_BOTTOM,
      { kind: 'scroll', metrics: metrics(200, 2000) },
      { kind: 'content', metrics: metrics(200, 2600) },
      { kind: 'scroll', metrics: metrics(2100, 2600) },
    );
    expect(state.stuck).toBe(true);
    expect(shouldShowJumpChip(state)).toBe(false);
  });

  it('the chip re-engages the stick, and travels smoothly', () => {
    const detached = run(
      AT_BOTTOM,
      { kind: 'scroll', metrics: metrics(200, 2000) },
      { kind: 'content', metrics: metrics(200, 2600) },
    ).state;
    const d = reduceStick(detached, { kind: 'jump' });
    expect(d.write).toBe('smooth');
    expect(d.state.stuck).toBe(true);
    expect(shouldShowJumpChip(d.state)).toBe(false);
    // A delta while the animation is still travelling is not chased (it would
    // cut the travel short); the arrival settles it, and from there the next
    // delta follows the answer again.
    expect(reduceStick(d.state, { kind: 'content', metrics: metrics(2200, 3000) }).write).toBe('none');
    const landed = run(
      d.state,
      { kind: 'content', metrics: metrics(2200, 3000) },
      { kind: 'arrived', metrics: metrics(2100, 3000) },
    );
    expect(landed.write).toBe('instant');
    expect(reduceStick(landed.state, { kind: 'content', metrics: metrics(2500, 3400) }).write).toBe('instant');
  });
});

describe('reduceStick — our own write, outrun by the content', () => {
  // THE SECOND REPORT. "응답 이후에 새로운 요청을 하면 스크롤해야 응답을 볼 수 있다."
  // The list came unstuck with nobody touching it. The scroll event that
  // follows a programmatic write is dispatched a frame later, and by then a
  // delta, a tool block or a system-event bar has landed below the write —
  // so the handler measured "not at the bottom" and read it as the user
  // reading history. From there nothing ever moved the view again.
  const pinned: StickState = { ...initialStickState, height: 2000, scrollTop: 1500 };

  it('THE REPORT: a scroll event that did not move up, from a pinned list, re-pins', () => {
    const { state, write } = run(
      pinned,
      { kind: 'content', metrics: metrics(1500, 2600) }, // grew → instant write
      { kind: 'wrote', scrollTop: 2100 },                // the browser landed here
      { kind: 'scroll', metrics: metrics(2100, 2800) },  // …and 200px more arrived first
    );
    expect(state.stuck).toBe(true);
    expect(shouldShowJumpChip(state)).toBe(false);
    expect(write).toBe('instant');
  });

  it('a wheel up straight after the write still detaches', () => {
    const { state, write } = run(
      pinned,
      { kind: 'wrote', scrollTop: 2100 },
      { kind: 'scroll', metrics: metrics(1900, 2800) },
    );
    expect(state.stuck).toBe(false);
    expect(write).toBe('none');
  });

  it('a wheel up that coalesced with the write is a wheel up', () => {
    // The browser folds a write and a wheel in the same frame into one event;
    // it reports less than the write, which is the user speaking.
    const { state } = run(
      pinned,
      { kind: 'content', metrics: metrics(1500, 2600) },
      { kind: 'wrote', scrollTop: 2100 },
      { kind: 'scroll', metrics: metrics(1950, 2600) },
    );
    expect(state.stuck).toBe(false);
  });

  it('the clamp after content shrinks keeps the stick', () => {
    // The thinking bubble goes, the browser pulls scrollTop back to the new
    // maximum. Down in absolute terms, but at the bottom.
    const d = reduceStick(pinned, { kind: 'scroll', metrics: metrics(1200, 1700) });
    expect(d.state.stuck).toBe(true);
    expect(d.write).toBe('none');
  });

  it('wheeling down toward the bottom while detached stays detached', () => {
    const reading: StickState = { stuck: false, pending: true, height: 2000, scrollTop: 200, travelling: false };
    const d = reduceStick(reading, { kind: 'scroll', metrics: metrics(600, 2000) });
    expect(d.state.stuck).toBe(false);
    expect(shouldShowJumpChip(d.state)).toBe(true);
    expect(d.write).toBe('none');
  });
});

describe('reduceStick — a smooth jump travels, then arrives', () => {
  const reading: StickState = { stuck: false, pending: true, height: 2000, scrollTop: 200, travelling: false };

  it('its own scroll events do not cut it short', () => {
    const { state, write } = run(
      reading,
      { kind: 'jump' },
      { kind: 'scroll', metrics: metrics(600, 2000) },
      { kind: 'scroll', metrics: metrics(1100, 2000) },
    );
    expect(state.stuck).toBe(true);
    expect(state.travelling).toBe(true);
    expect(write).toBe('none');
  });

  it('reaching the bottom ends the journey', () => {
    const { state } = run(reading, { kind: 'jump' }, { kind: 'scroll', metrics: metrics(1500, 2000) });
    expect(state.travelling).toBe(false);
    expect(state.stuck).toBe(true);
  });

  it('growth in flight is not chased, and is corrected on arrival', () => {
    const inFlight = run(
      reading,
      { kind: 'jump' },
      { kind: 'scroll', metrics: metrics(600, 2000) },
      { kind: 'content', metrics: metrics(600, 2600) },
    );
    expect(inFlight.write).toBe('none');
    const landed = reduceStick(inFlight.state, { kind: 'arrived', metrics: metrics(1500, 2600) });
    expect(landed.state.travelling).toBe(false);
    expect(landed.write).toBe('instant');
  });

  it('an arrival the tab could not measure still ends the journey', () => {
    // The tab was hidden before the animation finished. Left "travelling",
    // every later growth would be silently unchased — pinned, so no chip.
    const { state, write } = run(
      reading,
      { kind: 'jump' },
      { kind: 'arrived', metrics: metrics(0, 0, 0) },
    );
    expect(state.travelling).toBe(false);
    expect(state.stuck).toBe(true);
    expect(write).toBe('none');
  });

  it('a wheel up mid-flight is the user, and wins', () => {
    const { state } = run(
      reading,
      { kind: 'jump' },
      { kind: 'scroll', metrics: metrics(600, 2000) },
      { kind: 'scroll', metrics: metrics(400, 2000) },
    );
    expect(state.stuck).toBe(false);
    expect(state.travelling).toBe(false);
  });
});

describe('reduceStick — the viewport shrank under a growing composer', () => {
  /**
   * THE SECOND REPORT. "엔터로 여러 줄을 입력하면 입력창이 커지면서 질문/답변
   * 영역을 덮어버린다" — the input grows as you type a second line and the last
   * messages disappear behind it.
   *
   * WHAT IS ACTUALLY HAPPENING. Nothing is drawn on top of anything: the
   * transcript and the composer share one flex column, so the composer's extra
   * lines come off the BOTTOM of the list's viewport. `scrollHeight` is
   * unchanged, `scrollTop` is unchanged, `clientHeight` fell — and the pixels
   * that fell off the bottom are exactly the newest message. The content
   * observer cannot see this: by its measure nothing happened.
   */

  it('THE REPORT: a pinned list re-pins when the composer takes 124px', () => {
    // Pinned at the bottom of a 500px viewport over 2000px of transcript…
    const pinned: StickState = { stuck: true, pending: false, height: 2000, scrollTop: 1500, travelling: false };
    // …the composer grows from 1 line to 10, so the viewport is now 376px. The
    // content did not move: scrollHeight is still 2000, scrollTop still 1500.
    const d = reduceStick(pinned, { kind: 'viewport', metrics: metrics(1500, 2000, 376) });
    expect(d.write).toBe('instant');
    expect(d.state.stuck).toBe(true);
  });

  it('the content observer would have said nothing — which is the bug', () => {
    // The same measurements as a `content` event: no growth, so no write. This
    // is why a separate event kind exists rather than another call into the old
    // one.
    const pinned: StickState = { stuck: true, pending: false, height: 2000, scrollTop: 1500, travelling: false };
    expect(reduceStick(pinned, { kind: 'content', metrics: metrics(1500, 2000, 376) }).write).toBe('none');
  });

  it('a shrinking viewport does not unstick a user who never scrolled', () => {
    // distanceFromBottom is now 124 — past the 96px tolerance. Re-deriving
    // `stuck` from the metrics here would detach a pinned list for the crime of
    // typing a second line, and the next delta would raise a "new response"
    // chip for an answer already on screen.
    const pinned: StickState = { stuck: true, pending: false, height: 2000, scrollTop: 1500, travelling: false };
    const d = reduceStick(pinned, { kind: 'viewport', metrics: metrics(1500, 2000, 376) });
    expect(d.state.stuck).toBe(true);
    expect(shouldShowJumpChip(d.state)).toBe(false);
  });

  it('READING HISTORY IS STILL SACRED: no write while scrolled up', () => {
    // scrollTop is measured from the TOP, so a shorter viewport does not move
    // what they are reading. Any correction would.
    const reading: StickState = { stuck: false, pending: true, height: 2000, scrollTop: 400, travelling: false };
    const d = reduceStick(reading, { kind: 'viewport', metrics: metrics(400, 2000, 376) });
    expect(d.write).toBe('none');
    expect(d.state.stuck).toBe(false);
    // …and the chip they have not clicked yet is still owed to them.
    expect(shouldShowJumpChip(d.state)).toBe(true);
  });

  it('a reflow caused by the resize is not mistaken for new content', () => {
    // A width change rewraps the transcript, so scrollHeight moves without a
    // single new token. Re-baselining here keeps that out of the `grew` test.
    const reading: StickState = { stuck: false, pending: false, height: 2000, scrollTop: 400, travelling: false };
    const after = reduceStick(reading, { kind: 'viewport', metrics: metrics(400, 2200, 376) }).state;
    expect(after.height).toBe(2200);
    expect(shouldShowJumpChip(after)).toBe(false);
  });

  it('the composer collapsing again re-pins too', () => {
    // Send clears the input, the box returns to one line, the viewport grows.
    const pinned: StickState = { stuck: true, pending: false, height: 2000, scrollTop: 1500, travelling: false };
    expect(reduceStick(pinned, { kind: 'viewport', metrics: metrics(1500, 2000, 500) }).write).toBe('instant');
  });

  it('a hidden tab is not measured here either', () => {
    const detached: StickState = { stuck: false, pending: true, height: 2600, scrollTop: 200, travelling: false };
    const d = reduceStick(detached, { kind: 'viewport', metrics: metrics(0, 0, 0) });
    expect(d.state).toEqual(detached);
    expect(d.write).toBe('none');
  });
});

describe('reduceStick — send', () => {
  it('sending pins, whatever the user was reading', () => {
    const detached = run(
      { ...initialStickState, height: 4000, scrollTop: 3500 },
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
    const detached: StickState = { stuck: false, pending: true, height: 2600, scrollTop: 200, travelling: false };
    const d = reduceStick(detached, { kind: 'content', metrics: hidden });
    expect(d.state).toEqual(detached);
    expect(d.write).toBe('none');
  });

  it('a scroll event from a hidden tab changes nothing', () => {
    const detached: StickState = { stuck: false, pending: true, height: 2600, scrollTop: 200, travelling: false };
    const d = reduceStick(detached, { kind: 'scroll', metrics: hidden });
    expect(d.state).toEqual(detached);
    expect(d.write).toBe('none');
  });
});

describe('reduceStick — reset', () => {
  it('a fresh transcript lands at the newest message', () => {
    const d = reduceStick({ stuck: false, pending: true, height: 9000, scrollTop: 200, travelling: false }, { kind: 'reset' });
    expect(d.state).toEqual(initialStickState);
    expect(d.write).toBe('instant');
  });
});
