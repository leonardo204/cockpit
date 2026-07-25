import { describe, it, expect } from 'vitest';
import { applyAgentImport, IMPORTED_SESSION_ID } from './agentImport';
import { exportAgent } from './agentExport';
import {
  parseAgentSidecar,
  computeGrowth,
  canBeAddressed,
  DEFAULT_USER_ID,
  type Agent,
  type CheckinRecord,
  type EvalEvent,
  type MemoryItem,
  type MemoryScope,
} from '../../../../../../../dist/naby-runtime.mjs';

/**
 * Phase 3 P3-M7 — the WRITE half of an import, against a store that mints ids.
 *
 * The end-to-end direction matters most here. The runtime spike proves the parse
 * rules; this proves that after the rows are actually stored and read back, an
 * imported agent still cannot be addressed — which is the promise the export
 * format makes and the only reason a stage badge means anything.
 *
 * NO MEMORY IS WRITTEN, deliberately: the write gate forbids external content from
 * writing `user` scope at all, so the imported facts live in the agent's own
 * instructions instead. The first test asserts they arrived there.
 */

const NOW = 1_784_000_000_000;

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'a1',
    name: 'persona',
    kind: 'persona',
    description: 'Learns how you decide.',
    systemPrompt: 'You are the persona agent.',
    memoryScope: 'user',
    autonomy: { escalation: 'inline' },
    createdAt: 1,
    updatedAt: 2,
    ...over,
  };
}

let seq = 0;
function mem(over: Partial<MemoryItem> = {}): MemoryItem {
  seq += 1;
  return {
    id: `m${seq}`,
    scope: 'user' as MemoryScope,
    scopeKey: DEFAULT_USER_ID,
    type: 'semantic',
    key: `fact-${seq}`,
    value: `something true ${seq}`,
    provenance: { source: 'user', basis: 'they said so' },
    confidence: 1,
    status: 'confirmed',
    createdAt: 10,
    updatedAt: 20,
    ...over,
  } as MemoryItem;
}

function ledgerOf(hits: number, total: number): EvalEvent[] {
  return Array.from({ length: total }, (_, i) => ({
    id: `e${i}`,
    kind: 'checkin' as const,
    at: 1_000 + i,
    agentId: 'a1',
    sessionId: 'their-session',
    question: `Q${i}?`,
    options: [`A${i}`, `B${i}`],
    recommended: 0,
    chosen: i < hits ? 0 : 1,
    hit: i < hits,
  })) as EvalEvent[];
}

/** A store with the behaviours that matter: id minting and a readable ledger. */
function fakeStore(opts: { memory?: MemoryItem[] } = {}) {
  const agents: Agent[] = [];
  const memories: MemoryItem[] = [...(opts.memory ?? [])];
  const events: Array<Record<string, unknown>> = [];
  let ids = 0;
  return {
    agents,
    memories,
    events,
    listAgents: () => agents,
    putAgent(input: Omit<Agent, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }) {
      ids += 1;
      const row: Agent = { ...input, id: input.id ?? `new-${ids}`, createdAt: NOW, updatedAt: NOW } as Agent;
      agents.push(row);
      return row;
    },
    appendEvalEvent(event: Record<string, unknown>) {
      events.push(event);
      return event;
    },
    getScopedMemory(scope: MemoryScope, scopeKey: string) {
      return memories.filter((m) => m.scope === scope && m.scopeKey === scopeKey);
    },
    listEvalEvents() {
      return events as unknown as EvalEvent[];
    },
  };
}

const IMPORT_OPTS = { now: NOW, userId: DEFAULT_USER_ID };

