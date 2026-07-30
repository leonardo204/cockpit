import { describe, it, expect, vi } from 'vitest';
import {
  kickReflectionSweep,
  MEMORY_AUTO_CONFIRM_KEY,
  runReflectionSweep,
  type ReflectionStore,
  type ReflectionSweepResult,
} from './reflection';
import {
  CORROBORATION_THRESHOLD,
  DEFAULT_USER_ID,
  REFLECTION_IDLE_MS,
  REFLECTION_SWEEP_CAP,
  type Agent,
  type EvalEvent,
  type MemoryItem,
  type MemoryWriteRequest,
  type ReflectionCase,
  type ReflectionCursor,
  type ReflectionJudge,
  type ReflectionMemoryCandidate,
  type RuntimeMessage,
  type SessionRef,
} from '../../../../../../../dist/naby-runtime.mjs';

const AGENT_ID = 'agent-1';
const NOW = 10_000_000;
/** Any session whose lastUsedAt is this is idle enough to reflect on. */
const IDLE_AT = NOW - REFLECTION_IDLE_MS - 1;

const CORRECTION = 'no, undo that and write to the other file';

/** The transcript shape `runTurn` writes: user → assistant tool-call → tool result
 *  → assistant → user. The last user message is the correction. */
function transcript(corrected = true): RuntimeMessage[] {
  const rows: RuntimeMessage[] = [
    { role: 'user', content: 'update the config' },
    { role: 'assistant', content: '', toolCalls: [{ toolCallId: 'c1', toolName: 'Write', input: {} }] },
    { role: 'tool', toolCallId: 'c1', toolName: 'Write', output: { content: 'wrote it' } },
    { role: 'assistant', content: 'Done.' },
  ];
  rows.push({ role: 'user', content: corrected ? CORRECTION : 'thanks, now add a test as well' });
  return rows;
}

/** The same shape with only ONE user message — below
 *  `REFLECTION_MIN_USER_MESSAGES`, so it never triggers the M8c memory-only call
 *  (§6.4) and a case-less sweep over it stays silent. */
function briefTranscript(): RuntimeMessage[] {
  return [
    { role: 'user', content: 'update the config' },
    { role: 'assistant', content: '', toolCalls: [{ toolCallId: 'c1', toolName: 'Write', input: {} }] },
    { role: 'tool', toolCallId: 'c1', toolName: 'Write', output: { content: 'wrote it' } },
    { role: 'assistant', content: 'Done.' },
  ];
}

/** A conversation with NO tool call and no ledger row at all: the session shape
 *  that produced no cases and therefore taught nothing at all before M8c. */
function conversationOnly(userMessages: string[]): RuntimeMessage[] {
  return userMessages.flatMap((content): RuntimeMessage[] => [
    { role: 'user', content },
    { role: 'assistant', content: 'Understood.' },
  ]);
}

function autonomousRow(sessionId: string, id = 'ev-1'): EvalEvent {
  return {
    id,
    kind: 'autonomous',
    at: 1_000,
    agentId: AGENT_ID,
    sessionId,
    toolName: 'Write',
    reversible: true,
  };
}

type FakeSessionSpec = {
  sessionId: string;
  lastUsedAt?: number;
  messages?: RuntimeMessage[];
  events?: EvalEvent[];
  cursor?: ReflectionCursor;
  /** The session's project directory, if any — what decides whether a
   *  `project`-scope proposal can be keyed at all (P3-M8b). */
  cwd?: string;
};

/** How the fake store may be set up for the memory half (P3-M8b). */
type FakeStoreOptions = {
  /** Seed `proposed` rows the consolidation step will look at. */
  memory?: MemoryItem[];
  /** Distinct-session counts per memory id. */
  corroboration?: Record<string, number>;
  /** Pre-set settings, e.g. the auto-confirm opt-in. */
  settings?: Record<string, string>;
  /** Make `putMemory` throw for a given key — the memory GATE denying a write. */
  denyKeys?: string[];
};

/** A store that serves fixed sessions and records every write. Structural — the
 *  production `Store` satisfies the same interface. */
