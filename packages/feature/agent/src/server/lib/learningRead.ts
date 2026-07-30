// packages/feature/agent/src/server/lib/learningRead.ts
//
// Phase 3 P3-M8c — THE LEARNING-DEPTH READING (continuous-learning §6.3).
//
// WHAT IT IS. The panel's answer to "what has naby actually picked up?": how many
// facts are confirmed and in which scopes, how many are waiting to be reviewed,
// how many distinct sessions have independently agreed with something, how many
// KINDS of work the ledger has seen, and when the reflection pass last looked
// back at a conversation.
//
// WHAT IT IS NOT, AND WHY THAT IS THE WHOLE POINT. None of these numbers enter
// the butterfly gate, and the panel says so in as many words. butterfly-trust-
// meter §2 decided that counting conversations and stored memories is not a trust
// signal — an agent that stored fifty wrong facts would otherwise read as fully
// grown — and trust-meter §9.2 rule 2 says two numbers on one screen must never
// disagree. So this block is computed here, rendered in its own section, and
// never mixed into `GrowthReport`'s axes. It answers "what did it learn", while
// the meter above it answers "can it be trusted".
//
// SEPARATE FILE, deliberately. `growthRead.ts` is the ONE place a ledger becomes a
// trust reading and both the palette and the panel go through it; folding a
// different kind of number into that file is the first step towards one of them
// leaking into the other.
//
// EVERY READ IS BEST-EFFORT, exactly like growthRead's: a store hiccup shows an
// empty learning block, never a blank panel or a 500.

import {
  DEFAULT_USER_ID,
  type EvalEvent,
  type MemoryItem,
  type MemoryScope,
  type MemoryStatus,
} from '../../../../../../../dist/naby-runtime.mjs';

/** How many distinct sessions must have agreed with a fact for it to count as
 *  corroborated in this reading. NOT `CORROBORATION_THRESHOLD` (3), which is the
 *  bar for AUTO-CONFIRMING without a person: this is the bar for "more than one
 *  conversation said it", which is the interesting thing to show. */
export const CORROBORATED_MIN = 2;

/** How much ledger the task-type count reads. The panel is describing breadth
 *  ("it has seen N kinds of work"), so it wants more history than the meter's
 *  recent window — but still a bounded query. */
export const LEARNING_LEDGER_LIMIT = 500;

/** The narrow store slice this read needs. Structural, so a test hands it four
 *  functions and the production `Store` satisfies it unchanged. */
export interface LearningStore {
  getScopedMemory(
    scope: MemoryScope,
    scopeKey: string,
    opts?: { status?: MemoryStatus },
  ): MemoryItem[];
  getMemoryCorroboration(memoryIds: readonly string[]): Record<string, number>;
  listEvalEvents(agentId: string, opts?: { limit?: number }): EvalEvent[];
  getLatestReflectionAt(): number | undefined;
}

/** The learning block as the panel receives it. Counts only — no stage, no
 *  percentage, nothing that could be mistaken for the gauge above it. */
export type LearningReport = {
  /** Confirmed facts per scope. A scope is present only when it was READ, so an
   *  absent `project` means "this agent has no project here", not "zero facts". */
  confirmedByScope: { session?: number; project?: number; user: number; org?: number };
  /** Confirmed facts in total, across the scopes that were read. */
  confirmedTotal: number;
  /** Facts waiting for a person to review them. */
  proposedCount: number;
  /** Facts at least `CORROBORATED_MIN` distinct sessions have agreed with. */
  corroborated2Plus: number;
  /** How many kinds of work the ledger has recorded at all. */
  distinctTaskTypes: number;
  /** When the reflection pass last read a conversation; absent before the first. */
  lastReflectionAt?: number;
};

const EMPTY: LearningReport = {
  confirmedByScope: { user: 0 },
  confirmedTotal: 0,
  proposedCount: 0,
  corroborated2Plus: 0,
  distinctTaskTypes: 0,
};

