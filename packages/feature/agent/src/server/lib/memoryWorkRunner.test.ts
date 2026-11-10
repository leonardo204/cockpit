import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  DEFAULT_USER_ID,
  MEMORY_BACKOFF_BASE_MS,
  MemoryStore,
  SqliteStore,
  type MemoryItem,
  type MemoryJobModel,
  type MemoryWriteRequest,
} from '../../../../../../../dist/naby-runtime.mjs';
import { MemoryWorkRunner, MEMORY_WORK_CALLS_KEY } from './memoryWorkRunner';
import type { MemoryJobExecutor, MemoryModelPort, MemoryWorkStore } from './memoryJobs';

/**
 * THE MEMORY QUEUE, RUNNING (specs/memory-worker.md R2, R5, R8, §2).
 *
 * The runner the memory process (and the in-process fallback) runs, driven with
 * a fake model port: no model is called anywhere. What is pinned:
 *
 *   * one job at a time AND one model call at a time, however many are owed (R2);
 *   * a 429 backs the job off 1 → 2 minutes and holds every other call (R5);
 *   * a fresh runner queues what the database says is owed (R8);
 *   * the status carries counts and codes, never a memory's text (§2).
 */

// Loaded the way the runtime loads it (sqlite-store.ts): a static `node:sqlite`
// import is not something every bundler in this tree resolves.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
};

const MODEL: MemoryJobModel = { engineId: 'dev-claude', providerId: 'dev-claude', model: 'sonnet' };

function freshStore(): MemoryWorkStore {
  return new MemoryStore() as unknown as MemoryWorkStore;
}

function write(store: MemoryWorkStore, over: Partial<MemoryWriteRequest> & { key: string; value: string }): MemoryItem {
  return store.putMemory({
    scope: 'user',
    scopeKey: DEFAULT_USER_ID,
    type: 'semantic',
    provenance: { source: 'user', sessionId: 's-1', evidenceQuote: 'q', basisKind: 'stated' },
    confidence: 0.5,
    requestedStatus: 'confirmed',
    ...over,
  } as MemoryWriteRequest);
}

/** A port that records concurrency and answers after `delayMs`. */
function slowPort(delayMs: number, answer = '{"reviews":[]}') {
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const port: MemoryModelPort = {
    async call() {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, delayMs));
      inFlight -= 1;
      return { text: answer, label: 'fake (sonnet)' };
    },
  };
  return { port, stats: () => ({ calls, maxInFlight }) };
}

const runners: MemoryWorkRunner[] = [];
afterEach(() => {
  for (const r of runners.splice(0)) r.dispose();
});

function runner(opts: ConstructorParameters<typeof MemoryWorkRunner>[0]): MemoryWorkRunner {
  const r = new MemoryWorkRunner(opts);
  runners.push(r);
  return r;
}

describe('R2 — one job, one model call at a time', () => {
  it('never overlaps two calls, even when several kinds are owed', async () => {
    const store = freshStore();
    const { port, stats } = slowPort(20);
    // Every kind makes two calls through the port it is handed.
    const twoCalls: MemoryJobExecutor = async ({ port: p }) => {
      await Promise.all([
        p.call({ kind: 'session', model: MODEL }, { system: 's', user: 'u' }, 1000),
        p.call({ kind: 'session', model: MODEL }, { system: 's', user: 'u' }, 1000),
      ]);
      return { counts: { done: 1 } };
    };
    const r = runner({
      store,
      port,
      mode: 'worker',
      executors: { review: twoCalls, tidy: twoCalls, summary: twoCalls, reflection: twoCalls },
    });
    r.turnStarted({ sessionId: 'a', model: MODEL });
    r.turnEnded({ sessionId: 'a', model: MODEL, autoApply: true });
    r.enqueue({ kind: 'tidy', reason: 'turn', enqueuedAt: Date.now(), attempts: 0, notBefore: 0 });
    await r.idle();
    expect(stats().calls).toBe(6);
    expect(stats().maxInFlight).toBe(1);
  });

  it('coalesces repeated kicks of one kind into one waiting job', async () => {
    const store = freshStore();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let reviews = 0;
    const r = runner({
      store,
      port: slowPort(0).port,
      mode: 'worker',
      executors: {
        reflection: async () => {
          await gate;
          return { counts: {} };
        },
        review: async () => {
          reviews += 1;
          return { counts: {} };
        },
      },
    });
    r.turnStarted({ sessionId: 'a', model: MODEL });
    await new Promise((res) => setImmediate(res));
    // The sweep is running; three quick turns end behind it.
    for (const id of ['a', 'b', 'c']) r.turnEnded({ sessionId: id, model: MODEL, autoApply: true });
    expect(r.queuedKinds()).toEqual(['review']);
    release();
    await r.idle();
    expect(reviews).toBe(1);
  });

  it('a turn notice returns before any work starts (it is a message, not a call)', () => {
    const store = freshStore();
    let started = false;
    const r = runner({
      store,
      port: slowPort(0).port,
      mode: 'worker',
      executors: {
        reflection: async () => {
          started = true;
          return { counts: {} };
        },
      },
    });
    r.turnStarted({ sessionId: 'a', model: MODEL });
    // Synchronously after the notice: queued, not started.
    expect(started).toBe(false);
    expect(r.status().queued).toEqual({ reflection: 1 });
  });
});

