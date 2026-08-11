import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * NABY SPEAKS FIRST WHEN A BACKGROUND JOB ENDS.
 *
 * THE REPORT. "배포하고 끝나면 알려줘." naby backgrounded the deploy, said it
 * would report back, the turn ended — and nothing was ever said again. The
 * mechanism did not exist: nothing but the scheduled-task manager could start a
 * turn after a turn, and the model cannot create a scheduled task.
 *
 * WHAT IS PINNED HERE, each one a way this could go wrong in the user's hands
 * rather than in a type checker:
 *
 *   1. A finished job starts EXACTLY ONE turn, in ITS session and ITS cwd, on
 *      the naby engine.
 *   2. `reserveRun` happens BEFORE the dispatch. A tab attaching in that gap
 *      would otherwise be told the session is idle and sit in front of an empty
 *      conversation while a turn it never heard about ran (the same race
 *      `startFastGrowthKickoff` documents).
 *   3. The prompt names the job and NOTHING of its output. A build log is
 *      megabytes; pasting it in would spend the window of the one turn that has
 *      to read it.
 *   4. A job with no session reports nowhere, and a job still running never
 *      produces a turn that states an outcome nobody has.
 *   5. The busy-session race retries and then STOPS. A refusal that will not
 *      improve (no engine configured) is not retried at all.
 *   6. The wiring is really in the engine: the workspace toolset is built with a
 *      job sink and this session's id.
 */

const h = vi.hoisted(() => ({
  reserved: [] as string[],
  released: [] as string[],
  /** Every hub call and every dispatch, in the order they really happened. */
  order: [] as string[],
}));

vi.mock('../sessionRunHub', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sessionRunHub')>();
  return {
    ...actual,
    reserveRun: (key: string) => {
      h.reserved.push(key);
      h.order.push('reserveRun');
    },
    releaseRun: (key: string) => {
      h.released.push(key);
      h.order.push('releaseRun');
    },
  };
});

import {
  buildJobReportPrompt,
  makeJobSink,
  reportFinishedJob,
  JOB_REPORT_SOURCE,
  type JobReportDispatch,
} from './backgroundJobReport';
import type { JobRecord } from '../../../../../../../dist/naby-runtime.mjs';

const finished = (over: Partial<JobRecord> = {}): JobRecord => ({
  id: 'job-1a2b3c4d',
  command: 'npm run deploy -- --prod',
  cwd: '/tmp/project',
  status: 'succeeded',
  startedAt: 1_000,
  endedAt: 901_000,
  exitCode: 0,
  sessionId: 'sess-deploy',
  ...over,
});

/** A dispatch that records what it was asked to do and answers as told. */
function recordingDispatch(answers: Array<{ ok: boolean; error?: string; status?: number }>) {
  const calls: Array<{ sessionId: string; prompt: string; cwd?: string }> = [];
  let i = 0;
  const dispatch: JobReportDispatch = async (input) => {
    calls.push(input);
    return answers[Math.min(i++, answers.length - 1)] ?? { ok: true };
  };
  return { dispatch, calls };
}

beforeEach(() => {
  h.reserved.length = 0;
  h.released.length = 0;
  h.order.length = 0;
});