function fakeStore(specs: FakeSessionSpec[], options: FakeStoreOptions = {}) {
  const messages = new Map<string, RuntimeMessage[]>();
  const events = new Map<string, EvalEvent[]>();
  const cursors = new Map<string, ReflectionCursor>();
  const sessions: SessionRef[] = specs.map((s) => {
    messages.set(s.sessionId, s.messages ?? transcript());
    events.set(s.sessionId, s.events ?? [autonomousRow(s.sessionId, `ev-${s.sessionId}`)]);
    if (s.cursor) cursors.set(s.sessionId, s.cursor);
    return {
      sessionId: s.sessionId,
      providerId: 'test',
      createdAt: 1,
      lastUsedAt: s.lastUsedAt ?? IDLE_AT,
      ...(s.cwd ? { cwd: s.cwd } : {}),
    };
  });

  const marked: string[] = [];
  const cursorWrites: Array<{ sessionId: string; lastSeq: number; reflectedAt: number }> = [];
  // P3-M8b state: what was written, what was confirmed, and the settings the
  // consolidation step reads.
  const writes: MemoryWriteRequest[] = [];
  const confirmed: string[] = [];
  const memory = [...(options.memory ?? [])];
  const corroboration = { ...(options.corroboration ?? {}) };
  const settings = new Map(Object.entries(options.settings ?? {}));

  const store: ReflectionStore = {
    listSessions: () => sessions,
    putMemory: (req) => {
      if (options.denyKeys?.includes(req.key)) {
        // Mirrors the real store: a gate deny THROWS rather than returning.
        throw new Error(`memory write denied: ${req.key} is not allowed here`);
      }
      writes.push(req);
      const item: MemoryItem = {
        id: `mem-${writes.length}`,
        scope: req.scope,
        scopeKey: req.scopeKey,
        type: req.type,
        key: req.key,
        value: req.value,
        provenance: req.provenance,
        confidence: req.confidence,
        status: req.requestedStatus,
        createdAt: 1,
        updatedAt: 1,
      };
      memory.push(item);
      return item;
    },
    confirmMemory: (id) => {
      confirmed.push(id);
      const row = memory.find((m) => m.id === id);
      if (row) row.status = 'confirmed';
    },
    listCorroboratedProposed: (threshold) =>
      memory
        .filter((m) => m.status === 'proposed' && (corroboration[m.id] ?? 0) >= threshold)
        .sort((a, b) => (corroboration[b.id] ?? 0) - (corroboration[a.id] ?? 0)),
    getMemoryCorroboration: (ids) => {
      const out: Record<string, number> = {};
      for (const id of ids) if (corroboration[id]) out[id] = corroboration[id]!;
      return out;
    },
    getSetting: (key) => settings.get(key),
    getMessages: (sessionId) => messages.get(sessionId) ?? [],
    listAgents: () =>
      [
        {
          id: AGENT_ID,
          name: 'persona',
          kind: 'persona',
          systemPrompt: '',
          memoryScope: 'user',
          autonomy: { escalation: 'inline' },
          createdAt: 1,
          updatedAt: 1,
        } satisfies Agent,
      ],
    listEvalEvents: (agentId, opts) => {
      if (agentId !== AGENT_ID) return [];
      const sessionId = opts?.sessionId;
      if (!sessionId) return [...events.values()].flat();
      return events.get(sessionId) ?? [];
    },
    markEvalEventCorrected: (id) => {
      const row = [...events.values()].flat().find((e) => e.id === id);
      // Mirrors the real store: only an 'autonomous' row can be marked.
      if (!row || row.kind !== 'autonomous') return false;
      marked.push(id);
      row.correctedAfter = true;
      return true;
    },
    getReflectionCursor: (sessionId) => cursors.get(sessionId),
    setReflectionCursor: (sessionId, lastSeq, reflectedAt) => {
      cursors.set(sessionId, { lastSeq, reflectedAt });
      cursorWrites.push({ sessionId, lastSeq, reflectedAt });
    },
  };

  return { store, marked, cursorWrites, cursors, events, writes, confirmed, memory };
}

/** The counts a sweep that touched no memory returns — spelled out once so the
 *  M8a assertions stay readable. */
const NO_MEMORY = { proposedMemories: 0, droppedCandidates: 0, autoConfirmed: 0 } as const;

