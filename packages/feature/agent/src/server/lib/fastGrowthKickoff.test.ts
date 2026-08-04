import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * THE FAST-GROWTH SESSION'S OPENING TURN (fast-evolution §3.3b).
 *
 * THE REPORT. The button created a named session and opened it — and the user
 * landed in an empty conversation, did not know what was wanted of them, and
 * typed "시작" to find out. Only then did naby start the interview. The session
 * whose entire premise is that naby asks the questions was waiting to be asked
 * one.
 *
 * WHAT IS PINNED HERE, and each one is a way this could go wrong in the user's
 * hands rather than in a type checker:
 *
 *   1. Creating the session fires EXACTLY ONE turn, into that session.
 *   2. Nothing else fires one — not an ordinary session, not `fastGrowth.set`,
 *      and not re-opening a session that was already kicked off.
 *   3. A failed kickoff (no engine, refusal, an exception) does not fail the
 *      creation. The user gets the empty session the previous build gave them,
 *      not an error.
 *   4. The assistant's greeting actually lands in the TRANSCRIPT, which is what
 *      the chat view renders when the tab opens.
 *
 * NO ENGINE IS REACHABLE FROM THIS FILE. `dispatchChat` is mocked, and the
 * "greeting" mode delegates to the REAL orchestrator with a fake spec — so the
 * run lifecycle, the registry and the store writes are the real ones while the
 * model is not. Without the mock, `session.fastGrowth.create` in a test would
 * run preflight against whatever engine this machine happens to have configured
 * and could start a genuine model turn.
 */

const h = vi.hoisted(() => ({
  /** Every dispatch the kickoff attempted, in order. */
  calls: [] as { sessionId?: string; prompt?: unknown; engine?: string; cwd?: string }[],
  /** What the mocked dispatch does: answer with a greeting, refuse, or throw. */
  mode: 'greet' as 'greet' | 'refuse' | 'throw',
}));

/** What the fake engine says. Distinctive enough that finding it in the
 *  transcript cannot be an accident. */
const GREETING = 'What are you working on these days?';

vi.mock('../engines/orchestrator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/orchestrator')>();
  return {
    ...actual,
    dispatchChat: async (_spec: unknown, body: Record<string, unknown>) => {
      h.calls.push({
        sessionId: body.sessionId as string | undefined,
        prompt: body.prompt,
        engine: body.engine as string | undefined,
        cwd: body.cwd as string | undefined,
      });
      if (h.mode === 'throw') throw new Error('the engine exploded');
      if (h.mode === 'refuse') {
        // The shape preflight answers with when this machine has no engine
        // configured at all — the case the graceful fallback is written for.
        return { ok: false as const, status: 503, error: 'no engine configured' };
      }
      // The real run lifecycle, with a fake spec in place of the model.
      return actual.dispatchChat(fakeSpec(), body);
    },
  };
});

import { getStore } from '../engines/naby';
import { runNabyAction } from '../api/naby';
import {
  addRunListener,
  getAttachAnnouncement,
  isRunPending,
  markRunIdle,
} from '../sessionRunHub';
import type { EngineSpec, RunCtx } from '../engines/types';
import {
  DEFAULT_KICKOFF_TEXT,
  KICKOFF_TEXT_MAX,
  kickoffFastGrowthSession,
  kickoffKey,
  normalizeKickoffText,
  startFastGrowthKickoff,
} from './fastGrowthKickoff';

/**
 * A stand-in for `nabySpec`: it writes the same two rows the runtime writes
 * (`src/runtime/session.ts` appends the user turn, then the assistant text) and
 * declares `persistsOwnTranscript` for the same reason naby does, so the
 * orchestrator's recorder does not write them a second time.
 */
