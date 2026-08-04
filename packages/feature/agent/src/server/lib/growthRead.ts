// packages/feature/agent/src/server/lib/growthRead.ts
//
// Phase 3 P3-M5 — the ONE place the shell turns a stored ledger into a growth
// reading.
//
// Two very different callers need it: the `@` palette (which needs a stage and a
// percentage per agent, cheaply, on every keystroke) and the Settings panel
// (which needs the full breakdown plus a reason for a regression). Both must
// agree — a palette that says "butterfly" beside a panel that says "pupa" would
// destroy the meter's credibility faster than a wrong number would. So the read
// limit, the best-effort behaviour and the shape all live here.
//
// EVERY READ IS BEST-EFFORT. A store hiccup or a ledger that does not exist yet
// must never empty the palette or blank the panel: it reads as an egg, which is
// the truthful answer for an agent with no measured history.

import {
  computeGrowth,
  canBeAddressed,
  diagnoseChange,
  GROWTH_WINDOW,
  type CheckinRecord,
  type GrowthChange,
  type GrowthStage,
  type GrowthState,
} from '../../../../../../../dist/naby-runtime.mjs';
import type { EvalEvent, EvalEventKind } from '../../../../../../../dist/naby-runtime.mjs';

/** How much ledger history a reading pulls per agent. Generous enough for the
 *  change detector (which needs rows on both sides of a candidate split) while
 *  still bounding the query — the meter itself scores only the recent window.
 *
 *  It also has to be comfortably wider than the IMPLICIT window (P3-M8d): 200
 *  rows of every kind against an implicit pool of 40 autonomous ones, so the
 *  weak-label half is never truncated by this limit before the meter windows it. */
export const LEDGER_READ_LIMIT = GROWTH_WINDOW * 10;

/** How many past questions the duplicate check compares against. Small on
 *  purpose: "the same thing was JUST asked" is the gaming move worth catching,
 *  while re-asking a decision from last month is legitimate. */
export const RECENT_QUESTION_LOOKBACK = 12;

/** The narrow slice of the store these reads need. Keeps the callers (and the
 *  tests) from having to construct a whole store. */
export interface GrowthLedgerStore {
  listEvalEvents(
    agentId: string,
    opts?: { kind?: EvalEventKind; taskType?: string; limit?: number },
  ): EvalEvent[];
}

/** Read an agent's recent ledger, oldest-first. [] on any failure. */
export function readLedger(store: GrowthLedgerStore, agentId: string): EvalEvent[] {
  try {
    return store.listEvalEvents(agentId, { limit: LEDGER_READ_LIMIT });
  } catch {
    return [];
  }
}

/** The cheap reading: stage + percent, for the palette. */
export function readGrowth(store: GrowthLedgerStore, agentId: string): GrowthState {
  return computeGrowth(readLedger(store, agentId) as CheckinRecord[]);
}

/**
 * MAY THIS AGENT BE `@`-ADDRESSED? (Phase 3, P3-M9 — G2.)
 *
 * The one gate, in one function, over the one read. It existed as a rule before
 * it existed as a function: the palette greyed out a non-butterfly (commands.ts)
 * while the engine routed to it anyway, so the product refused a delegation in
 * the menu and performed it when the name was typed by hand. Two implementations
 * of one policy is how that happens; there is now only one.
 *
 * FAIL-CLOSED. `readGrowth` already turns an unreadable ledger into an egg — the
 * honest reading for an agent with no measured history — and the catch covers
 * anything else. An agent whose trust cannot be established is not one the user's
 * work gets handed to.
 */
export function isAddressable(store: GrowthLedgerStore, agentId: string): boolean {
  try {
    return canBeAddressed(readGrowth(store, agentId).stage);
  } catch {
    return false;
  }
}

/** The agent's recent check-in questions, NEWEST FIRST — what `degenerateReason`
 *  compares a new question against. Excluded rows are included on purpose: a
 *  question that was already thrown out for being a repeat still counts as having
 *  been asked, so asking it a third time is caught too.
 *
 *  DRILLS ARE IN HERE TOO (P3-M12c), and that is what makes the degenerate
 *  defence cover practice without a line of new code: the query filters by KIND,
 *  not by the drill flag, so a practice question that re-words something already
 *  asked — in a drill or in real work — comes back `excludedFromScoring` and
 *  never reaches the drill pool. It cuts both ways, which is right: a real
 *  check-in that merely re-asks yesterday's practice question is not new evidence
 *  either. */
