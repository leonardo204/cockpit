/**
 * stickToBottom — the "does the transcript follow the answer" decision, as a
 * pure state machine.
 *
 * THE REPORT. "스크롤이 중간에 멈춰 있어서 새로운 응답이 온지 아닌지 헷갈림" — the
 * view freezes partway through a reply and the user cannot tell whether naby is
 * still writing or has stopped.
 *
 * THE CAUSE. The old rule in MessageList was `if (shouldAutoScroll && messages
 * .length > prevLength) scrollIntoView()`. A streamed answer does not change
 * `messages.length`: every delta, every appended segment, every subagent block
 * REWRITES THE LAST MESSAGE. So the list scrolled exactly once — when the empty
 * assistant bubble was pushed — and then sat still for the entire answer, while
 * the text it was supposed to be showing grew off the bottom of the viewport.
 *
 * THE RULE, which is the IDE/chat convention and not an invention:
 *   • at (or near) the bottom  → every growth keeps the view pinned there;
 *   • scrolled up              → NOTHING moves the viewport. Reading history is
 *     the user's, and yanking them to the newest token is the one behaviour a
 *     transcript must never have. New content raises a "↓ new response" chip
 *     instead, and the chip — a deliberate click — re-engages the stick;
 *   • the user sends           → pin unconditionally. They just acted; their
 *     intent is not in question;
 *   • the VIEWPORT shrinks     → a pinned list re-pins. The composer grows as
 *     the user types a second line and takes those pixels from the bottom of
 *     the transcript; without this the last message hides behind it, which
 *     reads as the input having been drawn ON TOP of the conversation.
 *   • our own write, outrun    → a scroll event that did NOT move the view up
 *     is never the user reading history — it is content that landed between
 *     our write and the browser reporting it — so a pinned list writes again
 *     instead of detaching. (The second report; see the `scroll` case.)
 *
 * WHY A NEAR-BOTTOM TOLERANCE. Exact equality is unreachable in practice:
 * sub-pixel layout, a lazily measured code block, an image that finishes
 * decoding — each leaves a few pixels between the scroll position and the true
 * bottom, and an exact test would silently unstick a user who never scrolled.
 *
 * WHY IT IS PURE. jsdom has no layout, so a rendered test could not tell a
 * pinned list from a detached one — every metric would read 0. Kept as a
 * reducer over measured numbers, the whole contract is pinned by cases, and the
 * component is left with only "measure, then obey".
 */

/**
 * How close to the bottom still counts as being AT it. ~1 line of chat text
 * plus the sub-pixel slack described above.
 */
export const BOTTOM_TOLERANCE_PX = 96;

/** The three numbers a scroll container reports. */
export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Pixels of content still below the viewport. Never negative. */
export function distanceFromBottom(m: ScrollMetrics): number {
  return Math.max(0, m.scrollHeight - m.scrollTop - m.clientHeight);
}

/** Is the view at (or within `tolerance` of) the bottom? */
export function isAtBottom(m: ScrollMetrics, tolerance: number = BOTTOM_TOLERANCE_PX): boolean {
  return distanceFromBottom(m) <= tolerance;
}

export interface StickState {
  /** Pinned: growth keeps the newest content in view. */
  stuck: boolean;
  /** Content arrived while detached — so the jump chip has something to offer.
   *  Distinct from `!stuck`: a user who scrolled up and has been shown nothing
   *  new since gets no chip, because there is nothing new to jump to. */
  pending: boolean;
  /** Last observed scrollHeight, so a real GROWTH can be told from a re-measure
   *  of unchanged content (a resize, a reconcile that swaps ids but no text). */
  height: number;
  /**
   * Where the viewport was when last MEASURED OR WRITTEN. This is what tells a
   * scroll event the user made from one our own write produced — see the
   * `scroll` case for the second report, the one this field closes.
   */
  scrollTop: number;
  /**
   * A smooth jump is on its way. While it travels, its own scroll events must
   * not be read as "content outran the write" and answered with an instant hop
   * that cuts the animation short; the `arrived` event settles the difference.
   */
  travelling: boolean;
}