describe('R5 — a rate limit backs off, and holds every call', () => {
  it('defers the job 1 min, then 2 min, holding other kinds; a success clears it', async () => {
    let now = 1_000_000;
    const store = freshStore();
    let attempts = 0;
    let tidyCalls = 0;
    let fail = true;
    const port: MemoryModelPort = {
      async call(target) {
        if (target.kind === 'session' && fail) {
          attempts += 1;
          throw Object.assign(new Error('429 Too Many Requests: rate_limit_error'), { status: 429 });
        }
        return { text: '{}', label: 'fake' };
      },
    };
    const callOnce: MemoryJobExecutor = async ({ port: p }) => {
      try {
        await p.call({ kind: 'session', model: MODEL }, { system: 's', user: 'u' }, 1000);
      } catch {
        // The review swallows its own failures (R42) — the port must still see it.
      }
      return { counts: {} };
    };
    const r = runner({
      store,
      port,
      mode: 'worker',
      now: () => now,
      executors: {
        review: callOnce,
        tidy: async ({ port: p }) => {
          tidyCalls += 1;
          await p.call({ kind: 'session', model: MODEL }, { system: 's', user: 'u' }, 1000);
          return { counts: {} };
        },
      },
    });
    r.turnEnded({ sessionId: 'a', model: MODEL, autoApply: true });
    await r.idle();
    expect(attempts).toBe(1);
    let s = r.status();
    expect(s.lastFailure).toMatchObject({ kind: 'review', reason: 'rate-limited', retryAt: now + MEMORY_BACKOFF_BASE_MS });
    expect(s.state).toBe('waiting');
    expect(s.waitingFor).toBe('backoff');

    // Another kind queued inside the window does not call.
    r.enqueue({ kind: 'tidy', model: MODEL, reason: 'turn', enqueuedAt: now, attempts: 0, notBefore: 0 });
    await r.idle();
    expect(tidyCalls).toBe(0);

    // Past the window: retried, limited again → two minutes this time.
    now += MEMORY_BACKOFF_BASE_MS + 1;
    r.poke();
    await new Promise((res) => setTimeout(res, 10));
    await r.idle();
    expect(attempts).toBe(2);
    s = r.status();
    expect(s.lastFailure?.retryAt).toBe(now + 2 * MEMORY_BACKOFF_BASE_MS);

    // The limit lifts: the review and the held tidy both run.
    fail = false;
    now += 2 * MEMORY_BACKOFF_BASE_MS + 1;
    r.poke();
    await new Promise((res) => setTimeout(res, 10));
    await r.idle();
    expect(tidyCalls).toBe(1);
    expect(r.status().state).toBe('idle');
    expect(r.status().lastDone).toBeDefined();
  });
});

describe('R8 — a fresh runner re-seeds from the database', () => {
  it('queues the review, summary and tidy the store says are owed', () => {
    const store = freshStore();
    write(store, { key: 'pending-1', value: 'Pending fact.', requestedStatus: 'proposed', reviewState: 'pending' });
    write(store, { key: 'long-1', value: 'line one\nline two\nline three\nline four\n' + 'x'.repeat(400) });
    const r = runner({ store, port: slowPort(0).port, mode: 'worker' });
    r.reseed();
    // memory-tiers: the promotion and retention passes run at every start too.
    expect(new Set(r.queuedKinds())).toEqual(new Set(['review', 'summary', 'tidy', 'promote', 'archive']));
    const s = r.status();
    expect(s.backlog?.pendingReview).toBe(1);
    // No turn has named a model since start: the jobs wait for one (R38).
    expect(s.waitingFor).toBe('turn-model');
  });

  it('re-seeded jobs run on the next turn\'s model', async () => {
    const store = freshStore();
    write(store, { key: 'pending-2', value: 'Pending fact.', requestedStatus: 'proposed', reviewState: 'pending' });
    const seen: (MemoryJobModel | undefined)[] = [];
    const r = runner({
      store,
      port: slowPort(0).port,
      mode: 'worker',
      executors: {
        review: async ({ reviewer }) => {
          seen.push(reviewer ? MODEL : undefined);
          return { counts: {} };
        },
        tidy: async () => ({ counts: {} }),
        summary: async () => ({ counts: {} }),
        reflection: async () => ({ counts: {} }),
      },
    });
    r.reseed();
    await r.idle();
    expect(seen).toEqual([]);
    r.turnModel({ sessionId: 'later', model: MODEL });
    await new Promise((res) => setImmediate(res));
    await r.idle();
    expect(seen).toEqual([MODEL]);
  });
});

