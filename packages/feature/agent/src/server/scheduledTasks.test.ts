// A scheduled task runs on the NABY engine, or it does not run.
// (harness-standalone §2.4 — violations V4/V5.)
//
// WHY THIS IS WORTH A TEST. A scheduled task is the least supervised turn in the
// product: it fires on a timer, into a session nobody is looking at. Until now
// its backend was chosen by a STRING PERSISTED ON DISK (`task.engine`, written by
// an engine picker that no longer exists), and that string could still select a
// vendor cockpit engine — claude / claude2 / codex / kimi / deepseek / ollama —
// which inherits the vendor's MCP config and settings and writes the vendor's
// transcripts. The least watched turn took the least owned path.
//
// Two properties, and they are opposites on purpose:
//   * a task with no engine, or with a LEGACY value from the old picker, runs —
//     on naby. Refusing those would silently break every task already on disk.
//   * a task naming any OTHER engine is REFUSED, not quietly upgraded. The user
//     asked for a specific backend; answering with a different one without
//     saying so is how a scheduled prompt ends up somewhere nobody expects.
//
// The dispatch seam is mocked because the assertion is about ROUTING, not about
// running a model: what matters is whether `dispatchChat` was called at all, and
// with which spec.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Effect } from 'effect';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dispatchChat = vi.fn();
const getSession = vi.fn();

vi.mock('./engines/orchestrator', () => ({
  dispatchChat: (...args: unknown[]) => dispatchChat(...args),
}));

vi.mock('./engines/naby', () => ({
  // The spec identity is what the test asserts on — nothing here runs.
  nabySpec: { name: 'naby', runner: { run: async () => {} } },
  getStore: () => ({ getSession: (id: string) => getSession(id) }),
}));

vi.mock('./sessionRunHub', () => ({
  isRunActive: () => false,
  getRunSnapshot: () => ({ status: 'idle' }),
  getRunSessionId: () => undefined,
  requestStop: () => {},
}));

vi.mock('./state/globalState', () => ({
  updateGlobalState: async () => {},
  getSessionTitle: async () => undefined,
}));

// A REBIND WRITES THE TASK FILE, so this suite gets a data dir of its own before
// anything resolves one. `COCKPIT_HOME` is the documented switch (paths.ts), and
// it is set here — ahead of the dynamic import below — because the paths module
// reads it once, at load.
process.env.COCKPIT_HOME = mkdtempSync(join(tmpdir(), 'cockpit-tasks-'));

const { sendChatMessageEff, scheduledTaskManager } = await import('./scheduledTasks');

type Task = Parameters<typeof sendChatMessageEff>[0];

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    cwd: '/proj',
    tabId: 'tab1',
    sessionId: 'sess-1',
    message: 'run the daily check',
    type: 'once',
    nextFireTime: 0,
    paused: false,
    createdAt: 0,
    ...overrides,
  } as Task;
}

const run = (t: Task) => Effect.runPromise(sendChatMessageEff(t));

beforeEach(() => {
  dispatchChat.mockReset();
  dispatchChat.mockResolvedValue({ ok: true, runKey: 'sess-1', sessionId: 'sess-1' });
  getSession.mockReset();
  // The resume target exists in the store — naby sessions live in `app.db`, not
  // in a provider's jsonl tree.
  getSession.mockReturnValue({ id: 'sess-1' });
});

