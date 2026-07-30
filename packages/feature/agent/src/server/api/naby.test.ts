import { describe, it, expect } from 'vitest';
import { runNabyAction } from './naby';
import { getStore } from '../engines/naby';
import {
  BUILTIN_PERSONA_ID,
  DEFAULT_USER_ID,
  REFLECTION_IDLE_MS,
} from '../../../../../../../dist/naby-runtime.mjs';

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

/**
 * `growth.get` — the trust reading, plus (P3-M8c, spec §6.3) the LEARNING block
 * beside it. The computation is covered in lib/learningRead.test.ts; this covers
 * the wiring and the ONE structural promise the panel depends on: the two are
 * separate fields, so no learning count can reach the butterfly reading.
 */
describe('POST /api/naby — growth.get and the learning block', () => {
  it('answers with the growth reading and a learning block beside it', async () => {
    const result = await runNabyAction({ action: 'growth.get' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.growth).toBeDefined();
    expect(result.learning).toBeDefined();
    expect(typeof result.learning?.confirmedTotal).toBe('number');
    expect(typeof result.learning?.proposedCount).toBe('number');
    expect(typeof result.learning?.corroborated2Plus).toBe('number');
    expect(typeof result.learning?.distinctTaskTypes).toBe('number');
    expect(typeof result.learning?.confirmedByScope.user).toBe('number');
  });

  it('keeps the learning counts OUT of the growth reading (§6.3)', async () => {
    // The separation is the load-bearing part. butterfly-trust-meter §2 decided
    // that counting stored facts is not a trust signal, and §9.2 rule 2 says two
    // numbers on one screen must never disagree; the only durable way to keep
    // that true is for the meter's shape not to contain these fields at all.
    const result = await runNabyAction({ action: 'growth.get' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const growth = result.growth as unknown as Record<string, unknown>;
    for (const key of ['confirmedTotal', 'proposedCount', 'corroborated2Plus', 'learning']) {
      expect(growth, `growth must not carry ${key}`).not.toHaveProperty(key);
    }
  });

  it('counts real confirmed memory, and moves when a proposal is confirmed', async () => {
    const store = getStore();
    const key = `panel-fact-${Date.now()}`;
    const before = await runNabyAction({ action: 'growth.get' });
    if (!before.ok) throw new Error('growth.get failed');
    const confirmedBefore = before.learning!.confirmedTotal;
    const proposedBefore = before.learning!.proposedCount;

    const row = store.putMemory({
      scope: 'user',
      scopeKey: DEFAULT_USER_ID,
      type: 'semantic',
      key,
      value: 'Wants the SQL before the explanation.',
      provenance: { source: 'artifact', sessionId: 'sess-panel' },
      confidence: 0.5,
      requestedStatus: 'proposed',
    });

    const proposed = await runNabyAction({ action: 'growth.get' });
    if (!proposed.ok) throw new Error('growth.get failed');
    // A PROPOSAL IS NOT A FACT IN USE: it cannot shape a turn until confirmed,
    // so it must move the review count and not the confirmed one.
    expect(proposed.learning!.proposedCount).toBe(proposedBefore + 1);
    expect(proposed.learning!.confirmedTotal).toBe(confirmedBefore);

    store.confirmMemory(row.id);
    const after = await runNabyAction({ action: 'growth.get' });
    if (!after.ok) throw new Error('growth.get failed');
    expect(after.learning!.confirmedTotal).toBe(confirmedBefore + 1);
    expect(after.learning!.proposedCount).toBe(proposedBefore);
  });

  it('counts project-scope memory only when a cwd is supplied', async () => {
    const store = getStore();
    const cwd = `/tmp/naby-panel-${Date.now()}`;
    store.putMemory({
      scope: 'project',
      scopeKey: cwd,
      type: 'procedural',
      key: 'build-command',
      value: 'Builds with npm run build:app before packaging.',
      provenance: { source: 'user' },
      confidence: 1,
      requestedStatus: 'confirmed',
    });

    const without = await runNabyAction({ action: 'growth.get' });
    if (!without.ok) throw new Error('growth.get failed');
    // Absent, not zero: with no project open there is no project to report on.
    expect(without.learning!.confirmedByScope.project).toBeUndefined();

    const withCwd = await runNabyAction({ action: 'growth.get', cwd });
    if (!withCwd.ok) throw new Error('growth.get failed');
    expect(withCwd.learning!.confirmedByScope.project).toBe(1);
    expect(withCwd.learning!.confirmedTotal).toBe(without.learning!.confirmedTotal + 1);
  });

  it('reports the last reflection time from the cursors', async () => {
    const store = getStore();
    const sessionId = `growth-reflected-${Date.now()}`;
    store.touchSession(sessionId, 'test-provider');
    const at = Date.now();
    store.setReflectionCursor(sessionId, 3, at);

    const result = await runNabyAction({ action: 'growth.get', agentId: BUILTIN_PERSONA_ID });
    if (!result.ok) throw new Error('growth.get failed');
    expect(result.learning!.lastReflectionAt).toBeGreaterThanOrEqual(at);
  });
});
