// packages/feature/agent/src/server/lib/fastGrowth.ts
//
// THE FAST-GROWTH SESSION'S INSTRUCTION (Phase 3, P3-M12b/c/d —
// fast-evolution §3.3).
//
// THE PROBLEM IT SOLVES. Trust is only earned from check-ins the user answers
// during real work, and weeks can pass without a conversation that produces one.
// A user who wants to get on with it has no lever at all — so they leave before
// the agent is worth anything.
//
// THE TWO LEVERS, AND THE LINE BETWEEN THEM. This session gives naby two jobs:
//
//   INTERVIEW (learning). When there is barely any confirmed memory, the fastest
//   real gain is knowing the person. Letting the model ASK beats handing the user
//   a form — GATE (arXiv:2310.11589) found an LM interview extracts more useful
//   preference information at less effort than the user's own written prompt. The
//   answers become `naby_remember` proposals and NOTHING ELSE. Not one row of the
//   trust ledger. Learning may be accelerated freely; being TRUSTED may not.
//
//   PRACTICE CHECK-INS (evidence, discounted). The missing thing is proof that
//   naby can predict this user. So it invents a decision they plausibly face,
//   COMMITS to what it thinks they would choose, and asks through the ordinary
//   check-in tool. The user's answer grades it. That is a genuine prediction —
//   the examiner is not marking its own paper — which is why it may count at all.
//
// ONE FLOW, NOT A FORK (P3-M12b-5, 2026-08-04). Until now these were the two
// BRANCHES of one condition: below `INTERVIEW_SPARSE_BELOW` confirmed facts naby
// was told to interview, at or above it to run practice check-ins. A real session
// then did exactly what the branch said and no more — a user ran a full
// fast-growth sitting, naby interviewed them well and proposed eight memories,
// and called `naby_checkin` ZERO times. The growth report afterwards read
// "check-ins 0/0, stage egg, 5 more check-ins needed", which is the truth and
// also an indictment: a session sold as GROWTH had produced no growth evidence
// whatsoever, because the only path to a practice check-in was a memory count the
// session itself was still filling.
//
// So the interview is now the OPENING of a sitting rather than an alternative to
// it, and every sitting reaches the practice check-ins. The old
// skip-the-questions behaviour survives as what it always should have been — a
// shortcut past part 1 when there is nothing left to ask — instead of being the
// only door to part 2.
//
// WHY THE NUMBERS ARE PASSED IN. Same reason `stageInstruction` takes a
// `StageProgress`: a model asked how far along its user is will produce an
// encouraging sentence, and an encouraging sentence about a number the user can
// check in the growth panel is how a meter loses its credibility. The engine
// computes both counts from the ledger and this module only writes them down.
//
// WHAT THE MODEL IS STILL NOT TOLD, here as everywhere: how any of this SCORES.
// Not that practice counts for less, not that a daily cap exists, not how the
// rate is computed. It is told which of the two activities can move a stage at
// all — the same fact `stageProgressClause` already states out loud, and the fact
// whose absence produced a session with no check-ins in it — and then told to ask
// good questions and commit to its real best guess. The exchange rate remains the
// ledger's business; an agent that knew it would start optimizing it.

/** Below this many confirmed user-scope memories, a sitting OPENS with questions.
 *  A soft line, not a gate: the point is that asking someone to predict their own
 *  decisions before you know anything about them produces questions that are
 *  about nobody. At or above it, part 1 is skipped — never part 2. */
export const INTERVIEW_SPARSE_BELOW = 10;

/** How many questions one sitting may ask. The number is a UX finding, not a
 *  guess: past a handful, an interview stops feeling like a conversation and
 *  starts feeling like onboarding paperwork, which is the thing the user opened
 *  this session to avoid. */
export const INTERVIEW_MAX_PER_SITTING = 5;

/** How many practice check-ins one sitting should produce. Two is the floor
 *  because one is indistinguishable from an accident; three is the ceiling for
 *  the same reason the interview has one — a fourth invented decision in a row
 *  stops reading as a conversation. Told to the model, unlike anything about
 *  scoring: it is a PACE, and a pace is not an exchange rate. */
export const PRACTICE_MIN_PER_SITTING = 2;
export const PRACTICE_MAX_PER_SITTING = 3;

/** The real numbers the instruction is anchored on, all computed by the engine
 *  from the ledger and the memory store. */
export interface FastGrowthCounts {
  /** How many CONFIRMED user-scope facts naby holds. Confirmed, not proposed: a
   *  pile of unreviewed guesses is not knowledge of the user, and counting it
   *  would send naby practising on things it invented. */
  confirmedUserMemories: number;
  /** Practice check-ins already RECORDED in this session, before this turn. */
  practiceThisSession: number;
  /** How many more check-ins answered during REAL work the subject still needs
   *  before its stage can be read at all. 0 = the minimum sample is already in. */
  realCheckinsRemaining: number;
}

/**
 * The system-prompt block for a fast-growth session — one sitting, two parts, in
 * order. Pure: every number arrives already computed.
 */
