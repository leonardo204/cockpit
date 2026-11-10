import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore, type MemoryJobModel } from '../../../../../../../dist/naby-runtime.mjs';
import {
  MemoryWorkSupervisor,
  memoryWorkerScriptCandidates,
  type MemoryWorkerChild,
} from './memoryWorker';
import type { MemoryWorkStore } from './memoryJobs';
import type { FromMemoryWorker, ToMemoryWorker } from './memoryWorkerProtocol';

/**
 * THE MEMORY PROCESS'S SUPERVISOR (specs/memory-worker.md R1, R8), against a
 * fake child process. The real fork, the real worker entry and the real kill are
 * exercised by `npm run spike:memory-worker`; this pins the decisions:
 *
 *   * notices posted before the child is ready are delivered once it is;
 *   * a child that dies is restarted, and the restarted one is told the latest
 *     turn's model so its re-seeded queue can run (R8, R38);
 *   * a child that cannot start puts the work in-process — memory never silently
 *     stops;
 *   * a `call` from the child is answered on the app side.
 */

class FakeChild extends EventEmitter implements MemoryWorkerChild {
  static nextPid = 1000;
  readonly pid = FakeChild.nextPid++;
  readonly sent: ToMemoryWorker[] = [];
  killed = false;
  send(message: ToMemoryWorker): boolean {
    this.sent.push(message);
    return true;
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
  ready(): void {
    this.emit('message', { type: 'ready', pid: this.pid } satisfies FromMemoryWorker);
  }
  die(code = 1): void {
    this.emit('exit', code, null);
  }
}

const MODEL: MemoryJobModel = { engineId: 'dev-claude', providerId: 'dev-claude', model: 'sonnet' };
const store = () => new MemoryStore() as unknown as MemoryWorkStore;

const supervisors: MemoryWorkSupervisor[] = [];
// vitest.setup.ts keeps memory work in-process for every other suite; these tests
// ARE about the process, and fake it, so the switch is lifted here.
let savedMode: string | undefined;
beforeEach(() => {
  savedMode = process.env.NABY_MEMORY_WORKER;
  delete process.env.NABY_MEMORY_WORKER;
});
afterEach(() => {
  for (const s of supervisors.splice(0)) s.shutdown();
  vi.useRealTimers();
  if (savedMode === undefined) delete process.env.NABY_MEMORY_WORKER;
  else process.env.NABY_MEMORY_WORKER = savedMode;
});

function supervise(opts: ConstructorParameters<typeof MemoryWorkSupervisor>[0]) {
  const s = new MemoryWorkSupervisor({ log: () => undefined, ...opts });
  supervisors.push(s);
  return s;
}

describe('R1 — notices reach the memory process', () => {
  it('buffers until ready, then delivers in order after the hello', () => {
    const children: FakeChild[] = [];
    const s = supervise({ script: '/fake/memoryWorker.mjs', spawn: () => (children.push(new FakeChild()), children.at(-1)!) });
    const st = store();
    s.turnStarted({ sessionId: 'a', model: MODEL, store: st });
    s.turnEnded({ sessionId: 'a', model: MODEL, store: st, autoApply: true });
    expect(children).toHaveLength(1);
    expect(children[0]!.sent).toEqual([]);
    children[0]!.ready();
    expect(children[0]!.sent.map((m) => m.type)).toEqual(['hello', 'turn-started', 'turn-ended']);
    expect(s.currentMode()).toBe('worker');
  });

  it('a notice never carries the store or a reviewer across', () => {
    const child = new FakeChild();
    const s = supervise({ script: '/fake/memoryWorker.mjs', spawn: () => child });
    s.ensureStarted(store());
    child.ready();
    s.turnEnded({ sessionId: 'a', model: MODEL, store: store(), autoApply: true });
    const sent = child.sent.at(-1)!;
    expect(JSON.parse(JSON.stringify(sent))).toEqual({ type: 'turn-ended', sessionId: 'a', autoApply: true, model: MODEL });
  });

  it('the status read is the child\'s own, marked as the worker', () => {
    const child = new FakeChild();
    const s = supervise({ script: '/fake/memoryWorker.mjs', spawn: () => child });
    s.status(store());
    child.ready();
    child.emit('message', {
      type: 'status',
      status: { mode: 'worker', state: 'working', current: { kind: 'review', startedAt: 1, size: 3 }, queued: {}, callsToday: 4 },
    } satisfies FromMemoryWorker);
    expect(s.status(store())).toMatchObject({ mode: 'worker', state: 'working', current: { size: 3 }, callsToday: 4, restarts: 0 });
  });
});

describe('R8 — a dead memory process is restarted and told what to run on', () => {
  it('restarts after a crash; the new child gets the latest model and the missed notices', async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const s = supervise({ script: '/fake/memoryWorker.mjs', spawn: () => (children.push(new FakeChild()), children.at(-1)!) });
    const st = store();
    s.turnStarted({ sessionId: 'a', model: MODEL, store: st });
    children[0]!.ready();

    // Killed mid-work.
    children[0]!.die(null as unknown as number);
    expect(s.status(st)).toMatchObject({ state: 'waiting', lastFailure: { reason: 'crashed' } });
    // A turn ends while it is down: buffered, not lost.
    s.turnEnded({ sessionId: 'b', model: { ...MODEL, model: 'opus' }, store: st, autoApply: true });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(children).toHaveLength(2);
    children[1]!.ready();
    const [hello, ...rest] = children[1]!.sent;
    expect(hello).toEqual({ type: 'hello', lastModel: { sessionId: 'b', model: { ...MODEL, model: 'opus' } } });
    expect(rest.map((m) => m.type)).toEqual(['turn-ended']);
    expect(s.status(st).restarts).toBe(1);
    expect(s.currentMode()).toBe('worker');
  });

  it('gives up and runs in-process when the child keeps crashing', async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const s = supervise({ script: '/fake/memoryWorker.mjs', spawn: () => (children.push(new FakeChild()), children.at(-1)!) });
    const st = store();
    s.turnStarted({ sessionId: 'a', model: MODEL, store: st });
    for (let i = 0; i < 10 && s.currentMode() !== 'in-process'; i += 1) {
      children.at(-1)!.ready();
      children.at(-1)!.die();
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(s.currentMode()).toBe('in-process');
    expect(s.status(st).mode).toBe('in-process');
  });
});

