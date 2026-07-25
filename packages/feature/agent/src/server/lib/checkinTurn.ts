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

import {
  CHECKIN_TOOL_NAME,
  CHECKIN_MAX_OPTIONS,
  CHECKIN_MIN_OPTIONS,
  isConsequentialTool,
  isReversibleAction,
  normalizeToolName,
  type Agent,
  type CheckinAnswer,
  type CheckinLedgerRow,
  type CheckinQuestion,
  type CheckinSink,
  type EvalEventInput,
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
 */
export function checkinInstruction(): string {
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
  /** Injected so this module needs no clock of its own (and a test can pin it). */
  now: () => number;
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
          clearTimeout(timer);
          deps.signal.removeEventListener('abort', onAbort);
          unregisterCheckin(checkinId);
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
        deps.emit({
          type: 'checkin_request',
          checkinId,
          question: question.question,
          options: question.options,
          recommended: question.recommended,
          session_id: deps.sessionId,
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
 * @returns the kind written, or undefined when the call was not consequential
 */
export function recordGateOutcome(deps: {
  store: { appendEvalEvent(event: EvalEventInput): unknown };
  agentId: string;
  sessionId: string;
  toolName: string;
  allowed: boolean;
  reason?: string;
}): 'autonomous' | 'tripwire' | undefined {
  const bare = normalizeToolName(deps.toolName);
  // A denied READ is not a tripwire: the meter's hard block is for
  // safety-relevant refusals, and refusing a Grep is a policy preference.
  if (!isConsequentialTool(bare)) return undefined;
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