describe('scheduled tasks are pinned to the naby engine', () => {
  it('a task with NO engine field runs, on naby', async () => {
    expect(await run(task())).toBe(true);
    expect(dispatchChat).toHaveBeenCalledTimes(1);
    const [spec, params] = dispatchChat.mock.calls[0];
    expect(spec.name).toBe('naby');
    expect(params.engine).toBe('naby');
    expect(params.prompt).toBe('run the daily check');
  });

  it("a legacy 'claude' / 'claude2' task still runs — on naby, not on the vendor spec", async () => {
    for (const legacy of ['claude', 'claude2']) {
      dispatchChat.mockClear();
      expect(await run(task({ engine: legacy }))).toBe(true);
      expect(dispatchChat.mock.calls[0][0].name).toBe('naby');
    }
  });

  it('a task naming an explicit naby engine runs', async () => {
    expect(await run(task({ engine: 'naby' }))).toBe(true);
    expect(dispatchChat.mock.calls[0][0].name).toBe('naby');
  });

  it.each(['codex', 'kimi', 'deepseek', 'ollama'])(
    "a task asking for '%s' is REFUSED and never dispatched",
    async (engine) => {
      expect(await run(task({ engine }))).toBe(false);
      // Not "dispatched to naby instead" — not dispatched AT ALL.
      expect(dispatchChat).not.toHaveBeenCalled();
    },
  );

  it('an unknown engine string is refused too (deny by default)', async () => {
    expect(await run(task({ engine: 'some-future-thing' }))).toBe(false);
    expect(dispatchChat).not.toHaveBeenCalled();
  });

  it('resumes the session from the STORE, and starts fresh only when it is gone', async () => {
    // Present: the run resumes it.
    await run(task());
    expect(getSession).toHaveBeenCalledWith('sess-1');
    expect(dispatchChat.mock.calls[0][1].sessionId).toBe('sess-1');

    // Absent: the run starts a fresh session instead of failing. (The old check
    // stat'd `~/.claude/projects/.../<id>.jsonl` — a file a naby session never
    // has, so EVERY scheduled run took this branch and silently abandoned the
    // thread it was meant to continue.)
    dispatchChat.mockClear();
    getSession.mockReturnValue(undefined);
    await run(task());
    expect(dispatchChat.mock.calls[0][1].sessionId).toBeUndefined();
  });

  it('a store read that throws resumes anyway (never abandons a live thread)', async () => {
    getSession.mockImplementation(() => {
      throw new Error('db locked');
    });
    await run(task());
    expect(dispatchChat.mock.calls[0][1].sessionId).toBe('sess-1');
  });
});

/**
 * REBINDING A CONTINUED SESSION (session-context-management §2.2).
 *
 * "Continue in a new tab" retires a session in everything but name. A task still
 * naming the old id would keep firing unattended turns into a conversation nobody
 * reads — the same wrong-place failure the `startFresh` rebind fixes for a session
 * that is GONE, applied to one that has been superseded.
 *
 * Every task here is created PAUSED on purpose: an unpaused one arms a real timer
 * in the test process, and the rebind is supposed to work regardless of state.
 */
describe('rebinding the session a task is bound to', () => {
  it('moves exactly the tasks bound to the old session, and persists them', async () => {
    await scheduledTaskManager.addTask(
      task({ id: 'r1', sessionId: 'old-sess', paused: true }),
    );
    await scheduledTaskManager.addTask(
      task({ id: 'r2', sessionId: 'old-sess', paused: true }),
    );
    await scheduledTaskManager.addTask(
      task({ id: 'r3', sessionId: 'other-sess', paused: true }),
    );

    expect(await scheduledTaskManager.rebindSession('old-sess', 'new-sess')).toBe(2);

    // Read back from DISK (getTasks always does) — the file is the shared truth
    // between the two module instances, so a rebind only in memory is no rebind.
    const after = await scheduledTaskManager.getTasks();
    const byId = Object.fromEntries(after.map((t) => [t.id, t.sessionId]));
    expect(byId.r1).toBe('new-sess');
    expect(byId.r2).toBe('new-sess');
    // A task on another conversation is not swept up by someone else's continue.
    expect(byId.r3).toBe('other-sess');
  });

  it('does nothing when no task names the old session, or when the ids are the same', async () => {
    expect(await scheduledTaskManager.rebindSession('nobodys-session', 'new-sess')).toBe(0);
    expect(await scheduledTaskManager.rebindSession('new-sess', 'new-sess')).toBe(0);
    expect(await scheduledTaskManager.rebindSession('', 'new-sess')).toBe(0);
  });
});
