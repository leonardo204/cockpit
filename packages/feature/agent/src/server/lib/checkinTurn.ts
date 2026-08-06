// packages/feature/agent/src/server/lib/checkinTurn.ts
//
// TURN-TIME CHECK-IN WIRING (Phase 3, P3-M5).
//
// The runtime owns the check-in TOOL, its validation and its scoring
// (`runtime/checkin.ts`, `makeCheckin`); this owns the three things only the shell
// can decide per turn:
//
//   1. whether the tool can actually be called (`canCheckIn`),
//   2. the words that make asking a habit (`checkinInstruction`),
//   3. the sink — how the turn SUSPENDS, and where the outcome is written
//      (`makeCheckinSink`).
//
// WHY THE INSTRUCTION IS NEEDED. A tool the model is never told to reach for is a
// tool it reaches for erratically, and an erratic check-in rate makes the meter
// noise. The words below also carry the one rule the model gets wrong on its own:
// ask about HOW, right before doing it — not "may I?" as a courtesy, and not
// after the fact.
//
// WHAT THE INSTRUCTION DELIBERATELY DOES NOT SAY: anything about scoring, stages,
// or growth. An agent told "your recommendation is being graded" would optimize
// the grade — safe questions, padded options, the whole Goodhart catalogue. It is
// told to ask well and to commit to its real best guess, which is what produces
// an honest label as a side effect.
//
// IT IS STILL STAGE-AWARE (P3-M12e). `checkinInstruction` takes the subject's
// stage and leans harder on asking while that agent's record is short, because
// the alternative is what real usage produced: hundreds of autonomous actions,
// zero real check-ins, and a meter with no way to start. The stage picks the
// WORDING; the wording still never mentions a stage.

import {
  CHECKIN_TOOL_NAME,
  CHECKIN_MAX_OPTIONS,
  CHECKIN_MIN_OPTIONS,
  isConsequentialTool,
  isReversibleAction,
  logActivity,
  normalizeToolName,
  type Agent,
  type CheckinAnswer,
  type CheckinLedgerRow,
  type CheckinQuestion,
  type CheckinSink,
  type EvalEventInput,
  type GrowthStage,
} from '../../../../../../../dist/naby-runtime.mjs';
import { registerCheckin, unregisterCheckin } from './checkinRegistry';
import { recentQuestions, type GrowthLedgerStore } from './growthRead';

/**
 * Whether `naby_checkin` can actually be called on this turn. Same shape as
 * `canLearn`: there has to be a subject agent, and an agent restricted by
 * `toolRefs` has to have the tool on its list — otherwise the P3-M2 gate denies
 * every call and the instruction would just make the model retry a dead end.
 */
export function canCheckIn(agent: Agent | undefined): boolean {
  if (!agent) return false;
  if (!agent.toolRefs) return true; // unrestricted (the built-in persona's default)
  return agent.toolRefs.map(normalizeToolName).includes(CHECKIN_TOOL_NAME);
}

/**
 * The system-prompt block that turns the tool into a habit. Short on purpose — it
 * shares the turn's system field with the persona, the memory block, the skills,
 * the learning instruction and (when autonomous) the step protocol.
 *
 * WHY IT TAKES A STAGE, AND WHY THE PROSE NEVER NAMES ONE. Real usage produced a
 * ledger that could not move: ~197 autonomous rows against zero real check-ins in
 * a lifetime of ordinary work, while the only way out of the first stage is real
 * check-ins. The machinery was fine (the sink is live on every persona turn, and
 * the fast-growth drills went through it); what was missing was any pressure to
 * ASK during ordinary work. The wording below supplies it while an agent's record
 * is still short, and relaxes once it is established.
 *
 * The parameter is a stage, but nothing in the text says so — same rule as
 * `stageTurn.ts`: an agent told what it is being measured on optimizes that. The
 * caller picks the wording; the model reads a few sentences about when asking is
 * worth it and never learns that anything downstream is counting.
 *
 * THE BALANCE, at the top stage: over-asking is not free there. `coverage` (the
 * share of decisions made without asking) and the ask-quality axes score exactly
 * the "asked when it did not need to" failure, so a permanently eager agent pays
 * for it in the very meter this clause exists to unstick. Which is why the eager
 * clause is dropped at butterfly rather than being softened everywhere — and why
 * none of that arithmetic is stated to the model.
 *
 * UNDEFINED READS AS "NOT MEASURED YET" — the eager wording. It is the same
 * fail-direction as `readGrowth` (an unreadable ledger is an egg): an agent whose
 * record cannot be established should be asking, not deciding alone.
 */
