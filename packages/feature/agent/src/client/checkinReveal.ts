/**
 * checkinReveal — the life of the 🦋 / 🐛 banner that follows a check-in.
 *
 * WHAT THE BANNER IS. After the user answers a check-in blind, <CheckinPrompt>
 * reveals the recommendation they answered against: "나비도 같은 것을 추천했습니다:
 * …". It is the whole payoff of the blind pick — the evidence that naby knew.
 *
 * THE REPORT. It never left. Shown once, it sat above the input for the rest of
 * the session unless the user found and clicked its ✕ — so a banner about a
 * question answered twenty minutes ago was still commenting on a conversation
 * that had moved on. Read literally, it said naby had recommended something for
 * whatever exchange happened to be on screen.
 *
 * THE RULE. The banner belongs to the exchange it was earned in, so it lives
 * exactly that long: visible while that exchange is on screen, gone when the
 * conversation MOVES ON — the next turn starting is the signal, whether the
 * user sent it or it arrived from Telegram or a scheduled task.
 *
 * WHY NOT A TIMER. Timed dismissal takes content away from a user who may be
 * mid-sentence reading it, and the deadline is set by a clock that knows
 * nothing about them (NN/g on auto-dismissing messages). Tying it to
 * conversation progression means it disappears only once the user has visibly
 * moved past it — and the ✕ is still there for anyone who wants it gone sooner.
 *
 * Pure, so the lifecycle is pinned by cases: the component is left holding one
 * `useState` and a reducer call per event.
 */

/** What the user is being shown, plus the run it belongs to. */
export interface RevealBanner {
  /** The check-in question that was answered. Kept for context/testing. */
  question: string;
  /** The option naby had recommended, revealed only now. */
  recommendedOption: string;
  /** Did the user pick it? Decides 🦋 vs 🐛 and which sentence is shown. */
  hit: boolean;
  /**
   * The value of the session's run counter when the answer was given — i.e. the
   * turn this banner is about. Anything strictly newer means the conversation
   * has moved on.
   */
  bornAtRun: number;
}

export type RevealEvent =
  /** The user answered a check-in; this is the reveal it earned. */
  | { kind: 'answered'; question: string; recommendedOption: string; hit: boolean; run: number }
  /** A turn started on this session (the user sent, or a turn arrived). */
  | { kind: 'run-start'; run: number }
  /** A NEW check-in arrived — its prompt supersedes the previous reveal. */
  | { kind: 'question' }
  /** The manual ✕. */
  | { kind: 'dismiss' };

/**
 * Advance the banner. `null` means "show nothing".
 *
 * Note the run-start rule is `>`, not `>=`: the reveal is created WHILE its own
 * turn is still in flight (the check-in pauses the turn server-side and the
 * answer resumes it), so a late signal from the turn it was born in must not
 * erase it the instant it appears.
 */
export function reduceReveal(prev: RevealBanner | null, ev: RevealEvent): RevealBanner | null {
  switch (ev.kind) {
    case 'answered':
      // A check-in with no recorded recommendation has nothing to reveal — and
      // an empty banner reads as a bug rather than as an absence.
      if (!ev.recommendedOption) return null;
      return {
        question: ev.question,
        recommendedOption: ev.recommendedOption,
        hit: ev.hit,
        bornAtRun: ev.run,
      };
    case 'run-start':
      if (!prev) return null;
      return ev.run > prev.bornAtRun ? null : prev;
    case 'question':
    case 'dismiss':
      return null;
  }
}
