import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  growthReport,
  isAddressable,
  readGrowth,
  readLedger,
  recentQuestions,
  AUTONOMOUS_READ_LIMIT,
  CHECKIN_READ_LIMIT,
  LEDGER_READ_LIMITS,
  TRIPWIRE_READ_LIMIT,
} from './growthRead';
import {
  canBeAddressed,
  GROWTH_MIN_SAMPLE,
  IMPLICIT_WINDOW,
} from '../../../../../../../dist/naby-runtime.mjs';
import type { EvalEvent, EvalEventKind } from '../../../../../../../dist/naby-runtime.mjs';

let seq = 0;
function row(over: Partial<EvalEvent> = {}): EvalEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    kind: 'checkin',
    at: 1_000 + seq,
    agentId: 'a1',
    sessionId: 's1',
    ...over,
  } as EvalEvent;
}

/** A store that serves a fixed ledger and honours `kind` / `limit` the way the
 *  real one does (newest N, returned oldest-first). */
function fakeStore(rows: EvalEvent[]) {
  const calls: Array<{ agentId: string; opts?: unknown }> = [];
  return {
    calls,
    listEvalEvents(agentId: string, opts?: { kind?: EvalEventKind; limit?: number }) {
      calls.push({ agentId, opts });
      let out = rows.filter((r) => r.agentId === agentId);
      if (opts?.kind) out = out.filter((r) => r.kind === opts.kind);
      if (opts?.limit != null) out = out.slice(-opts.limit);
      return out;
    },
  };
}

function brokenStore() {
  return {
    listEvalEvents(): EvalEvent[] {
      throw new Error('database is locked');
    },
  };
}

describe('growthRead — the reading the palette and the panel share', () => {
  it('an agent with no ledger reads as an egg at 0%, not as an error', () => {
    const g = readGrowth(fakeStore([]), 'a1');
    expect(g.stage).toBe('egg');
    expect(g.percent).toBe(0);
  });

  it('a store failure reads as an egg too — a hiccup must not empty the palette', () => {
    const g = readGrowth(brokenStore(), 'a1');
    expect(g.stage).toBe('egg');
    expect(g.percent).toBe(0);
    expect(growthReport(brokenStore(), 'a1').ledgerRows).toBe(0);
  });

  it('bounds the query PER KIND, so no kind can be crowded out by another', () => {
    const store = fakeStore([]);
    readGrowth(store, 'a1');
    expect(store.calls).toEqual([
      { agentId: 'a1', opts: { kind: 'checkin', limit: CHECKIN_READ_LIMIT } },
      { agentId: 'a1', opts: { kind: 'autonomous', limit: AUTONOMOUS_READ_LIMIT } },
      { agentId: 'a1', opts: { kind: 'tripwire', limit: TRIPWIRE_READ_LIMIT } },
    ]);
  });

  it('merges the three reads back into one chronological sequence', () => {
    // The panel slices the LAST N rows for its decision list and the diagnosis
    // splits the sequence in half, so a merged read that came back grouped by
    // kind would quietly reorder history.
    const rows = [
      row({ at: 10, kind: 'checkin', hit: true }),
      row({ at: 20, kind: 'autonomous' }),
      row({ at: 30, kind: 'tripwire' }),
      row({ at: 40, kind: 'autonomous' }),
      row({ at: 50, kind: 'checkin', hit: false }),
    ];
    expect(readLedger(fakeStore(rows), 'a1').map((r) => r.at)).toEqual([10, 20, 30, 40, 50]);
  });

  it('one unreadable kind costs only that kind', () => {
    const rows = Array.from({ length: 8 }, () => row({ hit: true }));
    const store = {
      listEvalEvents(agentId: string, opts?: { kind?: EvalEventKind; limit?: number }) {
        if (opts?.kind === 'autonomous') throw new Error('database is locked');
        return rows.filter((r) => r.kind === (opts?.kind ?? 'checkin'));
      },
    };
    // The check-ins still arrive, so the stage is still measured — the old flat
    // read turned any failure into a total blank.
    expect(readGrowth(store, 'a1').stage).toBe('butterfly');
  });

  it('reads only the named agent — growth is per agent', () => {
    const rows = [
      ...Array.from({ length: 20 }, () => row({ agentId: 'a1', hit: true })),
      ...Array.from({ length: 20 }, () => row({ agentId: 'a2', hit: false })),
    ];
    expect(readGrowth(fakeStore(rows), 'a1').stage).toBe('butterfly');
    expect(readGrowth(fakeStore(rows), 'a2').percent).toBe(0);
  });
});

