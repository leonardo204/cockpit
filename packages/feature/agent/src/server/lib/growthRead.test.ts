import { describe, it, expect } from 'vitest';
import { growthReport, readGrowth, recentQuestions, LEDGER_READ_LIMIT } from './growthRead';
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
