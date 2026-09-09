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
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY GROUPED BY PROJECT
 *
 * The registry is global, the window is not. A 2026-09-07 field report had jobs
 * from another project's server session listed under an unrelated project, and
 * the reader took the list at face value both ways — "nothing is running here"
 * when something was, "something is running here" when it was someone else's
 * work. So the popover draws a heading per project directory and puts the open
 * one first (jobGroups.ts).
 *
 * The count on the button stays the TOTAL, because it is the app's only "work
 * is happening somewhere" signal; when some of it belongs elsewhere, the label
 * says so instead of the number lying by omission.
 *
 * And there is no "nothing running in this project" line. Waits the SDK owns
 * itself — `Monitor`, a backgrounded Bash — never reach this registry, so such
 * a line would be false in exactly the moment a reader is waiting on one. An
 * empty current project simply has no section.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getJobsSnapshot,
  refreshJobs,
  subscribeJobs,
  type JobRow,
} from '@cockpit/feature-agent';
import { groupJobsByProject, isJobInProject } from './jobGroups';


/**
 * How often to re-ask WHILE something is running.
 *
 * Slow on purpose. The number on screen is an elapsed time in minutes, so a
 * faster beat would buy nothing and cost a request; and this is the one timer in
 * the feature, so it should be visibly cheap. Cleared when nothing is running.
 */
const LIVE_REFRESH_MS = 15_000;

/**
 * How long a job that DID NOT succeed stays in the list after it ended.
 *
 * A succeeded job leaves at once — it worked, there is nothing to go back for. A
 * failed / stopped / lost job is the one a person may want to notice, so it
 * lingers this long and then clears itself, rather than piling up forever. The
 * transcript block for the job is unaffected: this is only the toolbar list's
 * housekeeping.
 */
const FAILED_JOB_TTL_MS = 5 * 60_000;

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

export interface RunningJobsIndicatorProps {
  /** The open project's directory, used to say which jobs are this project's.
   *  Absent (no project open) means no group is the current one. */
  cwd?: string;
}

export function RunningJobsIndicator({ cwd }: RunningJobsIndicatorProps = {}) {
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

  // WHAT THE LIST MAY SHOW, after two rules the field asked for:
  //
  //   1. A succeeded job is dropped at once; a failed/stopped/lost one lingers
  //      FAILED_JOB_TTL_MS and then clears itself. Running jobs always stay.
  //   2. WHEN A PROJECT IS OPEN, only that project's jobs appear — another
  //      project's work is hidden entirely, not merely separated by a divider,
  //      so it cannot be mistaken for this project's. With no project open (the
  //      home view), everything is shown, grouped by project.
  const rows = useMemo(() => {
    const kept = [
      ...data.running,
      ...data.recent.filter((job) => {
        if (job.status === 'succeeded') return false;
        const ended = job.endedAt ?? job.startedAt ?? 0;
        return now - ended < FAILED_JOB_TTL_MS;
      }),
    ];
    return cwd ? kept.filter((job) => isJobInProject(job, cwd)) : kept;
  }, [data, cwd, now]);
  // Grouped headers are only meaningful in the home view — a single open project
  // needs none, because every row already belongs to it.
  const groups = useMemo(() => groupJobsByProject(rows, cwd), [rows, cwd]);
  const showHeaders = !cwd;

  // A FAILED ROW LEAVES WHILE YOU WATCH, with one self-cancelling timer and no
  // poll: while the list is open, wake once at the soonest row's expiry to
  // re-filter. Re-arms after each wake (it depends on `now`), and does not exist
  // when the list is closed or nothing is expiring.
  useEffect(() => {
    if (!open) return;
    let soonest = Infinity;
    for (const job of data.recent) {
      if (job.status === 'succeeded') continue;
      const ended = job.endedAt ?? job.startedAt ?? 0;
      const left = ended + FAILED_JOB_TTL_MS - now;
      if (left < soonest) soonest = left;
    }
    if (!Number.isFinite(soonest)) return;
    const id = setTimeout(() => setNow(Date.now()), Math.max(0, soonest) + 50);
    return () => clearTimeout(id);
  }, [open, data, now]);
  // Counted over RUNNING rows only, since the number beside it is `runningCount`.
  const runningHere = useMemo(
    () => (cwd ? data.running.filter((job) => isJobInProject(job, cwd)).length : 0),
    [data.running, cwd]
  );

  // ALWAYS SHOWN, since 2026-09-03. It used to render nothing until a job had
  // run at least once, and while idle it drew a clock — and the field report
  // from Windows was "the background-work icon is missing": the control was
  // there, and read as a history button. A control that only appears once you
  // have already used the feature cannot teach anyone the feature exists. So it
  // stays in the row, at rest as an activity line rather than a clock, and the
  // list it opens says plainly when there is nothing in it.
  //
  // THE NUMBER IS THE TOTAL; THE WORDS SAY WHERE. When some of the running work
  // belongs to another project, the label carries that split so the count is not
  // read as "this many here".
  const label =
    runningCount > 0
      ? cwd && runningHere < runningCount
        ? t('jobs.runningElsewhere', {
            defaultValue: '{{count}} running · {{here}} in this project',
            count: runningCount,
            here: runningHere,
          })
        : t('jobs.running', { defaultValue: '{{count}} running', count: runningCount })
      : t('jobs.title', { defaultValue: 'Background jobs' });

  return (
    <div className="relative">
      {/* `data-tooltip`, not `title`: the app's own popover (TooltipProvider)
          is what every other control uses, and native title tooltips were the
          thing the Windows build was not showing. */}
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          void load();
        }}
        aria-expanded={open}
        aria-label={label}
        data-tooltip={label}
        className={`flex items-center gap-1 p-2 rounded-lg transition-colors hover:bg-accent ${
          runningCount > 0 ? 'text-brand' : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        {runningCount > 0 ? (
          // A ring that turns, so "still going" reads without counting.
          <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
            <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        ) : (
          // An activity trace, in the same outline style and size as the
          // buttons beside it — "work", not "time".
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M22 12h-4l-3 9L9 3l-3 9H2" />
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
            {rows.length === 0 && (
              <div className="px-3 py-3 text-xs text-muted-foreground">
                {cwd
                  ? t('jobs.noneHere', { defaultValue: 'No background jobs in this project.' })
                  : t('jobs.none', { defaultValue: 'Nothing running, and nothing recent.' })}
              </div>
            )}
            {groups.map((group) => (
              <div key={group.cwd}>
                {/* The project header appears only in the home view (`showHeaders`).
                    With a project open there is exactly one project's work here, so
                    a header would only repeat what the whole panel already means. */}
                {showHeaders && (
                  <div
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-muted/40 border-b border-border text-[0.688rem] text-muted-foreground"
                    title={group.cwd}
                  >
                    {group.isCurrent && (
                      <span className="rounded px-1 py-px bg-brand/15 text-brand text-[0.625rem]">
                        {t('jobs.thisProject', { defaultValue: 'This project' })}
                      </span>
                    )}
                    <span className="truncate font-medium text-foreground">{group.label}</span>
                  </div>
                )}
                {group.jobs.map((job) => (
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