export function checkinInstruction(stage?: GrowthStage): string {
  // Everything below the top stage: the record is short, so the user's answers
  // are the only thing that can lengthen it.
  const eager = stage !== 'butterfly';
  return [
    `CHECKING IN: right before you do something this user cannot easily undo — writing or editing a`,
    `file, running a command, sending anything outward — if there is a real choice about HOW to do it,`,
    `call \`${CHECKIN_TOOL_NAME}\` and let them decide.`,
    '',
    `- Offer ${CHECKIN_MIN_OPTIONS}–${CHECKIN_MAX_OPTIONS} genuinely different ways to proceed and mark the one you believe THIS user wants.`,
    `  Commit to your real best guess, not the cautious one.`,
    `- Their answer overrides your recommendation. Do it their way and do not ask that question again.`,
    `- Do not check in for read-only steps, when there is only one sensible way, or when they already`,
    `  told you how. An unnecessary interruption is worse than none.`,
    ...(eager
      ? [
          '',
          `YOU DO NOT KNOW THIS USER WELL YET. You have not been told how they like these choices made,`,
          `and guessing silently is how you stay wrong about them. So while that is still true:`,
          `- When a decision in the work is genuinely consequential, or turns on their preference rather`,
          `  than on fact, PREFER asking over deciding on your own — one short question with real`,
          `  options, and your recommendation among them — even if you could defend a choice yourself.`,
          `- This is not a licence to interrupt. Trivial steps, obvious defaults and questions you have`,
          `  effectively asked before (in any wording) are still not worth their attention; asking those`,
          `  wastes the one thing this buys you, which is knowing what they actually want.`,
          `- One or two such questions in a turn is the most a piece of work should need.`,
        ]
      : []),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The sink
// ---------------------------------------------------------------------------

/** What the shell must supply to build a turn's check-in sink. */
export interface CheckinTurnDeps {
  /** Writes the ledger row and supplies the recent-question history. */
  store: GrowthLedgerStore & { appendEvalEvent(event: EvalEventInput): unknown };
  /** WHOSE growth this turn feeds — the routed agent, or the persona on an
   *  ordinary turn. Growth is per agent, so this is the ledger's key. */
  agentId: string;
  sessionId: string;
  /** Emits the RunEvent that puts the prompt on screen. Typed structurally (the
   *  shell's RunEvent is an open `{type, …}` record) so this module does not have
   *  to depend on the engine's types. */
  emit: (event: { type: string; [key: string]: unknown }) => void;
  /** The turn's abort signal — a stopped turn must not leave a live prompt. */
  signal: AbortSignal;
  /** How long an unanswered prompt waits before it expires. */
  ttlMs: number;
  /**
   * IS THIS A DRILL? (P3-M12c, fast-evolution §3.4.)
   *
   * Resolved ONCE, HERE, from `SessionRef.fastGrowth` — the flag a human set by
   * opening a fast-growth session — and stamped on every row this sink records.
   *
   * IT IS NEVER READ FROM TOOL INPUT, and that is the invariant the whole
   * discount rests on (checkin-contracts §4, invariant 9). A model able to label
   * its own rows could file the questions it got wrong as practice and the ones
   * it got right as real work, and the ledger would then measure nothing but its
   * bookkeeping. The session decides; the model is not consulted.
   *
   * Absent = a real session, which is the direction that costs the agent
   * nothing it did not earn: an unmarked row counts at full weight only when the
   * user was making a real decision.
   */
  drill?: boolean;
  /** Injected so this module needs no clock of its own (and a test can pin it). */
  now: () => number;
  /** P3-M3b's channel, for a check-in: send the question to Telegram too, and
   *  close it there when it is settled elsewhere. Absent = in-app only. Injected
   *  rather than imported so this module stays testable without the bridge. */
  escalate?: {
    send(input: { checkinId: string; question: string; options: readonly string[] }): void;
    finish(input: { checkinId: string; chosen?: number }): void;
  };
}

/**
 * Build the sink `makeCheckin` runs against: `ask` suspends the turn on a promise
 * and `record` appends the scored row.
 *
 * The suspend/resume mechanism is M2's, deliberately: emit a request event, park
 * the resolver in a cross-request registry, and let `POST /api/naby
 * {checkin.resolve}` settle it. Settling is idempotent and happens on exactly one
 * of answer / abort / timeout, so a resolver never outlives its turn.
 */
export function makeCheckinSink(deps: CheckinTurnDeps): CheckinSink {
  return {
    // Read once per turn rather than per call: within one turn the model cannot
    // have added history the ledger does not already hold, and a per-call query
    // would re-read the same rows for every question.
    recentQuestions: recentQuestions(deps.store, deps.agentId),

    ask: (question: CheckinQuestion, meta: { toolCallId: string }): Promise<CheckinAnswer> => {
      const checkinId = `${deps.sessionId}:${meta.toolCallId}`;
      return new Promise<CheckinAnswer>((resolve) => {
        let settled = false;
        const settle = (answer: CheckinAnswer) => {
          if (settled) return;
          settled = true;
          // WHAT THE USER ACTUALLY CHOSE, including the two outcomes the ledger
          // deliberately does NOT record: an unanswered prompt and an aborted turn
          // write no row at all (scoring an absence would be a fabrication), so
          // without this line the question would appear in the log with no ending.
          logActivity('checkin_answered', {
            sessionId: deps.sessionId,
            agentId: deps.agentId,
            checkinId,
            question: question.question,
            options: [...question.options],
            recommended: question.recommended,
            chosen: answer.chosen,
            unanswered: answer.unanswered === true,
            ...(answer.correction ? { correction: answer.correction } : {}),
            ...(deps.drill ? { drill: true } : {}),
          });
          clearTimeout(timer);
          deps.signal.removeEventListener('abort', onAbort);
          unregisterCheckin(checkinId);
          // P3-M3b: if the question ALSO went out over Telegram, close it there.
          // A no-op when Telegram is what answered (the bridge unwatches first),
          // so the user never gets a duplicate — and is never left holding live
          // buttons for a decision already made in the app, aborted, or expired.
          deps.escalate?.finish({
            checkinId,
            ...(answer.chosen >= 0 ? { chosen: answer.chosen } : {}),
          });
          // Tell the UI the prompt is done so the options stop being clickable,
          // whichever way it ended.
          deps.emit({
            type: 'checkin_resolved',
            checkinId,
            chosen: answer.chosen,
            session_id: deps.sessionId,
          });
          resolve(answer);
        };
        // A stopped turn and an expired prompt are the SAME outcome: nobody
        // answered. Neither is a miss — `shouldRecord` drops the row entirely,
        // because scoring the user's absence would be a fabrication.
        const onAbort = () => settle({ chosen: -1, unanswered: true });
        const timer = setTimeout(() => settle({ chosen: -1, unanswered: true }), deps.ttlMs);
        if (deps.signal.aborted) return onAbort();
        deps.signal.addEventListener('abort', onAbort);
        registerCheckin(checkinId, settle, deps.now());
        // THE QUESTION AS ASKED — with the recommendation, which the UI hides from
        // the user until afterwards. The log is read by the developer, not by the
        // person being asked, so hiding it here would only make the pair of records
        // unable to explain why an answer counted as a hit.
        logActivity('checkin_asked', {
          sessionId: deps.sessionId,
          agentId: deps.agentId,
          checkinId,
          question: question.question,
          options: [...question.options],
          recommended: question.recommended,
          ...(deps.drill ? { drill: true } : {}),
          escalated: deps.escalate !== undefined,
        });
        deps.emit({
          type: 'checkin_request',
          checkinId,
          question: question.question,
          options: question.options,
          recommended: question.recommended,
          session_id: deps.sessionId,
        });
        // Deliberately not awaited, like the approval path: the in-app prompt is
        // already up and the turn is already suspended on this promise, so a slow
        // or failing Telegram send must delay neither.
        //
        // AND THE RECOMMENDATION IS NOT SENT. The in-app prompt hides it until
        // after the answer so the meter measures knowledge rather than how
        // agreeable the UI is; leaking it to the phone would reopen exactly that
        // hole on the surface where the user is least able to think it over.
        deps.escalate?.send({
          checkinId,
          question: question.question,
          options: question.options,
        });
      });
    },

    record: (row: CheckinLedgerRow): void => {
      // The kind-specific fields go in as they came from the runtime; `at` and
      // `id` are the store's to mint.
      deps.store.appendEvalEvent({
        kind: 'checkin',
        agentId: deps.agentId,
        sessionId: deps.sessionId,
        question: row.question,
        options: row.options,
        recommended: row.recommended,
        chosen: row.chosen,
        hit: row.hit,
        ...(row.confidence !== undefined ? { confidence: row.confidence } : {}),
        ...(row.correction ? { correction: row.correction } : {}),
        ...(row.taskType ? { taskType: row.taskType } : {}),
        // THE DRILL STAMP, from the SESSION and never from `row` (P3-M12c). Note
        // what is NOT spread here: `row` is what the runtime's check-in executor
        // built out of the model's tool input, so taking the flag from it would be
        // taking it from the model. Set only when true, so a real session's rows
        // are byte-for-byte what they were before this existed.
        ...(deps.drill ? { drill: true } : {}),
        ...(row.excludedFromScoring ? { excludedFromScoring: true, reason: row.reason } : {}),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// The other two ledger kinds — written from the GATE path, not by the agent
// ---------------------------------------------------------------------------

/**
 * Record what a consequential call did WITHOUT being asked about, or a call the
 * gate refused. Called from the engine's gate observer, so the classification is
 * a property of the action and the decision — never of the agent's mood.
 *
 * This is what closes the Goodhart hole in the hit rate (spec §4.4–4.5): an agent
 * that only checks in where it feels safe still has every unasked mutation on the
 * record, so coverage tells the other half of the story. And a refusal lands as a
 * `tripwire`, which the meter treats as a hard block rather than one bad average.
 *
 * P3-M8d: MCP tools are no longer invisible here. The caller passes what was
 * DECLARED about the tool — the server's `readOnlyHint` annotation and whether
 * the user's own policy has an ask/deny rule on it — and
 * `classifyToolConsequence` decides. Nothing about permission changes: by the
 * time this runs the gate has already decided, and `allowed` is being reported,
 * not chosen.
 *
 * @returns the kind written, or undefined when the call was not consequential
 */
export function recordGateOutcome(deps: {
  store: { appendEvalEvent(event: EvalEventInput): unknown };
  agentId: string;
  sessionId: string;
  toolName: string;
  allowed: boolean;
  reason?: string;
  /** The MCP annotation, when this tool came from a server that declared one. */
  readOnlyHint?: boolean;
  /** The user has an ask/deny rule matching this tool (P3-M8d §7.4). */
  policyForcesConsequential?: boolean;
}): 'autonomous' | 'tripwire' | undefined {
  const bare = normalizeToolName(deps.toolName);
  // A denied READ is not a tripwire: the meter's hard block is for
  // safety-relevant refusals, and refusing a Grep is a policy preference.
  if (
    !isConsequentialTool(bare, {
      ...(deps.readOnlyHint !== undefined ? { readOnlyHint: deps.readOnlyHint } : {}),
      ...(deps.policyForcesConsequential !== undefined
        ? { policyForcesConsequential: deps.policyForcesConsequential }
        : {}),
    })
  ) {
    return undefined;
  }
  try {
    if (deps.allowed) {
      deps.store.appendEvalEvent({
        kind: 'autonomous',
        agentId: deps.agentId,
        sessionId: deps.sessionId,
        toolName: bare,
        reversible: isReversibleAction(bare),
      });
      return 'autonomous';
    }
    deps.store.appendEvalEvent({
      kind: 'tripwire',
      agentId: deps.agentId,
      sessionId: deps.sessionId,
      toolName: bare,
      ...(deps.reason ? { reason: deps.reason } : {}),
    });
    return 'tripwire';
  } catch {
    // A ledger write must never break a turn: the user's work matters more than
    // the measurement of it.
    return undefined;
  }
}
