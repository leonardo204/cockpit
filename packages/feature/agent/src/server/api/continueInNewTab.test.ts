import { describe, it, expect, vi } from 'vitest';

/**
 * `session.continueInNewTab` — the ACTION's wiring (specs/session-context-management
 * §2.2).
 *
 * NO TEST IN THIS FILE MAY REACH A MODEL. The production summarizer picks the same
 * backends the engine does, so on a developer's laptop with a Claude sign-in an
 * unmocked action would make a REAL call from a test that is only asserting a row
 * was written. The mock is the barrier — and it also lets these cases drive the
 * two outcomes (a handoff, and a summary that failed) deterministically.
 *
 * The behaviour of the flow itself lives in `lib/sessionHandoff.test.ts`; this
 * covers that the action exists, reaches the SAME store the engine writes, and
 * answers with the fields the client navigates on.
 */
const summarizer = vi.hoisted(() => ({
  calls: 0,
  reply: 'AGREED: ship on Friday. OPEN: pricing.',
  fail: false,
}));

vi.mock('../lib/handoffSummary', () => ({
  modelHandoffSummarizer: () => async () => {
    summarizer.calls += 1;
    if (summarizer.fail) throw new Error('no engine configured in tests');
    return summarizer.reply;
  },
}));

import { runNabyAction } from './naby';
import { getStore } from '../engines/naby';
import { customTitleKey } from '../state/recentSessions';
import { handoffInstruction } from '../lib/sessionHandoff';

function seededSession(): string {
  const store = getStore();
  const { sessionId } = store.createSession('test-provider', 'Pricing work');
  store.appendMessage(sessionId, { role: 'user', content: '금요일에 출시하기로 했습니다' });
  store.appendMessage(sessionId, { role: 'assistant', content: '알겠습니다' });
  return sessionId;
}

describe('POST /api/naby — session.continueInNewTab', () => {
  it('mints a session carrying the handoff and answers with its id', async () => {
    summarizer.calls = 0;
    summarizer.fail = false;
    const store = getStore();
    const sourceId = seededSession();

    const result = await runNabyAction({
      action: 'session.continueInNewTab',
      sessionId: sourceId,
      cwd: '/tmp/naby-continue',
      title: '이어서 — Pricing work',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(summarizer.calls).toBe(1);
    expect(result.handoff).toBe(true);
    expect(result.title).toBe('이어서 — Pricing work');
    expect(typeof result.sessionId).toBe('string');
    const newId = result.sessionId!;
    expect(newId).not.toBe(sourceId);

    // The SAME store the engine reads at turn time, and the row the engine reads
    // it from (`SessionRef.handoff`).
    const ref = store.getSession(newId);
    expect(ref?.handoff).toBe('AGREED: ship on Friday. OPEN: pricing.');
    expect(ref?.cwd).toBe('/tmp/naby-continue');
    // The name lands where a rename would put it, so the tab and the Recent list
    // show the conversation the user just made.
    expect(store.getSetting(customTitleKey(newId))).toBe('이어서 — Pricing work');
    // And what the engine will inject is a labelled block carrying it.
    expect(handoffInstruction(ref?.handoff)).toContain('AGREED: ship on Friday');

    // The source conversation is untouched — no handoff, no extra messages.
    expect(store.getSession(sourceId)?.handoff).toBeUndefined();
    expect(store.getMessages(sourceId).length).toBe(2);
  });

  it('still creates the session when the summary fails — a failed handoff never blocks the tab', async () => {
    summarizer.calls = 0;
    summarizer.fail = true;
    const store = getStore();
    const sourceId = seededSession();

    const result = await runNabyAction({
      action: 'session.continueInNewTab',
      sessionId: sourceId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(summarizer.calls).toBe(1);
    expect(result.handoff).toBe(false);
    expect(typeof result.sessionId).toBe('string');
    const ref = store.getSession(result.sessionId!);
    expect(ref).toBeDefined();
    expect(ref?.handoff).toBeUndefined();
    // Nothing is injected, so the new tab starts as an ordinary session.
    expect(handoffInstruction(ref?.handoff)).toBeUndefined();
  });

  it('refuses without a session id, and for a session that does not exist', async () => {
    const missingId = await runNabyAction({ action: 'session.continueInNewTab' } as never);
    expect(missingId.ok).toBe(false);

    const noSuch = await runNabyAction({
      action: 'session.continueInNewTab',
      sessionId: 'no-such-session',
    });
    expect(noSuch.ok).toBe(false);
    if (noSuch.ok) return;
    expect(noSuch.error).toMatch(/not found/);
  });
});
