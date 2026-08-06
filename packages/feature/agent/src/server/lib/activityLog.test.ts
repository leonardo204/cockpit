// packages/feature/agent/src/server/lib/activityLog.test.ts
//
// THE SHELL'S HALF OF THE ACTIVITY LOG (naby-activity-log §3).
//
// The runtime hooks (`runTurn`, the store) are covered by `npm run spike:activity`
// in the parent repo, which drives a real turn and reads the file back. What is
// left to this suite is the three places the RUNTIME CANNOT SEE, and which
// therefore only the shell can prove:
//
//   * the outer run lifecycle in the orchestrator — the one door every engine's
//     turn comes through, including the engines that never reach `runTurn`;
//   * the check-in exchange as the user experienced it, including the two endings
//     the growth ledger deliberately does not record (unanswered, aborted);
//   * outbound Telegram, at the transport.
//
// Every assertion reads the FILE, not a spy: the point of this feature is that
// something survives on disk, and a mocked logger would pass while the log was
// empty. `vitest.setup.ts` puts NABY_DB_PATH in a per-worker temp directory, so
// the log directory these tests write to is that temp home — never `~/.naby`.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  activityLogDir,
  activityLogFileName,
  LOG_RETENTION_DAYS,
  pruneActivityLogs,
} from '../../../../../../../dist/naby-runtime.mjs';
import { dispatchChat } from '../engines/orchestrator';
import { isRunActive } from '../sessionRunHub';
import { makeCheckinSink } from './checkinTurn';
import { sendTelegramMessage } from './telegram';
import type { EngineSpec, RunCtx, RunEvent } from '../engines/types';

type Record_ = { kind: string; [key: string]: unknown };

/** Every record written today, parsed. Parsing IS the "valid JSONL" assertion. */
function todaysRecords(): Record_[] {
  const dir = activityLogDir();
  if (!dir) return [];
  const file = join(dir, activityLogFileName());
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record_);
}

function recordsOfKind(kind: string): Record_[] {
  return todaysRecords().filter((r) => r.kind === kind);
}

