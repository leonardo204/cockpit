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
 *     intent is not in question.
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
}

export const initialStickState: StickState = { stuck: true, pending: false, height: 0 };

export type StickEvent =
  /** The user (or a programmatic write) moved the viewport. */
  | { kind: 'scroll'; metrics: ScrollMetrics }
  /** The content box changed size — a streamed delta, an appended segment, a
   *  growing subagent block, the reconcile after a run ends. */
  | { kind: 'content'; metrics: ScrollMetrics }
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
      if (ev.metrics.clientHeight === 0) return { state: prev, write: 'none' };
      const stuck = isAtBottom(ev.metrics, tolerance);
      return {
        // Returning to the bottom re-engages the stick AND consumes the chip:
        // the user has now seen the newest content, so there is nothing to
        // offer them a jump to.
        state: { stuck, pending: stuck ? false : prev.pending, height: ev.metrics.scrollHeight },
        // Never write during a scroll. Any correction here would be fighting
        // the user's own wheel.
        write: 'none',
      };
    }
    case 'content': {
      if (ev.metrics.clientHeight === 0) return { state: prev, write: 'none' };
      const grew = ev.metrics.scrollHeight > prev.height;
      if (prev.stuck) {
        return {
          state: { stuck: true, pending: false, height: ev.metrics.scrollHeight },
          // `instant`, never `smooth`: a smooth scroll restarted by every
          // 50ms delta flush never arrives, which looks exactly like the
          // stuck-in-the-middle bug this replaces.
          write: grew ? 'instant' : 'none',
        };
      }
      return {
        state: { stuck: false, pending: prev.pending || grew, height: ev.metrics.scrollHeight },
        write: 'none',
      };
    }
    case 'send':
      return { state: { stuck: true, pending: false, height: prev.height }, write: 'instant' };
    case 'jump':
      // Smooth here and only here: one deliberate click, so the animation
      // carries the sense of travel instead of teleporting the user.
      return { state: { stuck: true, pending: false, height: prev.height }, write: 'smooth' };
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
