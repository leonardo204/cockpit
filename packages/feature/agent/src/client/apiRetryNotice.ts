/**
 * apiRetryNotice.ts — what to say while the SDK is retrying a request.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS NEEDED SAYING DIFFERENTLY
 *
 * The retry itself is not naby's: the Agent SDK retries 408, 409, 429 and every
 * 5xx on its own backoff, and reports each attempt. naby's job is only to say so
 * — and it was saying `Retrying API call (attempt 1/3, delay 2.0s)`, in English,
 * in a Korean app, in the vocabulary of the person who wrote the SDK.
 *
 * THE 429 CASE IS THE ONE THAT MISLEADS. "Rate limited" reads as "you have used
 * up your plan", and it is not: a 429 here is the SERVER being busy, and the
 * plan chip beside it may well be showing 16%. A reader who concludes they are
 * out of quota will stop working for the rest of the day for no reason. So that
 * status gets its own sentence, and the sentence says which of the two it is.
 *
 * Nothing here decides whether to retry — that has already happened by the time
 * this renders. It only names what is going on.
 */

/** What the notice needs from the SDK's retry event. Structural rather than
 *  importing `ApiRetryInfo`, so the rule can be tested on plain objects. */
export interface RetryNoticeInput {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  errorStatus?: number;
}

export interface RetryNotice {
  /** The i18n key for the headline. */
  key: string;
  /** Interpolation values for it. */
  values: { attempt: number; maxRetries: number; seconds: string };
  /** Whether the attempt counter is worth printing. A retry that does not know
   *  how many tries it gets says "attempt 1/0", which reads as a bug. */
  showAttempts: boolean;
}

/** HTTP 429 — too many requests. The one status a reader will misread as their
 *  own plan running out. */
const TOO_MANY_REQUESTS = 429;

export function apiRetryNotice(info: RetryNoticeInput): RetryNotice {
  return {
    // A BUSY SERVER AND A BROKEN ONE ARE DIFFERENT NEWS. Everything that is not
    // a 429 (a 500, a dropped connection) is "something went wrong, trying
    // again" — true, and not alarming in the specific way a quota message is.
    key:
      info.errorStatus === TOO_MANY_REQUESTS
        ? 'chat.apiRetryBusy'
        : 'chat.apiRetryTransient',
    values: {
      attempt: info.attempt,
      maxRetries: info.maxRetries,
      // Seconds, one decimal: the delays are single-digit seconds and a bare
      // millisecond count is not a duration anyone reads.
      seconds: (info.delayMs / 1000).toFixed(1),
    },
    // `maxRetries` is 0 when the SDK did not say, and an attempt counter with no
    // ceiling is worse than none: "attempt 3" alone cannot tell the reader
    // whether this is nearly over or has barely started.
    showAttempts: info.attempt > 0 && info.maxRetries > 0,
  };
}