/** A judge that quotes the user's own words when they pushed back. */
function honestJudge(): { judge: ReflectionJudge; calls: ReflectionCase[][] } {
  const calls: ReflectionCase[][] = [];
  const judge: ReflectionJudge = async (cases) => {
    calls.push([...cases]);
    return cases.map((c) =>
      c.laterUserMessages.some((m) => m.includes('undo that'))
        ? { caseId: c.caseId, corrected: true, evidenceQuote: 'undo that' }
        : { caseId: c.caseId, corrected: false },
    );
  };
  return { judge, calls };
}

const neverCalled: ReflectionJudge = async () => {
  throw new Error('the judge should not have been called');
};

describe('runReflectionSweep — which sessions get read', () => {
  it('leaves an active session alone: idle time has not passed', async () => {
    const { store, cursorWrites } = fakeStore([{ sessionId: 's1', lastUsedAt: NOW - 1_000 }]);
    const out = await runReflectionSweep(store, neverCalled, { now: NOW });
    expect(out).toEqual<ReflectionSweepResult>({
      sweptSessions: 0,
      markedEvents: 0,
      droppedVerdicts: 0,
      ...NO_MEMORY,
    });
    expect(cursorWrites).toEqual([]);
  });

  it('leaves an idle session alone when it has said nothing new since the last reflection', async () => {
    const { store, cursorWrites } = fakeStore([
      { sessionId: 's1', cursor: { lastSeq: 4, reflectedAt: 1 } },
    ]);
    const out = await runReflectionSweep(store, neverCalled, { now: NOW });
    expect(out.sweptSessions).toBe(0);
    expect(cursorWrites).toEqual([]);
  });

  it('never reflects on the session the turn is running in', async () => {
    const { store, cursorWrites } = fakeStore([{ sessionId: 'live' }, { sessionId: 'idle' }]);
    const { judge, calls } = honestJudge();
    await runReflectionSweep(store, judge, { now: NOW, excludeSessionId: 'live' });
    expect(calls).toHaveLength(1);
    expect(cursorWrites.map((c) => c.sessionId)).toEqual(['idle']);
  });

  it('stops at the sweep cap even when more sessions are due', async () => {
    const specs = Array.from({ length: REFLECTION_SWEEP_CAP + 3 }, (_, i) => ({
      sessionId: `s${i}`,
      events: [autonomousRow(`s${i}`, `ev-${i}`)],
    }));
    const { store } = fakeStore(specs);
    const { judge, calls } = honestJudge();
    const out = await runReflectionSweep(store, judge, { now: NOW });
    expect(out.sweptSessions).toBe(REFLECTION_SWEEP_CAP);
    expect(calls).toHaveLength(REFLECTION_SWEEP_CAP);
  });

  it('a cap of 0 does nothing at all', async () => {
    const { store } = fakeStore([{ sessionId: 's1' }]);
    const out = await runReflectionSweep(store, neverCalled, { now: NOW, cap: 0 });
    expect(out.sweptSessions).toBe(0);
  });
});

