// Live progress for a Telegram-started turn (telegram-chat §4.1).
//
// Everything runs on fakes: an injected clock and an IO seam that records what
// would have been sent or edited. No bot, no engine, no timers to wait on
// except the grace, which the tests set to a handful of milliseconds.

import { describe, it, expect } from 'vitest';
import {
  PROGRESS_EDIT_INTERVAL_MS,
  PROGRESS_RECENT_LINES,
  PROGRESS_TARGET_CHARS,
  formatElapsed,
  formatToolLine,
  initialProgressState,
  readProgressEvent,
  reduceProgress,
  renderProgress,
  shortToolTarget,
  shouldEditNow,
  startProgressReporter,
  type ProgressIo,
  type ProgressState,
} from './telegramProgress';
import { STR } from './telegramChatStrings';

// ---------------------------------------------------------------------------
// event shapes
// ---------------------------------------------------------------------------

/** The naby engine's tool_use shape (engines/naby.ts `tool_request`). */
function toolUse(name: string, input: unknown): unknown {
  return {
    type: 'assistant',
    session_id: 's1',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name, input }] },
  };
}

/** The naby engine's tool_result shape (`emitToolResult`). */
function toolResult(isError: boolean): unknown {
  return {
    type: 'user',
    session_id: 's1',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out', is_error: isError }],
    },
  };
}

describe('telegramProgress — reading run events', () => {
  it('reads a tool call with a file target as its basename', () => {
    expect(readProgressEvent(toolUse('Read', { file_path: '/x/proj/src/app/page.tsx' }))).toEqual({
      kind: 'tool',
      name: 'Read',
      target: 'page.tsx',
    });
  });

  it('reads a Bash call as the head of its command', () => {
    expect(readProgressEvent(toolUse('Bash', { command: 'npm test\nnpm run build' }))).toEqual({
      kind: 'tool',
      name: 'Bash',
      target: 'npm test',
    });
  });

  it('reads a search call as its pattern', () => {
    expect(readProgressEvent(toolUse('Grep', { pattern: 'projectLabel' }))).toEqual({
      kind: 'tool',
      name: 'Grep',
      target: 'projectLabel',
    });
  });

  it('reads a tool result and whether it failed', () => {
    expect(readProgressEvent(toolResult(false))).toEqual({ kind: 'toolResult', isError: false });
    expect(readProgressEvent(toolResult(true))).toEqual({ kind: 'toolResult', isError: true });
  });

  it('reads the terminal result event', () => {
    expect(readProgressEvent({ type: 'result', is_error: false, result: 'done' })).toEqual({
      kind: 'result',
    });
  });

  it('ignores everything else without throwing', () => {
    // Other engines (claude/codex/ollama) emit their own variants and any field
    // may be missing — a progress line is never worth a throw inside a listener.
    for (const junk of [
      undefined,
      null,
      42,
      'text',
      {},
      { type: 'assistant' },
      { type: 'assistant', message: {} },
      { type: 'assistant', message: { content: 'not an array' } },
      { type: 'assistant', message: { content: [null, 7, { type: 'text', text: 'hi' }] } },
      { type: 'stream_event', event: { type: 'content_block_delta' } },
      { type: 'thinking', text: '음…' },
    ]) {
      expect(readProgressEvent(junk)).toBeUndefined();
    }
  });

  it('names an unnamed tool rather than dropping the call', () => {
    expect(readProgressEvent(toolUse('', { file_path: '/a/b.ts' }))).toEqual({
      kind: 'tool',
      name: 'tool',
      target: 'b.ts',
    });
  });

  it('reports a tool call with no recognizable input as a bare name', () => {
    expect(readProgressEvent(toolUse('TodoWrite', { todos: [{ x: 1 }] }))).toEqual({
      kind: 'tool',
      name: 'TodoWrite',
    });
  });
});

