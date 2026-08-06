'use client';

import { memo, useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Loader,
  CircleAlert,
  CircleSlash,
  Terminal,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ToolCallModal } from './ToolCallModal';
import { formatElapsed } from './elapsed';
import { type BackgroundJob, jobElapsedSeconds } from './backgroundJobs';

/**
 * ONE BACKGROUND JOB, AS ONE ROW THAT KEEPS TALKING.
 *
 * The row a backgrounded `Bash` call left behind said the command had been run
 * and nothing else — the tool result arrives in milliseconds because it is only
 * the launch acknowledgement, so a deploy that took four minutes looked finished
 * the moment it started. This block is the part of the transcript that stays
 * open: it names the command, it counts while the job runs, and it says how the
 * job ended.
 *
 * Same muted vocabulary as `SubagentBlock` — a toggle line, rows underneath. A
 * background job is machinery, and machinery does not get to look like something
 * the assistant said.
 *
 * `memo`'d and fed only what it renders. `job` comes from a `useMemo` in the
 * bubble, so its identity changes only when the job actually changes.
 */

const STATUS_KEY = {
  running: 'chat.backgroundJobRunning',
  completed: 'chat.backgroundJobCompleted',
  failed: 'chat.backgroundJobFailed',
  stopped: 'chat.backgroundJobStopped',
} as const;

const STATUS_FALLBACK = {
  running: 'running',
  completed: 'done',
  failed: 'failed',
  stopped: 'stopped',
} as const;

function StatusIcon({ status }: { status: BackgroundJob['status'] }) {
  if (status === 'running') return <Loader className="w-3 h-3 animate-spin opacity-70" />;
  if (status === 'completed') return <CheckCircle2 className="w-3 h-3 opacity-60" />;
  if (status === 'failed') return <CircleAlert className="w-3 h-3 opacity-70" />;
  if (status === 'stopped') return <CircleSlash className="w-3 h-3 opacity-60" />;
  return null;
}

/**
 * The elapsed count, in whole seconds.
 *
 * TICKS ONLY WHERE IT IS BEING READ. Every chat tab stays mounted (three panels,
 * `display:none` for the ones that are not on screen), so a per-second interval
 * per job would keep re-rendering turns nobody can see — the exact thing the
 * render conventions are about. A job that has ENDED needs no interval at all:
 * its two timestamps are fixed and the number is computed once.
 */
function useJobElapsed(job: BackgroundJob, isActive: boolean): number | null {
  const live = job.status === 'running' && isActive && job.endedAt === undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);
  return jobElapsedSeconds(job, now);
}

interface BackgroundJobBlockProps {
  job: BackgroundJob;
  cwd?: string;
  sessionId?: string | null;
  /** Whether this tab is the one on screen. A hidden tab does not tick. */
  isActive?: boolean;
}

export const BackgroundJobBlock = memo(function BackgroundJobBlock({
  job,
  cwd,
  sessionId,
  isActive = true,
}: BackgroundJobBlockProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const elapsed = useJobElapsed(job, isActive);

  // The call that launched it. It is the only row this block has to show —
  // the ending edge carries a summary and an output-file path, and neither
  // crosses the runtime seam (they are model-authored text and a path on this
  // machine), so the block reports the OUTCOME and never invents the output.
  const rows = job.spawningCall ? [job.spawningCall] : [];

  // What is running. The command when the spawning call is known, the model's
  // own words for it otherwise — and when neither survived (a job reported
  // without its call), the block still says a background job exists rather than
  // disappearing, which is the failure this whole thing is about.
  const label = job.command ?? job.description;

  return (
    <div className="mt-0.5" data-testid="background-job-block" data-job-id={job.id}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        data-testid="background-job-toggle"
        className="flex w-full items-center gap-1.5 rounded px-2 py-0.5 text-[0.786rem] text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3 opacity-60 flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 opacity-60 flex-shrink-0" />
        )}
        <Terminal className="w-3 h-3 opacity-60 flex-shrink-0" />
        <span className="flex-shrink-0">
          {t('chat.backgroundJob', { defaultValue: 'Background job' })}
        </span>
        {job.status === 'unknown' ? (
          // NOT A SPINNER, AND NOT A VERDICT. Either the transcript was reloaded
          // (the lifecycle is transport and never persisted) or the turn ended
          // before the job reported back — in both cases the outcome is simply
          // not recorded, and saying so is the only thing that is true.
          <span className="flex-shrink-0 opacity-70" data-testid="background-job-status">
            {t('chat.backgroundJobUnknown', { defaultValue: 'outcome not recorded' })}
          </span>
        ) : (
          <span
            className="flex items-center gap-1 flex-shrink-0"
            data-testid="background-job-status"
          >
            <StatusIcon status={job.status} />
            {t(STATUS_KEY[job.status], { defaultValue: STATUS_FALLBACK[job.status] })}
          </span>
        )}
        {/* How long it has been going — the one number that distinguishes a job
            that is working from one that has hung. Absent when nothing recorded
            a start time (a reloaded transcript), rather than counting from now. */}
        {elapsed !== null && (
          <span
            className="flex-shrink-0 tabular-nums opacity-70"
            data-testid="background-job-elapsed"
          >
            ·{' '}
            {t('chat.backgroundJobElapsed', {
              elapsed: formatElapsed(elapsed),
              defaultValue: '{{elapsed}} elapsed',
            })}
          </span>
        )}
        {/* The command last and truncated: it is free text and the most likely
            to be long. `formatJobCommand` already put it on one line. */}
        {label && <span className="truncate opacity-60 text-left font-mono">· {label}</span>}
      </button>
      {expanded && rows.length > 0 && (
        <div className="ml-3 border-l border-border/50 pl-2">
          {rows.map((toolCall, index) => (
            <ToolCallModal
              key={`${toolCall.id}-${index}`}
              toolCall={toolCall}
              cwd={cwd}
              sessionId={sessionId}
            />
          ))}
        </div>
      )}
    </div>
  );
});
