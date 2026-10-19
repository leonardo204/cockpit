import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../../../../../../../dist/naby-runtime.mjs';
import type { CrossSessionMeta, Store } from '../../../../../../../dist/naby-runtime.mjs';
import {
  CROSS_SESSION_ENABLED_KEY,
  CROSS_SESSION_MAX_PENDING,
  deliverCrossSession,
  listOtherSessions,
  makeCrossSessionTools,
  pendingCountFrom,
  readCrossSessionEnabled,
  resetCrossSessionRegistry,
  writeCrossSessionEnabled,
  type CrossSessionDeps,
  type CrossSessionDispatch,
  type CrossSessionOutcome,
  type PendingCrossSession,
} from './crossSession';
import { toChatMessages } from '../api/session/toChatMessages';

/**
 * SESSIONS ASKING EACH OTHER (specs/cross-session-messaging.md §4) — the
 * delivery, with a stub dispatch and a stub run hub: no orchestrator, no model,
 * no timers worth waiting for. A "turn" is a run key the stub marks active and
 * then finishes with the events a real run would leave in the registry.
 */

const CWD = '/tmp/naby-cross-session-project';

type Dispatched = { sessionId: string; prompt: string; crossSession: CrossSessionMeta };

/** A fake run hub + dispatch. `script(sessionId)` says how a turn there goes. */
function fakeRuns(
  script: (call: Dispatched, attempt: number) =>
    | { busy: true }
    | { refuse: string }
    | { answer: string; error?: boolean; ticks?: number }
    | { hang: true },
) {
  const active = new Map<string, number>(); // key → ticks left
  const snaps = new Map<string, unknown[]>();
  const stopped: string[] = [];
  const reserved: string[] = [];
  const calls: Dispatched[] = [];
  const attempts = new Map<string, number>();
  const dispatch: CrossSessionDispatch = async (input) => {
    const n = (attempts.get(input.sessionId) ?? 0) + 1;
    attempts.set(input.sessionId, n);
    const call = { sessionId: input.sessionId, prompt: input.prompt, crossSession: input.crossSession };
    const s = script(call, n);
    if ('busy' in s) return { ok: false, status: 409, error: 'session is already running' };
    if ('refuse' in s) return { ok: false, status: 400, error: s.refuse };
    calls.push(call);
    if ('hang' in s) {
      active.set(input.sessionId, Number.POSITIVE_INFINITY);
    } else {
      active.set(input.sessionId, s.ticks ?? 1);
      snaps.set(input.sessionId, [
        { type: 'result', is_error: s.error === true, result: s.answer },
      ]);
    }
    return { ok: true, runKey: input.sessionId };
  };
  const hub = {
    isRunActive(key: string) {
      const left = active.get(key);
      if (left === undefined) return false;
      if (left <= 0) {
        active.delete(key);
        return false;
      }
      active.set(key, left - 1);
      return true;
    },
    getRunSnapshot(key: string) {
      const events = snaps.get(key);
      return events ? { events } : undefined;
    },
    requestStop(key: string) {
      stopped.push(key);
      active.delete(key);
      return true;
    },
    reserveRun(key: string) {
      reserved.push(key);
    },
    releaseRun() {},
  };
  /** Make `key` look busy (a turn of its own) for `ticks` polls. */
  const busy = (key: string, ticks: number) => active.set(key, ticks);
  return { dispatch, hub, calls, stopped, attempts, reserved, busy };
}

function setup() {
  const store = new MemoryStore() as unknown as Store;
  const a = store.createSession('', 'Research', CWD).sessionId;
  const b = store.createSession('', 'Search', CWD).sessionId;
  const other = store.createSession('', 'Elsewhere', '/tmp/another-project').sessionId;
  return { store, a, b, other };
}

