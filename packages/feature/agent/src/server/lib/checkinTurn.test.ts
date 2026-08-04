import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canCheckIn, checkinInstruction, makeCheckinSink, recordGateOutcome } from './checkinTurn';
import { resolveCheckin, hasPendingCheckin } from './checkinRegistry';
import type { Agent, EvalEvent, EvalEventInput } from '../../../../../../../dist/naby-runtime.mjs';

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'a1',
    name: 'nabi',
    kind: 'persona',
    systemPrompt: 'you are nabi',
    memoryScope: 'user',
    autonomy: { escalation: 'inline' },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

/** A store just wide enough for the sink: it remembers what was appended and can
 *  serve a question history. */
function fakeStore(history: string[] = []) {
  const appended: EvalEventInput[] = [];
  return {
    appended,
    appendEvalEvent(event: EvalEventInput) {
      appended.push(event);
      return event as EvalEvent;
    },
    listEvalEvents() {
      // Oldest-first, as the real store returns.
      return history.map((question, i) => ({
        id: `e${i}`,
        kind: 'checkin' as const,
        at: 1000 + i,
        agentId: 'a1',
        sessionId: 's1',
        question,
      })) as EvalEvent[];
    },
  };
}

function sinkFor(store: ReturnType<typeof fakeStore>, signal: AbortSignal, ttlMs = 10_000) {
  const emitted: Array<Record<string, unknown>> = [];
  const sink = makeCheckinSink({
    store,
    agentId: 'a1',
    sessionId: 's1',
    emit: (e) => emitted.push(e),
    signal,
    ttlMs,
    now: () => 5_000,
  });
  return { sink, emitted };
}

const QUESTION = {
  question: 'Migrate the column, or add a new one?',
  options: ['migrate', 'add a new one'],
  recommended: 0,
};

describe('checkinTurn — whether the agent may check in (P3-M5)', () => {
  it('an unrestricted agent may', () => {
    expect(canCheckIn(agent())).toBe(true);
  });

  it('no subject agent means no check-in — the tool is not even built', () => {
    expect(canCheckIn(undefined)).toBe(false);
  });

  it('an allowlisted agent may only when the tool is on its list', () => {
    expect(canCheckIn(agent({ toolRefs: ['naby_checkin', 'Read'] }))).toBe(true);
    // The P3-M2 gate would deny every call, so instructing it to ask would just
    // make it retry a dead end.
    expect(canCheckIn(agent({ toolRefs: ['Read', 'Grep'] }))).toBe(false);
  });

  it('the instruction never tells the agent it is being scored', () => {
    // EVERY wording, not just the default one: the stage-aware half (below) is
    // the newest place a stage name could leak into the prompt.
    for (const stage of [undefined, 'egg', 'larva', 'pupa', 'butterfly'] as const) {
      const words = checkinInstruction(stage).toLowerCase();
      for (const leak of ['score', 'hit rate', 'butterfly', 'stage', 'growth', 'percent']) {
        expect(words, `${stage ?? 'no stage'} leaked "${leak}"`).not.toContain(leak);
      }
      expect(words).toContain('naby_checkin');
    }
  });

  /**
   * P3-M12e — WHY THE WORDING IS STAGE-AWARE.
   *
   * A real ledger after months of use: ~197 autonomous rows, 0 real check-ins,
   * so the one exit from the egg (real check-ins, which drills deliberately
   * cannot supply — fast-evolution §3.4) was unreachable in practice. The tool,
   * the sink and the prompt block were all live; nothing ever pushed the model to
   * ASK during ordinary work. This is the push, and it stops at butterfly, where
   * coverage and ask-quality already price over-asking.
   */
  it('below butterfly it is told to prefer asking on consequential choices', () => {
    for (const stage of [undefined, 'egg', 'larva', 'pupa'] as const) {
      const words = checkinInstruction(stage).toLowerCase();
      expect(words, `${stage ?? 'no stage'} lost the eager clause`).toContain(
        'prefer asking over deciding on your own',
      );
      // The eagerness is bounded in the same breath, or it becomes an
      // interruption machine — and the degenerate guard voids repeats anyway.
      expect(words).toContain('this is not a licence to interrupt');
      expect(words).toContain('one or two');
    }
  });

  it('at butterfly the wording stays as light as it was', () => {
    const words = checkinInstruction('butterfly').toLowerCase();
    expect(words).not.toContain('prefer asking over deciding on your own');
    expect(words).not.toContain('this is not a licence to interrupt');
    // The original block is untouched underneath, at every stage.
    for (const stage of [undefined, 'egg', 'butterfly'] as const) {
      expect(checkinInstruction(stage)).toContain('CHECKING IN: right before you do something');
    }
  });

  /**
   * AN EGG MAY CHECK IN. P3-M12b-5, and the thing that has to stay true for the
   * fast-growth session to work at all: check-ins are precisely HOW an egg grows
   * (trust-meter §4.1 — the ledger is the only input to the stage), so a gate that
   * required a stage, or required the agent to be `@`-addressable, would be the
   * M5 deadlock rebuilt — trusted enough to earn trust.
   *
   * `canCheckIn` takes no stage and no ledger, which is the design; this pins that
   * the day someone is tempted to add one.
   */
  it('an egg-stage persona may check in — this gate knows nothing about stages', () => {
    const eggPersona = agent({ id: 'agent-persona-builtin', kind: 'persona' });
    expect(canCheckIn(eggPersona)).toBe(true);
    expect(canCheckIn.length).toBe(1); // one parameter: the agent. No stage, no growth.
  });
});

