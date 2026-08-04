/**
 * runSignal — what ONE /ws/session-stream message says about "is naby working
 * on this session right now".
 *
 * WHY IT IS ITS OWN FUNCTION. The answer used to be spread across the branches
 * of `useLiveStream`'s socket handler, tangled up with the transcript-rebuilding
 * logic that lives in the same place — and it was WRONG for the case that
 * matters most to a user: a tab opened onto a session whose turn is already
 * under way (the fast-growth kickoff, a Telegram-linked session, a scheduled
 * task). Untangled and pure, it is testable without a DOM, and the indicator's
 * behaviour is pinned by cases rather than by clicking.
 *
 * The transcript side (which events become bubbles) stays in the hook: it is
 * stateful by nature. This is only the answer to "spinner: on or off".
 */

/** The two things a stream message can change. */
export interface RunSignal {
  /** Is a turn in flight for this session? Drives the typing indicator and the
   *  input lock. */
  running: boolean;
  /** Did a turn just END? Drives the reconcile-from-disk that replaces the live
   *  bubbles with their canonical rows — and, just as importantly, is what
   *  clears the indicator when the run finished between the attach and now. */
  complete: boolean;
}

/** The subset of a stream message this decision reads. */
export interface RunStreamMessage {
  type?: string;
  status?: string;
  message?: { type?: string };
}

/**
 * Map a stream message to the indicator state, or `null` for messages that say
 * nothing about it (`ping`, anything unrecognised — an unknown message must
 * never be read as "the turn ended").
 */
export function runSignalFor(msg: RunStreamMessage | null | undefined): RunSignal | null {
  if (!msg || typeof msg.type !== 'string') return null;
  switch (msg.type) {
    // The attach found a live turn: its backlog is replayed and it is running.
    case 'run-snapshot':
      return { running: msg.status === 'running', complete: false };
    // The attach found a turn that has been RESERVED but has not started yet —
    // the window the fast-growth kickoff opens its tab in. Nothing has streamed,
    // and nothing is on disk, so this message is the only evidence the user has
    // that anything is happening at all.
    case 'run-pending':
      return { running: true, complete: false };
    case 'run-idle':
      return { running: false, complete: false };
    case 'run-event':
      // `run-ended` is the single definitive end signal — engines emit several
      // intermediate `result`s (codex = one per turn), so only this ends the turn.
      // It is also what a DROPPED reservation sends, which is what stops a
      // dispatch that never started from leaving the indicator on forever.
      return msg.message?.type === 'run-ended'
        ? { running: false, complete: true }
        : { running: true, complete: false };
    default:
      return null;
  }
}