function fakeSpec(): EngineSpec {
  return {
    name: 'fake-naby',
    persistsOwnTranscript: true,
    runner: {
      async run(ctx: RunCtx): Promise<void> {
        const store = getStore();
        const sessionId = ctx.sessionId;
        if (sessionId) {
          store.appendMessage(sessionId, { role: 'user', content: String(ctx.prompt ?? '') });
          store.appendMessage(sessionId, { role: 'assistant', content: GREETING });
        }
        ctx.emit({ type: 'assistant', text: GREETING });
        ctx.emit({ type: 'result', result: GREETING });
      },
    },
  };
}

async function waitUntil(pred: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('waitUntil timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

let n = 0;
const freshId = (label: string) => `${label}-${Date.now()}-${n++}`;

beforeEach(() => {
  h.calls.length = 0;
  h.mode = 'greet';
});

describe('the fast-growth session opens with naby already talking', () => {
  it('fires exactly one turn, into the session it just created', async () => {
    const created = await runNabyAction({
      action: 'session.fastGrowth.create',
      title: '빠른 성장 세션',
      kickoff: '빠른 성장 세션을 시작합니다.',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sessionId = created.sessionId!;

    await waitUntil(() => h.calls.length > 0);
    // Give any second dispatch a chance to show up before asserting there is none.
    await new Promise((r) => setTimeout(r, 30));
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.sessionId).toBe(sessionId);
    // THE SESSION, NOT A NEW ONE. A dispatch with no sessionId would mint a
    // second conversation and leave the named one empty — the reported bug with
    // an extra session in the list.
    expect(h.calls[0]!.engine).toBe('naby');
    // The words came from the client, verbatim.
    expect(h.calls[0]!.prompt).toBe('빠른 성장 세션을 시작합니다.');
  });

  it('puts the assistant greeting in the transcript the chat view reads', async () => {
    const created = await runNabyAction({ action: 'session.fastGrowth.create' });
    if (!created.ok) return;
    const sessionId = created.sessionId!;
    const store = getStore();

    // The tab renders `store.getMessages(...)` (mapped by `toChatMessages`), so
    // this is the assertion that the user sees something when it opens.
    await waitUntil(() =>
      store
        .getMessages(sessionId)
        .some((m) => m.role === 'assistant' && m.content.includes(GREETING)),
    );

    // The user side is ONE honest sentence, not a disguise: the schema has no
    // hidden message kind, and both other headless callers (the scheduled task,
    // the Telegram message) store their prompt as a plain user row too.
    const first = store.getMessages(sessionId)[0];
    expect(first?.role).toBe('user');
    expect(first?.role === 'user' ? first.content : '').toBe(DEFAULT_KICKOFF_TEXT);
  });

  it('never fires twice — a re-open finds the kickoff already spent', async () => {
    const created = await runNabyAction({ action: 'session.fastGrowth.create' });
    if (!created.ok) return;
    const sessionId = created.sessionId!;
    await waitUntil(() => h.calls.length === 1);

    // What a re-open would do if anything ever called it again. A second opening
    // question would arrive with no context — worse than none.
    const again = await startFastGrowthKickoff({ store: getStore(), sessionId });
    expect(again).toEqual({ started: false, reason: 'already-kicked' });
    expect(h.calls).toHaveLength(1);
  });

  it('does not fire for an ordinary session, or for `fastGrowth.set`', async () => {
    const store = getStore();

    // (a) A plain session, created the way every other session is.
    const ordinary = store.createSession('', undefined, undefined).sessionId;
    const outcome = await startFastGrowthKickoff({ store, sessionId: ordinary });
    expect(outcome).toEqual({ started: false, reason: 'not-fast-growth' });

    // (b) Marking an EXISTING conversation. It may be mid-thread, and an opening
    // question dropped into it would interrupt rather than greet.
    const marked = freshId('mark-me');
    store.touchSession(marked, 'test-provider');
    const set = await runNabyAction({
      action: 'session.fastGrowth.set',
      sessionId: marked,
      fastGrowth: true,
    });
    expect(set.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 30));

    expect(h.calls).toHaveLength(0);
    expect(store.getSetting(kickoffKey(ordinary))).toBeUndefined();
    expect(store.getSetting(kickoffKey(marked))).toBeUndefined();
  });

  it('a session that vanished between create and kickoff is a no-op', async () => {
    const outcome = await startFastGrowthKickoff({
      store: getStore(),
      sessionId: 'no-such-session-at-all',
    });
    expect(outcome).toEqual({ started: false, reason: 'no-session' });
    expect(h.calls).toHaveLength(0);
  });
});

describe('a kickoff that fails leaves the session, and the user, intact', () => {
  it('a refused dispatch (no engine on this machine) does not fail creation', async () => {
    h.mode = 'refuse';
    const created = await runNabyAction({ action: 'session.fastGrowth.create', title: 'X' });
    // THE WHOLE POINT: a machine with nothing configured can still make a
    // fast-growth session. It is simply the empty one the previous build gave.
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.sessionId).toBeTruthy();
    expect(getStore().getSession(created.sessionId!)?.fastGrowth).toBe(true);

    await waitUntil(() => h.calls.length === 1);
    // Nothing was written into the transcript: preflight refuses before a run
    // starts, so not even the user row exists.
    expect(getStore().getMessages(created.sessionId!)).toHaveLength(0);
  });

  it('a dispatch that throws does not fail creation either', async () => {
    h.mode = 'throw';
    const created = await runNabyAction({ action: 'session.fastGrowth.create' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await waitUntil(() => h.calls.length === 1);
    // The route returned before the throw could have reached it, and the session
    // is there either way.
    expect(getStore().getSession(created.sessionId!)?.fastGrowth).toBe(true);
  });

  it('reports the throw to its caller rather than raising it', async () => {
    h.mode = 'throw';
    const store = getStore();
    const sessionId = freshId('throwing');
    store.touchSession(sessionId, 'test-provider');
    store.setSessionFastGrowth(sessionId, true);

    const outcome = await startFastGrowthKickoff({ store, sessionId });
    expect(outcome.started).toBe(false);
    if (outcome.started) return;
    expect(outcome.reason).toBe('threw');
    expect(outcome.error).toContain('exploded');
  });

  it('gives up waiting for a dispatch that never starts, without hanging', async () => {
    // The guard exists for a preflight that talks to the network and never comes
    // back: the response must not be pinned to it. The run, if it ever starts,
    // still streams into the tab — only the WAIT is bounded.
    const store = getStore();
    const sessionId = freshId('hanging');
    store.touchSession(sessionId, 'test-provider');
    store.setSessionFastGrowth(sessionId, true);

    const outcome = await kickoffFastGrowthSession(
      { store, dispatch: () => new Promise(() => {}), startTimeoutMs: 20 },
      { sessionId },
    );
    expect(outcome).toEqual({ started: false, reason: 'timeout' });
    // And it is still spent: a turn that may yet arrive must not be joined by a
    // second one.
    expect(store.getSetting(kickoffKey(sessionId))).toBeTruthy();
  });
});

/**
 * AND THE TAB SHOWS THAT IT IS COMING (§3.3c).
 *
 * THE SECOND REPORT, from the build that fixed the first one. naby now speaks
 * first — but the tab opens in the same instant the turn is being started, and
 * it wins that race: a dynamic import of the engine composition root and an
 * async preflight sit between the route's answer and `startRun`. The attach
 * found no run, was told the session was idle, and the user was back in front of
 * an empty conversation — this time while naby actually WAS working.
 *
 * So the kickoff reserves the session in the run registry before it does
 * anything else, and the attach reports that reservation. What must hold:
 *   1. the reservation is up before the route can answer (no race to lose),
 *   2. a turn that starts converts it — the run's own events take over,
 *   3. a turn that never starts drops it, and says so, so nothing waits forever.
 */
describe('the tab that opens onto the kickoff is told a turn is coming', () => {
  it('is never told "idle" the instant the button returns', async () => {
    const created = await runNabyAction({ action: 'session.fastGrowth.create' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sessionId = created.sessionId!;
    // The client opens the tab on THIS response. Whatever stage the headless turn
    // has reached by now — reserved, or already streaming — an attach must not be
    // told there is nothing to wait for. That answer is the empty conversation.
    expect(getAttachAnnouncement(sessionId).type).not.toBe('run-idle');
  });

  it('the run itself takes the reservation over, and the reservation ends with the turn', async () => {
    const created = await runNabyAction({ action: 'session.fastGrowth.create' });
    if (!created.ok) return;
    const sessionId = created.sessionId!;
    const store = getStore();
    await waitUntil(() =>
      store.getMessages(sessionId).some((m) => m.role === 'assistant' && m.content.includes(GREETING)),
    );
    // Converted, not left standing beside the run it described.
    expect(isRunPending(sessionId)).toBe(false);
    // And a tab that opens AFTER the turn finished (the race the reconcile has to
    // survive) is told about a finished run, so its indicator never goes up.
    await waitUntil(() => {
      const a = getAttachAnnouncement(sessionId);
      return a.type === 'run-snapshot' && a.status !== 'running';
    });
  });

  it('a kickoff that cannot start stops the waiting instead of leaving it on', async () => {
    // A machine with no engine configured: preflight refuses and no run is ever
    // created. The tab attached during the window, so the ONLY way its indicator
    // comes down is this signal.
    h.mode = 'refuse';
    const store = getStore();
    const sessionId = freshId('refused-kickoff');
    store.touchSession(sessionId, 'test-provider');
    store.setSessionFastGrowth(sessionId, true);

    const started = startFastGrowthKickoff({ store, sessionId });
    // SYNCHRONOUS: the reservation is made before the first await, which is why
    // the client — which is handed the session id and opens it immediately —
    // cannot arrive first.
    expect(isRunPending(sessionId)).toBe(true);
    expect(getAttachAnnouncement(sessionId)).toEqual({ type: 'run-pending' });

    const seen: Array<{ message: unknown }> = [];
    const off = addRunListener(sessionId, (ev) => seen.push(ev));

    const outcome = await started;
    expect(outcome.started).toBe(false);
    expect(isRunPending(sessionId)).toBe(false);
    expect(getAttachAnnouncement(sessionId)).toEqual({ type: 'run-idle' });
    // The same end-of-turn signal a real turn sends, so the tab needs no special
    // case to stop waiting.
    expect(seen.map((e) => (e.message as { type?: string }).type)).toEqual(['run-ended']);
    off();
  });

  it('a kickoff for a session that is not fast-growth leaves nothing behind', async () => {
    const store = getStore();
    const ordinary = store.createSession('', undefined, undefined).sessionId;
    await startFastGrowthKickoff({ store, sessionId: ordinary });
    expect(isRunPending(ordinary)).toBe(false);
    expect(getAttachAnnouncement(ordinary)).toEqual({ type: 'run-idle' });
    markRunIdle(ordinary, 'idle'); // no-op; guards against a stray registry entry
  });
});

describe('the words of the opening turn', () => {
  it('falls back to English when the client sent none', () => {
    // This server has no locale, which is why the client sends the sentence. A
    // request without one must not produce an empty prompt — that is a 400 and
    // no greeting at all.
    expect(normalizeKickoffText(undefined)).toBe(DEFAULT_KICKOFF_TEXT);
    expect(normalizeKickoffText('   ')).toBe(DEFAULT_KICKOFF_TEXT);
  });

  it('is trimmed and bounded — an opening bubble is a sentence, not an essay', () => {
    expect(normalizeKickoffText('  빠른 성장 세션을 시작합니다.  ')).toBe(
      '빠른 성장 세션을 시작합니다.',
    );
    expect(normalizeKickoffText('가'.repeat(500))).toHaveLength(KICKOFF_TEXT_MAX);
  });
});
