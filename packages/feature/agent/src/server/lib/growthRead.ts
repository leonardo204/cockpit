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
// budgets, the best-effort behaviour and the shape all live here.
//
// EVERY READ IS BEST-EFFORT. A store hiccup or a ledger that does not exist yet
// must never empty the palette or blank the panel: it reads as an egg, which is
// the truthful answer for an agent with no measured history.

import {
  computeGrowth,
  canBeAddressed,
  diagnoseChange,
  GROWTH_WINDOW,
  IMPLICIT_WINDOW,
  type CheckinRecord,
  type GrowthChange,
  type GrowthStage,
  type GrowthState,
} from '../../../../../../../dist/naby-runtime.mjs';
import type { EvalEvent, EvalEventKind } from '../../../../../../../dist/naby-runtime.mjs';

// ---------------------------------------------------------------------------
// HOW MUCH LEDGER A READING PULLS — and why it is PER KIND, not one flat limit
// ---------------------------------------------------------------------------
//
// THE BUG THIS SHAPE EXISTS TO PREVENT. The read used to be a single
// `{ limit: GROWTH_WINDOW * 10 }` over every kind at once. That is sound only
// while the kinds arrive at comparable rates, and they do not: an `autonomous`
// row is written per consequential tool call, a `checkin` row only when naby
// stops and asks. On a real ledger the ratio ran past 40:1 (846 autonomous
// against 20 check-ins), so the newest 200 rows held TWO check-ins — below
// `GROWTH_MIN_SAMPLE` — and the meter reported "egg · not measured yet" for an
// agent whose full ledger computes a butterfly. The user watched their agent
// regress for no reason but their own heavy use, which is the single most
// destructive thing a trust meter can do: the number moved, nothing they did
// explains it, and after that nobody believes the gauge again.
//
// The fix is not a bigger number. Any flat limit has the same failure mode one
// busy week later. Each kind is read on its OWN budget, sized against the window
// the meter actually consumes it in, and the three reads are merged by time.

/** CHECK-INS — the labelled predictions the stage is computed from.
 *
 *  Every check-in-consuming window fits inside this with room to spare:
 *  `GROWTH_WINDOW` (20) for the stage itself, `RECENT_QUESTION_LOOKBACK` (12)
 *  for the degenerate defence, `DRILL_WINDOW` (20) for practice, and the eight
 *  rows the panel lists. It also feeds ADWIN, which wants rows on BOTH sides of
 *  a candidate split, and the lifetime totals — both of which simply get more
 *  honest the more history they see, so this is set at 10× the scored window
 *  rather than at the window. */
export const CHECKIN_READ_LIMIT = GROWTH_WINDOW * 10;

/** AUTONOMOUS ACTIONS — the coverage axis, the correction count, and the weak
 *  implicit labels.
 *
 *  THIS ONE IS NOT MERELY INFORMATIONAL, which is what makes its size worth
 *  measuring rather than guessing. `implicitPool` takes the newest
 *  `IMPLICIT_WINDOW` (40) autonomous rows THAT REFLECTION HAS REVIEWED, and
 *  those enter the same Wilson bound the check-ins do at `IMPLICIT_WEIGHT`. Come
 *  up short and the bound falls, so a budget that cannot reach 40 reviewed rows
 *  costs a STAGE, not just a percentage.
 *
 *  Sized against what a real ledger looks like, because two things make the
 *  reviewed rows sit much deeper than 40:
 *
 *    - REVIEWED IS A SUBSET. Reflection only stamps sessions its sweep has
 *      reached. On the ledger this bug was found in, 70 of 846 autonomous rows
 *      carried `reviewedAt` — about one in twelve — so the 40th-newest reviewed
 *      row sat 525 rows from the end. A 400-row budget reached 12 of them and
 *      reported pupa 84% where the full ledger reads butterfly 100%: the same
 *      class of failure as the flat read, one stage less severe.
 *    - THE SPAN IS WIDER STILL. `coverage`, `correctedAfter` and the
 *      ask-quality counts read EVERY autonomous row since the recent check-in
 *      window began — 576 rows on that same ledger.
 *
 *  50× the implicit window (2000) covers both with ~4× headroom at the observed
 *  review density, and costs nothing measurable: the whole three-read reading
 *  against that ledger takes ~1.5ms, unchanged from 400, because the budget is a
 *  ceiling and the rows are not there to be read.
 *
 *  IT IS STILL A CEILING, and the honest note is that a ceiling is the wrong
 *  shape for this axis: what the meter actually wants is every autonomous row
 *  SINCE the check-in window began, which is a time bound. `listEvalEvents` has
 *  no `since` filter today, and inventing one is a runtime/store change rather
 *  than a fix to a display read. Until it exists, this degrades gracefully — a
 *  truncated pool understates the bound, never inflates it. */