describe('growthRead — recent questions for the duplicate check', () => {
  it('returns them newest first, questionless rows dropped', () => {
    const rows = [
      row({ question: 'first?', hit: true }),
      row({ hit: true }), // an old row from before questions were stored
      row({ question: 'second?', hit: false }),
    ];
    expect(recentQuestions(fakeStore(rows), 'a1')).toEqual(['second?', 'first?']);
  });

  it('asks the store for check-ins only', () => {
    const store = fakeStore([]);
    recentQuestions(store, 'a1');
    expect((store.calls[0]!.opts as { kind?: string }).kind).toBe('checkin');
  });

  it('a store failure yields no history rather than throwing', () => {
    expect(recentQuestions(brokenStore(), 'a1')).toEqual([]);
  });
});

describe('growthRead — the full report the Settings panel renders', () => {
  it('agrees with the palette on stage and addressability', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row({ hit: i < 17 }));
    const store = fakeStore(rows);
    const report = growthReport(store, 'a1');
    const palette = readGrowth(store, 'a1');
    expect(report.stage).toBe(palette.stage);
    expect(report.percent).toBe(palette.percent);
    // The SAME predicate the engine routes on, so the panel cannot promise a
    // mention that routing would refuse.
    expect(report.addressable).toBe(true);
    expect(report.stage).toBe('butterfly');
  });

  it('carries a regression reason as a code, never as prose', () => {
    const report = growthReport(fakeStore([]), 'a1');
    expect(typeof report.change.code).toBe('string');
    expect(['up', 'down', 'flat']).toContain(report.change.direction);
  });

  it('breaks trust down per task type, each starting in its own egg', () => {
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => row({ hit: i < 18, taskType: 'code-refactor' })),
      // A brand-new kind of work: too few samples to be measured at all.
      row({ hit: true, taskType: 'sql-review' }),
      row({ hit: false, taskType: 'sql-review' }),
    ];
    const report = growthReport(fakeStore(rows), 'a1');
    const byType = Object.fromEntries(report.byTaskType.map((t) => [t.taskType, t]));
    expect(report.byTaskType.map((t) => t.taskType)).toEqual(['code-refactor', 'sql-review']);
    expect(byType['code-refactor']!.stage).toBe('butterfly');
    expect(byType['sql-review']!.stage).toBe('egg');
    expect(byType['sql-review']!.percent).toBe(0);
    expect(byType['sql-review']!.trials).toBe(2);
  });

  it('lists the recent decisions newest first, with the exclusion reason attached', () => {
    const rows = [
      row({ question: 'older?', options: ['a', 'b'], recommended: 0, chosen: 0, hit: true }),
      row({
        question: 'newer?',
        options: ['a', 'b'],
        recommended: 1,
        chosen: -1,
        hit: false,
        correction: 'do it the other way',
        excludedFromScoring: true,
        reason: 'repeat-question',
      }),
      // Not a decision: an autonomous action has no question to show.
      row({ kind: 'autonomous', toolName: 'Write' }),
    ];
    const decisions = growthReport(fakeStore(rows), 'a1').recentDecisions;
    expect(decisions.map((d) => d.question)).toEqual(['newer?', 'older?']);
    expect(decisions[0]).toMatchObject({
      chosen: -1,
      hit: false,
      correction: 'do it the other way',
      excludedCode: 'repeat-question',
    });
    expect(decisions[1]!.excludedCode).toBeUndefined();
  });
});