async function waitUntil(pred: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('waitUntil timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

let n = 0;
const freshRunId = () => `activity-log-test-${Date.now()}-${n++}`;

function spec(name: string, run: (ctx: RunCtx) => Promise<void>): EngineSpec {
  return { name, runner: { run } };
}

describe('the activity log lives beside the database', () => {
  it('resolves <naby home>/logs from the same NABY_DB_PATH the store uses', () => {
    const dbPath = process.env.NABY_DB_PATH;
    expect(dbPath).toBeTruthy();
    expect(activityLogDir()).toBe(join(dirname(dbPath as string), 'logs'));
    // And that home is a temp directory, not the developer's own — the guarantee
    // storeIsolation.test.ts makes for the database, restated for the log.
    expect(activityLogDir()).not.toContain(`${process.env.HOME ?? '~'}/.naby`);
  });
});

describe('the orchestrator brackets every dispatched run', () => {
  it('writes run_started and run_completed for a turn on ANY engine', async () => {
    const runId = freshRunId();
    const out = await dispatchChat(
      spec('fake-engine', async (ctx) => {
        ctx.emit({ type: 'assistant', text: 'hi' } as RunEvent);
        ctx.emit({ type: 'result', is_error: false, num_turns: 1 } as RunEvent);
      }),
      { prompt: 'log this run', runId, source: 'scheduled' },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    await waitUntil(() => !isRunActive(out.runKey));
    // The completion is written in the detached teardown, just after markRunIdle.
    await waitUntil(() => recordsOfKind('run_completed').some((r) => r.runId === runId));

    const started = recordsOfKind('run_started').find((r) => r.runId === runId);
    expect(started).toBeDefined();
    expect(started?.engine).toBe('fake-engine');
    expect(started?.source).toBe('scheduled');
    expect(started?.prompt).toBe('log this run');

    const completed = recordsOfKind('run_completed').find((r) => r.runId === runId);
    expect(completed).toBeDefined();
    expect(typeof completed?.durationMs).toBe('number');
    expect(completed?.resultIsError).toBe(false);
    expect(completed?.numTurns).toBe(1);
    // A non-autonomous turn is one step; the marker-counting must not read 0.
    expect(completed?.steps).toBe(1);
  });

  it('writes run_failed, with the reason, when the runner throws', async () => {
    const runId = freshRunId();
    const out = await dispatchChat(
      spec('fake-engine', async () => {
        throw new Error('the engine fell over');
      }),
      { prompt: 'this will fail', runId },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    await waitUntil(() => recordsOfKind('run_failed').some((r) => r.runId === runId));
    const failed = recordsOfKind('run_failed').find((r) => r.runId === runId);
    expect(failed?.error).toBe('the engine fell over');
    // An unmarked caller is the chat route, and says so rather than saying nothing.
    expect(failed?.source).toBe('chat');
  });

  it('counts autonomy steps from the markers the loop already emits', async () => {
    const runId = freshRunId();
    const out = await dispatchChat(
      spec('fake-engine', async (ctx) => {
        ctx.emit({ type: 'system', subtype: 'harness', harness_subtype: 'autonomy' } as RunEvent);
        ctx.emit({ type: 'system', subtype: 'harness', harness_subtype: 'autonomy' } as RunEvent);
        ctx.emit({ type: 'system', subtype: 'harness', harness_subtype: 'other' } as RunEvent);
        ctx.emit({ type: 'result', is_error: false } as RunEvent);
      }),
      { prompt: 'two steps', runId },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    await waitUntil(() => recordsOfKind('run_completed').some((r) => r.runId === runId));
    const completed = recordsOfKind('run_completed').find((r) => r.runId === runId);
    expect(completed?.steps).toBe(2);
  });
});

describe('the check-in exchange', () => {
  const question = {
    question: 'Which way should I do this?',
    options: ['left', 'right'],
    recommended: 1,
  };

  /** The sink's deps, with a store that only has to accept ledger rows. */
  function deps(sessionId: string, signal: AbortSignal, ttlMs = 50) {
    const emitted: { type: string; [key: string]: unknown }[] = [];
    return {
      emitted,
      sink: makeCheckinSink({
        store: {
          appendEvalEvent: () => undefined,
          listEvalEvents: () => [],
        } as never,
        agentId: 'agent-under-test',
        sessionId,
        emit: (e) => emitted.push(e),
        signal,
        ttlMs,
        drill: true,
        now: () => Date.now(),
      }),
    };
  }

  it('logs the question as asked — recommendation included — and the answer', async () => {
    const sessionId = `checkin-session-${Date.now()}`;
    const ac = new AbortController();
    const { sink, emitted } = deps(sessionId, ac.signal, 5000);
    const pending = sink.ask(question, { toolCallId: 'call-9' });

    await waitUntil(() => recordsOfKind('checkin_asked').some((r) => r.sessionId === sessionId));
    const asked = recordsOfKind('checkin_asked').find((r) => r.sessionId === sessionId);
    expect(asked?.question).toBe(question.question);
    expect(asked?.options).toEqual(['left', 'right']);
    // The UI hides the recommendation from the user; the log is for the developer.
    expect(asked?.recommended).toBe(1);
    expect(asked?.drill).toBe(true);

    // Answer it the way the API route does: through the registry the emit named.
    const checkinId = emitted.find((e) => e.type === 'checkin_request')?.checkinId as string;
    const { resolveCheckin } = await import('./checkinRegistry');
    resolveCheckin(checkinId, { chosen: 0 });
    await pending;

    const answered = recordsOfKind('checkin_answered').find((r) => r.sessionId === sessionId);
    expect(answered?.chosen).toBe(0);
    expect(answered?.recommended).toBe(1);
    expect(answered?.unanswered).toBe(false);
  });

  it('logs an UNANSWERED check-in, which the growth ledger deliberately does not record', async () => {
    const sessionId = `checkin-timeout-${Date.now()}`;
    const ac = new AbortController();
    const { sink } = deps(sessionId, ac.signal, 10);
    const answer = await sink.ask(question, { toolCallId: 'call-10' });
    expect(answer.unanswered).toBe(true);
    const answered = recordsOfKind('checkin_answered').find((r) => r.sessionId === sessionId);
    expect(answered).toBeDefined();
    expect(answered?.unanswered).toBe(true);
    expect(answered?.chosen).toBe(-1);
  });
});

describe('outbound Telegram is logged at the transport', () => {
  beforeAll(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 4242 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
  });

  it('records the message and NEVER the bot token', async () => {
    const sent = await sendTelegramMessage(
      { botToken: 'SECRET-BOT-TOKEN-do-not-log', chatId: '424242' },
      'the agent finished the job',
      { replyMarkup: { inline_keyboard: [] } },
    );
    expect(sent.ok).toBe(true);
    const out = recordsOfKind('telegram_out').find((r) => r.messageId === 4242);
    expect(out).toBeDefined();
    expect(out?.text).toBe('the agent finished the job');
    expect(out?.chatId).toBe('424242');
    expect(out?.hasButtons).toBe(true);
    // The whole day's file, not just this record: a token leaking through some
    // other field would be just as bad.
    expect(JSON.stringify(todaysRecords())).not.toContain('SECRET-BOT-TOKEN');
  });

  it('records a FAILED send too — a message the user never got is the interesting case', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, description: 'chat not found' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const sent = await sendTelegramMessage(
      { botToken: 'SECRET-BOT-TOKEN-do-not-log', chatId: '424242' },
      'this one never arrives',
    );
    expect(sent.ok).toBe(false);
    const out = recordsOfKind('telegram_out').find((r) => r.text === 'this one never arrives');
    expect(out?.ok).toBe(false);
    expect(out?.error).toBe('chat not found');
  });
});

describe('retention', () => {
  it('deletes only YYYY-MM-DD.jsonl files older than the window, by filename', () => {
    const dir = activityLogDir();
    expect(dir).toBeTruthy();
    const day = (daysAgo: number): string => {
      const d = new Date(Date.now() - daysAgo * 86_400_000);
      const p = (x: number) => String(x).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`;
    };
    const stale = day(LOG_RETENTION_DAYS + 5);
    const fresh = day(LOG_RETENTION_DAYS - 1);
    const foreign = 'keep-me.txt';
    for (const name of [stale, fresh, foreign]) {
      writeFileSync(join(dir as string, name), '{"kind":"fixture"}\n', 'utf8');
    }
    const removed = pruneActivityLogs(Date.now(), dir as string);
    const after = readdirSync(dir as string);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(after).not.toContain(stale);
    expect(after).toContain(fresh);
    expect(after).toContain(foreign);
  });
});