export function fastGrowthInstruction(counts: FastGrowthCounts): string {
  const { confirmedUserMemories, practiceThisSession, realCheckinsRemaining } = counts;
  const sparse = confirmedUserMemories < INTERVIEW_SPARSE_BELOW;

  const header = [
    'FAST-GROWTH SESSION: the user opened this conversation specifically to help you get to',
    'know them faster. Treat that as the task — do not wait for them to bring you work.',
    // REGISTER (2026-08-04). This session is nothing but questions, so the way one
    // reads is the whole experience of it — and a question in the wrong register
    // reads as rudeness from something claiming to know its user. The persona seed
    // carries the same rule for every turn; it is repeated here because this is
    // where it surfaced.
    'Ask in the user\'s own language. When they write Korean, ask in natural, polite everyday',
    'Korean (해요체/합니다체) — never a crude or slangy idiom, and never a stiff word-for-word',
    'rendering of an English question.',
    '',
    // THE FACT WHOSE ABSENCE PRODUCED A SESSION WITH NO CHECK-INS IN IT.
    'WHAT ACTUALLY MOVES YOUR STAGE. Answering questions about themselves becomes MEMORY and',
    'nothing else — it leaves your stage exactly where it was. The only thing that moves it is a',
    'check-in they answer: you commit to what you believe THIS user would choose, they pick, and',
    'being right about them is the evidence. So a sitting spent only asking about them is a sitting',
    'that produced none.',
    '',
    'THIS SITTING HAS TWO PARTS, IN THIS ORDER — and part 2 happens every sitting.',
    '',
  ];

  const part1 = sparse
    ? [
        `PART 1 — GET YOUR BEARINGS. You know very little about them so far (${confirmedUserMemories} confirmed fact(s)),`,
        'so open by asking.',
        '',
        '- ONE question per turn. Never a list, never a form.',
        `- At most ${INTERVIEW_MAX_PER_SITTING} questions in this sitting, and fewer is better — this part is the warm-up, not`,
        '  the session.',
        '- Write the question from what has actually come up in this conversation and what you already',
        '  know — not from a fixed script. A question that could have been asked of anyone teaches you',
        '  nothing about them.',
        '- Start light (how they like to work, what they are working on, how they want to be talked to)',
        '  and go deeper only if they are engaging.',
        '- SKIPPING IS FREE. If they pass, say fine and move on, and never ask that question again in',
        '  any form. Pressing for an answer they already declined is the fastest way to lose the session.',
        '- When they tell you something durable about themselves, record it with `naby_remember`. It',
        '  lands as a PROPOSAL they review — say so if they ask, and never imply that answering',
        '  questions makes you more trusted. It does not.',
        '- Then MOVE ON TO PART 2 in this same conversation, without being asked to.',
      ]
    : [
        `PART 1 — ALREADY DONE. You know a fair amount about them (${confirmedUserMemories} confirmed fact(s)) — enough to`,
        'predict them, so skip the getting-to-know-you questions and START AT PART 2.',
        '',
        '- Ask one anyway when something obvious is missing, and record it with `naby_remember` as',
        '  usual. It lands as a PROPOSAL they review, and never imply that answering questions makes',
        '  you more trusted. It does not.',
      ];

  const part2 = [
    'PART 2 — PRACTISE PREDICTING THEM. This is the part the session exists for.',
    '',
    `- Run ${PRACTICE_MIN_PER_SITTING}–${PRACTICE_MAX_PER_SITTING} practice check-ins in this sitting. ${practiceCountSentence(practiceThisSession)}`,
    '- Build each one out of what you have JUST learned: their project, the work they said they would',
    '  hand to you, the preferences they just described. A realistic decision they plausibly face in',
    '  the next few days — not a quiz question, not a hypothetical about somebody else.',
    '- COMMIT FIRST. Call `naby_checkin` with the genuinely different ways to go and mark the one you',
    '  believe THIS user would pick. Your real best guess, not the safe one — a hedged recommendation',
    '  teaches neither of you anything.',
    '- Then listen. Whatever they choose is the answer; say what it tells you about them and do not',
    '  defend your recommendation.',
    `- Then ASK THE NEXT ONE, in the same sitting, until you have run ${PRACTICE_MAX_PER_SITTING}. Do not wait to be`,
    '  invited back, and do not offer to continue another time.',
    '- VARY THEM. Different topics, different stakes, easy ones and genuinely close calls. A run of',
    '  near-identical questions is worthless to both of you.',
    '- NEVER NEAR-REPEAT a question they have already been asked, in this session or an earlier one.',
    '  A re-worded repeat is thrown out and teaches nobody anything — ask about something else.',
    '',
    'CLOSING THE SITTING. When you have run them all, or the user says they have had enough, stop',
    'asking and tell them where they stand in ONE sentence, in their own language, using these two',
    'numbers and no invented ones:',
    `  - practice check-ins in this session: ${practiceThisSession} recorded before this turn, plus the ones you have run`,
    '    since — count those yourself, this number was taken when the turn started.',
    `  - ${remainingClause(realCheckinsRemaining)}`,
    'Then be useful with what you have.',
  ];

  return [...header, ...part1, '', ...part2].join('\n');
}

/** The pace line's second sentence — kept out of the template so "none yet" reads
 *  like a sentence rather than "0 so far". */
function practiceCountSentence(practiceThisSession: number): string {
  if (practiceThisSession <= 0) return 'None have been recorded in it yet.';
  if (practiceThisSession === 1) return 'One has been recorded in it so far.';
  return `${practiceThisSession} have been recorded in it so far.`;
}

/** What is still needed before the stage can be read at all — the SAME fact
 *  `stageProgressClause` states for a routed agent, computed from the same ledger
 *  source, so the two surfaces cannot tell the user different things. */
function remainingClause(realCheckinsRemaining: number): string {
  if (realCheckinsRemaining <= 0) {
    return 'they have already answered enough check-ins during real work for your stage to be read.';
  }
  return (
    'check-ins during REAL work still needed before your stage can be read at all: ' +
    `${realCheckinsRemaining}. Practice ones do not fill that.`
  );
}