export function recentQuestions(store: GrowthLedgerStore, agentId: string): string[] {
  let rows: EvalEvent[];
  try {
    rows = store.listEvalEvents(agentId, { kind: 'checkin', limit: RECENT_QUESTION_LOOKBACK });
  } catch {
    return [];
  }
  return rows
    .map((r) => r.question)
    .filter((q): q is string => typeof q === 'string' && q.length > 0)
    .reverse();
}

/** One decision as the panel shows it. */
export type GrowthDecision = {
  at: number;
  question: string;
  options: string[];
  recommended: number;
  chosen: number;
  hit: boolean;
  taskType?: string;
  correction?: string;
  /** Present when the row was thrown out. A CODE (`one-real-option` /
   *  `repeat-question`), not prose — the panel renders it in the user's language.
   *  Older rows may hold free text, so the client falls back to showing it. */
  excludedCode?: string;
  /** This one was a PRACTICE question from a fast-growth session (P3-M12c).
   *  Marked in the list rather than hidden from it: the panel's decision list is
   *  what makes the gauge auditable, and a practice answer sitting there
   *  unlabelled would read as a real decision the user made about real work. */
  drill?: boolean;
};

/** A per-task-type reading — trust is graduated, not global (spec §4.9). */
export type GrowthByTaskType = {
  taskType: string;
  stage: GrowthStage;
  percent: number;
  hits: number;
  trials: number;
};

/** Everything the Settings panel renders. The regression REASON is a structured
 *  code plus its numbers, never prose: the runtime must not hardcode a language,
 *  and the shell turns the code into the user's own words. */
export type GrowthReport = GrowthState & {
  agentId: string;
  /** Whether `@`-mentioning this agent is allowed — the SAME predicate the engine
   *  routes on, so the panel can never promise what routing would refuse. */
  addressable: boolean;
  /** Why growth moved, as a code the shell renders per locale. */
  change: GrowthChange;
  /** How many rows the reading is based on, so "not measured yet" is explicable. */
  ledgerRows: number;
  byTaskType: GrowthByTaskType[];
  recentDecisions: GrowthDecision[];
};

/** How many recent decisions the panel lists. */
const RECENT_DECISION_LIMIT = 8;

/** The full reading, for Settings → the naby agent. */
export function growthReport(store: GrowthLedgerStore, agentId: string): GrowthReport {
  const rows = readLedger(store, agentId);
  const records = rows as CheckinRecord[];
  const state = computeGrowth(records);

  // Task types are read from the SAME rows, so a breakdown can never reference a
  // span the headline number did not see.
  const types = [...new Set(rows.map((r) => r.taskType).filter((t): t is string => !!t))].sort();
  const byTaskType: GrowthByTaskType[] = types.map((taskType) => {
    const s = computeGrowth(records, { taskType });
    return { taskType, stage: s.stage, percent: s.percent, hits: s.hits, trials: s.trials };
  });

  const recentDecisions: GrowthDecision[] = rows
    .filter((r) => r.kind === 'checkin' && typeof r.hit === 'boolean')
    .slice(-RECENT_DECISION_LIMIT)
    .reverse()
    .map((r) => ({
      at: r.at,
      question: r.question ?? '',
      options: r.options ?? [],
      recommended: r.recommended ?? -1,
      chosen: r.chosen ?? -1,
      hit: r.hit === true,
      ...(r.taskType ? { taskType: r.taskType } : {}),
      ...(r.correction ? { correction: r.correction } : {}),
      ...(r.excludedFromScoring ? { excludedCode: r.reason ?? 'excluded' } : {}),
      ...(r.drill ? { drill: true } : {}),
    }));

  // The drill counts ride along inside `state` (`drillTrials` / `drillHits` /
  // `drillWeight`), absent when nothing was practised — so a ledger with no
  // fast-growth session produces exactly the report it produced before M12c.
  return {
    ...state,
    agentId,
    addressable: canBeAddressed(state.stage),
    change: diagnoseChange(records),
    ledgerRows: rows.length,
    byTaskType,
    recentDecisions,
  };
}