describe('checkinTurn — the pause bridge', () => {
  it('a resolved check-in resumes the turn with the pick and clears the registry', async () => {
    const store = fakeStore();
    const ac = new AbortController();
    const { sink, emitted } = sinkFor(store, ac.signal);

    const pending = sink.ask(QUESTION, { toolCallId: 'call-1' });
    // The request event is what puts the prompt on screen.
    const request = emitted.find((e) => e.type === 'checkin_request');
    expect(request).toMatchObject({
      checkinId: 's1:call-1',
      question: QUESTION.question,
      options: QUESTION.options,
      recommended: 0,
      session_id: 's1',
    });
    expect(hasPendingCheckin('s1:call-1')).toBe(true);

    expect(resolveCheckin('s1:call-1', { chosen: 1 })).toBe(true);
    await expect(pending).resolves.toEqual({ chosen: 1 });
    expect(hasPendingCheckin('s1:call-1')).toBe(false);
    expect(emitted.some((e) => e.type === 'checkin_resolved' && e.chosen === 1)).toBe(true);
  });

  it('a stopped turn ends the prompt as unanswered, not as a miss', async () => {
    const store = fakeStore();
    const ac = new AbortController();
    const { sink } = sinkFor(store, ac.signal);
    const pending = sink.ask(QUESTION, { toolCallId: 'call-2' });
    ac.abort();
    await expect(pending).resolves.toEqual({ chosen: -1, unanswered: true });
    expect(hasPendingCheckin('s1:call-2')).toBe(false);
  });

  it('an already-stopped turn never puts a prompt up at all', async () => {
    const store = fakeStore();
    const ac = new AbortController();
    ac.abort();
    const { sink, emitted } = sinkFor(store, ac.signal);
    await expect(sink.ask(QUESTION, { toolCallId: 'call-3' })).resolves.toEqual({
      chosen: -1,
      unanswered: true,
    });
    expect(emitted.some((e) => e.type === 'checkin_request')).toBe(false);
  });

  it('an unanswered prompt expires instead of hanging the turn forever', async () => {
    vi.useFakeTimers();
    try {
      const store = fakeStore();
      const { sink } = sinkFor(store, new AbortController().signal, 1_000);
      const pending = sink.ask(QUESTION, { toolCallId: 'call-4' });
      vi.advanceTimersByTime(1_001);
      await expect(pending).resolves.toEqual({ chosen: -1, unanswered: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a late resolve for a settled check-in is a harmless no-op', async () => {
    const store = fakeStore();
    const ac = new AbortController();
    const { sink } = sinkFor(store, ac.signal);
    const pending = sink.ask(QUESTION, { toolCallId: 'call-5' });
    expect(resolveCheckin('s1:call-5', { chosen: 0 })).toBe(true);
    await pending;
    expect(resolveCheckin('s1:call-5', { chosen: 1 })).toBe(false);
  });
});

describe('checkinTurn — the ledger row', () => {
  it('records the answer, the label and the exclusion reason as given', () => {
    const store = fakeStore();
    const { sink } = sinkFor(store, new AbortController().signal);
    sink.record({
      question: QUESTION.question,
      options: QUESTION.options,
      recommended: 0,
      chosen: 1,
      hit: false,
      confidence: 0.4,
      correction: 'do neither',
      taskType: 'schema-change',
      excludedFromScoring: true,
      reason: 'repeat-question',
    });
    expect(store.appended).toHaveLength(1);
    expect(store.appended[0]).toEqual({
      kind: 'checkin',
      agentId: 'a1',
      sessionId: 's1',
      question: QUESTION.question,
      options: QUESTION.options,
      recommended: 0,
      chosen: 1,
      hit: false,
      confidence: 0.4,
      correction: 'do neither',
      taskType: 'schema-change',
      excludedFromScoring: true,
      reason: 'repeat-question',
    });
  });

  it('reads the recent question history so a repeat can be spotted, newest first', () => {
    const store = fakeStore(['oldest question', 'middle question', 'newest question']);
    const { sink } = sinkFor(store, new AbortController().signal);
    expect(sink.recentQuestions).toEqual(['newest question', 'middle question', 'oldest question']);
  });

  // -- P3-M12c: the drill stamp (fast-evolution §3.4, contracts invariant 9) --

  it('an ordinary session stamps NOTHING — a row without the flag is real work', () => {
    const store = fakeStore();
    const { sink } = sinkFor(store, new AbortController().signal);
    sink.record({ question: 'q', options: ['a', 'b'], recommended: 0, chosen: 0, hit: true });
    // Absent, not `drill: false`: every reader uses `=== true`, and a ledger with
    // no fast-growth session must produce exactly the rows it produced pre-M12c.
    expect(store.appended[0]).not.toHaveProperty('drill');
  });

  it('a fast-growth session stamps every row it writes', () => {
    const store = fakeStore();
    const sink = makeCheckinSink({
      store,
      agentId: 'a1',
      sessionId: 's1',
      emit: () => {},
      signal: new AbortController().signal,
      ttlMs: 10_000,
      now: () => 5_000,
      drill: true,
    });
    sink.record({ question: 'q1', options: ['a', 'b'], recommended: 0, chosen: 0, hit: true });
    sink.record({ question: 'q2', options: ['a', 'b'], recommended: 0, chosen: 1, hit: false });
    expect(store.appended.map((e) => (e as { drill?: boolean }).drill)).toEqual([true, true]);
  });

  it('the SESSION decides, never the row the model produced', () => {
    // The row the runtime hands `record` is built from the model's tool input. If
    // a `drill` field in there could reach the ledger, a model could file the
    // questions it got wrong as practice and the ones it got right as real work,
    // and the discount would measure nothing but its bookkeeping.
    const real = fakeStore();
    const realSink = sinkFor(real, new AbortController().signal).sink;
    realSink.record({
      question: 'q',
      options: ['a', 'b'],
      recommended: 0,
      chosen: 0,
      hit: true,
      // @ts-expect-error — CheckinLedgerRow has no `drill`; this is the smuggling
      // attempt the test exists to prove impossible.
      drill: true,
    });
    expect(real.appended[0]).not.toHaveProperty('drill');

    // …and the reverse: a model cannot un-mark a drill either.
    const practice = fakeStore();
    const practiceSink = makeCheckinSink({
      store: practice,
      agentId: 'a1',
      sessionId: 's1',
      emit: () => {},
      signal: new AbortController().signal,
      ttlMs: 10_000,
      now: () => 5_000,
      drill: true,
    });
    practiceSink.record({
      question: 'q',
      options: ['a', 'b'],
      recommended: 0,
      chosen: 0,
      hit: true,
      // @ts-expect-error — same reason, the other direction.
      drill: false,
    });
    expect((practice.appended[0] as { drill?: boolean }).drill).toBe(true);
  });
});

describe('checkinTurn — what the GATE records (not the agent)', () => {
  const base = { agentId: 'a1', sessionId: 's1' };

  it('an allowed consequential call is an autonomous row', () => {
    const store = fakeStore();
    expect(recordGateOutcome({ store, ...base, toolName: 'Write', allowed: true })).toBe('autonomous');
    expect(store.appended[0]).toMatchObject({
      kind: 'autonomous',
      toolName: 'Write',
      // A file edit is covered by the per-call snapshot, so it is recoverable.
      reversible: true,
    });
  });

  it('a shell command is recorded as NOT reversible', () => {
    const store = fakeStore();
    recordGateOutcome({ store, ...base, toolName: 'Bash', allowed: true });
    expect(store.appended[0]).toMatchObject({ kind: 'autonomous', reversible: false });
  });

  it('a refused consequential call is a tripwire, carrying the reason', () => {
    const store = fakeStore();
    expect(
      recordGateOutcome({ store, ...base, toolName: 'Bash', allowed: false, reason: 'denied by policy' }),
    ).toBe('tripwire');
    expect(store.appended[0]).toMatchObject({
      kind: 'tripwire',
      toolName: 'Bash',
      reason: 'denied by policy',
    });
  });

  it('reads are not scored at all — neither allowed nor denied', () => {
    const store = fakeStore();
    expect(recordGateOutcome({ store, ...base, toolName: 'Read', allowed: true })).toBeUndefined();
    // A denied Grep is a policy preference, not a safety refusal: making it a
    // tripwire would hard-block growth on an unrelated permission choice.
    expect(recordGateOutcome({ store, ...base, toolName: 'Grep', allowed: false })).toBeUndefined();
    expect(store.appended).toHaveLength(0);
  });

  it('our own outbound tool is scored, and so is an MCP tool that declared nothing (P3-M8d)', () => {
    const store = fakeStore();
    expect(recordGateOutcome({ store, ...base, toolName: 'send_message', allowed: true })).toBe(
      'autonomous',
    );
    // THE GAP THIS MILESTONE CLOSED. Through M8c a third-party tool that mails
    // someone produced no row at all, because danger was not inferable from a
    // name — and the honest consequence was that coverage read higher than the
    // truth for anyone using MCP. It is not inferred now either: an undeclared
    // tool counts because it is UNDECLARED (fail-closed, spec §7.4), not because
    // of anything its name suggests.
    expect(
      recordGateOutcome({ store, ...base, toolName: 'mail__send_email', allowed: true }),
    ).toBe('autonomous');
    expect(store.appended[1]).toMatchObject({
      kind: 'autonomous',
      toolName: 'mail__send_email',
      // Unknown means unknown: nothing promises a third-party action can be undone.
      reversible: false,
    });
  });

  it('an MCP tool that DECLARED itself read-only produces no row', () => {
    const store = fakeStore();
    expect(
      recordGateOutcome({
        store,
        ...base,
        toolName: 'jira__search_issues',
        allowed: true,
        readOnlyHint: true,
      }),
    ).toBeUndefined();
    // And a refused read-only tool is not a safety tripwire either — the same
    // rule that keeps a denied Grep from hard-blocking growth.
    expect(
      recordGateOutcome({
        store,
        ...base,
        toolName: 'jira__search_issues',
        allowed: false,
        reason: 'denied by policy',
        readOnlyHint: true,
      }),
    ).toBeUndefined();
    expect(store.appended).toHaveLength(0);
  });

  it("the user's own ask/deny rule outranks the server's read-only claim", () => {
    const store = fakeStore();
    // They put a rule on it, which is them saying they want to see this one. A
    // `readOnlyHint` cannot talk its way out of that.
    expect(
      recordGateOutcome({
        store,
        ...base,
        toolName: 'jira__search_issues',
        allowed: true,
        readOnlyHint: true,
        policyForcesConsequential: true,
      }),
    ).toBe('autonomous');
    expect(
      recordGateOutcome({
        store,
        ...base,
        toolName: 'jira__search_issues',
        allowed: false,
        reason: 'blocked by your policy rule',
        policyForcesConsequential: true,
      }),
    ).toBe('tripwire');
    expect(store.appended).toHaveLength(2);
  });

  it('a ledger failure never breaks the turn', () => {
    const store = {
      appendEvalEvent() {
        throw new Error('disk full');
      },
    };
    expect(() => recordGateOutcome({ store, ...base, toolName: 'Write', allowed: true })).not.toThrow();
    expect(recordGateOutcome({ store, ...base, toolName: 'Write', allowed: true })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The engine wiring (P3-M12e).
//
// Same shape as `harnessHome.test.ts`'s: the turn loop cannot be stood up here,
// so what is pinned is the PAIRING — the instruction is composed with a stage,
// the stage comes from the SUBJECT's own record, and it costs at most one ledger
// read on a turn that actually has the tool.
// ---------------------------------------------------------------------------

describe('naby engine wiring — the check-in instruction gets a stage', () => {
  const source = readFileSync(join(__dirname, '../engines/naby.ts'), 'utf8');

  it('composes the instruction with the subject\'s stage', () => {
    expect(source).toContain('checkinInstruction(subjectGrowth?.stage)');
  });

  it('reads the subject\'s record, reusing the routed read, only when the tool is there', () => {
    const block = source.slice(source.indexOf('const subjectGrowth ='), source.indexOf('if (checksIn) {'));
    // Gated on the tool being present — an ordinary turn without a check-in sink
    // must not pay for a ledger read it cannot use.
    expect(block).toContain('checksIn && growthSubject');
    // A routed turn already read this exact ledger above.
    expect(block).toContain('routedGrowth');
    expect(block).toContain('readGrowth(store, growthSubject.id)');
    // ONE read per turn: the fast-growth block shares it instead of repeating it.
    expect(source.match(/readGrowth\(store, growthSubject\.id\)/g) ?? []).toHaveLength(2);
    expect(source).toContain('subjectGrowth ?? readGrowth(store, growthSubject.id)');
  });
});