describe('telegramProgress — short targets', () => {
  it('takes the basename of a Windows path too', () => {
    expect(shortToolTarget({ file_path: 'C:\\work\\naby\\readme.md' })).toBe('readme.md');
  });

  it('truncates hard', () => {
    const long = 'a'.repeat(200);
    const out = shortToolTarget({ command: long })!;
    expect(out.length).toBe(PROGRESS_TARGET_CHARS + 1); // + the ellipsis
    expect(out.endsWith('…')).toBe(true);
  });

  it('collapses whitespace to one line', () => {
    expect(shortToolTarget({ command: '  git   status  \n  git log' })).toBe('git status');
  });

  it('accepts a bare string input', () => {
    expect(shortToolTarget('describe the plan')).toBe('describe the plan');
  });

  it('has no target for input it cannot read', () => {
    expect(shortToolTarget(undefined)).toBeUndefined();
    expect(shortToolTarget(123)).toBeUndefined();
    expect(shortToolTarget({ file_path: 42 })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// the accumulator
// ---------------------------------------------------------------------------

function fold(events: readonly unknown[], startedAt = 1_000): ProgressState {
  let state = initialProgressState(startedAt);
  for (const raw of events) {
    const ev = readProgressEvent(raw);
    if (ev) state = reduceProgress(state, ev);
  }
  return state;
}

describe('telegramProgress — the accumulator', () => {
  it('counts every tool call and keeps only the tail', () => {
    const state = fold([
      toolUse('Read', { file_path: '/a/one.ts' }),
      toolUse('Read', { file_path: '/a/two.ts' }),
      toolUse('Read', { file_path: '/a/three.ts' }),
      toolUse('Read', { file_path: '/a/four.ts' }),
      toolUse('Read', { file_path: '/a/five.ts' }),
      toolUse('Read', { file_path: '/a/six.ts' }),
    ]);
    expect(state.toolCount).toBe(6);
    expect(state.recent).toHaveLength(PROGRESS_RECENT_LINES);
    expect(state.recent.map((l) => l.target)).toEqual(['three.ts', 'four.ts', 'five.ts', 'six.ts']);
  });

  it('marks the call that failed rather than adding a line for the result', () => {
    const state = fold([toolUse('Bash', { command: 'npm test' }), toolResult(true)]);
    expect(state.recent).toEqual([{ name: 'Bash', target: 'npm test', failed: true }]);
  });

  it('leaves a successful result invisible', () => {
    const state = fold([toolUse('Bash', { command: 'npm test' }), toolResult(false)]);
    expect(state.recent).toEqual([{ name: 'Bash', target: 'npm test' }]);
  });

  it('ignores a result that arrives before any call', () => {
    expect(fold([toolResult(true)]).recent).toEqual([]);
  });

  it('accumulates pending changes so the throttle can coalesce them', () => {
    const state = fold([
      toolUse('Read', { file_path: '/a/one.ts' }),
      toolUse('Read', { file_path: '/a/two.ts' }),
    ]);
    expect(state.pending).toBe(2);
  });

  it('marks the turn done on the terminal result', () => {
    const state = fold([toolUse('Read', { file_path: '/a/one.ts' }), { type: 'result' }]);
    expect(state.done).toBe(true);
  });

  it('never mutates the state it was given', () => {
    const before = initialProgressState(0);
    reduceProgress(before, { kind: 'tool', name: 'Read' });
    expect(before).toEqual({ startedAt: 0, toolCount: 0, recent: [], pending: 0, done: false });
  });
});

// ---------------------------------------------------------------------------
// the throttle predicate
// ---------------------------------------------------------------------------

describe('telegramProgress — shouldEditNow', () => {
  it('says no when nothing changed, however long it has been', () => {
    expect(shouldEditNow({ lastEditAt: 0, now: 10 * 60_000, pending: 0 })).toBe(false);
  });

  it('says yes at once for the first change after the message was posted', () => {
    expect(shouldEditNow({ lastEditAt: 0, now: 1, pending: 1 })).toBe(true);
  });

  it('holds an edit back until the interval has elapsed', () => {
    expect(shouldEditNow({ lastEditAt: 1_000, now: 1_000 + PROGRESS_EDIT_INTERVAL_MS - 1, pending: 5 }))
      .toBe(false);
    expect(shouldEditNow({ lastEditAt: 1_000, now: 1_000 + PROGRESS_EDIT_INTERVAL_MS, pending: 5 }))
      .toBe(true);
  });

  it('takes an overridden interval', () => {
    expect(shouldEditNow({ lastEditAt: 100, now: 150, pending: 1, intervalMs: 40 })).toBe(true);
    expect(shouldEditNow({ lastEditAt: 100, now: 130, pending: 1, intervalMs: 40 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

describe('telegramProgress — rendering', () => {
  it('names the project, the elapsed time, the tool count and the tail', () => {
    const state = fold([toolUse('Bash', { command: 'npm test' })], 0);
    const body = renderProgress(state, { project: 'naby', now: 12_000 });
    expect(body.split('\n')[0]).toBe('📁 naby');
    expect(body).toContain('12초');
    expect(body).toContain('툴 1회');
    expect(body).toContain('• Bash — npm test');
  });

  it('prints the no-project marker rather than a gap', () => {
    const body = renderProgress(initialProgressState(0), { project: '', now: 0 });
    expect(body.split('\n')[0]).toBe(`📁 ${STR.noProject}`);
  });

  it('says it is wrapping up once the run reported its result', () => {
    const working = renderProgress(fold([], 0), { project: 'naby', now: 0 });
    const done = renderProgress(fold([{ type: 'result' }], 0), { project: 'naby', now: 0 });
    expect(working).toContain('⏳');
    expect(done).toContain('✅');
  });

  it('marks a failed call', () => {
    expect(formatToolLine({ name: 'Bash', target: 'npm test', failed: true })).toBe('✗ Bash — npm test');
    expect(formatToolLine({ name: 'Bash' })).toBe('• Bash');
  });

  it('reads elapsed time coarsely', () => {
    expect(formatElapsed(0)).toBe('0초');
    expect(formatElapsed(-5)).toBe('0초');
    expect(formatElapsed(59_999)).toBe('59초');
    expect(formatElapsed(90_000)).toBe('1분 30초');
    expect(formatElapsed(3 * 3_600_000 + 4 * 60_000)).toBe('3시간 4분');
  });
});

// ---------------------------------------------------------------------------
// the reporter
// ---------------------------------------------------------------------------

type Recorder = {
  io: ProgressIo;
  sent: string[];
  edits: Array<[number, string]>;
  clock: { t: number };
  failEditsAfter: (n: number) => void;
  failSend: () => void;
};

function recorder(): Recorder {
  const sent: string[] = [];
  const edits: Array<[number, string]> = [];
  const clock = { t: 1_000 };
  let editBudget = Number.POSITIVE_INFINITY;
  let sendOk = true;
  return {
    sent,
    edits,
    clock,
    failEditsAfter: (n: number) => void (editBudget = n),
    failSend: () => void (sendOk = false),
    io: {
      now: () => clock.t,
      send: async (text: string) => {
        sent.push(text);
        return sendOk ? { ok: true as const, messageId: 500 } : { ok: false as const, error: 'nope' };
      },
      edit: async (messageId: number, text: string) => {
        if (edits.length >= editBudget) return { ok: false as const, error: 'rate limited' };
        edits.push([messageId, text]);
        return { ok: true as const };
      },
    },
  };
}

/** Let the reporter's internal write chain drain. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe('telegramProgress — the reporter', () => {
  it('posts nothing at all for a turn that ends inside the grace window', async () => {
    const r = recorder();
    const rep = startProgressReporter(r.io, { project: 'naby', graceMs: 10_000 });
    rep.onEvent(toolUse('Read', { file_path: '/a/one.ts' }));
    await rep.finish();
    expect(r.sent).toEqual([]);
    expect(r.edits).toEqual([]);
  });

  it('posts ONE message after the grace and then only edits it', async () => {
    const r = recorder();
    const rep = startProgressReporter(r.io, { project: 'naby', graceMs: 5, intervalMs: 0 });
    await settle();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toContain('📁 naby');

    rep.onEvent(toolUse('Bash', { command: 'npm test' }));
    await settle();
    rep.onEvent(toolUse('Read', { file_path: '/a/two.ts' }));
    await settle();
    await rep.finish();

    expect(r.sent).toHaveLength(1);
    expect(r.edits.length).toBeGreaterThanOrEqual(2);
    expect(r.edits.every(([id]) => id === 500)).toBe(true);
    expect(r.edits[r.edits.length - 1]![1]).toContain('툴 2회');
  });

  it('coalesces a burst of tool calls into one edit', async () => {
    const r = recorder();
    const rep = startProgressReporter(r.io, { project: 'naby', graceMs: 5, intervalMs: 60_000 });
    await settle();
    // The clock never moves, so every one of these lands inside one interval.
    for (let i = 0; i < 6; i += 1) rep.onEvent(toolUse('Read', { file_path: `/a/${i}.ts` }));
    await settle();
    expect(r.edits).toHaveLength(0);
    await rep.finish();
    // The final flush is forced, so exactly one edit carries all six.
    expect(r.edits).toHaveLength(1);
    expect(r.edits[0]![1]).toContain('툴 6회');
  });

  it('always flushes a final state before the answer goes out', async () => {
    const r = recorder();
    const rep = startProgressReporter(r.io, { project: 'naby', graceMs: 5, intervalMs: 60_000 });
    await settle();
    rep.onEvent(toolUse('Bash', { command: 'npm test' }));
    rep.onEvent({ type: 'result', is_error: false, result: '끝' });
    await rep.finish();
    expect(r.edits).toHaveLength(1);
    expect(r.edits[0]![1]).toContain('✅');
  });

  it('does not edit at the end when nothing changed since the last write', async () => {
    const r = recorder();
    const rep = startProgressReporter(r.io, { project: 'naby', graceMs: 5, intervalMs: 0 });
    await settle();
    await rep.finish();
    // Telegram rejects an identical edit anyway; not asking is the honest form.
    expect(r.edits).toHaveLength(0);
  });

  it('STOPS EDITING after the first failure rather than retrying', async () => {
    const r = recorder();
    r.failEditsAfter(1);
    const rep = startProgressReporter(r.io, { project: 'naby', graceMs: 5, intervalMs: 0 });
    await settle();
    rep.onEvent(toolUse('Read', { file_path: '/a/one.ts' }));
    await settle();
    expect(r.edits).toHaveLength(1);
    // Everything from here on is silence — never a retry loop, never a fresh send.
    for (let i = 0; i < 10; i += 1) {
      rep.onEvent(toolUse('Read', { file_path: `/a/${i}.ts` }));
      await settle();
    }
    await rep.finish();
    expect(r.edits).toHaveLength(1);
    expect(r.sent).toHaveLength(1);
  });

  it('degrades to silence when the first post fails', async () => {
    const r = recorder();
    r.failSend();
    const rep = startProgressReporter(r.io, { project: 'naby', graceMs: 5, intervalMs: 0 });
    await settle();
    rep.onEvent(toolUse('Read', { file_path: '/a/one.ts' }));
    await settle();
    await rep.finish();
    expect(r.sent).toHaveLength(1);
    expect(r.edits).toEqual([]);
  });

  it('never posts a progress message after the turn ended', async () => {
    const r = recorder();
    const rep = startProgressReporter(r.io, { project: 'naby', graceMs: 5, intervalMs: 0 });
    await rep.finish();
    await settle();
    await settle();
    expect(r.sent).toEqual([]);
  });

  it('survives an event that cannot be read', async () => {
    const r = recorder();
    const rep = startProgressReporter(r.io, { project: 'naby', graceMs: 5, intervalMs: 0 });
    await settle();
    rep.onEvent(Object.create(null));
    rep.onEvent({ type: 'assistant', get message() { throw new Error('boom'); } });
    await settle();
    await rep.finish();
    expect(r.sent).toHaveLength(1);
  });

  it('reports the elapsed time from the injected clock', async () => {
    const r = recorder();
    const rep = startProgressReporter(r.io, { project: 'naby', graceMs: 5, intervalMs: 0 });
    await settle();
    r.clock.t += 90_000;
    rep.onEvent(toolUse('Bash', { command: 'npm run build' }));
    await settle();
    await rep.finish();
    expect(r.edits[0]![1]).toContain('1분 30초');
  });
});