export const initialStickState: StickState = {
  stuck: true,
  pending: false,
  height: 0,
  scrollTop: 0,
  travelling: false,
};

export type StickEvent =
  /** The user (or a programmatic write) moved the viewport. */
  | { kind: 'scroll'; metrics: ScrollMetrics }
  /** The caller just wrote `scrollTop` — the position the browser actually
   *  landed on, after clamping. Recorded so the scroll event that follows can
   *  be recognised as ours. */
  | { kind: 'wrote'; scrollTop: number }
  /** A smooth jump finished travelling (`scrollend`, or a fallback timer). */
  | { kind: 'arrived'; metrics: ScrollMetrics }
  /** The content box changed size — a streamed delta, an appended segment, a
   *  growing subagent block, the reconcile after a run ends. */
  | { kind: 'content'; metrics: ScrollMetrics }
  /** THE VIEWPORT ITSELF changed size, with the content untouched: the composer
   *  grew as the user typed a second line, a banner appeared above it, the
   *  window was resized. The transcript and the composer share one flex column,
   *  so every pixel the composer takes is a pixel the list loses FROM THE
   *  BOTTOM — and `scrollTop` does not move on its own, so the newest message
   *  silently slides out of view behind the taller input. Content-size events
   *  cannot stand in for this: `scrollHeight` is identical before and after. */
  | { kind: 'viewport'; metrics: ScrollMetrics }
  /** The user pressed send. */
  | { kind: 'send' }
  /** The user clicked the jump-to-latest chip/button. */
  | { kind: 'jump' }
  /** Fresh transcript (initial load): land at the newest message. */
  | { kind: 'reset' };

/** What the caller should do to the scroll position, if anything. */
export type ScrollWrite = 'none' | 'instant' | 'smooth';

export interface StickDecision {
  state: StickState;
  write: ScrollWrite;
}

/**
 * Advance the stick state. The caller performs `decision.write` and stores
 * `decision.state`; it makes no scroll decisions of its own.
 *
 * `content` events whose metrics are unmeasurable (`clientHeight === 0`) are
 * IGNORED rather than interpreted. A background chat tab is rendered with
 * `display:none` (TabManager keeps every tab mounted), where every box metric
 * reads 0 — and 0/0/0 satisfies "at bottom", so measuring a hidden tab would
 * quietly re-pin a conversation the user had scrolled up in.
 */