describe('growthRead — the implicit axis reaches the wire (P3-M8d)', () => {
  it('passes reviewedAt through, so the report carries the raw counts and the weight', () => {
    const rows = [
      // Five answered check-ins: enough to be measured at all.
      ...Array.from({ length: 5 }, () => row({ hit: true })),
      // Four reviewed actions, one of which the user fixed afterwards.
      ...Array.from({ length: 3 }, () =>
        row({ kind: 'autonomous', toolName: 'Write', reviewedAt: 2_000 }),
      ),
      row({ kind: 'autonomous', toolName: 'Write', reviewedAt: 2_000, correctedAfter: true }),
    ];
    const report = growthReport(fakeStore(rows), 'a1');

    // RAW, not pre-multiplied: the panel says "3 of 4 stood, each worth 0.25",
    // which a user can check against their own history. A weighted 0.75 could
    // not be checked against anything.
    expect(report.implicitTrials).toBe(4);
    expect(report.implicitHits).toBe(3);
    expect(report.implicitWeight).toBe(0.25);
    // The check-in record is untouched by the weak labels.
    expect(report.hits).toBe(5);
    expect(report.trials).toBe(5);
  });

  it('omits the implicit fields entirely when nothing has been reviewed', () => {
    // The regression invariant as the WIRE sees it: an existing user, whose
    // ledger has autonomous rows that no reflection pass has ever read, gets a
    // report shaped exactly as before — so the panel renders no implicit
    // sentence rather than "0 of 0".
    const rows = [
      ...Array.from({ length: 5 }, () => row({ hit: true })),
      ...Array.from({ length: 4 }, () => row({ kind: 'autonomous', toolName: 'Write' })),
    ];
    const report = growthReport(fakeStore(rows), 'a1');
    expect(report.implicitTrials).toBeUndefined();
    expect(report.implicitHits).toBeUndefined();
    expect(report.implicitWeight).toBeUndefined();
    expect(report.lowerBound).toBe(readGrowth(fakeStore(rows), 'a1').lowerBound);
  });
});

describe('growthRead — the drill axis reaches the wire (P3-M12c)', () => {
  it('reports real and practice counts SEPARATELY, so the panel can print both', () => {
    const rows = [
      ...Array.from({ length: 5 }, () => row({ hit: true })),
      ...Array.from({ length: 4 }, () => row({ drill: true, hit: true })),
      row({ drill: true, hit: false }),
    ];
    const report = growthReport(fakeStore(rows), 'a1');
    // The real record is exactly what it was — practice does not touch the
    // numbers the panel prints as "guessed right, N of M".
    expect(report.hits).toBe(5);
    expect(report.trials).toBe(5);
    expect(report.lifetimeTrials).toBe(5);
    // …and the practice is reported raw, with the weight it entered at.
    expect(report.drillTrials).toBe(5);
    expect(report.drillHits).toBe(4);
    expect(report.drillWeight).toBe(0.5);
  });

  it('marks a practice question in the decision list rather than hiding it', () => {
    const rows = [
      row({ question: 'real one?', options: ['a', 'b'], recommended: 0, chosen: 0, hit: true }),
      row({
        question: 'practice one?',
        options: ['a', 'b'],
        recommended: 0,
        chosen: 1,
        hit: false,
        drill: true,
      }),
    ];
    const decisions = growthReport(fakeStore(rows), 'a1').recentDecisions;
    // Newest first. The list is what makes the gauge auditable, so an invented
    // scenario sitting in it unlabelled would read as a real decision.
    expect(decisions[0]).toMatchObject({ question: 'practice one?', drill: true });
    expect(decisions[1]?.drill).toBeUndefined();
  });

  it('omits the drill fields entirely when nothing has been practised', () => {
    const rows = Array.from({ length: 5 }, () => row({ hit: true }));
    const report = growthReport(fakeStore(rows), 'a1');
    expect(report.drillTrials).toBeUndefined();
    expect(report.drillHits).toBeUndefined();
    expect(report.drillWeight).toBeUndefined();
  });

  it('a practice question still counts as HAVING BEEN ASKED for the duplicate check', () => {
    // `recentQuestions` filters by kind, not by the drill flag, which is what
    // makes the degenerate defence cover practice with no extra code: naby cannot
    // ask one easy question twenty ways and bank twenty answers.
    const rows = [
      row({ question: 'practice one?', drill: true, hit: true }),
      row({ question: 'real one?', hit: true }),
    ];
    expect(recentQuestions(fakeStore(rows), 'a1')).toEqual(['real one?', 'practice one?']);
  });
});