describe('R1 — when the memory process cannot start, the work runs here', () => {
  it('no built entry → in-process at once, and the notice is not lost', async () => {
    const s = supervise({ script: null });
    const st = store();
    s.turnEnded({ sessionId: 'a', model: MODEL, store: st, autoApply: true });
    expect(s.currentMode()).toBe('in-process');
    expect(s.status(st)).toMatchObject({ mode: 'in-process' });
    await s.settle();
  });

  it('a child that dies before it is ever ready, twice → in-process', async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const s = supervise({ script: '/fake/memoryWorker.mjs', spawn: () => (children.push(new FakeChild()), children.at(-1)!) });
    const st = store();
    s.turnStarted({ sessionId: 'a', model: MODEL, store: st });
    children[0]!.die();
    await vi.advanceTimersByTimeAsync(1_000);
    children[1]!.die();
    expect(s.currentMode()).toBe('in-process');
  });

  it('a spawn that throws → in-process', () => {
    const s = supervise({
      script: '/fake/memoryWorker.mjs',
      spawn: () => {
        throw new Error('ENOENT');
      },
    });
    s.turnStarted({ sessionId: 'a', model: MODEL, store: store() });
    expect(s.currentMode()).toBe('in-process');
  });

  it('the engine\'s test seams never fork', () => {
    const spawn = vi.fn();
    const s = supervise({ script: '/fake/memoryWorker.mjs', spawn });
    s.turnStarted({ sessionId: 'a', store: store(), inProcess: true });
    s.turnEnded({ sessionId: 'a', store: store(), autoApply: true, reviewer: { label: 't', call: async () => '{}' } });
    expect(spawn).not.toHaveBeenCalled();
    expect(s.currentMode()).toBe('idle');
  });
});

describe('a model call the child cannot make is answered on the app side', () => {
  it('replies with the text, or the rate-limit flag', async () => {
    const child = new FakeChild();
    let n = 0;
    const s = supervise({
      script: '/fake/memoryWorker.mjs',
      spawn: () => child,
      answerCall: async () => {
        n += 1;
        if (n === 2) throw Object.assign(new Error('overloaded_error'), { status: 529 });
        return { text: 'answer', label: 'ai-sdk (gemini)' };
      },
    });
    s.ensureStarted(store());
    child.ready();
    const prompt = { system: 's', user: 'u' };
    child.emit('message', { type: 'call', id: 1, target: { kind: 'judge' }, prompt, timeoutMs: 1000 } satisfies FromMemoryWorker);
    child.emit('message', { type: 'call', id: 2, target: { kind: 'judge' }, prompt, timeoutMs: 1000 } satisfies FromMemoryWorker);
    await vi.waitFor(() => expect(child.sent.filter((m) => m.type === 'call-result')).toHaveLength(2));
    const results = child.sent.filter((m) => m.type === 'call-result');
    expect(results[0]).toMatchObject({ id: 1, text: 'answer' });
    expect(results[1]).toMatchObject({ id: 2, rateLimited: true });
  });
});

describe('where the entry is looked for (packaging-path-resolution §2)', () => {
  it('NABY_APP_ROOT, then COCKPIT_ROOT, then the module — never the cwd', () => {
    const saved = { app: process.env.NABY_APP_ROOT, cockpit: process.env.COCKPIT_ROOT };
    try {
      process.env.NABY_APP_ROOT = '/opt/Naby.app/Contents/Resources/app.asar';
      process.env.COCKPIT_ROOT = '/opt/shell';
      const c = memoryWorkerScriptCandidates();
      expect(c[0]).toBe('/opt/Naby.app/Contents/Resources/app.asar/shell/dist/memoryWorker.mjs');
      expect(c[1]).toBe('/opt/shell/dist/memoryWorker.mjs');
      expect(c.some((p) => p === join(process.cwd(), 'dist', 'memoryWorker.mjs') && !p.includes('/shell/'))).toBe(false);
    } finally {
      if (saved.app === undefined) delete process.env.NABY_APP_ROOT;
      else process.env.NABY_APP_ROOT = saved.app;
      if (saved.cockpit === undefined) delete process.env.COCKPIT_ROOT;
      else process.env.COCKPIT_ROOT = saved.cockpit;
    }
  });

  it('the source never reads process.cwd(), and the build emits the entry', () => {
    const code = readFileSync(join(__dirname, 'memoryWorker.ts'), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/process\.cwd\(\)/);
    const tsup = readFileSync(join(__dirname, '../../../../../../tsup.server.ts'), 'utf8');
    expect(tsup).toContain("memoryWorker: 'packages/feature/agent/src/server/lib/memoryWorkerMain.ts'");
  });
});
