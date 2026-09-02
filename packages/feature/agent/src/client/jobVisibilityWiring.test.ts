/**
 * jobVisibilityWiring.test.ts — a job that is still running has to look like it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TWO BUGS THIS PINS, BOTH OF WHICH SHIPPED
 *
 * 1. THE GOOD PATH WAS INVISIBLE. A block appeared only for a call whose input
 *    said `run_in_background: true` — the engine's own Bash. `naby_start_job`,
 *    the one path that can report when the work ends, has no such input, so the
 *    only trustworthy background mechanism left no trace in the transcript at
 *    all. The path that DID draw a block was the one that could never report.
 *
 * 2. THE BLOCK WENT QUIET WHEN THE TURN ENDED, NOT WHEN THE JOB DID. `turnEnded`
 *    downgraded a running job to `unknown`, which was honest while lifecycle
 *    edges were the only source — they stop with the turn. It is not honest now
 *    that a naby job can be looked up in a store that outlives the turn.
 *
 * Neither is visible to a type checker and both look like a correct render.
 */
import { describe, expect, it } from 'vitest';
import {
  NABY_START_JOB_TOOL,
  nabyJobIdOf,
  partitionBackgroundJobs,
  statusFromStore,
} from './backgroundJobs';
import type { ToolCallInfo } from './types';

const startCall = (id: string, jobId?: string): ToolCallInfo => ({
  id,
  name: NABY_START_JOB_TOOL,
  input: { command: 'ffmpeg -i in.mov out.mp4' },
  result: `Started in the background as ${jobId ?? 'job-????'}`,
  ...(jobId ? { resultData: { jobId, command: 'ffmpeg', status: 'running' } } : {}),
});

describe('finding a naby job in a turn', () => {
  it('reads the id from the structured result, not the sentence', () => {
    expect(nabyJobIdOf(startCall('c1', 'job-abc12345'))).toBe('job-abc12345');
  });

  it('ignores a result that only has the prose', () => {
    // A live turn carries the text but not the payload; the block appears when
    // the transcript reconciles. Guessing the id out of the sentence would break
    // the first time that sentence is reworded.
    expect(nabyJobIdOf(startCall('c1'))).toBeUndefined();
  });

  it('ignores other tools and other payloads', () => {
    expect(nabyJobIdOf({ id: 'c', name: 'Bash', input: {}, resultData: { jobId: 'job-1' } })).toBeUndefined();
    expect(
      nabyJobIdOf({ id: 'c', name: NABY_START_JOB_TOOL, input: {}, resultData: { jobId: 'nope' } }),
    ).toBeUndefined();
  });
});

describe('a naby job gets a block of its own', () => {
  it('is taken out of the ordinary tool rows', () => {
    const call = startCall('c1', 'job-abc12345');
    const { jobs, calls } = partitionBackgroundJobs([call], []);
    expect(jobs).toHaveLength(1);
    expect(calls).toHaveLength(0);
    expect(jobs[0]!.id).toBe('job-abc12345');
    expect(jobs[0]!.command).toContain('ffmpeg');
  });

  it('reads running from the store even after the turn ended', () => {
    // THE FIX. Before, `turnEnded` alone decided this and the answer was
    // `unknown` — "outcome not recorded" — while the encode was still going.
    const call = startCall('c1', 'job-abc12345');
    const { jobs } = partitionBackgroundJobs([call], [], {
      turnEnded: true,
      jobStore: { 'job-abc12345': { status: 'running', startedAt: 1000 } },
    });
    expect(jobs[0]!.status).toBe('running');
    expect(jobs[0]!.startedAt).toBe(1000);
  });

  it('reports how it actually ended, days later, from the store alone', () => {
    const call = startCall('c1', 'job-abc12345');
    const { jobs } = partitionBackgroundJobs([call], [], {
      turnEnded: true,
      jobStore: { 'job-abc12345': { status: 'failed', startedAt: 1, endedAt: 2 } },
    });
    expect(jobs[0]!.status).toBe('failed');
    expect(jobs[0]!.endedAt).toBe(2);
  });

  it('assumes running when the store has not answered yet', () => {
    // The store is fetched, so the first render may precede it. A job whose
    // launch was acknowledged is running until something says otherwise —
    // the opposite default would flash "unknown" on every fresh transcript.
    const { jobs } = partitionBackgroundJobs([startCall('c1', 'job-abc12345')], [], {
      turnEnded: true,
    });
    expect(jobs[0]!.status).toBe('running');
  });
});

describe('the old path keeps its old rule', () => {
  const sdkCall: ToolCallInfo = {
    id: 'c2',
    name: 'Bash',
    input: { command: 'sleep 999', run_in_background: true },
  };

  it('an SDK-backgrounded job still goes unknown when the turn ends', () => {
    // Not a regression to fix: for that path the lifecycle really did stop, and
    // there is no store row to ask. Saying `unknown` is still the truth.
    const { jobs } = partitionBackgroundJobs([sdkCall], [], { turnEnded: true });
    expect(jobs[0]!.status).toBe('unknown');
  });
});

describe('translating the store vocabulary', () => {
  it('renames the two that are the same thing', () => {
    expect(statusFromStore('succeeded')).toBe('completed');
    expect(statusFromStore('killed')).toBe('stopped');
    expect(statusFromStore('running')).toBe('running');
    expect(statusFromStore('failed')).toBe('failed');
  });

  it('reads `lost` as unknown, never as failed', () => {
    // `lost` means the app restarted mid-job. The work may well have succeeded;
    // calling it failed would accuse a job that finished fine.
    expect(statusFromStore('lost')).toBe('unknown');
  });
});