/**
 * THE `@` GATE (P3-M9, G2). One function, one read, two surfaces — the palette
 * (api/commands.ts) and engine routing both call `isAddressable`, so the menu can
 * no longer refuse a delegation the engine would perform. The growth read is
 * mocked here (a fixed ledger), which is what makes "egg → no, butterfly → yes"
 * assertable without a model or a real store.
 */
describe('growthRead — isAddressable, the one @ gate', () => {
  it('refuses an agent with no measured history — an egg is not delegable', () => {
    expect(readGrowth(fakeStore([]), 'a1').stage).toBe('egg');
    expect(isAddressable(fakeStore([]), 'a1')).toBe(false);
  });

  it('refuses every stage below butterfly, not merely the egg', () => {
    // 4 of 5 lands at larva, 5 of 5 at pupa (growth.ts stage table). Both are
    // "measured, and not yet trusted" — the gate must not read "has a ledger" as
    // "is grown".
    const larva = [...Array.from({ length: 4 }, () => row({ hit: true })), row({ hit: false })];
    expect(readGrowth(fakeStore(larva), 'a1').stage).toBe('larva');
    expect(isAddressable(fakeStore(larva), 'a1')).toBe(false);

    const pupa = Array.from({ length: 5 }, () => row({ hit: true }));
    expect(readGrowth(fakeStore(pupa), 'a1').stage).toBe('pupa');
    expect(isAddressable(fakeStore(pupa), 'a1')).toBe(false);
  });

  it('allows a butterfly — the stage the whole meter exists to certify', () => {
    const rows = Array.from({ length: 8 }, () => row({ hit: true }));
    expect(readGrowth(fakeStore(rows), 'a1').stage).toBe('butterfly');
    expect(isAddressable(fakeStore(rows), 'a1')).toBe(true);
  });

  it('FAILS CLOSED: a store that throws reads as not addressable', () => {
    // The same best-effort behaviour the palette has always had, with the
    // consequence that matters here — an agent whose trust we cannot establish
    // does not get handed the user's work.
    expect(isAddressable(brokenStore(), 'a1')).toBe(false);
  });

  it('agrees with the reading the palette shows, on the same rows', () => {
    // The regression this exists to prevent: two surfaces answering differently.
    // Asserted as an equality against `canBeAddressed(readGrowth(...).stage)`,
    // which is literally what api/commands.ts renders.
    for (const n of [0, 3, 5, 8, 20]) {
      const rows = Array.from({ length: n }, () => row({ hit: true }));
      const store = fakeStore(rows);
      expect(isAddressable(store, 'a1')).toBe(canBeAddressed(readGrowth(store, 'a1').stage));
    }
  });
});

/**
 * THE FLOOD (the regression this file's per-kind read exists for).
 *
 * A real ledger held 846 autonomous rows against 20 check-ins — one autonomous
 * row per consequential tool call against one check-in per decision worth
 * stopping for. The read was a single `{ limit: 200 }`, so the newest 200 rows
 * held TWO check-ins, the meter saw `trials: 2 < GROWTH_MIN_SAMPLE` and reported
 * "egg · not measured yet" for an agent whose full ledger computes a butterfly.
 * The stage regressed because the user WORKED. Nothing they could have done
 * would have explained it, and a gauge that moves for reasons its owner cannot
 * reconstruct is a gauge nobody believes again.
 *
 * Every test here builds the same shape — a handful of real check-ins buried
 * under hundreds of autonomous rows — and each one also asserts what the OLD
 * flat read would have produced, so the fixture is provably still adversarial.
 */