function req(a: string, b: string, extra: Partial<PendingCrossSession> = {}): PendingCrossSession {
  return {
    requestId: 'xs-1',
    fromSessionId: a,
    fromTitle: 'Research',
    targetSessionId: b,
    targetTitle: 'Search',
    cwd: CWD,
    request: 'find the release date of X',
    expectReply: true,
    createdAt: 0,
    ...extra,
  };
}

function deps(store: Store, runs: ReturnType<typeof fakeRuns>, logs: Record<string, unknown>[], extra: Partial<CrossSessionDeps> = {}): CrossSessionDeps {
  return {
    store,
    dispatch: runs.dispatch,
    hub: runs.hub,
    retryDelayMs: 0,
    pollMs: 0,
    log: (_kind, payload) => logs.push(payload),
    ...extra,
  };
}

beforeEach(() => resetCrossSessionRegistry());

describe('deliverCrossSession — the round trip (R3, R4)', () => {
  it('runs the request in B, then puts B’s answer into A as a labelled reply turn', async () => {
    const { store, a, b } = setup();
    const runs = fakeRuns((c) => (c.sessionId === b ? { answer: 'X ships on 3 May.', ticks: 2 } : { answer: 'thanks' }));
    const logs: Record<string, unknown>[] = [];
    const out = await deliverCrossSession(deps(store, runs, logs), req(a, b));
    expect(out).toEqual({ phase: 'replied' });
    expect(runs.calls.map((c) => c.sessionId)).toEqual([b, a]);
    const [toB, toA] = runs.calls;
    expect(toB!.crossSession).toEqual({ requestId: 'xs-1', fromSessionId: a, fromTitle: 'Research', role: 'request' });
    expect(toB!.prompt).toMatch(/^\[cross-session request\]/);
    expect(toB!.prompt).toContain('<untrusted_cross_session_request>\nfind the release date of X\n');
    expect(toA!.crossSession).toEqual({ requestId: 'xs-1', fromSessionId: b, fromTitle: 'Search', role: 'reply' });
    expect(toA!.prompt).toContain('X ships on 3 May.');
    expect(logs.map((l) => l.phase)).toEqual(['delivered', 'answered', 'replied']);
  });

  it('retries a busy target (409) and delivers when it frees up', async () => {
    const { store, a, b } = setup();
    const runs = fakeRuns((c, n) => (c.sessionId === b && n < 3 ? { busy: true } : { answer: 'ok' }));
    const out = await deliverCrossSession(deps(store, runs, []), req(a, b));
    expect(out).toEqual({ phase: 'replied' });
    expect(runs.attempts.get(b)).toBe(3);
  });

  it('a target that never frees up becomes a "could not deliver" failure in A', async () => {
    const { store, a, b } = setup();
    const runs = fakeRuns((c) => (c.sessionId === b ? { busy: true } : { answer: 'noted' }));
    const logs: Record<string, unknown>[] = [];
    const out = await deliverCrossSession(deps(store, runs, logs, { maxAttempts: 2 }), req(a, b));
    expect(out).toEqual({ phase: 'failed', reason: 'busy', reported: true });
    expect(runs.attempts.get(b)).toBe(2);
    expect(runs.calls).toHaveLength(1);
    expect(runs.calls[0]!.sessionId).toBe(a);
    expect(runs.calls[0]!.crossSession.role).toBe('failure');
    expect(runs.calls[0]!.prompt).toMatch(/^\[cross-session failure\]/);
    expect(logs[0]).toMatchObject({ phase: 'failed', reason: 'busy' });
  });

  it('B’s turn ending in an error is reported to A', async () => {
    const { store, a, b } = setup();
    const runs = fakeRuns((c) => (c.sessionId === b ? { answer: 'boom', error: true } : { answer: 'ok' }));
    const out = await deliverCrossSession(deps(store, runs, []), req(a, b));
    expect(out).toEqual({ phase: 'failed', reason: 'error', reported: true });
    expect(runs.calls[1]!.prompt).toContain('ended with an error');
  });

  it('a B turn that runs past the deadline is stopped and reported as a timeout', async () => {
    const { store, a, b } = setup();
    const runs = fakeRuns((c) => (c.sessionId === b ? { hang: true } : { answer: 'ok' }));
    let t = 0;
    const out = await deliverCrossSession(
      deps(store, runs, [], { turnDeadlineMs: 10, now: () => (t += 5) }),
      req(a, b),
    );
    expect(out).toEqual({ phase: 'failed', reason: 'timeout', reported: true });
    expect(runs.stopped).toEqual([b]);
    expect(runs.calls[1]!.prompt).toContain('did not finish in time');
  });

  it('the target tab closed mid-turn → stopped, "target closed" reported', async () => {
    const { store, a, b } = setup();
    const runs = fakeRuns((c) => {
      if (c.sessionId === b) {
        queueMicrotask(() => store.deleteSession(b));
        return { hang: true };
      }
      return { answer: 'ok' };
    });
    const out = await deliverCrossSession(deps(store, runs, []), req(a, b));
    expect(out).toEqual({ phase: 'failed', reason: 'target-closed', reported: true });
    expect(runs.stopped).toEqual([b]);
    expect(runs.calls[1]!.prompt).toContain('the session was closed');
  });

  it('the sender tab closed before the answer came → the answer is dropped', async () => {
    const { store, a, b } = setup();
    const runs = fakeRuns((c) => {
      if (c.sessionId === b) store.deleteSession(a);
      return { answer: 'ok' };
    });
    const logs: Record<string, unknown>[] = [];
    const out = await deliverCrossSession(deps(store, runs, logs), req(a, b));
    expect(out).toEqual({ phase: 'dropped', why: 'sender-closed' });
    expect(runs.calls.map((c) => c.sessionId)).toEqual([b]);
    expect(logs.at(-1)).toMatchObject({ phase: 'dropped', why: 'sender-closed' });
  });

  it('expectReply:false — B runs, nothing comes back, not even a failure', async () => {
    const { store, a, b } = setup();
    const ok = fakeRuns(() => ({ answer: 'done' }));
    expect(await deliverCrossSession(deps(store, ok, []), req(a, b, { expectReply: false }))).toEqual({
      phase: 'answered',
    });
    expect(ok.calls.map((c) => c.sessionId)).toEqual([b]);
    expect(ok.calls[0]!.prompt).toContain('does not expect an answer');

    const bad = fakeRuns(() => ({ answer: 'x', error: true }));
    expect(await deliverCrossSession(deps(store, bad, []), req(a, b, { expectReply: false }))).toEqual({
      phase: 'failed',
      reason: 'error',
      reported: false,
    });
    expect(bad.calls.map((c) => c.sessionId)).toEqual([b]);
  });

  it('a long answer is cut at 12k characters in A’s prompt', async () => {
    const { store, a, b } = setup();
    const runs = fakeRuns((c) => (c.sessionId === b ? { answer: 'z'.repeat(13_000) } : { answer: 'ok' }));
    await deliverCrossSession(deps(store, runs, []), req(a, b));
    const prompt = runs.calls[1]!.prompt;
    expect(prompt).toContain('z'.repeat(12_000));
    expect(prompt).not.toContain('z'.repeat(12_001));
    expect(prompt).toMatch(/was cut/);
  });
});