/**
 * WHICH SCOPES THIS READS, and why it is the same rule the export uses.
 *
 *   user    — always. The machine-wide personal layer is what "what naby learned
 *             about me" means (agentExport.ts says the same, for the same reason).
 *   project — when a cwd is in play. Real memory, keyed on a directory.
 *   session — never. A count of facts that die with a conversation is not a
 *             measure of what was LEARNED, and the panel is not opened from
 *             inside a session anyway.
 *   org     — never here. Team memory is someone else's curation; counting it as
 *             this agent's learning would credit the agent with borrowed facts.
 *
 * Keeping the rule identical to `gatherExportMemories` is deliberate: two
 * different answers to "which scopes are this agent's" is how a panel comes to
 * claim a number the export then cannot ship.
 */
function scopesFor(opts: { cwd?: string }): Array<[MemoryScope, string]> {
  const scopes: Array<[MemoryScope, string]> = [['user', DEFAULT_USER_ID]];
  if (opts.cwd) scopes.push(['project', opts.cwd]);
  return scopes;
}

/** Read one scope, best-effort: an unreadable project scope must not blank the
 *  user scope's count. */
function readScope(store: LearningStore, scope: MemoryScope, scopeKey: string): MemoryItem[] {
  try {
    return store.getScopedMemory(scope, scopeKey);
  } catch {
    return [];
  }
}

/**
 * Compute the learning-depth block for one agent's memory scopes.
 *
 * `agentId` is only used for the ledger read (task types are per agent); memory
 * is keyed by (scope, scopeKey) rather than by agent, which is why the scope
 * rule above — not the agent id — decides what counts as "its" memory.
 */
export function learningReport(
  store: LearningStore,
  agentId: string,
  opts: { cwd?: string } = {},
): LearningReport {
  const confirmedByScope: LearningReport['confirmedByScope'] = { user: 0 };
  let confirmedTotal = 0;
  let proposedCount = 0;
  const proposedIds: string[] = [];

  for (const [scope, scopeKey] of scopesFor(opts)) {
    const rows = readScope(store, scope, scopeKey);
    const confirmed = rows.filter((r) => r.status === 'confirmed').length;
    confirmedByScope[scope as 'user' | 'project'] = confirmed;
    confirmedTotal += confirmed;
    for (const row of rows) {
      if (row.status !== 'proposed') continue;
      proposedCount += 1;
      proposedIds.push(row.id);
    }
  }

  // CORROBORATION IS COUNTED OVER THE PROPOSALS ONLY. A confirmed fact has
  // already been agreed to by the person whose memory it is, so "two sessions
  // said it" adds nothing to it; the number is interesting precisely for the
  // queue, where it says which of the waiting facts has more than one
  // conversation behind it.
  let corroborated2Plus = 0;
  if (proposedIds.length > 0) {
    try {
      const counts = store.getMemoryCorroboration(proposedIds);
      for (const id of proposedIds) {
        if ((counts[id] ?? 0) >= CORROBORATED_MIN) corroborated2Plus += 1;
      }
    } catch {
      /* an unreadable observation table reads as "no corroboration measured" */
    }
  }

  let distinctTaskTypes = 0;
  try {
    const rows = store.listEvalEvents(agentId, { limit: LEARNING_LEDGER_LIMIT });
    distinctTaskTypes = new Set(
      rows.map((r) => r.taskType).filter((t): t is string => typeof t === 'string' && t.length > 0),
    ).size;
  } catch {
    /* no ledger just means no kinds of work recorded yet */
  }

  let lastReflectionAt: number | undefined;
  try {
    lastReflectionAt = store.getLatestReflectionAt();
  } catch {
    /* never reflected, or unreadable — both render as "not yet" */
  }

  return {
    confirmedByScope,
    confirmedTotal,
    proposedCount,
    corroborated2Plus,
    distinctTaskTypes,
    ...(typeof lastReflectionAt === 'number' ? { lastReflectionAt } : {}),
  };
}

/** The whole reading, wrapped so that nothing in it can fail a `growth.get`. The
 *  trust meter is the load-bearing half of that response; a learning count must
 *  never be the reason a user cannot see their stage. */
export function safeLearningReport(
  store: LearningStore,
  agentId: string,
  opts: { cwd?: string } = {},
): LearningReport {
  try {
    return learningReport(store, agentId, opts);
  } catch {
    return EMPTY;
  }
}