describe('growthRead — heavy use must not bury the record (the egg regression)', () => {
  /** The old read, exactly: newest N rows of every kind at once. */
  function flatRead(rows: EvalEvent[], limit: number): EvalEvent[] {
    return [...rows].sort((a, b) => a.at - b.at).slice(-limit);
  }

  /** `checkins` real answered check-ins, then `autonomous` tool calls on top. */
  function flooded(opts: { checkins: number; hits: number; autonomous: number; tripwire?: boolean }) {
    const rows: EvalEvent[] = [];
    let at = 1_000;
    for (let i = 0; i < opts.checkins; i += 1) {
      at += 1;
      rows.push(
        row({
          at,
          kind: 'checkin',
          hit: i < opts.hits,
          question: `Which way for step ${i}?`,
          options: ['a', 'b'],
          recommended: 0,
          chosen: i < opts.hits ? 0 : 1,
          taskType: 'code-refactor',
        }),
      );
    }
    if (opts.tripwire) {
      at += 1;
      rows.push(row({ at, kind: 'tripwire' }));
    }
    for (let i = 0; i < opts.autonomous; i += 1) {
      at += 1;
      rows.push(row({ at, kind: 'autonomous', toolName: 'Write', taskType: 'code-refactor' }));
    }
    return rows;
  }

  it('reads the stage from the check-ins, however many tool calls sit on top', () => {
    const rows = flooded({ checkins: 10, hits: 10, autonomous: 300 });

    // The fixture is genuinely adversarial: the old read saw no check-in at all.
    const buried = flatRead(rows, 200).filter((r) => r.kind === 'checkin');
    expect(buried).toHaveLength(0);

    const store = fakeStore(rows);
    const g = readGrowth(store, 'a1');
    expect(g.trials).toBe(10);
    expect(g.trials).toBeGreaterThanOrEqual(GROWTH_MIN_SAMPLE);
    expect(g.stage).toBe('butterfly');
    expect(g.percent).toBeGreaterThan(0);
    expect(isAddressable(fakeStore(rows), 'a1')).toBe(true);
  });

  it('the panel and the palette agree on the flooded ledger too', () => {
    const rows = flooded({ checkins: 10, hits: 10, autonomous: 300 });
    const report = growthReport(fakeStore(rows), 'a1');
    const palette = readGrowth(fakeStore(rows), 'a1');
    expect(report.stage).toBe(palette.stage);
    expect(report.percent).toBe(palette.percent);
    expect(report.stage).toBe('butterfly');
    expect(report.addressable).toBe(true);
    // Every row the reading was based on, both kinds — not 200 of one kind.
    expect(report.ledgerRows).toBe(310);
    // The decisions are still listed: they are the rows that make the gauge
    // auditable, and a flood must not empty the list either.
    expect(report.recentDecisions).toHaveLength(8);
    expect(report.recentDecisions[0]!.question).toBe('Which way for step 9?');
    // The regression sentence is computed from a record that still exists.
    expect(report.change.code).not.toBe('not-measured');
  });

  it('the duplicate defence still sees the questions under the flood', () => {
    // `recentQuestions` filters by kind AT THE STORE. Sliced post-hoc from a flat
    // read, the newest twelve rows of a working day are twelve tool calls, and
    // the defence would silently compare every new question against nothing.
    const rows = flooded({ checkins: 10, hits: 10, autonomous: 300 });
    const questions = recentQuestions(fakeStore(rows), 'a1');
    expect(questions).toHaveLength(10);
    expect(questions[0]).toBe('Which way for step 9?');
    expect(flatRead(rows, 12).filter((r) => r.question)).toHaveLength(0);
  });

  it('a tripwire under the flood still blocks butterfly — the hard gate cannot be evicted', () => {
    // The one axis in the meter that is a refusal rather than an average. If a
    // safety row could be pushed out of the read by ordinary tool calls, the
    // block would silently lift on exactly the busiest ledgers.
    const rows = flooded({ checkins: 10, hits: 10, autonomous: 300, tripwire: true });
    expect(flatRead(rows, 200).some((r) => r.kind === 'tripwire')).toBe(false);

    const g = readGrowth(fakeStore(rows), 'a1');
    expect(g.tripwires).toBe(1);
    expect(g.blockedByTripwire).toBe(true);
    expect(g.stage).toBe('pupa');
    expect(isAddressable(fakeStore(rows), 'a1')).toBe(false);
  });

  it('the implicit pool still fills when reviewed rows sit at the real density', () => {
    // THE SECOND HALF OF THE SAME BUG, and the one that decided the autonomous
    // budget. `implicitPool` wants the newest IMPLICIT_WINDOW autonomous rows
    // THAT REFLECTION HAS REVIEWED — and reviewed rows are a subset: on the
    // ledger this was found in, 70 of 846 carried `reviewedAt`, so the 40th one
    // back sat 525 rows from the end. They enter the BOUND, so a budget that
    // cannot reach them costs a stage: at 400 that ledger read pupa 84% where
    // the full one reads butterfly 100%.
    //
    // The real ledger's check-in record: 10 of 14, which is a PUPA on its own and
    // a butterfly once the reviewed actions are counted. That is what makes this
    // assertion load-bearing rather than decorative — the pool has to arrive for
    // the stage to be right.
    const rows = flooded({ checkins: 14, hits: 10, autonomous: 0 });
    expect(readGrowth(fakeStore(rows), 'a1').stage).toBe('pupa');
    // The reviewed rows are the OLD ones, which is not an unlucky arrangement but
    // how reflection works: it sweeps IDLE sessions, so the newest actions — the
    // ones from the conversation still going — are exactly the unreviewed ones.
    // On the real ledger the newest reviewed row was already 146 rows back.
    let at = 5_000;
    for (let i = 0; i < IMPLICIT_WINDOW; i += 1) {
      at += 1;
      rows.push(row({ at, kind: 'autonomous', toolName: 'Write', reviewedAt: at + 1 }));
    }
    const buriedUnder = IMPLICIT_WINDOW * 11;
    for (let i = 0; i < buriedUnder; i += 1) {
      at += 1;
      rows.push(row({ at, kind: 'autonomous', toolName: 'Write' }));
    }
    // The budget has to clear the whole stack, not just the pool.
    expect(AUTONOMOUS_READ_LIMIT).toBeGreaterThanOrEqual(IMPLICIT_WINDOW + buriedUnder);

    const report = growthReport(fakeStore(rows), 'a1');
    expect(report.implicitTrials).toBe(IMPLICIT_WINDOW);
    expect(report.implicitHits).toBe(IMPLICIT_WINDOW);
    // …and the pool is what carries the stage over the line, which is why this
    // is asserted on the STAGE and not only on the counts.
    expect(report.stage).toBe('butterfly');
  });
});

