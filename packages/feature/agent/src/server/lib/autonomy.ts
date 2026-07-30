// packages/feature/agent/src/server/lib/autonomy.ts
//
// THE AUTONOMY LOOP'S RULES (Phase 3, P3-M3c).
//
// An agent's `autonomy.maxSteps` is what turns "answer my message" into "work on
// this until it is done". WHAT A STEP IS, precisely: one model turn — one
// `runTurn`, i.e. one `engine.run` with its own internal tool-call loop. maxSteps
// is how many of those the agent may take BY ITSELF, without the user typing
// "continue", before it must stop and report.
//
// WHERE THE LOOP LIVES (and why not elsewhere): inside the naby engine's own
// dispatch, around `runTurn`. Re-dispatching a continuation through /api/chat —
// the way a scheduled task starts a run — would hit the concurrent-run guard on
// its own still-active run (409) and would fragment one goal across several run
// registry entries. One goal = one run = up to N steps.
//
// THE THREE RULES THAT KEEP IT SAFE AND HONEST:
//
//  1. OPT-IN AND CAPPED. No `maxSteps` (or 1) is exactly today's single-turn
//     behaviour — no instruction injected, no continuation, byte-for-byte
//     unchanged. A configured value is clamped to AUTONOMY_STEP_CAP no matter what
//     the store says, so a typo (or a future UI bug) cannot mint an endless agent.
//  2. IT STOPS ON ITS OWN. Continuation requires the step to have actually DONE
//     something (a tool call). A step that only produced text is an answer, not
//     work in progress — that is what ends a run that would otherwise chat with
//     itself until the cap. The agent can also end it explicitly with [[DONE]].
//  3. AUTONOMY IS NOT PERMISSION. Every step's tool calls go through the same
//     gate, the same policy rules and the same `toolRefs` allowlist as a normal
//     turn, and an 'ask' rule still suspends the step for human approval (in-app
//     or, with P3-M3b, Telegram). More steps never means more privilege.
//
// Everything here is pure — the decision, the prompts, the clamp — so the loop in
// the engine is only orchestration, and the rules are unit-tested.

/** Hard ceiling on autonomous steps, independent of what an agent is configured
 *  with. A safety valve, not a preference: it bounds the worst case (a goal the
 *  agent never considers finished) in wall-clock and in tokens. */
export const AUTONOMY_STEP_CAP = 20;

/** The marker an agent ends its last message with to declare the goal achieved.
 *  Visible in the transcript on purpose — the user can see the agent decided it
 *  was done, rather than the harness deciding for it. */
export const DONE_MARKER = '[[DONE]]';

/** Clamp a configured `maxSteps` into a runnable step count. Undefined / absurd /
 *  non-integer values collapse to 1 = "one turn", i.e. autonomy off. */
export function resolveMaxSteps(maxSteps: number | undefined): number {
  if (maxSteps === undefined || !Number.isFinite(maxSteps)) return 1;
  const n = Math.floor(maxSteps);
  if (n <= 1) return 1;
  return Math.min(n, AUTONOMY_STEP_CAP);
}

/** Whether autonomy is even in play for this turn. */
export function isAutonomous(maxSteps: number): boolean {
  return maxSteps > 1;
}

/** The marker an agent states its EVIDENCE with, before it is allowed to call
 *  itself done (P3-M9, G4). `[[VERIFIED: ran the suite, 51/51 green]]`.
 *
 *  A deterministic token rather than a judgment call about whether some prose
 *  "sounds verified": the harness has to decide this on every stop, and a
 *  fuzzy rule would either nag agents that did check or wave through ones that
 *  did not. Only the PREFIX is matched, because what follows is free text — the
 *  content is for the human reading the transcript, not for this code.
 *
 *  Visible in the transcript on purpose, exactly like [[DONE]]: the user can see
 *  what the agent claims to have checked, which is what makes the claim
 *  falsifiable. */
export const VERIFIED_MARKER_PREFIX = '[[VERIFIED:';

/** Did the agent declare completion? Case-insensitive so a model that lowercases
 *  the marker is still believed. */