describe('deliverCrossSession — the answer waits for a busy sender', () => {
  it('A in a long turn (far past 5×30s) still gets the answer once it goes idle', async () => {
    const { store, a, b } = setup();
    const runs = fakeRuns(() => ({ answer: 'found' }));
    runs.busy(a, 1_000);
    let t = 0;
    // 1000 polls of A's own turn — far more than the delivery retry's 5 — and
    // still inside the wait on the injected clock.
    const out = await deliverCrossSession(
      deps(store, runs, [], { now: () => (t += 1), senderWaitMs: 10_000 }),
      req(a, b),
    );
    expect(out).toEqual({ phase: 'replied' });
    expect(runs.calls.map((c) => c.sessionId)).toEqual([b, a]);
    expect(runs.attempts.get(a)).toBe(1);
    expect(runs.reserved).toContain(a);
  });

  it('a 409 race at A (a new turn started in the gap) keeps waiting', async () => {
    const { store, a, b } = setup();
    const runs = fakeRuns((c, n) => (c.sessionId === a && n < 4 ? { busy: true } : { answer: 'ok' }));
    const out = await deliverCrossSession(deps(store, runs, []), req(a, b));
    expect(out).toEqual({ phase: 'replied' });
    expect(runs.attempts.get(a)).toBe(4);
  });

  it('A busy past the 30-minute wait → the answer is dropped and logged', async () => {
    const { store, a, b } = setup();
    const runs = fakeRuns(() => ({ answer: 'found' }));
    runs.busy(a, Number.POSITIVE_INFINITY);
    let t = 0;
    const logs: Record<string, unknown>[] = [];
    // 31 minutes per poll on the injected clock: the first check past start is over.
    const out = await deliverCrossSession(
      deps(store, runs, logs, { now: () => (t += 31 * 60_000), turnDeadlineMs: Number.POSITIVE_INFINITY }),
      req(a, b),
    );
    expect(out).toEqual({ phase: 'dropped', why: 'sender-busy' });
    expect(runs.calls.map((c) => c.sessionId)).toEqual([b]);
    expect(logs.at(-1)).toMatchObject({ phase: 'dropped', why: 'sender-busy' });
  });

  it('A’s tab closed while the answer waits → stops early, dropped', async () => {
    const { store, a, b } = setup();
    const runs = fakeRuns(() => ({ answer: 'found' }));
    runs.busy(a, Number.POSITIVE_INFINITY);
    let polls = 0;
    const out = await deliverCrossSession(
      deps(store, runs, [], {
        now: () => {
          polls += 1;
          if (polls === 6) store.deleteSession(a);
          return polls;
        },
      }),
      req(a, b),
    );
    expect(out).toEqual({ phase: 'dropped', why: 'sender-closed' });
    expect(runs.calls.map((c) => c.sessionId)).toEqual([b]);
  });
});

