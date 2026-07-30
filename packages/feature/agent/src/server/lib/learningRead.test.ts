import { describe, it, expect } from 'vitest';
import {
  learningReport,
  safeLearningReport,
  CORROBORATED_MIN,
  LEARNING_LEDGER_LIMIT,
  type LearningStore,
} from './learningRead';
import {
  DEFAULT_USER_ID,
  type EvalEvent,
  type MemoryItem,
  type MemoryScope,
  type MemoryStatus,
} from '../../../../../../../dist/naby-runtime.mjs';

/**
 * Phase 3 P3-M8c — the learning-depth block (continuous-learning §6.3).
 *
 * The numbers here are the ones a user will read as "how much does it know about
 * me", so being wrong is worse than being absent: a count that silently includes
 * the wrong scope, or counts proposals as facts in use, tells the person their
 * agent knows things it will never act on. Every assertion below is against a
 * store seeded with rows whose expected count is written out by hand.
 */

let seq = 0;
function mem(over: Partial<MemoryItem> = {}): MemoryItem {
  seq += 1;
  return {
    id: `m${seq}`,
    scope: 'user',
    scopeKey: DEFAULT_USER_ID,
    type: 'semantic',
    key: `k${seq}`,
    value: `v${seq}`,
    provenance: { source: 'user' },
    confidence: 1,
    status: 'confirmed' as MemoryStatus,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function ledgerRow(taskType?: string): EvalEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    kind: 'checkin',
    at: 1_000 + seq,
    agentId: 'a1',
    sessionId: 's1',
    ...(taskType ? { taskType } : {}),
  } as EvalEvent;
}

type FakeOptions = {
  memory?: Partial<Record<MemoryScope, MemoryItem[]>>;
  corroboration?: Record<string, number>;
  ledger?: EvalEvent[];
  reflectedAt?: number;
  /** Scopes whose read throws, to exercise the best-effort behaviour. */
  brokenScopes?: MemoryScope[];
  breakCorroboration?: boolean;
  breakLedger?: boolean;
  breakReflection?: boolean;
};

function fakeStore(options: FakeOptions = {}) {
  const reads: Array<{ scope: MemoryScope; scopeKey: string }> = [];
  const ledgerCalls: Array<{ agentId: string; opts?: { limit?: number } }> = [];
  const store: LearningStore = {
    getScopedMemory(scope, scopeKey) {
      reads.push({ scope, scopeKey });
      if (options.brokenScopes?.includes(scope)) throw new Error('database is locked');
      return options.memory?.[scope] ?? [];
    },
    getMemoryCorroboration(ids) {
      if (options.breakCorroboration) throw new Error('no observation table');
      const out: Record<string, number> = {};
      for (const id of ids) {
        const n = options.corroboration?.[id];
        if (n) out[id] = n;
      }
      return out;
    },
    listEvalEvents(agentId, opts) {
      ledgerCalls.push({ agentId, ...(opts ? { opts } : {}) });
      if (options.breakLedger) throw new Error('database is locked');
      return options.ledger ?? [];
    },
    getLatestReflectionAt() {
      if (options.breakReflection) throw new Error('database is locked');
      return options.reflectedAt;
    },
  };
  return { store, reads, ledgerCalls };
}

describe('learningRead — which scopes count as this agent’s learning', () => {
  it('reads the user scope always, and the project scope only with a cwd', () => {
    const { store, reads } = fakeStore();
    learningReport(store, 'a1');
    expect(reads).toEqual([{ scope: 'user', scopeKey: DEFAULT_USER_ID }]);

    const withCwd = fakeStore();
    learningReport(withCwd.store, 'a1', { cwd: '/work/app' });
    expect(withCwd.reads).toEqual([
      { scope: 'user', scopeKey: DEFAULT_USER_ID },
      { scope: 'project', scopeKey: '/work/app' },
    ]);
  });

  it('never reads session or org — the same rule the export follows', () => {
    // A count of session-scoped facts is a count of things that die with the
    // conversation; org memory is someone else's curation. Crediting either to
    // this agent's learning would be a number the export could not ship.
    const { store, reads } = fakeStore();
    learningReport(store, 'a1', { cwd: '/work/app' });
    expect(reads.map((r) => r.scope)).not.toContain('session');
    expect(reads.map((r) => r.scope)).not.toContain('org');
  });

  it('omits project from the breakdown entirely when there is no cwd', () => {
    // Not "project: 0" — an absent scope means "not applicable here", and a zero
    // would read as "this project taught it nothing".
    const report = learningReport(fakeStore().store, 'a1');
    expect(report.confirmedByScope.project).toBeUndefined();
    expect(report.confirmedByScope.user).toBe(0);
  });
});

