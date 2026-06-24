import { describe, it, expect } from 'vitest';
import { dispatchChat } from './orchestrator';
import { isRunActive, getRunSnapshot, getRunSessionId, requestStop } from '../sessionRunHub';
import type { EngineSpec, RunCtx, RunEvent } from './types';

// ── Contract suite for the shared run-lifecycle skeleton (orchestrator) ──
// Uses fake engine runners (no real SDK/spawn). cwd is omitted so globalState never touches
// disk (orchestrator gates 'loading'/'unread' on cwd). Each test uses a unique runId so the
// in-memory sessionRunHub registry never collides across tests.

let n = 0;
const freshRunId = () => `test-run-${Date.now()}-${n++}`;

function spec(run: (ctx: RunCtx) => Promise<void>): EngineSpec {
  return { name: 'fake', runner: { run } };
}

/** Runner that blocks until the run is aborted (simulates a long in-flight turn). */
const blockingRun = (ctx: RunCtx) =>
  new Promise<void>((resolve) => {
    if (ctx.signal.aborted) return resolve();
    ctx.signal.addEventListener('abort', () => resolve(), { once: true });
  });

async function waitUntil(pred: () => boolean, ms = 1000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('waitUntil timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('orchestrator dispatch contract', () => {
  it('rejects empty content with 400 and starts no run', async () => {
    const out = await dispatchChat(spec(async () => {}), {});
    expect(out).toEqual({ ok: false, status: 400, error: 'Missing prompt or images' });
  });

  it('success: returns runKey, run is active then idle, events recorded', async () => {
    const runId = freshRunId();
    const events: RunEvent[] = [{ type: 'assistant', text: 'hi' }, { type: 'result' }];
    const out = await dispatchChat(
      spec(async (ctx) => {
        for (const e of events) ctx.emit(e);
      }),
      { prompt: 'hello', runId },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.runKey).toBe(runId);
    await waitUntil(() => !isRunActive(out.runKey));
    const snap = getRunSnapshot(out.runKey);
    expect(snap?.status).toBe('idle');
    // synthetic _human user event + the two engine events
    const types = (snap?.events ?? []).map((e) => (e as RunEvent).type);
    expect(types).toContain('assistant');
    expect(types).toContain('result');
  });

  it('#5 idempotency: duplicate active runId → 409', async () => {
    const runId = freshRunId();
    const first = await dispatchChat(spec(blockingRun), { prompt: 'x', runId });
    expect(first.ok).toBe(true);
    const second = await dispatchChat(spec(blockingRun), { prompt: 'x', runId });
    expect(second).toEqual({ ok: false, status: 409, error: 'run already active' });
    if (first.ok) requestStop(first.runKey); // cleanup
  });

  it('#10 guard: duplicate active sessionId → 409', async () => {
    const sessionId = `sess-${Date.now()}-${n++}`;
    const first = await dispatchChat(spec(blockingRun), { prompt: 'x', sessionId });
    expect(first.ok).toBe(true);
    const second = await dispatchChat(spec(blockingRun), { prompt: 'x', sessionId });
    expect(second).toEqual({ ok: false, status: 409, error: 'session is already running' });
    if (first.ok) requestStop(first.runKey);
  });

  it('failure: runner throws → terminal status error + error event appended', async () => {
    const runId = freshRunId();
    const out = await dispatchChat(
      spec(async () => {
        throw new Error('boom');
      }),
      { prompt: 'x', runId },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    await waitUntil(() => !isRunActive(out.runKey));
    const snap = getRunSnapshot(out.runKey);
    expect(snap?.status).toBe('error');
    expect((snap?.events ?? []).some((e) => (e as RunEvent).type === 'error')).toBe(true);
  });

  it('rekey: new session → getRunSessionId returns the real id after completion', async () => {
    const runId = freshRunId();
    const realId = `real-${Date.now()}-${n++}`;
    const out = await dispatchChat(
      spec(async (ctx) => {
        ctx.rekey(realId);
        ctx.emit({ type: 'result' });
      }),
      { prompt: 'x', runId },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    await waitUntil(() => !isRunActive(realId) && !isRunActive(runId));
    expect(getRunSessionId(realId)).toBe(realId);
  });

  it('rekey same-value (engine uses runId AS its session id, e.g. ollama): getRunSessionId still resolves it', async () => {
    // Regression for the ollama scheduled-task degradation: rekey(currentKey) where the real id
    // equals the runId must still record r.sessionId, else getRunSessionId returns null and the
    // scheduler never rebinds → every round starts fresh.
    const runId = freshRunId();
    const out = await dispatchChat(
      spec(async (ctx) => {
        ctx.rekey(ctx.currentKey()); // realId === runId
        ctx.emit({ type: 'result' });
      }),
      { prompt: 'x', runId },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    await waitUntil(() => !isRunActive(out.runKey));
    expect(getRunSessionId(out.runKey)).toBe(runId);
  });

  it('stop: requestStop aborts the runner → terminal idle', async () => {
    const runId = freshRunId();
    const out = await dispatchChat(spec(blockingRun), { prompt: 'x', runId });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(isRunActive(out.runKey)).toBe(true);
    requestStop(out.runKey);
    await waitUntil(() => !isRunActive(out.runKey));
    expect(getRunSnapshot(out.runKey)?.status).toBe('idle');
  });
});