describe('§2 — the status is counts and codes', () => {
  it('names the job, its size, the model and today\'s calls — never a value', async () => {
    const store = freshStore();
    const secret = 'My bank PIN is 4321.';
    write(store, { key: 'pin', value: secret, requestedStatus: 'proposed', reviewState: 'pending' });
    const statuses: string[] = [];
    const r = runner({
      store,
      port: slowPort(5, JSON.stringify({ reviews: [] })).port,
      mode: 'worker',
      onStatus: (s) => statuses.push(JSON.stringify(s)),
    });
    r.turnEnded({ sessionId: 's-1', model: MODEL, autoApply: true });
    await r.idle();
    const working = statuses.map((s) => JSON.parse(s)).find((s) => s.current?.kind === 'review');
    expect(working?.current.size).toBe(1);
    const done = r.status();
    expect(done.model).toBe('fake (sonnet)');
    expect(done.callsToday).toBeGreaterThan(0);
    expect(store.getSetting(MEMORY_WORK_CALLS_KEY)).toContain('"count"');
    for (const s of statuses) expect(s).not.toContain('4321');
  });
});

describe('R3 — two processes write the same file without SQLITE_BUSY', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** Run a writer in ANOTHER process — the memory process's situation — while
   *  this one holds the write lock. Resolves with what the child printed. */
  function childWrite(path: string, opts: { viaStore: boolean }): Promise<string> {
    const runtime = pathToFileURL(join(__dirname, '../../../../../../../dist/naby-runtime.mjs')).href;
    const code = opts.viaStore
      ? `import { SqliteStore } from ${JSON.stringify(runtime)};
         const s = new SqliteStore({ path: ${JSON.stringify(path)} });
         try { s.setSetting('from.child', 'yes'); console.log('ok'); } catch (e) { console.log('ERR ' + e.message); }`
      : `import { DatabaseSync } from 'node:sqlite';
         const db = new DatabaseSync(${JSON.stringify(path)});
         try { db.exec("INSERT INTO settings(key, value) VALUES('raw.child', 'yes')"); console.log('ok'); } catch (e) { console.log('ERR ' + e.message); }`;
    return new Promise((resolve, reject) => {
      execFile(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      });
    });
  }

  it('a store write waits out another process\'s lock (and a bare connection would not)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'naby-busy-'));
    const path = join(dir, 'app.db');
    const app = new SqliteStore({ path });
    app.setSetting('seed', '1');
    // Hold the write lock from a second handle in THIS process for 700 ms — the
    // shape of a user turn's write the memory process can collide with.
    const lock = new DatabaseSync(path);
    lock.exec('PRAGMA busy_timeout = 5000');
    lock.exec('BEGIN IMMEDIATE');
    lock.exec("INSERT INTO settings(key, value) VALUES('held', '1')");
    const release = setTimeout(() => lock.exec('COMMIT'), 700);
    try {
      const [viaStore, bare] = await Promise.all([childWrite(path, { viaStore: true }), childWrite(path, { viaStore: false })]);
      // The store sets busy_timeout on open: it waited and landed.
      expect(viaStore).toBe('ok');
      // The control: without it the same write fails at once — the test can tell.
      expect(bare).toMatch(/ERR .*(locked|busy)/i);
    } finally {
      clearTimeout(release);
      try {
        lock.exec('COMMIT');
      } catch {
        /* already committed */
      }
      lock.close();
    }
    expect(app.getSetting('from.child')).toBe('yes');
    app.close();
  });
});

describe('§2 — /api/memory work.status', () => {
  it('answers the status from the supervisor, and refuses a store that cannot run the work', async () => {
    const { runMemoryAction } = await import('../api/memory');
    const res = runMemoryAction({ action: 'work.status' }, freshStore() as never);
    // NABY_MEMORY_WORKER=off in the test setup: the work runs in this process.
    expect(res).toMatchObject({ ok: true, work: { mode: 'in-process', queued: {} } });
    expect(runMemoryAction({ action: 'work.status' }, { getSetting: () => undefined } as never)).toMatchObject({ ok: false });
  });
});

describe('§2 — "모델을 부를 수 없음" is told apart from a failed job', () => {
  it('a review whose backend cannot be reached reports no-model, and the row waits', async () => {
    const { MemoryModelUnavailableError } = await import('./memoryJobs');
    const store = freshStore();
    const row = write(store, { key: 'p', value: 'Pending.', requestedStatus: 'proposed', reviewState: 'pending' });
    const r = runner({
      store,
      port: {
        async call() {
          throw new MemoryModelUnavailableError();
        },
      },
      mode: 'worker',
    });
    r.turnEnded({ sessionId: 's-1', model: MODEL, autoApply: true });
    await r.idle();
    expect(r.status().lastFailure).toMatchObject({ kind: 'review', reason: 'no-model' });
    expect(store.getMemoryById(row.id)?.reviewState).toBe('pending');
  });
});