describe('learningRead — the counts', () => {
  it('counts confirmed per scope and in total, and proposals separately', () => {
    const { store } = fakeStore({
      memory: {
        user: [
          mem({ id: 'u1' }),
          mem({ id: 'u2' }),
          mem({ id: 'u3', status: 'proposed' }),
          mem({ id: 'u4', status: 'proposed' }),
        ],
        project: [mem({ id: 'p1', scope: 'project' }), mem({ id: 'p2', scope: 'project', status: 'proposed' })],
      },
    });
    const report = learningReport(store, 'a1', { cwd: '/work/app' });

    expect(report.confirmedByScope).toEqual({ user: 2, project: 1 });
    expect(report.confirmedTotal).toBe(3);
    // Proposals are NOT facts in use: they cannot shape a turn until confirmed,
    // so counting them together would promise behaviour the agent will not show.
    expect(report.proposedCount).toBe(3);
  });

  it(`counts a proposal as corroborated at ${CORROBORATED_MIN} distinct sessions, not below`, () => {
    const { store } = fakeStore({
      memory: {
        user: [
          mem({ id: 'p-two', status: 'proposed' }),
          mem({ id: 'p-one', status: 'proposed' }),
          mem({ id: 'p-none', status: 'proposed' }),
        ],
      },
      corroboration: { 'p-two': 2, 'p-one': 1 },
    });
    expect(learningReport(store, 'a1').corroborated2Plus).toBe(1);
  });

  it('does not ask about corroboration when nothing is proposed', () => {
    const { store } = fakeStore({
      memory: { user: [mem({ id: 'u1' })] },
      // A throwing implementation proves the call is not made at all: if it were,
      // the try/catch would hide the mistake behind a plausible 0.
      breakCorroboration: true,
    });
    expect(learningReport(store, 'a1').corroborated2Plus).toBe(0);
  });

  it('counts DISTINCT task types from a bounded ledger read', () => {
    const { store, ledgerCalls } = fakeStore({
      ledger: [
        ledgerRow('sql-review'),
        ledgerRow('sql-review'),
        ledgerRow('code-refactor'),
        ledgerRow(), // an older row from before task types were recorded
      ],
    });
    const report = learningReport(store, 'a1');
    expect(report.distinctTaskTypes).toBe(2);
    expect(ledgerCalls).toEqual([{ agentId: 'a1', opts: { limit: LEARNING_LEDGER_LIMIT } }]);
  });

  it('reports the last reflection, and omits it before the first one', () => {
    expect(learningReport(fakeStore({ reflectedAt: 4_242 }).store, 'a1').lastReflectionAt).toBe(4_242);
    expect(learningReport(fakeStore().store, 'a1').lastReflectionAt).toBeUndefined();
  });
});

describe('learningRead — every read is best-effort', () => {
  it('an unreadable project scope does not lose the user scope', () => {
    const { store } = fakeStore({
      memory: { user: [mem({ id: 'u1' }), mem({ id: 'u2' })] },
      brokenScopes: ['project'],
    });
    const report = learningReport(store, 'a1', { cwd: '/work/app' });
    expect(report.confirmedByScope.user).toBe(2);
    expect(report.confirmedByScope.project).toBe(0);
    expect(report.confirmedTotal).toBe(2);
  });

  it('a broken ledger, corroboration table or cursor still yields a report', () => {
    const { store } = fakeStore({
      memory: { user: [mem({ id: 'u1' }), mem({ id: 'p1', status: 'proposed' })] },
      breakLedger: true,
      breakCorroboration: true,
      breakReflection: true,
    });
    const report = learningReport(store, 'a1');
    expect(report.confirmedTotal).toBe(1);
    expect(report.proposedCount).toBe(1);
    expect(report.corroborated2Plus).toBe(0);
    expect(report.distinctTaskTypes).toBe(0);
    expect(report.lastReflectionAt).toBeUndefined();
  });

  it('safeLearningReport swallows even a store that cannot be read at all', () => {
    // The trust meter is the load-bearing half of `growth.get`. A learning count
    // must never be the reason a user cannot see their stage.
    const exploding = {
      getScopedMemory() {
        throw new Error('boom');
      },
    } as unknown as LearningStore;
    const report = safeLearningReport(exploding, 'a1');
    expect(report.confirmedTotal).toBe(0);
    expect(report.confirmedByScope).toEqual({ user: 0 });
  });
});