describe('runReflectionSweep — what it writes', () => {
  it('marks the corrected action and advances the cursor to the latest message', async () => {
    const { store, marked, cursorWrites } = fakeStore([{ sessionId: 's1' }]);
    const { judge, calls } = honestJudge();
    const out = await runReflectionSweep(store, judge, { now: NOW });

    expect(calls[0]).toHaveLength(1);
    expect(calls[0]?.[0]?.caseId).toBe('ev-s1');
    expect(calls[0]?.[0]?.laterUserMessages).toEqual([CORRECTION]);
    expect(marked).toEqual(['ev-s1']);
    expect(out).toEqual<ReflectionSweepResult>({
      sweptSessions: 1,
      markedEvents: 1,
      droppedVerdicts: 0,
      ...NO_MEMORY,
    });
    // transcript() is 5 messages ⇒ the highest seq is 4.
    expect(cursorWrites).toEqual([{ sessionId: 's1', lastSeq: 4, reflectedAt: NOW }]);
  });

  it('marks nothing when the user simply moved on', async () => {
    const { store, marked, cursorWrites } = fakeStore([
      { sessionId: 's1', messages: transcript(false) },
    ]);
    const { judge } = honestJudge();
    const out = await runReflectionSweep(store, judge, { now: NOW });
    expect(marked).toEqual([]);
    expect(out.markedEvents).toBe(0);
    // Still read, so still advanced — otherwise it would be re-judged forever.
    expect(cursorWrites).toHaveLength(1);
  });

  it('advances the cursor for a session with no judgeable action, without calling the judge', async () => {
    // P3-M8c NOTE: "no judgeable action" is no longer sufficient on its own — a
    // case-less session with enough conversation in it now earns a memory-only
    // call (§6.4, covered in its own describe below). What is asserted HERE is
    // the other half of that rule, unchanged since M8a: a session with too
    // little to say costs nothing and is still marked as read.
    const { store, cursorWrites } = fakeStore([
      { sessionId: 's1', events: [], messages: briefTranscript() },
    ]);
    const out = await runReflectionSweep(store, neverCalled, { now: NOW });
    expect(out.sweptSessions).toBe(1);
    expect(cursorWrites).toEqual([{ sessionId: 's1', lastSeq: 3, reflectedAt: NOW }]);
  });

  it('never re-judges an action already marked corrected', async () => {
    const already = { ...autonomousRow('s1', 'ev-s1'), correctedAfter: true };
    // Brief, so the M8c memory-only path does not fire and `neverCalled` still
    // proves what it did before: an already-marked row builds no case.
    const { store } = fakeStore([
      { sessionId: 's1', events: [already], messages: briefTranscript() },
    ]);
    const out = await runReflectionSweep(store, neverCalled, { now: NOW });
    expect(out.sweptSessions).toBe(1);
    expect(out.markedEvents).toBe(0);
  });

  it('counts a refused mark (a non-autonomous row) as not marked', async () => {
    const tripwire: EvalEvent = {
      id: 'ev-trip',
      kind: 'tripwire',
      at: 1_000,
      agentId: AGENT_ID,
      sessionId: 's1',
      toolName: 'Write',
    };
    const { store, marked } = fakeStore([{ sessionId: 's1', events: [tripwire] }]);
    // The judge insists on a verdict for a case it was never given — the validator
    // drops it, and even if it had not, the store would refuse the write.
    const rogue: ReflectionJudge = async () => [
      { caseId: 'ev-trip', corrected: true, evidenceQuote: 'undo that' },
    ];
    const out = await runReflectionSweep(store, rogue, { now: NOW });
    expect(marked).toEqual([]);
    expect(out.markedEvents).toBe(0);
  });
});

describe('runReflectionSweep — verdicts it refuses', () => {
  it('drops a verdict about a case it never sent, and one whose quote nobody typed', async () => {
    const { store, marked } = fakeStore([{ sessionId: 's1' }]);
    const hallucinating: ReflectionJudge = async (cases) => [
      { caseId: 'not-a-case', corrected: true, evidenceQuote: 'undo that' },
      { caseId: cases[0]!.caseId, corrected: true, evidenceQuote: 'the user was furious' },
    ];
    const out = await runReflectionSweep(store, hallucinating, { now: NOW });
    expect(marked).toEqual([]);
    expect(out.markedEvents).toBe(0);
    expect(out.droppedVerdicts).toBe(2);
    // The session WAS read, so the cursor still moves.
    expect(out.sweptSessions).toBe(1);
  });

  it('drops a corrected verdict that cites no evidence at all', async () => {
    const { store, marked } = fakeStore([{ sessionId: 's1' }]);
    const unevidenced: ReflectionJudge = async (cases) => [
      { caseId: cases[0]!.caseId, corrected: true },
    ];
    const out = await runReflectionSweep(store, unevidenced, { now: NOW });
    expect(marked).toEqual([]);
    expect(out.droppedVerdicts).toBe(1);
  });
});

