'use client';

/**
 * "기억 작업" — what the memory process is doing (specs/memory-worker.md §2).
 *
 * One collapsed row on the memory tab: the state word is always visible; opening
 * it shows the current job, what is waiting, the last thing finished and the last
 * thing that failed, the backend it calls and how many calls today. While it is
 * open it re-reads every few seconds; closed, it reads once and stops.
 *
 * COUNTS AND CODES ONLY. The status carries no memory's text — kinds, sizes,
 * failure codes and a backend label — the same rule as the activity log. A
 * failure is shown by its reason code, never the provider's message, which can
 * quote the prompt.
 *
 * FLAT, like everything in this pane (settingsLayout.test.ts): a rule above, no
 * box, no tint.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MemoryWorkStatus } from '../../../../../../dist/naby-runtime.mjs';

/** How often the open row re-reads the status. */
export const MEMORY_WORK_POLL_MS = 3_000;

type Translate = (key: string, opts?: Record<string, unknown>) => string;

async function fetchMemoryWorkStatus(): Promise<{ ok: true; work: MemoryWorkStatus } | { ok: false; error: string }> {
  try {
    const res = await fetch('/api/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'work.status' }),
    });
    const json = (await res.json().catch(() => null)) as { work?: MemoryWorkStatus; error?: string } | null;
    if (!res.ok || !json?.work) return { ok: false, error: json?.error ?? `request failed (${res.status})` };
    return { ok: true, work: json.work };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Pure copy — exported so the wording is testable without a server or a clock.
// ---------------------------------------------------------------------------

const KIND_KEYS: Record<string, string> = {
  review: 'memoryReview.workKindReview',
  summary: 'memoryReview.workKindSummary',
  reflection: 'memoryReview.workKindReflection',
  tidy: 'memoryReview.workKindTidy',
  // memory-tiers: promotion and archival (no model calls).
  promote: 'memoryReview.workKindPromote',
  archive: 'memoryReview.workKindArchive',
};

export function memoryWorkKindLabel(kind: string, t: Translate): string {
  return t(KIND_KEYS[kind] ?? 'memoryReview.workKindOther');
}

/** "새 기억 3개 검수 중" — the job, with its size when there is one. */
export function memoryWorkJobLabel(current: { kind: string; size?: number }, t: Translate): string {
  const sized = typeof current.size === 'number' && current.size > 0;
  switch (current.kind) {
    case 'review':
      return sized ? t('memoryReview.workJobReviewSized', { count: current.size }) : t('memoryReview.workJobReview');
    case 'summary':
      return sized ? t('memoryReview.workJobSummarySized', { count: current.size }) : t('memoryReview.workJobSummary');
    case 'tidy':
      return sized ? t('memoryReview.workJobTidySized', { count: current.size }) : t('memoryReview.workJobTidy');
    case 'reflection':
      return t('memoryReview.workJobReflection');
    case 'promote':
      return t('memoryReview.workJobPromote');
    case 'archive':
      return t('memoryReview.workJobArchive');
    default:
      return t('memoryReview.workJobOther');
  }
}

/** Which counts make up a job's one-line result, in the order they are read. */
const RESULT_PARTS: Record<string, readonly (readonly [string, string])[]> = {
  review: [
    ['applied', 'memoryReview.workResultApplied'],
    ['merged', 'memoryReview.workResultMerged'],
    ['refined', 'memoryReview.workResultRefined'],
    ['superseded', 'memoryReview.workResultSuperseded'],
    ['held', 'memoryReview.workResultHeld'],
    ['waiting', 'memoryReview.workResultWaiting'],
  ],
  summary: [['written', 'memoryReview.workResultWritten']],
  tidy: [
    ['reviewed', 'memoryReview.workResultReviewed'],
    ['tidied', 'memoryReview.workResultTidied'],
  ],
  reflection: [
    ['sessions', 'memoryReview.workResultSessions'],
    ['proposed', 'memoryReview.workResultProposed'],
  ],
  promote: [
    ['long', 'memoryReview.workResultLong'],
    ['anchored', 'memoryReview.workResultAnchored'],
    ['full', 'memoryReview.workResultAnchorFull'],
  ],
  archive: [
    ['archived', 'memoryReview.workResultArchived'],
    ['purged', 'memoryReview.workResultPurged'],
  ],
};

/** "2개 적용 · 1개 정리" — the non-zero counts, or "바뀐 것 없음". */
export function memoryWorkResultLine(kind: string, counts: Record<string, number>, t: Translate): string {
  const c: Record<string, number> = { ...counts };
  if (kind === 'tidy') c.tidied = (counts.equivalent ?? 0) + (counts.refines ?? 0) + (counts.contradicts ?? 0);
  const parts = (RESULT_PARTS[kind] ?? [])
    .filter(([field]) => (c[field] ?? 0) > 0)
    .map(([field, key]) => t(key, { count: c[field] }));
  return parts.length > 0 ? parts.join(' · ') : t('memoryReview.workResultNothing');
}

const REASON_KEYS: Record<string, string> = {
  'no-model': 'memoryReview.workReasonNoModel',
  'rate-limited': 'memoryReview.workReasonRateLimited',
  failed: 'memoryReview.workReasonFailed',
  crashed: 'memoryReview.workReasonCrashed',
};

export function memoryWorkReasonLabel(reason: string, t: Translate): string {
  return t(REASON_KEYS[reason] ?? 'memoryReview.workReasonFailed');
}

const STATE_KEYS: Record<MemoryWorkStatus['state'], string> = {
  idle: 'memoryReview.workStateIdle',
  working: 'memoryReview.workStateWorking',
  waiting: 'memoryReview.workStateWaiting',
};

/** "검수 1 · 정리 1" — waiting jobs per kind. */
export function memoryWorkQueuedLine(queued: Record<string, number>, t: Translate): string {
  const entries = Object.entries(queued).filter(([, n]) => n > 0);
  if (entries.length === 0) return t('memoryReview.workQueuedNone');
  return t('memoryReview.workQueued', {
    list: entries.map(([kind, n]) => `${memoryWorkKindLabel(kind, t)} ${n}`).join(' · '),
  });
}

/** A backlog count at its cap reads as "100+" (memoryJobs.ts MEMORY_BACKLOG_COUNT_CAP). */
const BACKLOG_CAP = 100;
const capped = (n: number): string => (n >= BACKLOG_CAP ? `${BACKLOG_CAP}+` : String(n));

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

export const MemoryWorkRow = memo(function MemoryWorkRow({ isOpen }: { isOpen: boolean }) {
  const { t } = useTranslation();
  const [work, setWork] = useState<MemoryWorkStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    const res = await fetchMemoryWorkStatus();
    if (!alive.current) return;
    if (res.ok) {
      setWork(res.work);
      setError(null);
    } else {
      setError(res.error);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // One read whenever the settings modal opens — the state word is visible
  // collapsed — and a re-read every few seconds only while the row is open.
  useEffect(() => {
    if (!isOpen) return;
    void load();
    if (!expanded) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = () => {
      timer = setTimeout(async () => {
        await load();
        if (!stopped) tick();
      }, MEMORY_WORK_POLL_MS);
    };
    tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [isOpen, expanded, load]);

  const onToggle = useCallback((e: React.SyntheticEvent<HTMLDetailsElement>) => {
    setExpanded(e.currentTarget.open);
  }, []);

  const stateWord = work ? t(STATE_KEYS[work.state]) : '…';

  return (
    <details className="pt-1 border-t border-border/60" onToggle={onToggle} data-testid="memory-work">
      <summary className="cursor-pointer select-none text-[0.714rem] uppercase tracking-wide text-muted-foreground hover:text-foreground">
        {t('memoryReview.workTitle')}
        {' · '}
        <span data-testid="memory-work-state" className={work?.state === 'working' ? 'text-foreground' : undefined}>
          {stateWord}
        </span>
      </summary>
      <div className="mt-1.5 space-y-0.5 text-[0.714rem] leading-relaxed text-muted-foreground" data-testid="memory-work-detail">
        {error ? (
          <p className="text-destructive">{t('memoryReview.workLoadError', { error })}</p>
        ) : !work ? (
          <p>{t('memoryReview.loading')}</p>
        ) : (
          <>
            {work.current ? (
              <p className="text-foreground">
                {t('memoryReview.workCurrent', { job: memoryWorkJobLabel(work.current, t) })}
              </p>
            ) : null}
            {work.state === 'waiting' && work.waitingFor === 'backoff' && work.nextRetryAt ? (
              <p>{t('memoryReview.workWaitingBackoff', { time: clock(work.nextRetryAt) })}</p>
            ) : null}
            {work.state === 'waiting' && work.waitingFor === 'turn-model' ? (
              <p>{t('memoryReview.workWaitingTurnModel')}</p>
            ) : null}
            <p>{memoryWorkQueuedLine(work.queued, t)}</p>
            {work.backlog ? (
              <p>
                {t('memoryReview.workBacklog', {
                  review: capped(work.backlog.pendingReview),
                  summary: capped(work.backlog.toSummarize),
                  tidy: capped(work.backlog.unreviewed),
                })}
              </p>
            ) : null}
            <p>
              {work.lastDone
                ? t('memoryReview.workLastDone', {
                    time: clock(work.lastDone.at),
                    kind: memoryWorkKindLabel(work.lastDone.kind, t),
                    result: memoryWorkResultLine(work.lastDone.kind, work.lastDone.counts, t),
                  })
                : t('memoryReview.workLastDoneNone')}
            </p>
            {work.lastFailure ? (
              <p className="text-warning">
                {t('memoryReview.workLastFailure', {
                  time: clock(work.lastFailure.at),
                  kind: memoryWorkKindLabel(work.lastFailure.kind, t),
                  reason: memoryWorkReasonLabel(work.lastFailure.reason, t),
                })}
              </p>
            ) : null}
            <p>
              {work.model
                ? t('memoryReview.workModel', { model: work.model, count: work.callsToday })
                : t('memoryReview.workModelNone', { count: work.callsToday })}
            </p>
            {work.mode === 'in-process' ? <p>{t('memoryReview.workModeInProcess')}</p> : null}
            {work.restarts ? <p>{t('memoryReview.workRestarts', { count: work.restarts })}</p> : null}
            <p>{t('memoryReview.workHint')}</p>
          </>
        )}
      </div>
    </details>
  );
});
