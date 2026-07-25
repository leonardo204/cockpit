// packages/feature/agent/src/server/lib/agentExport.ts
//
// Phase 3 P3-M6 — GATHERING what an export needs from the store.
//
// The runtime owns the packaging (`buildAgentExport`: what is dropped, the YAML,
// the sidecar shape). This owns the one thing only the shell knows: WHICH ROWS
// belong to this agent. Memory is keyed by (scope, scopeKey), not by agent id, so
// "the agent's memory" is a question about scope resolution — the same question
// the learning sink answers when it writes.
//
// WHICH SCOPES GO:
//   user     — always. This is the machine-wide personal layer, and it is what
//              "what naby learned about me" means.
//   project  — when a cwd is supplied. Tied to a directory that will not exist
//              elsewhere, but the scope tag travels on each line, so a reader sees
//              `(project/procedural)` and can judge it.
//   session  — never. `buildAgentExport` drops it anyway; not querying it as well
//              keeps the two rules from drifting apart. A consequence worth
//              knowing: `report.droppedSession` is therefore normally 0, which
//              means "none were offered", not "none exist".
//   org      — never. Team memory is a shared asset someone else curates; one
//              person's export is not the place to copy it off the machine.

import {
  buildAgentExport,
  DEFAULT_USER_ID,
  GROWTH_WINDOW,
  type Agent,
  type AgentExportResult,
  type EvalEvent,
  type MemoryItem,
  type MemoryScope,
  type MemoryStatus,
} from '../../../../../../../dist/naby-runtime.mjs';

/** How much ledger history an export carries. Larger than the meter's read
 *  (`growthRead.LEDGER_READ_LIMIT`) because an export is an archive, not a
 *  reading: the point is that the importing machine can recompute a stage, and
 *  throwing away history it could have used would defeat that. */
export const EXPORT_LEDGER_LIMIT = GROWTH_WINDOW * 50;

/** The narrow store slice an export needs. */
export interface AgentExportStore {
  getScopedMemory(
    scope: MemoryScope,
    scopeKey: string,
    opts?: { status?: MemoryStatus },
  ): MemoryItem[];
  listEvalEvents(agentId: string, opts?: { limit?: number }): EvalEvent[];
}

/** Read every row an export may consider, best-effort per scope: an unreadable
 *  project scope must not abort an export whose user scope is fine. */
export function gatherExportMemories(
  store: AgentExportStore,
  opts: { cwd?: string } = {},
): MemoryItem[] {
  const out: MemoryItem[] = [];
  const read = (scope: MemoryScope, scopeKey: string) => {
    try {
      out.push(...store.getScopedMemory(scope, scopeKey));
    } catch {
      /* a scope that cannot be read contributes nothing, never an exception */
    }
  };
  read('user', DEFAULT_USER_ID);
  if (opts.cwd) read('project', opts.cwd);
  return out;
}

/**
 * Build the export pair for one agent. Reads the store and hands everything to
 * the runtime's pure packager — the drop rules and the report live there, so the
 * shell cannot quietly ship something the rules would have excluded.
 */
export function exportAgent(
  store: AgentExportStore,
  agent: Agent,
  opts: { cwd?: string; now: number },
): AgentExportResult {
  let ledger: EvalEvent[] = [];
  try {
    ledger = store.listEvalEvents(agent.id, { limit: EXPORT_LEDGER_LIMIT });
  } catch {
    /* no ledger just means the importing machine starts from an egg */
  }
  return buildAgentExport({
    agent,
    memories: gatherExportMemories(store, opts),
    ledger,
    now: opts.now,
  });
}
