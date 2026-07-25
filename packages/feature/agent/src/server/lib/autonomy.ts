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

/** Did the agent declare completion? Case-insensitive so a model that lowercases
 *  the marker is still believed. */
export function sawDoneMarker(text: string): boolean {
  return text.toLowerCase().includes(DONE_MARKER.toLowerCase());
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
    `- When the goal is fully achieved — or you genuinely cannot proceed — end your`,
    `  message with ${DONE_MARKER} on its own line, and stop.`,
    '- A step that uses NO tool ends the run: if work remains, do it with a tool in the',
    '  same step instead of only describing it.',
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

/** Why a run stopped (or kept going) — reported to the log and the step marker so
 *  "why did it stop after two steps?" is always answerable. */
export type AutonomyStopReason =
  | 'continue'
  | 'done-marker'
  | 'no-tool-use'
  | 'max-steps'
  | 'error'
  | 'aborted'
  | 'not-autonomous';

export type AutonomyDecision = {
  /** Run another step. */
  proceed: boolean;
  reason: AutonomyStopReason;
};

/** THE decision, after a step's `result` event: does the agent get another step?
 *
 *  Order matters — the most authoritative signal wins, so the reported reason is
 *  the true one: an abort or an error beats the agent's own opinion, the agent's
 *  [[DONE]] beats the tool-use heuristic, and the budget is checked last so a
 *  finished-anyway step is never mislabelled 'max-steps'. */
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
}): AutonomyDecision {
  if (!isAutonomous(input.maxSteps)) return { proceed: false, reason: 'not-autonomous' };
  if (input.aborted) return { proceed: false, reason: 'aborted' };
  if (!input.ok) return { proceed: false, reason: 'error' };
  if (sawDoneMarker(input.text)) return { proceed: false, reason: 'done-marker' };
  if (!input.usedTools) return { proceed: false, reason: 'no-tool-use' };
  if (input.step >= input.maxSteps) return { proceed: false, reason: 'max-steps' };
  return { proceed: true, reason: 'continue' };
}

/** One-line label for the muted step bar in the transcript (and the log). The
 *  client renders harness events as a single muted row, so this is what the user
 *  sees between steps. */
export function stepMarker(step: number, maxSteps: number, decision: AutonomyDecision): string {
  return decision.proceed
    ? `step ${step}/${maxSteps} — continuing`
    : `step ${step}/${maxSteps} — stopped (${decision.reason})`;
}