describe('the prompt the report turn is given', () => {
  it('names the job, its command and its outcome', () => {
    const prompt = buildJobReportPrompt(finished());
    expect(prompt).toContain('job-1a2b3c4d');
    expect(prompt).toContain('npm run deploy -- --prod');
    expect(prompt).toContain('finished successfully');
    // 900s of wall clock, said in a form a person reads.
    expect(prompt).toContain('15m 0s');
  });

  it('tells the model to FETCH the output rather than carrying it', () => {
    const prompt = buildJobReportPrompt(finished());
    // The NABY-LAYER tool by name. The job tools live in `buildToolset`, so this
    // is the name the model sees on every engine — including dev-claude, where a
    // bare `read_job_output` would be a tool that does not exist.
    expect(prompt).toContain('naby_read_job_output("job-1a2b3c4d")');
    // The guard that matters: no transcript of the run may ride along. A log is
    // megabytes, and the turn that must read it is a context window.
    expect(prompt.length).toBeLessThan(1_200);
    expect(prompt).not.toMatch(/stdout|stderr|\bnpm WARN\b/);
  });

  it('says a failure failed, and a kill was killed — never "succeeded"', () => {
    expect(buildJobReportPrompt(finished({ status: 'failed', exitCode: 2 }))).toContain(
      'FAILED (exit 2)',
    );
    expect(
      buildJobReportPrompt(finished({ status: 'killed', signal: 'SIGKILL', exitCode: undefined })),
    ).toContain('was stopped (SIGKILL)');
    const lost = buildJobReportPrompt(
      finished({ status: 'lost', exitCode: undefined, note: 'the app session ended' }),
    );
    expect(lost).toContain('unrecorded outcome');
    expect(lost).toContain('the app session ended');
  });

  it('passes on that the log was truncated, so the report cannot claim completeness', () => {
    expect(buildJobReportPrompt(finished({ truncated: true }))).toContain('truncated');
  });
});

