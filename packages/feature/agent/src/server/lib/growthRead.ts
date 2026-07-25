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
 *  still bounding the query — the meter itself scores only the recent window. */
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

/** The agent's recent check-in questions, NEWEST FIRST — what `degenerateReason`
 *  compares a new question against. Excluded rows are included on purpose: a
 *  question that was already thrown out for being a repeat still counts as having
 *  been asked, so asking it a third time is caught too. */
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
  /** Present when the row was thrown out, with the plain-words reason. */
  excludedReason?: string;
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
      ...(r.excludedFromScoring ? { excludedReason: r.reason ?? 'excluded from scoring' } : {}),
    }));

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