export function sawDoneMarker(text: string): boolean {
  return text.toLowerCase().includes(DONE_MARKER.toLowerCase());
}

/** Did the agent state what it verified? Case-insensitive, prefix-only — see
 *  VERIFIED_MARKER_PREFIX. */
export function sawVerifiedMarker(text: string): boolean {
  return text.toLowerCase().includes(VERIFIED_MARKER_PREFIX.toLowerCase());
}

/** The system-prompt block that tells the agent the protocol it is running under.
 *  Injected ONLY when autonomous, so a normal turn's system prompt is untouched.
 *  It states the step budget, how to finish, and — importantly — that a step
 *  without tool use ENDS the run, which is what makes rule 2 above predictable
 *  rather than a surprise. */
export function autonomyInstruction(maxSteps: number): string {
  return [
    `AUTONOMOUS MODE: you may take up to ${maxSteps} steps on your own to reach this goal.`,
    '',
    '- A step is one of your turns. After each step the harness asks you to continue,',
    `  up to ${maxSteps} times — so do not ask the user to run things for you; do the work.`,
    '- Use your tools to make real progress in every step, then say briefly what you did',
    '  and what is next.',
    `- Before you finish, CHECK THE RESULT against the goal's success criteria, then`,
    `  state what you checked as ${VERIFIED_MARKER_PREFIX} what you checked]] — e.g.`,
    `  ${VERIFIED_MARKER_PREFIX} ran the test suite, 51/51 pass]].`,
    `- When the goal is fully achieved — or you genuinely cannot proceed — end your`,
    `  message with that verification line and then ${DONE_MARKER} on its own line, and stop.`,
    '- A step that uses NO tool ends the run: if work remains, do it with a tool in the',
    '  same step instead of only describing it.',
    '- Stopping WITHOUT the verification line buys you one more step to go and check.',
    '  Use it — do not simply repeat the claim.',
    '- Permissions are unchanged: a tool call that needs approval pauses for the user',
    '  (in the app or over Telegram) and then continues. Never work around a denial.',
  ].join('\n');
}

/** The user-turn text that drives step 2..N. It is stored in the transcript as a
 *  real user message (that is what actually drove the model), so it says plainly
 *  who is asking and where in the budget the agent is. */
export function continuationPrompt(step: number, maxSteps: number): string {
  return (
    `[naby autonomy] Continue toward the goal — step ${step} of ${maxSteps}. ` +
    `Make concrete progress with your tools. ` +
    `If the goal is already fully achieved, reply with a short summary of the result ` +
    `and end with ${DONE_MARKER}.`
  );
}

/** The user-turn text for the ONE verification step a run may be granted (P3-M9,
 *  G4). Sent in place of the ordinary continuation when the agent tried to stop
 *  without saying what it checked.
 *
 *  It asks for a CHECK, not for more work and not for a restatement — the failure
 *  mode this exists to catch is an agent that believes it is finished, so
 *  "continue toward the goal" would just get the same claim again. It also names
 *  the exit explicitly, both ways: verified-and-done, or keep going. An agent
 *  that cannot tell which it is has learned something worth reporting. */
export function verificationNudgePrompt(step: number, maxSteps: number): string {
  return (
    `[naby autonomy] Before this run ends — step ${step} of ${maxSteps}. ` +
    `You have not said what you checked. Verify the result against the goal and its ` +
    `success criteria, using your tools rather than your memory of what you did. ` +
    `If something is missing or wrong, fix it. If it holds up, say what you checked as ` +
    `${VERIFIED_MARKER_PREFIX} ...]] and end with ${DONE_MARKER}.`
  );
}

/** Why a run stopped (or kept going) — reported to the log and the step marker so
 *  "why did it stop after two steps?" is always answerable. */
export type AutonomyStopReason =
  | 'continue'
  | 'done-marker'
  | 'no-tool-use'
  | 'max-steps'
  | 'error'
  | 'aborted'
  | 'not-autonomous'
  /** P3-M9: the step tried to stop with nothing said about verification, and the
   *  run had a nudge and a step left to spend. Proceeds — once per run. */
  | 'verify-nudge';