export function reduceStick(
  prev: StickState,
  ev: StickEvent,
  tolerance: number = BOTTOM_TOLERANCE_PX,
): StickDecision {
  switch (ev.kind) {
    case 'scroll': {
      const m = ev.metrics;
      if (m.clientHeight === 0) return { state: prev, write: 'none' };
      const measured = { height: m.scrollHeight, scrollTop: m.scrollTop };
      if (isAtBottom(m, tolerance)) {
        // Returning to the bottom re-engages the stick AND consumes the chip:
        // the user has now seen the newest content, so there is nothing to
        // offer them a jump to. A jump that was travelling has landed.
        return {
          state: { stuck: true, pending: false, travelling: false, ...measured },
          write: 'none',
        };
      }
      // THE SECOND REPORT. "응답 이후에 새로운 요청을 하면 스크롤해야 응답을 볼 수
      // 있다" — every so often the transcript came unstuck with nobody touching
      // it. The scroll event that followed OUR OWN write was the culprit: the
      // write lands, then a delta, a tool block or a system-event bar lands
      // before the browser dispatches that event, and by the time the handler
      // measures, the bottom has moved past the tolerance. The old rule read
      // any not-at-bottom scroll as the user reading history, and from there
      // "reading history is sacred" kept the view exactly where it was.
      //
      // The tell is DIRECTION. A user reading history moves the viewport UP;
      // our writes only ever move it down, and content growing under a write
      // leaves it where the write put it. So a scroll that did not move up,
      // from a pinned state, is content outrunning us — and the answer is to
      // write again, which is not fighting anyone's wheel.
      const movedUp = m.scrollTop < prev.scrollTop;
      if (movedUp || !prev.stuck) {
        return {
          state: { stuck: false, pending: prev.pending, travelling: false, ...measured },
          // Never write for a user's own scroll.
          write: 'none',
        };
      }
      if (prev.travelling) {
        // The smooth jump's own progress. Let it arrive.
        return { state: { ...prev, ...measured }, write: 'none' };
      }
      return { state: { stuck: true, pending: false, travelling: false, ...measured }, write: 'instant' };
    }
    case 'wrote':
      return { state: { ...prev, scrollTop: ev.scrollTop }, write: 'none' };
    case 'arrived': {
      const m = ev.metrics;
      if (m.clientHeight === 0) return { state: { ...prev, travelling: false }, write: 'none' };
      const measured = { height: m.scrollHeight, scrollTop: m.scrollTop };
      // Content that grew while the animation was in flight was deliberately
      // not chased (see `content`); one corrective hop now, if it is owed.
      const short = prev.stuck && !isAtBottom(m, tolerance);
      return { state: { ...prev, travelling: false, ...measured }, write: short ? 'instant' : 'none' };
    }
    case 'content': {
      const m = ev.metrics;
      if (m.clientHeight === 0) return { state: prev, write: 'none' };
      const grew = m.scrollHeight > prev.height;
      const measured = { height: m.scrollHeight, scrollTop: m.scrollTop };
      if (prev.stuck) {
        return {
          state: { stuck: true, pending: false, travelling: prev.travelling, ...measured },
          // `instant`, never `smooth`: a smooth scroll restarted by every
          // 50ms delta flush never arrives, which looks exactly like the
          // stuck-in-the-middle bug this replaces. And nothing at all while a
          // jump is travelling — `arrived` settles whatever it missed.
          write: grew && !prev.travelling ? 'instant' : 'none',
        };
      }
      return {
        state: { stuck: false, pending: prev.pending || grew, travelling: false, ...measured },
        write: 'none',
      };
    }
    case 'viewport': {
      const m = ev.metrics;
      if (m.clientHeight === 0) return { state: prev, write: 'none' };
      if (prev.stuck) {
        // Pinned, and the floor just rose. Re-pin unconditionally — NOT on a
        // `grew` test: a viewport shrink leaves `scrollHeight` exactly where it
        // was, which is the whole reason the content observer misses this.
        return {
          state: { ...prev, pending: false, height: m.scrollHeight, scrollTop: m.scrollTop },
          write: prev.travelling ? 'none' : 'instant',
        };
      }
      // Scrolled up and reading. `scrollTop` is measured from the TOP, so a
      // viewport change does not move what they are looking at, and the one
      // thing we must not do is "help". We only re-baseline the height, so a
      // reflow caused by the resize is not mistaken for new content arriving.
      //
      // NOT re-derived from `isAtBottom` either: shrinking the viewport pushes
      // the distance-from-bottom up by the same pixels, which would spuriously
      // unstick a user who had never scrolled at all.
      return { state: { ...prev, height: m.scrollHeight, scrollTop: m.scrollTop }, write: 'none' };
    }
    case 'send':
      return { state: { ...prev, stuck: true, pending: false, travelling: false }, write: 'instant' };
    case 'jump':
      // Smooth here and only here: one deliberate click, so the animation
      // carries the sense of travel instead of teleporting the user.
      return { state: { ...prev, stuck: true, pending: false, travelling: true }, write: 'smooth' };
    case 'reset':
      return { state: { ...initialStickState }, write: 'instant' };
  }
}

/**
 * The floating "↓ new response" chip: offered only when the user is away from
 * the bottom AND something arrived while they were.
 */
export function shouldShowJumpChip(state: StickState): boolean {
  return !state.stuck && state.pending;
}