/**
 * SOURCE ASSERTIONS. jsdom cannot see a SQL limit and a passing meter cannot
 * tell you which query produced it, so what is pinned here is the SHAPE of the
 * read: three budgets, one per kind, and no flat `limit` left anywhere in the
 * file. A future edit that "simplifies" this back into one read fails here.
 */
describe('growthRead — the read shape is pinned in source', () => {
  const source = readFileSync(join(__dirname, 'growthRead.ts'), 'utf8');

  it('every ledger read names a kind', () => {
    const calls = source.match(/listEvalEvents\(agentId, \{[^}]*\}/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toContain('kind');
  });

  it('sizes all three kinds, and the map is keyed by EvalEventKind so a new one must be sized', () => {
    expect(source).toContain('Readonly<Record<EvalEventKind, number>>');
    expect(LEDGER_READ_LIMITS).toEqual({
      checkin: CHECKIN_READ_LIMIT,
      autonomous: AUTONOMOUS_READ_LIMIT,
      tripwire: TRIPWIRE_READ_LIMIT,
    });
  });

  it('sizes each budget against the window that consumes it', () => {
    // The check-in budget carries every check-in-consuming window (the stage's
    // 20, the 12-question lookback, the drill window, the 8 listed decisions).
    expect(CHECKIN_READ_LIMIT).toBeGreaterThanOrEqual(200);
    // The autonomous budget reaches a full implicit pool at the review density a
    // real ledger showed (about one reviewed row in twelve), with headroom.
    expect(AUTONOMOUS_READ_LIMIT).toBeGreaterThanOrEqual(IMPLICIT_WINDOW * 24);
    // Tripwires are rare; the separate read, not the size, is what protects them.
    expect(TRIPWIRE_READ_LIMIT).toBeGreaterThan(0);
  });

  it('merges chronologically before the meter sees the rows', () => {
    expect(source).toContain('sortLedger');
    expect(source).toContain('a.at - b.at');
  });
});
