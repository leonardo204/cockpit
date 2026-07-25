// packages/feature/agent/src/server/lib/agentImport.ts
//
// Phase 3 P3-M7 — APPLYING an import plan to the store.
//
// The runtime owns the parse and every trust rule (`agent-import.ts`): what a file
// may claim, what it may never claim, and whether its ledger counts. This owns the
// writes, and one decision the runtime cannot make — what session an imported
// growth row belongs to.
//
// NO MEMORY IS WRITTEN. The imported facts are already inside the agent's own
// instructions by the time the plan gets here — `decideMemoryWrite` invariant 3
// forbids external content from writing `user`/`org` scope outright, so a memory
// path here could only ever be denied. An imported agent brings its own knowledge;
// it does not get to rewrite what naby believes about you.
//
// The agent goes in FIRST. If it fails there is nothing to attach growth rows to,
// and a half-import with orphaned rows would be worse than none. A ledger row that
// cannot be written is counted, not fatal: the agent is the import, and the record
// is provenance attached to it.

import type { Agent, AgentImportPlan } from '../../../../../../../dist/naby-runtime.mjs';

/**
 * The session id imported growth rows are filed under. A LITERAL, not a real
 * session: the file's own session ids name conversations that do not exist here,
 * and the ledger is keyed by `agentId` with `sessionId` as a link (checkin
 * contracts §4, invariant 4), so a placeholder link costs nothing and keeps the
 * rows honest about not having happened in any conversation on this machine.
 */
export const IMPORTED_SESSION_ID = 'imported';

/** The narrow store slice an import writes through. `appendEvalEvent` is typed
 *  loosely because the plan's rows are missing `agentId`/`sessionId` by design and
 *  are completed here. */
export interface AgentImportApplyStore {
  putAgent(input: AgentImportPlan['agent']): Agent;
  appendEvalEvent(event: Record<string, unknown>): unknown;
}

/** What actually landed. */
export interface AgentImportOutcome {
  agent: Agent;
  ledgerWritten: number;
  ledgerFailures: number;
}

/** Apply a parsed plan. Throws ONLY if the agent itself cannot be created. */
export function applyAgentImport(
  store: AgentImportApplyStore,
  plan: AgentImportPlan,
): AgentImportOutcome {
  const agent = store.putAgent(plan.agent);

  let ledgerWritten = 0;
  let ledgerFailures = 0;
  for (const row of plan.ledger) {
    try {
      store.appendEvalEvent({
        ...row,
        agentId: agent.id,
        sessionId: IMPORTED_SESSION_ID,
      });
      ledgerWritten += 1;
    } catch {
      ledgerFailures += 1;
    }
  }

  return { agent, ledgerWritten, ledgerFailures };
}