describe('agentImport — the round trip all the way through a store', () => {
  it('export → import → stored, and the imported agent is STILL an egg', () => {
    // A file that legitimately reached butterfly where it came from.
    const source = fakeStore();
    const out = exportAgent(
      { getScopedMemory: () => [mem({ key: 'prefers-metric-units', value: 'Metric.' })], listEvalEvents: () => ledgerOf(20, 20) },
      agent(),
      { now: NOW },
    );
    expect(out.report.stage).toBe('butterfly');

    const parsed = parseAgentSidecar(out.sidecar, IMPORT_OPTS);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const outcome = applyAgentImport(source, parsed.plan);

    // It landed: a custom agent, its memory awaiting review, its record kept.
    expect(outcome.agent.kind).toBe('custom');
    expect(outcome.agent.id).not.toBe('a1');
    // The learned fact is in its INSTRUCTIONS, and no memory row was created.
    expect(outcome.agent.systemPrompt).toContain('- (user/semantic) prefers-metric-units: Metric.');
    expect(source.memories).toHaveLength(0);
    expect(outcome.ledgerWritten).toBe(20);

    // AND IT CANNOT BE ADDRESSED. Reading the stored rows back through the meter
    // gives an egg, because every one of them is flagged `imported`.
    const growth = computeGrowth(source.listEvalEvents() as unknown as CheckinRecord[]);
    expect(growth.stage).toBe('egg');
    expect(growth.trials).toBe(0);
    expect(canBeAddressed(growth.stage)).toBe(false);
  });

  it('declared as the user\'s own export, the stored rows do count', () => {
    const store = fakeStore();
    const out = exportAgent(
      { getScopedMemory: () => [], listEvalEvents: () => ledgerOf(18, 20) },
      agent(),
      { now: NOW },
    );
    const parsed = parseAgentSidecar(out.sidecar, { ...IMPORT_OPTS, trustLedger: true });
    if (!parsed.ok) throw new Error('parse failed');
    applyAgentImport(store, parsed.plan);

    const growth = computeGrowth(store.listEvalEvents() as unknown as CheckinRecord[]);
    expect(growth.trials).toBe(20);
    expect(growth.hits).toBe(18);
    expect(growth.stage).toBe('butterfly');
    expect(canBeAddressed(growth.stage)).toBe(true);
  });

  it('files imported growth rows under a placeholder session, never a foreign one', () => {
    const store = fakeStore();
    const out = exportAgent({ getScopedMemory: () => [], listEvalEvents: () => ledgerOf(2, 2) }, agent(), { now: NOW });
    const parsed = parseAgentSidecar(out.sidecar, IMPORT_OPTS);
    if (!parsed.ok) throw new Error('parse failed');
    const outcome = applyAgentImport(store, parsed.plan);
    for (const e of store.events) {
      expect(e.sessionId).toBe(IMPORTED_SESSION_ID);
      expect(e.agentId).toBe(outcome.agent.id);
    }
  });
});

describe('agentImport — what it does and does not write', () => {
  it('writes no memory at all — the gate would deny it, so nothing is attempted', () => {
    // This store FAILS the test if a memory write is even tried: proposing a row
    // the gate can only deny is the silent half-run this design refuses.
    const store = {
      ...fakeStore(),
      putMemory() {
        throw new Error('putMemory must not be called by an import');
      },
    };
    const out = exportAgent(
      {
        getScopedMemory: () => [
          mem({ key: 'prefers-metric-units', value: 'Metric.' }),
          mem({ key: 'build-command', type: 'procedural', value: 'npm run build:app' }),
        ],
        listEvalEvents: () => [],
      },
      agent(),
      { now: NOW },
    );
    const parsed = parseAgentSidecar(out.sidecar, IMPORT_OPTS);
    if (!parsed.ok) throw new Error('parse failed');
    expect(parsed.plan.report.factsInlined).toBe(2);
    const outcome = applyAgentImport(store, parsed.plan);
    // Both facts are effective, as instructions rather than as machine memory.
    expect(outcome.agent.systemPrompt).toContain('prefers-metric-units');
    expect(outcome.agent.systemPrompt).toContain('build-command');
    expect(store.agents).toHaveLength(1);
  });

  it('a name already taken is renamed at write time, not rejected', () => {
    const store = fakeStore();
    store.putAgent({ ...agent({ name: 'persona' }) } as never);
    const out = exportAgent({ getScopedMemory: () => [], listEvalEvents: () => [] }, agent(), { now: NOW });
    const parsed = parseAgentSidecar(out.sidecar, {
      ...IMPORT_OPTS,
      existingNames: store.listAgents().map((a) => a.name),
    });
    if (!parsed.ok) throw new Error('parse failed');
    const outcome = applyAgentImport(store, parsed.plan);
    expect(outcome.agent.name).toBe('persona-imported');
    expect(parsed.plan.report.renamedFrom).toBe('persona');
    // Nothing was overwritten.
    expect(store.agents).toHaveLength(2);
  });

  it('a ledger that cannot be written does not lose the agent', () => {
    const store = {
      putAgent: (input: never) => ({ ...(input as object), id: 'new-1', createdAt: NOW, updatedAt: NOW }) as Agent,
      appendEvalEvent: () => {
        throw new Error('disk full');
      },
    };
    const out = exportAgent({ getScopedMemory: () => [], listEvalEvents: () => ledgerOf(2, 2) }, agent(), { now: NOW });
    const parsed = parseAgentSidecar(out.sidecar, IMPORT_OPTS);
    if (!parsed.ok) throw new Error('parse failed');
    const outcome = applyAgentImport(store, parsed.plan);
    expect(outcome.agent.id).toBe('new-1');
    expect(outcome.ledgerWritten).toBe(0);
    expect(outcome.ledgerFailures).toBe(2);
  });
});
