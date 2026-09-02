// packages/feature/agent/src/client/jobStore.ts
//
// WHAT THE APP KNOWS ABOUT BACKGROUND JOBS, IN ONE PLACE.
//
// Two very different components need the same answer and neither should ask for
// it separately: the toolbar indicator, which reports that work is going on at
// all, and every transcript block for a job, which reports how ITS job went. Two
// fetchers would mean two clocks, two answers on screen at once, and a request
// per rendered block.
//
// A MODULE SINGLETON RATHER THAN A CONTEXT, for the same reason `fileRefBus` is
// one: the readers live in two packages and at two very different depths of the
// tree, and threading a provider between them would be plumbing that exists only
// to satisfy React. This has no lifecycle of its own — it is a cache with
// subscribers.
//
// IT DOES NOT POLL. `refreshJobs()` is called at moments the app already has: a
// mount, a window focus, a turn ending, the reader opening the list. The one
// interval in the feature lives in the indicator and only while something is
// running (see RunningJobsIndicator).

/** One job, as `/api/jobs` reports it. */
export interface JobRow {
  id: string;
  command: string;
  cwd: string;
  status: 'running' | 'succeeded' | 'failed' | 'killed' | 'lost';
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  note?: string;
  /** When the child last wrote anything. The difference between "running" and
   *  "running and alive". */
  lastOutputAt?: number;
  outputBytes?: number;
  logPath?: string;
}

export interface JobsSnapshot {
  running: JobRow[];
  recent: JobRow[];
  runningCount: number;
  /** When this answer was fetched, so a reader can age it. */
  at: number;
}

const EMPTY: JobsSnapshot = { running: [], recent: [], runningCount: 0, at: 0 };

let snapshot: JobsSnapshot = EMPTY;
const listeners = new Set<() => void>();
/** Guards against a slow answer overwriting a newer one. */
let seq = 0;
/** Coalesces the burst of calls a single turn-ending produces. */
let inFlight: Promise<void> | null = null;

export function getJobsSnapshot(): JobsSnapshot {
  return snapshot;
}

/**
 * The job store as a lookup by id — what a transcript block needs.
 *
 * Derived here rather than in each block so the map is built once per fetch
 * instead of once per rendered block, and so its identity is stable between
 * fetches (which is what keeps `useMemo` in the bubble from re-running).
 */
let byId: Readonly<Record<string, JobRow>> = {};
export function getJobsById(): Readonly<Record<string, JobRow>> {
  return byId;
}

export function subscribeJobs(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Re-read `/api/jobs`.
 *
 * Concurrent calls share one request: a turn ending fires this from several
 * places at once and there is no reason for three round trips.
 */
export function refreshJobs(): Promise<void> {
  if (inFlight) return inFlight;
  const mine = ++seq;
  inFlight = (async () => {
    try {
      const res = await fetch('/api/jobs');
      if (!res.ok) return;
      const data = (await res.json()) as {
        running?: JobRow[];
        recent?: JobRow[];
        runningCount?: number;
      };
      // A stale answer is dropped rather than applied: the indicator's own
      // interval and a turn-ending can overlap.
      if (mine !== seq) return;
      const running = data.running ?? [];
      const recent = data.recent ?? [];
      snapshot = {
        running,
        recent,
        runningCount: data.runningCount ?? running.length,
        at: Date.now(),
      };
      const next: Record<string, JobRow> = {};
      for (const j of [...running, ...recent]) next[j.id] = j;
      byId = next;
      for (const fn of listeners) {
        try {
          fn();
        } catch {
          // One bad subscriber must not stop the others from redrawing.
        }
      }
    } catch {
      // Keep the last answer. This is a status light, not a control.
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Test seam — forget everything, so one test cannot see another's jobs. */
export function resetJobsSnapshot(): void {
  snapshot = EMPTY;
  byId = {};
  seq++;
}
