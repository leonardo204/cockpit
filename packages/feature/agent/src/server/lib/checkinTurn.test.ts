import { describe, it, expect, vi } from 'vitest';
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
    const words = checkinInstruction().toLowerCase();
    for (const leak of ['score', 'hit rate', 'butterfly', 'stage', 'growth', 'percent']) {
      expect(words).not.toContain(leak);
    }
    expect(words).toContain('naby_checkin');
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