export type AutonomyDecision = {
  /** Run another step. */
  proceed: boolean;
  reason: AutonomyStopReason;
};

/** THE decision, after a step's `result` event: does the agent get another step?
 *
 *  Order matters — the most authoritative signal wins, so the reported reason is
 *  the true one:
 *
 *    1. not-autonomous  a single-turn run never continues, whatever else is true
 *    2. aborted         the user's stop beats every opinion in this list
 *    3. error           a failed step is not a step to reason about
 *    4. done-marker  ┐  the agent's own "I am finished"…
 *    5. no-tool-use  ┘  …and the anti-chatter heuristic. Both are STOPS, and both
 *                       are what the P3-M9 verification gate intercepts (below):
 *                       a stop with no verification evidence can be converted,
 *                       ONCE per run, into 'verify-nudge' — proceed, not stop.
 *    6. max-steps       checked last, so a finished-anyway step is never
 *                       mislabelled as having run out of budget.
 *
 *  THE VERIFICATION GATE (G4) is deliberately wedged between "wants to stop" and
 *  "stops", not bolted on afterwards, because that is exactly the moment the
 *  claim "it is done" is made and has not yet been checked. It costs a step, so
 *  it is bounded twice over: once per run (`verification.nudgeSent`) and never
 *  past the budget (`step < maxSteps`) — the nudge continuation is an ordinary
 *  step and is counted like one.
 *
 *  OPT-IN BY SHAPE. With `verification` absent the function is byte-for-byte its
 *  pre-M9 self, so every existing caller and test keeps its exact behaviour and
 *  the new rule cannot leak in through a default. */
export function decideAutonomyStep(input: {
  /** 1-based index of the step that just finished. */
  step: number;
  /** Clamped step budget (`resolveMaxSteps`). */
  maxSteps: number;
  /** Did this step call at least one tool? */
  usedTools: boolean;
  /** The step's assistant text (searched for the done marker). */
  text: string;
  /** The step's result event `ok`. */
  ok: boolean;
  aborted: boolean;
  /** P3-M9 (G4). Present = the run enforces "verify before done". Absent = the
   *  pre-M9 rules exactly. */
  verification?: {
    /** Has this run already spent its one nudge? */
    nudgeSent: boolean;
  };
}): AutonomyDecision {
  if (!isAutonomous(input.maxSteps)) return { proceed: false, reason: 'not-autonomous' };
  if (input.aborted) return { proceed: false, reason: 'aborted' };
  if (!input.ok) return { proceed: false, reason: 'error' };
  // The two ways an agent asks to stop, in their existing precedence.
  const wantsToStop: AutonomyStopReason | undefined = sawDoneMarker(input.text)
    ? 'done-marker'
    : !input.usedTools
      ? 'no-tool-use'
      : undefined;
  if (wantsToStop) {
    if (
      input.verification &&
      !input.verification.nudgeSent &&
      !sawVerifiedMarker(input.text) &&
      input.step < input.maxSteps
    ) {
      return { proceed: true, reason: 'verify-nudge' };
    }
    return { proceed: false, reason: wantsToStop };
  }
  if (input.step >= input.maxSteps) return { proceed: false, reason: 'max-steps' };
  return { proceed: true, reason: 'continue' };
}

/** One-line label for the muted step bar in the transcript (and the log). The
 *  client renders harness events as a single muted row, so this is what the user
 *  sees between steps.
 *
 *  The nudge gets its own wording rather than the generic "continuing": the user
 *  is watching a run that looked finished take another step, and "verifying" is
 *  the difference between that reading as the protocol working and as the agent
 *  failing to stop. */
export function stepMarker(step: number, maxSteps: number, decision: AutonomyDecision): string {
  if (!decision.proceed) return `step ${step}/${maxSteps} — stopped (${decision.reason})`;
  return decision.reason === 'verify-nudge'
    ? `step ${step}/${maxSteps} — verifying before it stops`
    : `step ${step}/${maxSteps} — continuing`;
}
