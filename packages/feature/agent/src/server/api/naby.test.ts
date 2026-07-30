import { describe, it, expect } from 'vitest';
import { runNabyAction } from './naby';
import { getStore } from '../engines/naby';
import { REFLECTION_IDLE_MS } from '../../../../../../../dist/naby-runtime.mjs';

/**
 * `reflection.run` — the on-demand entry point to the session-reflection sweep
 * (P3-M8a/M8b, spec §4.3). The sweep itself is covered in lib/reflection.test.ts
 * with an injected judge; this covers the WIRING: that the action exists, reaches
 * the same store the engine writes, and answers with the full set of counts —
 * both the ledger half and (M8b) the memory half.
 *
 * It runs against the throwaway database vitest.setup.ts points NABY_DB_PATH at,
 * never the developer's ~/.naby/app.db.
 */
describe('POST /api/naby — reflection.run', () => {
  it('answers with the sweep counts', async () => {
    const result = await runNabyAction({ action: 'reflection.run' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reflection).toBeDefined();
    expect(typeof result.reflection?.sweptSessions).toBe('number');
    expect(typeof result.reflection?.markedEvents).toBe('number');
    expect(typeof result.reflection?.droppedVerdicts).toBe('number');
    // P3-M8b: the memory half is reported too, and reads zero on a run with no
    // idle session to reflect on rather than being absent.
    expect(result.reflection?.proposedMemories).toBe(0);
    expect(result.reflection?.droppedCandidates).toBe(0);
    expect(result.reflection?.autoConfirmed).toBe(0);
  });

  it('runs against the same store the engine writes, and leaves a live session alone', async () => {
    const store = getStore();
    const sessionId = `reflection-action-${Date.now()}`;
    store.touchSession(sessionId, 'test-provider');
    store.appendMessage(sessionId, { role: 'user', content: 'hello' });
    store.appendMessage(sessionId, { role: 'assistant', content: 'hi' });
    expect(store.getReflectionCursor(sessionId)).toBeUndefined();

    const result = await runNabyAction({ action: 'reflection.run' });
    expect(result.ok).toBe(true);

    // The session was touched a moment ago, so it is not yet idle: the due-ness
    // rule (§4.2) holds at the API boundary too, and no cursor was written. This
    // also means no model call was made — the action is safe with no credentials.
    expect(store.getReflectionCursor(sessionId)).toBeUndefined();

    // The cursor round-trips through the same store the action reads.
    const at = Date.now() - REFLECTION_IDLE_MS;
    store.setReflectionCursor(sessionId, 1, at);
    expect(store.getReflectionCursor(sessionId)).toEqual({ lastSeq: 1, reflectedAt: at });
  });

  it('an unexcluded live session id is accepted as a parameter', async () => {
    const result = await runNabyAction({ action: 'reflection.run', excludeSessionId: 'no-such-session' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reflection?.sweptSessions).toBeGreaterThanOrEqual(0);
  });
});