describe('the tools (R1, R2, R6, §3.4)', () => {
  function tools(store: Store, sessionId: string, runs: ReturnType<typeof fakeRuns>, deliveries: Promise<CrossSessionOutcome>[]) {
    return makeCrossSessionTools({
      store,
      sessionId,
      cwd: CWD,
      isRunActive: (k) => k === 'nobody',
      deliveryDeps: async () => deps(store, runs, []),
      log: () => {},
      onDelivery: (p) => deliveries.push(p),
    });
  }
  const ctx = { toolCall: { toolCallId: 't', toolName: 'x', input: {} }, signal: new AbortController().signal };

  it('lists the project’s other sessions, not itself and not another project’s', async () => {
    const { store, a, b } = setup();
    store.appendMessage(b, { role: 'user', content: 'look   up\nprices' });
    store.appendMessage(b, { role: 'user', content: 'from A', crossSession: { requestId: 'r', fromSessionId: a, fromTitle: 't', role: 'request' } });
    const rows = listOtherSessions(store, { isRunActive: () => false }, { sessionId: a, cwd: CWD });
    expect(rows).toEqual([{ sessionId: b, title: 'Search', lastUserMessage: 'look up prices', running: false }]);
    const t = tools(store, a, fakeRuns(() => ({ answer: 'ok' })), []);
    const out = await t.executors.naby_list_sessions!({}, ctx);
    expect(out.content).toContain(b);
    expect(out.content).toContain('"Search"');
  });

  it('send returns at once with a request id and delivers in the background', async () => {
    const { store, a, b } = setup();
    const runs = fakeRuns(() => ({ answer: 'ok' }));
    const deliveries: Promise<CrossSessionOutcome>[] = [];
    const t = tools(store, a, runs, deliveries);
    const out = await t.executors.naby_send_to_session!({ sessionId: b, request: 'search X' }, ctx);
    expect(out.isError).toBeUndefined();
    const data = out.data as { ok: boolean; requestId: string };
    expect(data.ok).toBe(true);
    expect(data.requestId).toMatch(/^xs-/);
    expect(pendingCountFrom(a)).toBe(1);
    expect(await deliveries[0]).toEqual({ phase: 'replied' });
    expect(pendingCountFrom(a)).toBe(0);
  });

  it('refuses itself, an unknown id, another project’s session and bad input', async () => {
    const { store, a, other } = setup();
    const t = tools(store, a, fakeRuns(() => ({ answer: 'ok' })), []);
    const send = t.executors.naby_send_to_session!;
    expect((await send({ sessionId: a, request: 'x' }, ctx)).isError).toBe(true);
    expect((await send({ sessionId: 'no-such', request: 'x' }, ctx)).isError).toBe(true);
    const cross = await send({ sessionId: other, request: 'x' }, ctx);
    expect(cross.isError).toBe(true);
    expect(cross.content).toContain('another project');
    expect((await send({ sessionId: other }, ctx)).isError).toBe(true);
    expect(pendingCountFrom(a)).toBe(0);
  });

  it(`allows ${CROSS_SESSION_MAX_PENDING} unfinished requests per session, then refuses`, async () => {
    const { store, a, b } = setup();
    // Never finishes, so every request stays pending.
    const runs = fakeRuns(() => ({ hang: true }));
    const t = makeCrossSessionTools({
      store,
      sessionId: a,
      cwd: CWD,
      isRunActive: () => false,
      deliveryDeps: () => new Promise<CrossSessionDeps>(() => {}),
      log: () => {},
    });
    void runs;
    const send = t.executors.naby_send_to_session!;
    for (let i = 0; i < CROSS_SESSION_MAX_PENDING; i++) {
      expect((await send({ sessionId: b, request: `r${i}` }, ctx)).isError).toBeUndefined();
    }
    const over = await send({ sessionId: b, request: 'one more' }, ctx);
    expect(over.isError).toBe(true);
    expect(over.content).toContain('already has');
  });
});

