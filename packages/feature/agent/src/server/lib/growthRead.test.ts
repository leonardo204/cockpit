import { describe, it, expect } from 'vitest';
import {
  growthReport,
  isAddressable,
  readGrowth,
  recentQuestions,
  LEDGER_READ_LIMIT,
} from './growthRead';
import { canBeAddressed } from '../../../../../../../dist/naby-runtime.mjs';
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

  it('bounds the query so a long history cannot be read in full', () => {
    const store = fakeStore([]);
    readGrowth(store, 'a1');
    expect(store.calls[0]).toEqual({ agentId: 'a1', opts: { limit: LEDGER_READ_LIMIT } });
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