describe('runReflectionSweep — failure containment', () => {
  it('does not advance the cursor when the judge fails, so the evidence is retried', async () => {
    const { store, cursorWrites } = fakeStore([{ sessionId: 's1' }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await runReflectionSweep(store, async () => {
      throw new Error('provider unavailable');
    }, { now: NOW });
    warn.mockRestore();
    expect(out.sweptSessions).toBe(0);
    expect(cursorWrites).toEqual([]);

    const { judge } = honestJudge();
    const retry = await runReflectionSweep(store, judge, { now: NOW });
    expect(retry.markedEvents).toBe(1);
  });

  it('one bad session does not end the sweep', async () => {
    const { store, cursorWrites } = fakeStore([{ sessionId: 'bad' }, { sessionId: 'good' }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const flaky: ReflectionJudge = async (cases) => {
      if (cases[0]?.caseId === 'ev-bad') {
        // The first session judged is the failing one.
        throw new Error('boom');
      }
      return cases.map((c) => ({ caseId: c.caseId, corrected: false }));
    };
    const out = await runReflectionSweep(store, flaky, { now: NOW });
    warn.mockRestore();
    expect(out.sweptSessions).toBe(1);
    expect(cursorWrites.map((c) => c.sessionId)).toEqual(['good']);
  });

  it('a store that cannot list sessions yields zeros instead of throwing', async () => {
    const broken = {
      listSessions() {
        throw new Error('database is locked');
      },
    } as unknown as ReflectionStore;
    await expect(runReflectionSweep(broken, neverCalled)).resolves.toEqual({
      sweptSessions: 0,
      markedEvents: 0,
      droppedVerdicts: 0,
      ...NO_MEMORY,
    });
  });
});

// ---------------------------------------------------------------------------
// P3-M8b — memory proposals and consolidation (spec §5)
// ---------------------------------------------------------------------------

/** The user message the proposals below quote. It is the LAST message of
 *  `transcript()`, so it is inside the reflected window either way. */
const GROUNDED_QUOTE = 'undo that';

/** A judge answering BOTH tasks: no corrections, and the given proposals. */
function proposingJudge(memories: ReflectionMemoryCandidate[]): {
  judge: ReflectionJudge;
  seen: Array<{ sessionId: string; cwd?: string; userMessages: string[] }>;
} {
  const seen: Array<{ sessionId: string; cwd?: string; userMessages: string[] }> = [];
  const judge: ReflectionJudge = async (cases, context) => {
    if (context) {
      seen.push({
        sessionId: context.sessionId,
        ...(context.cwd ? { cwd: context.cwd } : {}),
        userMessages: context.userMessages.map((m) => m.text),
      });
    }
    return {
      corrections: cases.map((c) => ({ caseId: c.caseId, corrected: false })),
      memories,
    };
  };
  return { judge, seen };
}

function candidate(over: Partial<ReflectionMemoryCandidate> = {}): ReflectionMemoryCandidate {
  return {
    scope: 'user',
    type: 'semantic',
    key: 'prefers-metric-units',
    value: 'Prefers metric units in every answer.',
    evidenceQuote: GROUNDED_QUOTE,
    ...over,
  };
}

describe('runReflectionSweep — the widened trigger (P3-M8c §6.4)', () => {
  const SQL_FIRST = 'always give me the SQL before the explanation';

  /** A judge that RECORDS every call, so "it was not called" is asserted rather
   *  than inferred from a store that happens to be unchanged. */
  function countingJudge(memories: ReflectionMemoryCandidate[]): {
    judge: ReflectionJudge;
    calls: ReflectionCase[][];
  } {
    const calls: ReflectionCase[][] = [];
    const judge: ReflectionJudge = async (cases) => {
      calls.push([...cases]);
      return { corrections: [], memories };
    };
    return { judge, calls };
  }

  it('calls the judge for a case-less session once it has said enough, with NO cases', async () => {
    // THE GAP M8b LEFT (§5.6): no autonomous action meant no call, so the purely
    // conversational sessions — the ones where a person actually says how they
    // want to be worked with — produced nothing at all.
    const { store, writes } = fakeStore([
      { sessionId: 's1', events: [], messages: conversationOnly([SQL_FIRST, 'and snake_case columns']) },
    ]);
    const { judge, calls } = countingJudge([
      candidate({ key: 'sql-first', value: 'Wants the SQL first.', evidenceQuote: SQL_FIRST }),
    ]);
    const out = await runReflectionSweep(store, judge, { now: NOW });

    expect(calls).toHaveLength(1);
    // MEMORY-EXTRACTION ONLY: there is no action to judge, so no case is put.
    expect(calls[0]).toEqual([]);
    expect(out.proposedMemories).toBe(1);
    expect(out.markedEvents).toBe(0);
    expect(writes[0]).toMatchObject({ key: 'sql-first', requestedStatus: 'proposed' });
  });

  it('does NOT call the judge below the threshold, and still advances the cursor', async () => {
    // One message is "thanks" — putting a model call behind every one of those
    // would attach a cost to closing a window.
    const { store, cursorWrites } = fakeStore([
      { sessionId: 's1', events: [], messages: conversationOnly(['thanks!']) },
    ]);
    const { judge, calls } = countingJudge([candidate()]);
    const out = await runReflectionSweep(store, judge, { now: NOW });

    expect(calls).toHaveLength(0);
    expect(out.proposedMemories).toBe(0);
    // Swept anyway: the span is spent, so the next sweep does not re-read it.
    expect(out.sweptSessions).toBe(1);
    expect(cursorWrites).toEqual([{ sessionId: 's1', lastSeq: 1, reflectedAt: NOW }]);
  });

  it('counts only messages NEW since the cursor, not the whole transcript', async () => {
    // Two user messages, but the cursor has already covered the first. Only one
    // is new, so this is below the threshold — otherwise a long-since-judged
    // conversation would earn a fresh call every time one message was added.
    const { store } = fakeStore([
      {
        sessionId: 's1',
        events: [],
        messages: conversationOnly([SQL_FIRST, 'and snake_case columns']),
        cursor: { lastSeq: 1, reflectedAt: 1 },
      },
    ]);
    const { judge, calls } = countingJudge([candidate()]);
    const out = await runReflectionSweep(store, judge, { now: NOW });

    expect(calls).toHaveLength(0);
    expect(out.sweptSessions).toBe(1);
  });

  it('still spends at most ONE call on a session that has cases AND conversation', async () => {
    // The widening must not turn into two calls per session: a session with a
    // case already asks both tasks in the one call M8b established.
    const { store } = fakeStore([{ sessionId: 's1' }]);
    const { judge, calls } = countingJudge([candidate()]);
    await runReflectionSweep(store, judge, { now: NOW });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
  });

  it('the sweep cap still bounds the cost when every session is conversation-only', async () => {
    const specs = Array.from({ length: REFLECTION_SWEEP_CAP + 2 }, (_, i) => ({
      sessionId: `s${i}`,
      events: [],
      messages: conversationOnly([SQL_FIRST, 'and snake_case columns']),
    }));
    const { store } = fakeStore(specs);
    const { judge, calls } = countingJudge([]);
    const out = await runReflectionSweep(store, judge, { now: NOW });

    expect(out.sweptSessions).toBe(REFLECTION_SWEEP_CAP);
    expect(calls.length).toBe(REFLECTION_SWEEP_CAP);
  });
});

describe('runReflectionSweep — memory proposals (P3-M8b §5.2)', () => {
  it('writes a grounded proposal as proposed/artifact with the evidence coordinate', async () => {
    const { store, writes } = fakeStore([{ sessionId: 's1' }]);
    const { judge } = proposingJudge([candidate()]);
    const out = await runReflectionSweep(store, judge, { now: NOW });

    expect(out.proposedMemories).toBe(1);
    expect(out.droppedCandidates).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      scope: 'user',
      scopeKey: DEFAULT_USER_ID,
      type: 'semantic',
      key: 'prefers-metric-units',
      requestedStatus: 'proposed',
      provenance: {
        source: 'artifact',
        sessionId: 's1',
        basis: 'observed in session reflection',
        // transcript() is 5 messages and the quoted one is the last (seq 4).
        createdFrom: 's1:4',
      },
    });
  });

  it('gives the judge the session context the memory task needs', async () => {
    const { store } = fakeStore([{ sessionId: 's1', cwd: '/work/app' }]);
    const { judge, seen } = proposingJudge([]);
    await runReflectionSweep(store, judge, { now: NOW });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.sessionId).toBe('s1');
    expect(seen[0]?.cwd).toBe('/work/app');
    // Only the USER's own messages, in order — the evidence space.
    expect(seen[0]?.userMessages).toEqual(['update the config', CORRECTION]);
  });

  it('drops a proposal whose quote nobody typed, and writes nothing for it', async () => {
    const { store, writes } = fakeStore([{ sessionId: 's1' }]);
    const { judge } = proposingJudge([
      candidate({ evidenceQuote: 'I love working in imperial units' }),
    ]);
    const out = await runReflectionSweep(store, judge, { now: NOW });
    expect(writes).toEqual([]);
    expect(out.proposedMemories).toBe(0);
    expect(out.droppedCandidates).toBe(1);
  });

  it('drops a secret-shaped value and an org-scope proposal', async () => {
    const { store, writes } = fakeStore([{ sessionId: 's1' }]);
    const { judge } = proposingJudge([
      candidate({ key: 'api-key', value: 'their api_key = sk-abcdefghijklmnop123456' }),
      candidate({ key: 'team-tone', scope: 'org' }),
    ]);
    const out = await runReflectionSweep(store, judge, { now: NOW });
    expect(writes).toEqual([]);
    expect(out.droppedCandidates).toBe(2);
  });

  it('drops a project-scope proposal from a session with no project', async () => {
    const { store, writes } = fakeStore([{ sessionId: 's1' }]);
    const { judge } = proposingJudge([candidate({ scope: 'project', key: 'build-command' })]);
    const out = await runReflectionSweep(store, judge, { now: NOW });
    expect(writes).toEqual([]);
    expect(out.droppedCandidates).toBe(1);
  });

  it('keys a project-scope proposal on the session cwd when it has one', async () => {
    const { store, writes } = fakeStore([{ sessionId: 's1', cwd: '/work/app' }]);
    const { judge } = proposingJudge([candidate({ scope: 'project', key: 'build-command' })]);
    const out = await runReflectionSweep(store, judge, { now: NOW });
    expect(out.proposedMemories).toBe(1);
    expect(writes[0]).toMatchObject({ scope: 'project', scopeKey: '/work/app' });
  });

  it('counts a gate deny as dropped and keeps going with the other proposals', async () => {
    const { store, writes } = fakeStore([{ sessionId: 's1' }], { denyKeys: ['blocked-fact'] });
    const { judge } = proposingJudge([
      candidate({ key: 'blocked-fact' }),
      candidate({ key: 'kept-fact' }),
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await runReflectionSweep(store, judge, { now: NOW });
    warn.mockRestore();

    expect(out.proposedMemories).toBe(1);
    expect(out.droppedCandidates).toBe(1);
    expect(writes.map((w) => w.key)).toEqual(['kept-fact']);
    // The session was still fully reflected on: one refused proposal costs it
    // neither its cursor nor its corrections.
    expect(out.sweptSessions).toBe(1);
  });

  it('still marks a correction in the same call that proposes memory', async () => {
    const { store, marked, writes } = fakeStore([{ sessionId: 's1' }]);
    const both: ReflectionJudge = async (cases) => ({
      corrections: cases.map((c) => ({
        caseId: c.caseId,
        corrected: true,
        evidenceQuote: GROUNDED_QUOTE,
      })),
      memories: [candidate()],
    });
    const out = await runReflectionSweep(store, both, { now: NOW });
    expect(marked).toEqual(['ev-s1']);
    expect(out.markedEvents).toBe(1);
    expect(writes).toHaveLength(1);
  });

  it('reads an M8a-shaped answer (a bare verdict array) as corrections only', async () => {
    const { store, marked, writes } = fakeStore([{ sessionId: 's1' }]);
    const { judge } = honestJudge();
    const out = await runReflectionSweep(store, judge, { now: NOW });
    expect(marked).toEqual(['ev-s1']);
    expect(writes).toEqual([]);
    expect(out.proposedMemories).toBe(0);
  });
});

describe('runReflectionSweep — consolidation (P3-M8b §5.4)', () => {
  const artifactProposal = (id: string, over: Partial<MemoryItem> = {}): MemoryItem => ({
    id,
    scope: 'user',
    scopeKey: DEFAULT_USER_ID,
    type: 'semantic',
    key: `key-${id}`,
    value: 'a durable fact',
    provenance: { source: 'artifact', sessionId: 'sX' },
    confidence: 0.5,
    status: 'proposed',
    createdAt: 1,
    updatedAt: 2,
    ...over,
  });

  it('promotes nothing while the opt-in is off, however corroborated', async () => {
    const { store, confirmed } = fakeStore([{ sessionId: 's1' }], {
      memory: [artifactProposal('m1')],
      corroboration: { m1: CORROBORATION_THRESHOLD + 5 },
    });
    const { judge } = honestJudge();
    const out = await runReflectionSweep(store, judge, { now: NOW });
    expect(confirmed).toEqual([]);
    expect(out.autoConfirmed).toBe(0);
  });

  it('promotes an artifact-tier proposal at the threshold once the opt-in is on', async () => {
    const { store, confirmed, memory } = fakeStore([{ sessionId: 's1' }], {
      memory: [artifactProposal('m1')],
      corroboration: { m1: CORROBORATION_THRESHOLD },
      settings: { [MEMORY_AUTO_CONFIRM_KEY]: 'true' },
    });
    const { judge } = honestJudge();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await runReflectionSweep(store, judge, { now: NOW });
    log.mockRestore();

    expect(confirmed).toEqual(['m1']);
    expect(out.autoConfirmed).toBe(1);
    expect(memory[0]?.status).toBe('confirmed');
  });

  it('leaves a proposal one session short of the threshold alone', async () => {
    const { store, confirmed } = fakeStore([{ sessionId: 's1' }], {
      memory: [artifactProposal('m1')],
      corroboration: { m1: CORROBORATION_THRESHOLD - 1 },
      settings: { [MEMORY_AUTO_CONFIRM_KEY]: 'true' },
    });
    const { judge } = honestJudge();
    const out = await runReflectionSweep(store, judge, { now: NOW });
    expect(confirmed).toEqual([]);
    expect(out.autoConfirmed).toBe(0);
  });

  it('NEVER promotes external-origin memory, setting or no setting', async () => {
    const { store, confirmed } = fakeStore([{ sessionId: 's1' }], {
      memory: [
        artifactProposal('m-ext', { provenance: { source: 'external' } }),
        artifactProposal('m-ok'),
      ],
      corroboration: { 'm-ext': CORROBORATION_THRESHOLD + 2, 'm-ok': CORROBORATION_THRESHOLD },
      settings: { [MEMORY_AUTO_CONFIRM_KEY]: 'true' },
    });
    const { judge } = honestJudge();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await runReflectionSweep(store, judge, { now: NOW });
    log.mockRestore();

    // memory-contracts §4 invariant 1: only an explicit user action confirms it.
    expect(confirmed).toEqual(['m-ok']);
    expect(out.autoConfirmed).toBe(1);
  });

  it('a consolidation failure does not fail the sweep', async () => {
    const { store } = fakeStore([{ sessionId: 's1' }], {
      settings: { [MEMORY_AUTO_CONFIRM_KEY]: 'true' },
    });
    store.listCorroboratedProposed = () => {
      throw new Error('database is locked');
    };
    const { judge } = honestJudge();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await runReflectionSweep(store, judge, { now: NOW });
    warn.mockRestore();
    expect(out.sweptSessions).toBe(1);
    expect(out.autoConfirmed).toBe(0);
  });
});

describe('kickReflectionSweep — the turn must not feel it', () => {
  it('returns synchronously and swallows a failure', async () => {
    const broken = {
      listSessions() {
        throw new Error('database is locked');
      },
    } as unknown as ReflectionStore;
    expect(() => kickReflectionSweep(broken, {}, neverCalled)).not.toThrow();
    // Let the detached promise settle; nothing may reach the caller.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('does not start a second sweep while one is still running', async () => {
    const { store } = fakeStore([{ sessionId: 's1' }]);
    let started = 0;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: ReflectionJudge = async (cases) => {
      started += 1;
      await blocked;
      return cases.map((c) => ({ caseId: c.caseId, corrected: false }));
    };
    kickReflectionSweep(store, { now: NOW }, slow);
    kickReflectionSweep(store, { now: NOW }, slow);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toBe(1);
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