export const AUTONOMOUS_READ_LIMIT = IMPLICIT_WINDOW * 50;

/** TRIPWIRES — safety refusals. Rare, and the one HARD gate in the meter: a
 *  single one inside the window blocks butterfly outright (§4.8), so it must
 *  never be the row an autonomous flood evicts. Its own read makes that
 *  structural rather than probabilistic.
 *
 *  Small on purpose. `computeGrowth` counts tripwires in `spanRows` — the rows
 *  since the recent check-in window began — and all the gate asks is whether
 *  that count is non-zero. Fifty newest is far more than a span ever holds; and
 *  in the pathological case where it is not, the read still returns the NEWEST
 *  fifty, so the count stays non-zero and the block still fires. The gate cannot
 *  be lost by truncation in either direction. */
export const TRIPWIRE_READ_LIMIT = 50;

/** The budget per kind, keyed by `EvalEventKind` so the compiler — not a future
 *  reviewer — is what forces a NEW kind to be sized before it can be stored.
 *  A kind missing from this map is a type error, which is the point: the flat
 *  read failed silently, and a silent failure in the trust meter is worse than
 *  a broken build. */
export const LEDGER_READ_LIMITS: Readonly<Record<EvalEventKind, number>> = {
  checkin: CHECKIN_READ_LIMIT,
  autonomous: AUTONOMOUS_READ_LIMIT,
  tripwire: TRIPWIRE_READ_LIMIT,
};

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

/**
 * Read an agent's recent ledger, OLDEST FIRST — one bounded read per kind,
 * merged by time. [] on total failure.
 *
 * THREE READS, NOT ONE, for the reason spelled out at `LEDGER_READ_LIMITS`: a
 * single limit lets the highest-frequency kind evict every other kind, and the
 * kind that gets evicted is the one the stage is computed from.
 *
 * MERGED ASCENDING BY `at`, ties broken by id — exactly the order the store
 * returns a single read in (`ORDER BY at DESC, id DESC` reversed), so callers
 * cannot tell a merged read from a flat one by its ordering. It matters:
 * `computeGrowth` re-sorts defensively, but `growthReport` slices the LAST N
 * rows for the decision list and `diagnoseChange` splits the sequence in half,
 * and both of those are chronology, not sets.
 *
 * BEST-EFFORT PER KIND. One unreadable kind contributes nothing instead of
 * blanking the other two — the same fail-direction the whole file has, applied
 * at the granularity the reads now have.
 */
export function readLedger(store: GrowthLedgerStore, agentId: string): EvalEvent[] {
  return readLedgerByKind(store, agentId, LEDGER_READ_LIMITS);
}

/**
 * The per-kind read itself, with the budget passed in — so the OTHER bounded
 * ledger readers (the export's archive, the learning panel's breadth count) get
 * the same protection from the same code instead of each re-deriving it and each
 * getting it wrong on a different day. It is a READ, not a reading: no stage, no
 * percentage, nothing that makes this the second place a ledger becomes trust.
 */
export function readLedgerByKind(
  store: GrowthLedgerStore,
  agentId: string,
  limits: Readonly<Record<EvalEventKind, number>>,
): EvalEvent[] {
  const rows: EvalEvent[] = [];
  for (const [kind, limit] of Object.entries(limits) as Array<[EvalEventKind, number]>) {
    try {
      rows.push(...store.listEvalEvents(agentId, { kind, limit }));
    } catch {
      /* one unreadable kind must not cost the others */
    }
  }
  return sortLedger(rows);
}

/** Chronological order, ties broken by id — the store's own ordering. */
export function sortLedger(rows: EvalEvent[]): EvalEvent[] {
  return rows.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
 *  either.
 *
 *  THE KIND FILTER IS THE STORE'S, and must stay there. Reading rows of every
 *  kind and keeping the check-ins afterwards would return NOTHING on a busy
 *  ledger — the newest twelve rows of a working day are twelve autonomous tool
 *  calls — and a duplicate defence that silently compares against an empty
 *  history is a duplicate defence that is off. Same failure the flat
 *  `readLedger` had; this one never had it, and this note is why. */
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
