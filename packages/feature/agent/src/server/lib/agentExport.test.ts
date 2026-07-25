import { describe, it, expect } from 'vitest';
import { exportAgent, gatherExportMemories, EXPORT_LEDGER_LIMIT } from './agentExport';
import { parseSubagentArtifact } from './harnessImporter';
import {
  DEFAULT_USER_ID,
  type Agent,
  type EvalEvent,
  type MemoryItem,
  type MemoryScope,
} from '../../../../../../../dist/naby-runtime.mjs';

/**
 * Phase 3 P3-M6 — THE ROUND TRIP, asserted against the REAL importer.
 *
 * The export format was not invented: `parseSubagentArtifact` already reads
 * Claude Code subagent files, and the exporter emits what that parser reads back.
 * That claim is only worth anything if the actual parser is the one doing the
 * reading, which is why this test lives here rather than in the runtime spike.
 */

const NOW = 1_784_000_000_000;

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'a1',
    name: 'persona',
    kind: 'persona',
    description: 'Learns how you decide and acts on your behalf.',
    systemPrompt: 'You are the persona agent.\n\nAlways answer in the user\'s language.',
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

function fakeStore(rows: MemoryItem[], ledger: EvalEvent[] = []) {
  const scopeCalls: Array<{ scope: string; scopeKey: string }> = [];
  const ledgerCalls: Array<{ agentId: string; opts?: unknown }> = [];
  return {
    scopeCalls,
    ledgerCalls,
    getScopedMemory(scope: MemoryScope, scopeKey: string) {
      scopeCalls.push({ scope, scopeKey });
      return rows.filter((r) => r.scope === scope && r.scopeKey === scopeKey);
    },
    listEvalEvents(agentId: string, opts?: { limit?: number }) {
      ledgerCalls.push({ agentId, opts });
      return ledger;
    },
  };
}

describe('agentExport — the round trip through the real importer', () => {
  it('the exported .md parses back into the same fields', () => {
    const a = agent({ model: 'claude-opus-5', toolRefs: ['Read', 'Grep', 'naby_remember'] });
    const out = exportAgent(fakeStore([]), a, { now: NOW });

    const parsed = parseSubagentArtifact('fallback-name', out.markdown);
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe(a.name);
    expect(parsed!.description).toBe(a.description);
    expect(parsed!.subagent?.model).toBe('claude-opus-5');
    expect(parsed!.subagent?.toolRefs).toEqual(['Read', 'Grep', 'naby_remember']);
    // The body starts with the persona's own instruction, untouched.
    expect(parsed!.subagent?.systemPrompt.startsWith('You are the persona agent.')).toBe(true);
  });

  it('a description full of YAML punctuation survives the round trip verbatim', () => {
    const nasty = 'Reviews SQL: fast, "safely" — #1 choice {always}, no: really';
    const out = exportAgent(fakeStore([]), agent({ description: nasty }), { now: NOW });
    // Unquoted, `description: Reviews SQL: fast` would truncate at the second
    // colon — the failure would be silent and the field would just be wrong.
    expect(parseSubagentArtifact('x', out.markdown)!.description).toBe(nasty);
  });

  it('the learned facts survive into the parsed system prompt, so one file is enough', () => {
    const rows = [
      mem({ key: 'prefers-metric-units', value: 'Distances and weights in metric.' }),
      mem({ key: 'build-command', value: 'Build with npm run build:app.' }),
    ];
    const out = exportAgent(fakeStore(rows), agent(), { now: NOW });
    const prompt = parseSubagentArtifact('x', out.markdown)!.subagent!.systemPrompt;
    expect(prompt).toContain('- (user/semantic) prefers-metric-units: Distances and weights in metric.');
    expect(prompt).toContain('- (user/semantic) build-command: Build with npm run build:app.');
    expect(out.report.memoriesIncluded).toBe(2);
  });

  it('nothing the parser reads back can grant trust', () => {
    const ledger = Array.from({ length: 20 }, (_, i) => ({
      id: `e${i}`,
      kind: 'checkin' as const,
      at: 1_000 + i,
      agentId: 'a1',
      sessionId: 's1',
      hit: i < 18,
    })) as EvalEvent[];
    const out = exportAgent(fakeStore([], ledger), agent(), { now: NOW });
    expect(out.report.stage).toBe('butterfly');

    const parsed = parseSubagentArtifact('x', out.markdown)!;
    // The importer's shape has no stage/growth field at all, so an artifact
    // claiming `butterfly` has nowhere to put the claim. Addressability comes
    // only from canBeAddressed(computeGrowth(ledger)) on the importing machine.
    const flat = JSON.stringify(parsed);
    expect(flat).not.toMatch(/"stage"|"growth"|"percent"|"addressable"/);
    // The record survives as a comment inside the prompt body — a note about
    // where the file came from, which no code path reads as permission.
    expect(parsed.subagent!.systemPrompt).toContain('a record, not a permission');
  });

  it('a hand-edited stage in the frontmatter is simply not a field', () => {
    const out = exportAgent(fakeStore([]), agent(), { now: NOW });
    const tampered = out.markdown.replace('---\nname:', '---\nstage: butterfly\ntrusted: true\nname:');
    const parsed = parseSubagentArtifact('x', tampered)!;
    // Both invented keys are dropped on the floor: there is nowhere for them to go.
    expect(JSON.stringify(parsed)).not.toMatch(/butterfly|trusted/);
    expect(parsed.name).toBe('persona');
  });
});

