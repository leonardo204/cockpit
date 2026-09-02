'use client';

/**
 * RunningJobsIndicator — the one place that says work is still going, wherever
 * you are in the app.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A GLOBAL ONE WAS NEEDED
 *
 * Every other "in progress" signal in this app is scoped to something that ends
 * before the work does. The transcript block is scoped to a turn, and turns end.
 * The dot on the tab follows `isLoading`, which is only true for a turn this tab
 * itself sent. The sidebar counts sessions that are mid-turn, not jobs.
 *
 * So a background job that outlived its turn — the exact case a background job
 * exists for — used to be invisible in all three at once, and the transcript's
 * own block would say "outcome not recorded" while the work was still running.
 *
 * This reads `/api/jobs`, which is backed by the job registry and the records
 * directory: both outlive a turn, a tab and a restart.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHEN IT ASKS, AND WHY THAT IS NOT A POLLER
 *
 * The repo bans standing timers. This obeys that by only asking at moments the
 * user (or the app) already created:
 *
 *   - when it mounts,
 *   - when the window is focused or the tab becomes visible again,
 *   - when a turn ends anywhere in this window (`job-refresh`),
 *   - when the reader opens the list.
 *
 * WITH ONE EXCEPTION, SCOPED AND SELF-CANCELLING: while at least one job is
 * running, it re-asks on a slow interval so an elapsed time is not frozen at
 * whatever it said when you last clicked. The interval exists only while there
 * is something to show and is cleared the moment the count reaches zero — it
 * never runs in an idle app, which is what the ban is about.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getJobsSnapshot,
  refreshJobs,
  subscribeJobs,
  type JobRow,
} from '@cockpit/feature-agent';


/**
 * How often to re-ask WHILE something is running.
 *
 * Slow on purpose. The number on screen is an elapsed time in minutes, so a
 * faster beat would buy nothing and cost a request; and this is the one timer in
 * the feature, so it should be visibly cheap. Cleared when nothing is running.
 */
const LIVE_REFRESH_MS = 15_000;

/** The event any part of the window can fire to make this re-read immediately —
 *  used when a turn ends, since a turn ending is when jobs most often start or
 *  finish. */
export const JOB_REFRESH_EVENT = 'naby:job-refresh';

function elapsed(fromMs: number, nowMs: number): string {
  const secs = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

export function RunningJobsIndicator() {
  const { t } = useTranslation();
  // ONE STORE, TWO READERS. The transcript blocks read the same snapshot, so a
  // job cannot say "running" in the toolbar and "finished" in the conversation.
  const data = useSyncExternalStore(subscribeJobs, getJobsSnapshot, getJobsSnapshot);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    await refreshJobs();
    setNow(Date.now());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The moments the app already has. No timer among them.
  useEffect(() => {
    const onWake = () => void load();
    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener(JOB_REFRESH_EVENT, onWake);
    return () => {
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener(JOB_REFRESH_EVENT, onWake);
    };
  }, [load]);

  const runningCount = data.runningCount;

  // THE ONE TIMER, and it does not exist while the app is idle.
  useEffect(() => {
    if (runningCount === 0) return;
    const id = setInterval(() => void load(), LIVE_REFRESH_MS);
    return () => clearInterval(id);
  }, [runningCount, load]);

  const rows = useMemo(() => [...data.running, ...data.recent], [data]);

  // NOTHING RUNNING AND NOTHING RECENT ⇒ NOTHING SHOWN. A permanently visible
  // zero would be one more thing in a toolbar that is already busy, and it says
  // nothing a person needs.
  if (rows.length === 0) return null;

  const label =
    runningCount > 0
      ? t('jobs.running', { defaultValue: '{{count}} running', count: runningCount })
      : t('jobs.title', { defaultValue: 'Background jobs' });

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          void load();
        }}
        aria-expanded={open}
        title={label}
        className={`flex items-center gap-1 px-2 py-1.5 rounded-lg transition-colors hover:bg-accent ${
          runningCount > 0 ? 'text-brand' : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        {runningCount > 0 ? (
          // A ring that turns, so "still going" reads without counting.
          <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
            <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        ) : (
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        )}
        {runningCount > 0 && <span className="text-xs tabular-nums">{runningCount}</span>}
      </button>

      {open && (
        <>
          {/* Click-away. A plain overlay rather than a document listener so it
              cannot outlive the popover. */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="absolute right-0 top-full mt-1 z-50 w-96 max-h-96 overflow-y-auto rounded-lg border border-border bg-card shadow-lg">
            <div className="px-3 py-2 border-b border-border text-xs font-medium text-foreground">
              {t('jobs.title', { defaultValue: 'Background jobs' })}
            </div>
            {rows.map((job) => (
              <div key={job.id} className="px-3 py-2 border-b border-border last:border-0">
                <div className="flex items-center gap-2">
                  <StatusDot status={job.status} />
                  <span className="font-mono text-[0.688rem] text-muted-foreground">{job.id}</span>
                  <span className="ml-auto text-[0.688rem] text-muted-foreground tabular-nums">
                    {elapsed(job.startedAt, job.endedAt ?? now)}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-xs text-foreground" title={job.command}>
                  {job.command}
                </div>
                <div className="text-[0.625rem] text-muted-foreground">
                  {jobLine(job, (k, o) => String(t(k, o)), now)}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: JobRow['status'] }) {
  const cls =
    status === 'running'
      ? 'bg-brand animate-pulse'
      : status === 'succeeded'
        ? 'bg-emerald-500'
        : status === 'lost'
          ? 'bg-amber-500'
          : 'bg-red-500';
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cls}`} aria-hidden="true" />;
}

/** The one line under a job. Says the thing that is true for THAT status rather
 *  than a generic field dump. */
function jobLine(
  job: JobRow,
  t: (k: string, o?: Record<string, unknown>) => string,
  now: number,
): string {
  if (job.status === 'running') {
    // LAST OUTPUT IS THE LIVENESS SIGNAL, not the start time. A job silent for
    // an hour may be working or wedged, and this is the only way to tell.
    return job.lastOutputAt
      ? t('jobs.lastOutput', {
          defaultValue: 'last output {{ago}} ago',
          ago: elapsed(job.lastOutputAt, now),
        })
      : t('jobs.noOutputYet', { defaultValue: 'no output yet' });
  }
  if (job.status === 'lost') {
    return t('jobs.lost', {
      defaultValue: 'the app restarted while this was running — outcome unknown',
    });
  }
  if (job.status === 'failed') {
    return t('jobs.failed', {
      defaultValue: 'failed{{code}}',
      code: job.exitCode !== undefined ? ` (exit ${job.exitCode})` : '',
    });
  }
  if (job.status === 'killed') return t('jobs.killed', { defaultValue: 'stopped' });
  return t('jobs.succeeded', { defaultValue: 'finished' });
}