describe('dispatching the report', () => {
  it('starts one turn, in the job\'s own session and directory', async () => {
    const { dispatch, calls } = recordingDispatch([{ ok: true }]);
    const outcome = await reportFinishedJob({ dispatch, log: () => {} }, finished());
    expect(outcome).toEqual({ started: true, attempts: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sessionId).toBe('sess-deploy');
    expect(calls[0]!.cwd).toBe('/tmp/project');
  });

  it('reports nowhere when the job belonged to no session', async () => {
    const { dispatch, calls } = recordingDispatch([{ ok: true }]);
    const outcome = await reportFinishedJob(
      { dispatch, log: () => {} },
      finished({ sessionId: undefined }),
    );
    expect(outcome.started).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('never reports a job that is still running', async () => {
    const { dispatch, calls } = recordingDispatch([{ ok: true }]);
    const outcome = await reportFinishedJob(
      { dispatch, log: () => {} },
      finished({ status: 'running', endedAt: undefined }),
    );
    expect(outcome).toMatchObject({ started: false, reason: 'still-running' });
    expect(calls).toHaveLength(0);
  });

  it('retries only the busy-session race, and stops', async () => {
    const { dispatch, calls } = recordingDispatch([
      { ok: false, status: 409, error: 'session is already running' },
    ]);
    const outcome = await reportFinishedJob(
      { dispatch, retryDelayMs: 0, maxAttempts: 3, reserve: () => {}, log: () => {} },
      finished(),
    );
    expect(outcome).toMatchObject({ started: false, reason: 'busy', attempts: 3 });
    expect(calls).toHaveLength(3);
  });

  it('gives up at once on a refusal that will not improve', async () => {
    const { dispatch, calls } = recordingDispatch([
      { ok: false, status: 503, error: 'no engine configured' },
    ]);
    const outcome = await reportFinishedJob(
      { dispatch, retryDelayMs: 0, log: () => {} },
      finished(),
    );
    expect(outcome).toMatchObject({ started: false, reason: 'refused', attempts: 1 });
    expect(calls).toHaveLength(1);
  });

  it('answers with a reason rather than throwing when the dispatch explodes', async () => {
    const outcome = await reportFinishedJob(
      {
        dispatch: async () => {
          throw new Error('the engine exploded');
        },
        log: () => {},
      },
      finished(),
    );
    expect(outcome).toMatchObject({ started: false, reason: 'threw' });
  });

  it('succeeds on a retry once the session frees up', async () => {
    const { dispatch, calls } = recordingDispatch([
      { ok: false, status: 409, error: 'busy' },
      { ok: true },
    ]);
    const outcome = await reportFinishedJob(
      { dispatch, retryDelayMs: 0, reserve: () => {}, log: () => {} },
      finished(),
    );
    expect(outcome).toEqual({ started: true, attempts: 2 });
    expect(calls).toHaveLength(2);
  });
});

describe('the sink the runtime is handed', () => {
  it('reserves the run SYNCHRONOUSLY, before anything async', () => {
    const sink = makeJobSink({
      dispatch: async () => async () => ({ ok: true }),
    });
    sink.onFinished(finished());
    // Not "eventually" — right now, in the same tick the child process exited.
    expect(h.reserved).toEqual(['sess-deploy']);
  });

  it('reserves before it dispatches, and does not release a turn that started', async () => {
    const sink = makeJobSink({
      dispatch: async () => async () => {
        h.order.push('dispatchChat');
        return { ok: true };
      },
    });
    sink.onFinished(finished());
    await vi.waitFor(() => expect(h.order).toContain('dispatchChat'));
    expect(h.order).toEqual(['reserveRun', 'dispatchChat']);
    expect(h.released).toEqual([]);
  });

  it('releases the reservation when no turn is coming', async () => {
    const sink = makeJobSink({
      dispatch: async () => async () => ({ ok: false, status: 503, error: 'no engine' }),
    });
    sink.onFinished(finished());
    await vi.waitFor(() => expect(h.released).toEqual(['sess-deploy']));
  });

  it('does nothing at all for a job with no session', () => {
    const sink = makeJobSink({ dispatch: async () => async () => ({ ok: true }) });
    sink.onFinished(finished({ sessionId: undefined }));
    expect(h.reserved).toEqual([]);
  });
});

describe('the wiring, asserted on the source', () => {
  // jsdom cannot run the engine and a mounted test cannot see a composition
  // root, so the guard is a source assertion — the same device
  // `sidebarPopoverClipping.test.ts` uses for a fact no runtime check can reach.
  const engine = readFileSync(
    join(__dirname, '..', 'engines', 'naby.ts'),
    'utf8',
  );

  it('injects the job sink into the NABY-LAYER toolset, bound to this session', () => {
    // buildToolset, not buildWorkspaceTools. The workspace kit is withheld from
    // dev-claude (which brings its own file and shell tools), so a job sink
    // injected there would mean that engine had no background jobs at all — the
    // exact hole this wiring exists to close.
    expect(engine).toMatch(
      /projectCwd \? \{ cwd: projectCwd, sink: makeJobSink\(\), sessionId \} : undefined/,
    );
    // And the workspace call takes its two options and nothing else, so a job
    // sink cannot quietly move back into the kit dev-claude never receives.
    expect(engine).toMatch(
      /buildWorkspaceTools\(\{\s*cwd: projectCwd,\s*allowMutations: !planMode && allowChanges,\s*\}\)/,
    );
  });

  it('hands the naby-layer schemas to EVERY engine — only the workspace kit is engine-gated', () => {
    // This is the link that makes the move work. `builtin` (buildToolset, which
    // now carries the job tools) is spread into the schemas unconditionally; the
    // ONLY toolset that asks which engine this is is the workspace one. The
    // Agent SDK engine turns whatever it is handed into its in-process MCP
    // server, so on dev-claude these arrive as mcp__nabytools__naby_*.
    expect(engine).toMatch(/const toolSchemas: ToolSchema\[\] = \[\s*\.\.\.builtin\.toolSchemas,/);
    expect(engine).toMatch(/const executors: Record<string, Executor> = \{\s*\.\.\.builtin\.executors,/);
    const engineGated = engine.match(/engineId !== 'dev-claude'/g) ?? [];
    expect(engineGated).toHaveLength(1);
    expect(engine).toMatch(/projectCwd && engineId !== 'dev-claude'\s*\?\s*buildWorkspaceTools/);
  });

  it('gives the report turn the persona\'s escalation channel', () => {
    // Without this the one message that exists because the user walked away
    // would fall back to 'inline' and stop at the screen they walked away from.
    expect(engine).toContain('ctx.params.source === JOB_REPORT_SOURCE');
    expect(engine).toMatch(/jobReportTurn \? readPersonaAutonomy\(store\)\.escalation/);
  });

  it('stamps the run with a source of its own', () => {
    expect(JOB_REPORT_SOURCE).toBe('background-job');
  });
});