describe('agentExport — which rows are gathered', () => {
  it('reads user scope always and project scope only with a cwd', () => {
    const store = fakeStore([]);
    gatherExportMemories(store);
    expect(store.scopeCalls).toEqual([{ scope: 'user', scopeKey: DEFAULT_USER_ID }]);

    const withCwd = fakeStore([]);
    gatherExportMemories(withCwd, { cwd: '/repo' });
    expect(withCwd.scopeCalls).toEqual([
      { scope: 'user', scopeKey: DEFAULT_USER_ID },
      { scope: 'project', scopeKey: '/repo' },
    ]);
  });

  it('never queries session or org scope — the drop rule and the query agree', () => {
    const store = fakeStore([]);
    gatherExportMemories(store, { cwd: '/repo' });
    expect(store.scopeCalls.map((c) => c.scope)).not.toContain('session');
    expect(store.scopeCalls.map((c) => c.scope)).not.toContain('org');
  });

  it('an unreadable scope contributes nothing instead of failing the export', () => {
    const store = {
      getScopedMemory(scope: MemoryScope) {
        if (scope === 'project') throw new Error('database is locked');
        return [mem({ key: 'survives' })];
      },
      listEvalEvents() {
        return [];
      },
    };
    const out = exportAgent(store, agent(), { cwd: '/repo', now: NOW });
    expect(out.report.memoriesIncluded).toBe(1);
    expect(out.markdown).toContain('survives');
  });

  it('a broken ledger read still produces a file — the importer just starts at egg', () => {
    const store = {
      getScopedMemory() {
        return [];
      },
      listEvalEvents(): EvalEvent[] {
        throw new Error('database is locked');
      },
    };
    const out = exportAgent(store, agent(), { now: NOW });
    expect(out.report.ledgerRows).toBe(0);
    expect(out.report.stage).toBe('egg');
    expect(parseSubagentArtifact('x', out.markdown)).not.toBeNull();
  });

  it('bounds the ledger query, and archives more than the meter reads', () => {
    const store = fakeStore([]);
    exportAgent(store, agent(), { now: NOW });
    expect(store.ledgerCalls[0]).toEqual({ agentId: 'a1', opts: { limit: EXPORT_LEDGER_LIMIT } });
    // An export is an archive: discarding history the importing machine could
    // have used to recompute a stage would defeat the point of the sidecar.
    expect(EXPORT_LEDGER_LIMIT).toBeGreaterThan(200);
  });

  it('the filenames are derived from the agent name, not from its id', () => {
    const out = exportAgent(fakeStore([]), agent({ name: 'SQL Reviewer' }), { now: NOW });
    expect(out.markdownName).toBe('sql-reviewer.md');
    expect(out.sidecarName).toBe('sql-reviewer.naby.json');
  });
});
