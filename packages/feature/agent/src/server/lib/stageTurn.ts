// packages/feature/agent/src/server/lib/stageTurn.ts
//
// THE STAGE INSTRUCTION (Phase 3, P3-M12a) — the advisory half of the capability
// contract.
//
// The BINDING half is the tool gate: `stageRefusalReason` in the runtime decides,
// and the engine refuses the call before an executor runs. This module writes the
// words that make the agent refuse HONESTLY AND FIRST, instead of reaching for a
// tool, being blocked, and narrating the failure — which is the same request
// answered two turns later and much worse.
//
// WHY THE NUMBERS COME FROM THE ENGINE. The refusal has to end with "here is what
// is still missing", and that is precisely the sentence a model would improvise
// into something encouraging and wrong. `stageProgressSummary` computes it from
// the ledger, the engine drops it in here, and the model's job is reduced to
// saying it in the user's language. Self-reported ability estimates are known to
// be badly calibrated (arXiv:2507.16199); a printed number is not an estimate.
//
// WHAT THIS DELIBERATELY DOES NOT SAY, exactly as `checkinInstruction` does not:
// anything about how the meter scores, or what would raise it fastest. An agent
// told which behaviour lifts its own number optimizes that number. It is told
// what it may do and what it owes the user when it cannot.

import {
  stageContract,
  type GrowthStage,
  type StageProgress,
} from '../../../../../../../dist/naby-runtime.mjs';

/**
 * What is still missing before the next stage, as one English clause the refusal
 * can end on. Pure; the numbers arrive already computed.
 */
export function stageProgressClause(progress: StageProgress): string {
  if (progress.kind === 'samples') {
    return (
      `${progress.remaining} more check-in(s) that the user answers during REAL work — ` +
      `practice check-ins never count toward that minimum`
    );
  }
  if (progress.kind === 'bound') {
    return (
      `the recent record scores ${progress.lowerBound.toFixed(2)} and ${progress.nextStage} ` +
      `begins at ${progress.nextThreshold.toFixed(2)} — that gap closes by being right about ` +
      `what this user wants, not by asking more often`
    );
  }
  return 'nothing — this is the top stage';
}

/**
 * The system-prompt block for a turn routed to an agent BELOW the butterfly
 * stage. Never injected for a butterfly: its contract allows everything the
 * user's settings allow, so the block would be a paragraph saying "no limits",
 * which is only noise in a prompt that already shares space with the persona, the
 * memory block, the skills and the check-in habit.
 */
export function stageInstruction(stage: GrowthStage, progress: StageProgress): string {
  const contract = stageContract(stage);
  const allowed = !contract.allowConsequential
    ? [
        '- Read, search, look things up, and ask.',
        '- Draft, plan, explain, and propose — in your reply, where the user can see and copy it.',
        '- Remember things about the user (that is a proposal they review, not a change).',
        '- You may NOT write or edit files, run commands, or send anything outward.',
      ]
    : [
        '- Everything a draft-only agent can do.',
        '- Actions that can be undone: writing and editing files (each one is snapshotted first).',
        '- You may NOT run commands or send anything outward — those cannot be taken back.',
      ];

  return [
    `YOUR STAGE: ${stage}. This decides what you may DO on this turn. It is about how much of`,
    `this user's work you have been measured on — not about how hard their request is, and not`,
    `something you should estimate for yourself.`,
    '',
    ...allowed,
    '',
    `The harness ENFORCES this: a call outside it is refused before it runs. Trying anyway spends`,
    `the user's turn and tells them nothing.`,
    '',
    'WHEN A REQUEST NEEDS MORE THAN YOU MAY DO, say three things, in this order, and then stop:',
    '  1. What you cannot do — name the ACTION ("I cannot edit the file"), not the topic.',
    '  2. What you CAN do instead, and then actually do it: the draft, the plan, the exact command',
    '     for them to run themselves.',
    `  3. What is still needed to reach the next stage: ${stageProgressClause(progress)}.`,
    '',
    'Do not apologise at length, do not promise to do it later, and do not go looking for a',
    'different tool that does the same forbidden thing.',
  ].join('\n');
}