describe('the setting (R10)', () => {
  it('defaults on and round-trips', () => {
    const store = new MemoryStore() as unknown as Store;
    expect(readCrossSessionEnabled(store)).toBe(true);
    writeCrossSessionEnabled(store, false);
    expect(store.getSetting(CROSS_SESSION_ENABLED_KEY)).toBe('false');
    expect(readCrossSessionEnabled(store)).toBe(false);
    writeCrossSessionEnabled(store, true);
    expect(readCrossSessionEnabled(store)).toBe(true);
  });
});

describe('toChatMessages — cross-session rows (§3.3)', () => {
  it('a request / reply / failure row becomes a cross-session notice, not a user bubble', () => {
    const rows = toChatMessages([
      { role: 'user', content: 'typed by me' },
      { role: 'user', content: '[cross-session request] …', crossSession: { requestId: 'r', fromSessionId: 'A', fromTitle: 'Research', role: 'request' } },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: '[cross-session reply] …', crossSession: { requestId: 'r', fromSessionId: 'B', fromTitle: 'Search', role: 'reply' } },
      { role: 'user', content: '[cross-session failure] …', crossSession: { requestId: 'q', fromSessionId: 'B', fromTitle: 'Search', role: 'failure' } },
    ]);
    expect(rows[0]).toMatchObject({ role: 'user', content: 'typed by me' });
    expect(rows[1]).toMatchObject({
      role: 'system',
      systemEvent: { kind: 'cross-session', status: 'request', peer: 'Research', detail: '[cross-session request] …' },
    });
    expect(rows[3]).toMatchObject({ role: 'system', systemEvent: { kind: 'cross-session', status: 'reply', peer: 'Search' } });
    expect(rows[4]).toMatchObject({ role: 'system', systemEvent: { kind: 'cross-session', status: 'failure' } });
  });
});
