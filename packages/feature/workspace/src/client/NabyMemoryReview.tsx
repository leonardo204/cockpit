'use client';

/**
 * The MEMORY TAB (settings-ia-reorg §3.3), formerly the memory summary card.
 *
 * WHAT IT USED TO BE, AND WHY IT CHANGED (P3-M10, memory-hygiene §1/§4). This was
 * the full review list: every memory in the selected scope, inline, with its
 * provenance and its buttons. That made the size of the Settings pane a function
 * of how much naby had learned — the better the product worked, the longer the
 * settings screen got. The list moved to a dedicated full-height browser
 * (`MemoryBrowserModal`) and what stays here is FIXED SIZE, whatever the memory
 * grows to.
 *
 * WHAT THE REORG CHANGED (nothing about behaviour, everything about order). The
 * card had grown to eight stacked blocks in the order they were written —
 * cold-start card, counts, proposals, browser button, two switches, fingerprint,
 * bulk delete — and the two distinctions P3-M13 added (global style needs a
 * person; a confirmed memory can be REPLACED) were invisible in it. The tab now
 * reads top-down as: what needs YOUR DECISION → what is TRUE right now → the
 * CONTROLS → the REFERENCE.
 *
 *   1. THE DECISIONS INBOX. Memory proposals, style proposals (with the "needs
 *      approval" badge on `style/global/*`, the one class corroboration may never
 *      confirm), and replacement notices with their undo. The whole block is
 *      absent when all three are empty — an inbox that says "nothing here" is a
 *      row of chrome charging rent.
 *   2. THE SUMMARY LINE. Counts per scope plus when reflection last ran, so the
 *      fact that learning is happening on its own is visible rather than implied.
 *   3. HOW IT LEARNS. Both switches in one group, with one sentence per channel:
 *      proposals are manual, corroboration is automatic, reflection is automatic
 *      (and its replacements wait for a confirmation), style is automatic per
 *      task type but manual globally.
 *   4. STYLE. The read-only fingerprint, plus a deep link into the browser
 *      narrowed to `style/*`.
 *   5. REFERENCE. The browser button stays visible; what "proposed" means and the
 *      provenance-addressed bulk delete wait behind the shared disclosure.
 *
 * IT IS STILL THE LAST DEFENSIVE LAYER. Confirming a `proposed` row is the ONLY
 * path external-origin memory becomes confirmed (memory-contracts §4 invariant
 * 1), and the poisoning rollback (delete-by-source) is still here — one
 * disclosure away rather than at the bottom of a scroll, which is nearer than it
 * was, not further.
 *
 * PERF + LAYOUT. Mounted only while the modal is open. Flat by contract (no card,
 * no tint — settingsLayout.test.ts asserts it); the proposal and notice rows keep
 * their borders because a repeated list item is what a border is still for.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';
import { ScopeBadge, type NabyScopeId } from './nabyScope';
// Type-only import: erased at compile time, so no runtime/node code enters the
// browser bundle. The shapes are the runtime's own (contract §3).
import type {
  MemoryItem,
  MemoryScope,
  StyleFingerprint,
} from '../../../../../../dist/naby-runtime.mjs';
import { BootstrapCard } from './BootstrapCard';
import { MemoryBrowserModal, STYLE_KEY_PREFIX, type MemoryFilters } from './MemoryBrowserModal';
import { SettingsDetails } from './SettingsDetails';

// ---------------------------------------------------------------------------
// Wire helpers.
// ---------------------------------------------------------------------------

type ScopeSummary = {
  scope: MemoryScope;
  scopeKey: string;
  confirmed: number;
  proposed: number;
  stale: number;
  /** P3-M13a §3.1: rows a newer memory replaced. Kept, not deleted, and not
   *  counted in `confirmed` — the card would otherwise overstate what naby
   *  currently believes. */
  replaced?: number;
};

/** One replaced memory, as the inbox shows it (settings-ia-reorg §3.3). */
export type SupersessionNotice = {
  oldId: string;
  oldKey: string;
  oldValue: string;
  newKey: string;
  newValue: string;
  at: number;
};

export type SummaryResponse = {
  scopes: ScopeSummary[];
  recentProposed: MemoryItem[];
  /** Pending `style/*` proposals, with the global ones marked — see the API. */
  pendingStyleProposals?: { item: MemoryItem; isGlobal: boolean }[];
  recentSupersessions?: SupersessionNotice[];
  /** Every decision waiting for this user — what the nav badge shows. */
  pendingCount?: number;
  corroboration?: Record<string, number>;
  autoConfirm?: boolean;
  corroborationThreshold?: number;
  lastReflectionAt?: number;
};

type MemoryActionBody =
  | { action: 'confirm'; id: string }
  | { action: 'delete'; id: string }
  | { action: 'deleteBySource'; source?: string; sessionId?: string }
  | { action: 'autoConfirm.set'; enabled: boolean }
  // P3-M13a §3.1 — the undo behind a replacement notice.
  | { action: 'revertSupersession'; id: string };

/**
 * Read the summary.
 *
 * EXPORTED because SettingsModal needs `pendingCount` for the memory tab's badge
 * while this panel is not mounted (only the selected tab renders). One fetch
 * function, one shape, one `?view=summary` request — the alternative was a second
 * endpoint that could answer a different number than the panel shows.
 */
export async function fetchMemorySummary(
  sessionId?: string,
  cwd?: string,
): Promise<{ ok: true; data: SummaryResponse } | { ok: false; error: string }> {
  try {
    const params = new URLSearchParams({ view: 'summary' });
    if (sessionId) params.set('sessionId', sessionId);
    if (cwd) params.set('cwd', cwd);
    const res = await fetch(`/api/memory?${params.toString()}`);
    const json = (await res.json().catch(() => null)) as
      | (SummaryResponse & { error?: string })
      | null;
    if (!res.ok) return { ok: false, error: json?.error ?? `request failed (${res.status})` };
    return { ok: true, data: json as SummaryResponse };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function memoryPost(body: MemoryActionBody): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) return { ok: false, error: json?.error ?? `request failed (${res.status})` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The app-wide learning switch lives on /api/naby with the other settings
 *  (§3) — see the action union there for why it is not on /api/memory. */
async function nabyPost(
  body: Record<string, unknown>,
): Promise<{
  ok: boolean;
  learningEnabled?: boolean;
  style?: StyleFingerprint | null;
  styleMinSamples?: number;
  error?: string;
}> {
  try {
    const res = await fetch('/api/naby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as
      | {
          learningEnabled?: boolean;
          style?: StyleFingerprint | null;
          styleMinSamples?: number;
          error?: string;
        }
      | null;
    if (!res.ok) return { ok: false, error: json?.error ?? `request failed (${res.status})` };
    return { ok: true, ...(json ?? {}) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * "Last looked back N hours ago", as an i18n key plus its count.
 *
 * PURE AND EXPORTED so the rounding is testable without a clock: the interesting
 * cases are the boundaries (under an hour, exactly a day) and a rendering test
 * would have to freeze time to reach them. Hours below a day, days above it —
 * a reflection pass that ran 40 minutes ago is "within the hour", not "0 hours
 * ago", which reads as broken.
 */
export function reflectionAgeCopy(
  at: number | undefined,
  now: number,
): { key: string; count: number } {
  if (typeof at !== 'number' || !Number.isFinite(at)) {
    return { key: 'memoryReview.reflectionNever', count: 0 };
  }
  const hours = Math.floor(Math.max(0, now - at) / 3_600_000);
  if (hours < 1) return { key: 'memoryReview.reflectionRecent', count: 0 };
  if (hours < 24) return { key: 'memoryReview.reflectionHoursAgo', count: hours };
  return { key: 'memoryReview.reflectionDaysAgo', count: Math.floor(hours / 24) };
}

// ---------------------------------------------------------------------------
// One pending proposal, inline on the card.
// ---------------------------------------------------------------------------

const ProposalRow = memo(function ProposalRow({
  item,
  cwd,
  busy,
  manualOnly,
  onConfirm,
  onDelete,
}: {
  item: MemoryItem;
  cwd?: string;
  busy: boolean;
  /** `style/global/*`: auto-confirmation is FORBIDDEN for this row whatever the
   *  setting says (P3-M13c §3.3), so it waits here until a person acts. The badge
   *  states that fact — it is not a severity colour. */
  manualOnly?: boolean;
  onConfirm: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-border p-2.5 space-y-1.5" data-testid="memory-proposal">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium text-foreground break-words">{item.key}</div>
          {/* CLAMPED to two lines. The card must not grow with the length of
              whatever the model wrote; the browser shows the whole thing. */}
          <div className="text-sm text-foreground/90 break-words line-clamp-2">{item.value}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {manualOnly ? (
            <span
              title={t('memoryReview.manualApprovalTitle')}
              className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-muted text-muted-foreground"
              data-testid="memory-manual-approval"
            >
              {t('memoryReview.manualApproval')}
            </span>
          ) : null}
          <ScopeBadge scope={item.scope as NabyScopeId} cwd={cwd} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onConfirm(item.id)}
          disabled={busy}
          title={t('memoryReview.confirmTitle')}
          className="text-xs px-2 py-1 rounded border border-border hover:bg-accent text-foreground disabled:opacity-50"
        >
          {t('memoryReview.confirm')}
        </button>
        <button
          onClick={() => onDelete(item.id)}
          disabled={busy}
          title={t('memoryReview.deleteTitle')}
          className="text-xs px-2 py-1 rounded border border-border hover:bg-red-500/10 hover:border-red-500/40 text-red-600 dark:text-red-400 disabled:opacity-50"
        >
          {t('memoryReview.delete')}
        </button>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// One replacement notice (settings-ia-reorg §3.3, group c).
// ---------------------------------------------------------------------------

/**
 * "X was replaced — here is what by, and here is the undo."
 *
 * WHY IT IS IN THE INBOX AT ALL. Supersession is the one thing on this screen a
 * machine does to a user's own words WITHOUT being asked (P3-M13a §3.1 allows it
 * precisely because it is reversible). A reversible act nobody is told about is
 * an irreversible one in practice, so the notice is not a log entry — it sits
 * with the decisions, and the undo is on it.
 */
const SupersessionRow = memo(function SupersessionRow({
  notice,
  busy,
  onRevert,
}: {
  notice: SupersessionNotice;
  busy: boolean;
  onRevert: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-border p-2.5 space-y-1.5" data-testid="memory-supersession">
      <div className="text-xs font-medium text-foreground break-words">
        {t('memoryReview.supersessionLine', { key: notice.oldKey })}
      </div>
      {/* ONE LINE OF EACH CLAIM. The old one is what is no longer in use, the new
          one is what took its place; without both the notice cannot be judged,
          and with more than a line each it stops being a notice. */}
      <div className="text-[11px] text-muted-foreground break-words line-clamp-1">
        {t('memoryReview.supersessionOld', { value: notice.oldValue })}
      </div>
      <div className="text-sm text-foreground/90 break-words line-clamp-2">
        {notice.newValue
          ? t('memoryReview.supersessionNew', { value: notice.newValue })
          : t('memoryReview.supersededByGone')}
      </div>
      <button
        onClick={() => onRevert(notice.oldId)}
        disabled={busy}
        title={t('memoryReview.revertTitle')}
        data-testid="memory-supersession-revert"
        className="text-xs px-2 py-1 rounded border border-border hover:bg-accent text-foreground disabled:opacity-50"
      >
        {t('memoryReview.revert')}
      </button>
    </div>
  );
});

// ---------------------------------------------------------------------------
// The tab.
// ---------------------------------------------------------------------------

/** Scope → its SHORT label key. `user` reads as "Global" in the UI (the scope
 *  dictionary's own spelling — the runtime calls it `user` because that is whose
 *  memory it is; the user sees "everywhere on this machine"). */
const SCOPE_LABELS: Record<string, string> = {
  user: 'scope.global',
  session: 'scope.session',
  project: 'scope.project',
  org: 'scope.org',
};

/** The four ways a memory can come to exist, one sentence each (§3.3 item 3).
 *  Listed as data so the group cannot grow a fifth line by accident and so the
 *  one-sentence rule can be asserted against the keys. */
const LEARNING_CHANNEL_KEYS = [
  'memoryReview.channelProposal',
  'memoryReview.channelCorroboration',
  'memoryReview.channelReflection',
  'memoryReview.channelStyle',
] as const;

/** The deep link into the browser: confirmed style preferences only (§3.4). */
const STYLE_DEEP_LINK: Partial<MemoryFilters> = {
  keyPrefix: STYLE_KEY_PREFIX,
  status: 'confirmed',
};

export function NabyMemoryReview({
  isOpen,
  sessionId,
  cwd,
  onPendingChange,
}: {
  isOpen: boolean;
  sessionId?: string;
  cwd?: string;
  /** Tells SettingsModal what the nav badge should say after this panel has
   *  reloaded — a confirm here has to clear the badge without a second request
   *  and without a polling loop. */
  onPendingChange?: (count: number) => void;
}) {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [autoConfirm, setAutoConfirm] = useState(false);
  const [learningEnabled, setLearningEnabled] = useState(true);
  // P3-M13c §3.3: READ-ONLY. There is deliberately no control here — the profile
  // is counted from the user's own messages and the only thing to do with it is
  // see it (and, if it is wrong, turn learning off or clear the memory that
  // shaped it). null means "not enough evidence yet", which is a normal state.
  const [style, setStyle] = useState<StyleFingerprint | null>(null);
  const [styleMinSamples, setStyleMinSamples] = useState(20);
  const [threshold, setThreshold] = useState(3);
  const [loading, setLoading] = useState(false);
  // WHEN the summary in hand was read. "N hours ago" needs a now, and reading the
  // clock during render is impure (the same panel would say different things on
  // two renders with the same data, and React's rules lint says so outright).
  // Stamped in the fetch, which is where a clock reading belongs.
  const [loadedAt, setLoadedAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // `false` = closed; otherwise WHICH view it was opened in. The style entry is a
  // deep link, so what it opens onto is part of the open itself.
  const [browserOpen, setBrowserOpen] = useState<false | 'all' | 'style'>(false);

  // REF INDIRECTION, not a dependency (shell/CLAUDE.md's referential-stability
  // rule). `reload` is the effect that fetches on open; taking an inline callback
  // from SettingsModal as a dep would make `reload` a new function on every
  // parent render, and the effect would refetch in a loop.
  const notifyPending = useRef(onPendingChange);
  notifyPending.current = onPendingChange;

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await fetchMemorySummary(sessionId, cwd);
    if (res.ok) {
      setSummary(res.data);
      setLoadedAt(Date.now());
      setAutoConfirm(res.data.autoConfirm === true);
      if (typeof res.data.corroborationThreshold === 'number') {
        setThreshold(res.data.corroborationThreshold);
      }
      // The badge follows the same answer this panel just rendered, rather than
      // a second read that could disagree with it.
      notifyPending.current?.(res.data.pendingCount ?? 0);
    } else {
      setSummary(null);
      setError(res.error);
    }
    // The learning switch is a SETTING and rides the settings route, so it is a
    // second request. Deliberately not merged into the summary: the summary is
    // about memory ROWS, and folding an unrelated setting into it would make
    // /api/memory the home of things that are not memory.
    const learn = await nabyPost({ action: 'learning.get' });
    if (learn.ok && typeof learn.learningEnabled === 'boolean') {
      setLearningEnabled(learn.learningEnabled);
    }
    // The fingerprint rides the settings route too, for the same reason the
    // learning switch does: it is a setting, and /api/memory is for memory ROWS.
    const styleRes = await nabyPost({ action: 'style.get' });
    if (styleRes.ok) {
      setStyle(styleRes.style ?? null);
      if (typeof styleRes.styleMinSamples === 'number') {
        setStyleMinSamples(styleRes.styleMinSamples);
      }
    }
    setLoading(false);
  }, [sessionId, cwd]);

  useEffect(() => {
    if (isOpen) void reload();
  }, [isOpen, reload]);

  const runAction = useCallback(
    async (id: string, body: MemoryActionBody, successKey: string) => {
      setBusyId(id);
      try {
        const res = await memoryPost(body);
        if (res.ok) {
          toast(t(successKey), 'success');
          await reload();
        } else {
          toast(t('memoryReview.actionError', { error: res.error ?? '' }), 'error');
        }
      } finally {
        setBusyId(null);
      }
    },
    [reload, t],
  );

  const handleConfirm = useCallback(
    (id: string) => void runAction(id, { action: 'confirm', id }, 'memoryReview.confirmed'),
    [runAction],
  );

  const handleDelete = useCallback(
    (id: string) => void runAction(id, { action: 'delete', id }, 'memoryReview.deleted'),
    [runAction],
  );

  const handleRevert = useCallback(
    (id: string) =>
      void runAction(id, { action: 'revertSupersession', id }, 'memoryReview.reverted'),
    [runAction],
  );

  const handleBulk = useCallback(
    (body: MemoryActionBody) => void runAction('__bulk__', body, 'memoryReview.deleted'),
    [runAction],
  );

  const handleAutoConfirm = useCallback(
    async (enabled: boolean) => {
      // Optimistic, then reconciled by the reload: the checkbox has to answer the
      // click immediately, and the reload is what makes a failed write visible
      // (it puts the box back where the server says it is).
      setAutoConfirm(enabled);
      setBusyId('__setting__');
      try {
        const res = await memoryPost({ action: 'autoConfirm.set', enabled });
        if (!res.ok) toast(t('memoryReview.actionError', { error: res.error ?? '' }), 'error');
        await reload();
      } finally {
        setBusyId(null);
      }
    },
    [reload, t],
  );

  const handleLearning = useCallback(
    async (enabled: boolean) => {
      setLearningEnabled(enabled);
      setBusyId('__setting__');
      try {
        const res = await nabyPost({ action: 'learning.set', enabled });
        if (!res.ok) toast(t('memoryReview.actionError', { error: res.error ?? '' }), 'error');
        await reload();
      } finally {
        setBusyId(null);
      }
    },
    [reload, t],
  );

  const busy = busyId !== null;
  const scopes = summary?.scopes ?? [];
  const proposals = summary?.recentProposed ?? [];
  const styleProposals = summary?.pendingStyleProposals ?? [];
  const supersessions = summary?.recentSupersessions ?? [];
  const totalRows = scopes.reduce((n, s) => n + s.confirmed + s.proposed, 0);
  // The whole inbox disappears when there is nothing in it — see the header.
  const hasInbox = proposals.length > 0 || styleProposals.length > 0 || supersessions.length > 0;
  const reflection = reflectionAgeCopy(summary?.lastReflectionAt, loadedAt);

  return (
    <div className="space-y-3">
      {/* Plain muted prose — the section's own description, not a callout. */}
      <p className="text-xs text-muted-foreground leading-relaxed">
        {t('memoryReview.description')}
      </p>

      {/* P15-07: the cold-start interview, shown only while it still has anything
          to ask. It writes CONFIRMED user memory, so the counts below refresh. */}
      <BootstrapCard isOpen={isOpen} onSaved={() => void reload()} />

      {/* ------------------------------------------------------------------
          1. THE DECISIONS INBOX (§3.3). First, because it is the only thing on
          this tab that is waiting for the user. Absent entirely when empty.
          ------------------------------------------------------------------ */}
      {hasInbox ? (
        <div className="space-y-2" data-testid="memory-inbox">
          {/* THE HEADING CARRIES THE BADGE'S NUMBER, and it is the same number.
              A "1" on the nav row with no noun beside it was read as an
              unexplained ornament ("what does the 1 mean?"), and a tooltip alone
              only answers that for whoever hovers. So the count is stated where
              the badge SENDS you, from `pendingCount` — the very field the badge
              reads — rather than from the lengths of the three lists below,
              which are capped for size. A badge that said 12 over a heading that
              said 3 would be worse than the bare number it replaced. */}
          <div
            className="text-[10px] uppercase tracking-wide text-muted-foreground"
            data-testid="memory-inbox-heading"
          >
            {t('memoryReview.summaryPendingCount', { count: summary?.pendingCount ?? 0 })}
          </div>

          {/* All three groups carry their kind, including this one: an inbox
              where two of three groups are labelled reads as a rendering bug,
              and "which kind of decision is this?" is the first thing each row
              has to answer. */}
          {proposals.length > 0 ? (
            <div className="space-y-1.5" data-testid="memory-proposals">
              <div className="text-[10px] text-muted-foreground">
                {t('memoryReview.inboxMemory')}
              </div>
              {proposals.map((item) => (
                <ProposalRow
                  key={item.id}
                  item={item}
                  cwd={cwd}
                  busy={busy}
                  onConfirm={handleConfirm}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          ) : null}

          {/* Style proposals — the same row, one badge different. They are split
              out because they answer "should naby write like this?" rather than
              "is this true about me?", and because the global ones can never be
              confirmed by anything but a person. */}
          {styleProposals.length > 0 ? (
            <div className="space-y-1.5" data-testid="memory-style-proposals">
              <div className="text-[10px] text-muted-foreground">
                {t('memoryReview.inboxStyle')}
              </div>
              {styleProposals.map(({ item, isGlobal }) => (
                <ProposalRow
                  key={item.id}
                  item={item}
                  cwd={cwd}
                  busy={busy}
                  manualOnly={isGlobal}
                  onConfirm={handleConfirm}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          ) : null}

          {supersessions.length > 0 ? (
            <div className="space-y-1.5" data-testid="memory-supersessions">
              <div className="text-[10px] text-muted-foreground">
                {t('memoryReview.inboxSuperseded')}
              </div>
              {supersessions.map((notice) => (
                <SupersessionRow
                  key={notice.oldId}
                  notice={notice}
                  busy={busy}
                  onRevert={handleRevert}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ------------------------------------------------------------------
          2. THE SUMMARY LINE — what is true right now, plus the evidence that
          the automatic half is running.
          ------------------------------------------------------------------ */}
      <div className="space-y-1.5" data-testid="memory-summary">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('memoryReview.summaryTitle')}
        </div>
        {loading && !summary ? (
          <p className="text-xs text-muted-foreground">{t('memoryReview.loading')}</p>
        ) : error ? (
          <p className="text-xs text-red-600 dark:text-red-400">
            {t('memoryReview.loadError', { error })}
          </p>
        ) : totalRows === 0 ? (
          <p className="text-xs text-muted-foreground">{t('memoryReview.summaryEmpty')}</p>
        ) : (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {scopes.map((s) => (
              <div key={`${s.scope}:${s.scopeKey}`} className="text-xs text-foreground">
                <span className="text-muted-foreground">{t(SCOPE_LABELS[s.scope] ?? s.scope)}</span>{' '}
                <span>{t('memoryReview.summaryConfirmed', { count: s.confirmed })}</span>
                {s.proposed > 0 ? (
                  <span className="text-amber-600 dark:text-amber-400">
                    {' · '}
                    {t('memoryReview.summaryProposed', { count: s.proposed })}
                  </span>
                ) : null}
                {s.stale > 0 ? (
                  <span className="text-muted-foreground">
                    {' · '}
                    {t('memoryReview.summaryStale', { count: s.stale })}
                  </span>
                ) : null}
                {s.replaced ? (
                  <span className="text-muted-foreground">
                    {' · '}
                    {t('memoryReview.summaryReplaced', { count: s.replaced })}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {/* WHEN IT LAST LOOKED BACK. The same reading the growth report's learning
            block shows, on the screen where "does this happen by itself?" is the
            question being asked. */}
        <p className="text-[10px] text-muted-foreground" data-testid="memory-last-reflection">
          {t(reflection.key, { count: reflection.count })}
        </p>
      </div>

      {/* ------------------------------------------------------------------
          3. HOW IT LEARNS — both switches, and the four channels they govern.
          ------------------------------------------------------------------ */}
      <div className="pt-1 border-t border-border/60 space-y-1.5" data-testid="memory-learning-method">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('memoryReview.learningMethodTitle')}
        </div>

        {/* P3-M10 §3 — LEARN AT ALL. First of the two switches, because it is the
            bigger one: it decides whether anything below it ever has input. The
            hint states the asymmetry that surprises people — off stops CAPTURE,
            not RECALL. */}
        <label className="flex items-start gap-2 text-xs text-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={learningEnabled}
            disabled={busy}
            onChange={(e) => void handleLearning(e.target.checked)}
            className="mt-0.5 accent-brand disabled:opacity-50"
            data-testid="memory-learning-toggle"
          />
          <span>{t('memoryReview.learningLabel')}</span>
        </label>
        <p className="text-[10px] text-muted-foreground leading-relaxed pl-6">
          {t('memoryReview.learningHint')}
        </p>

        {/* P3-M8b §5.4 — the auto-confirm opt-in. Off by default and stated
            plainly, including the one thing it does NOT do: external-origin
            memory is never confirmed without a person, setting or no setting. */}
        <label className="flex items-start gap-2 text-xs text-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={autoConfirm}
            disabled={busy}
            onChange={(e) => void handleAutoConfirm(e.target.checked)}
            className="mt-0.5 accent-brand disabled:opacity-50"
          />
          <span>{t('memoryReview.autoConfirmLabel')}</span>
        </label>
        <p className="text-[10px] text-muted-foreground leading-relaxed pl-6">
          {t('memoryReview.autoConfirmHint', { count: threshold })}
        </p>

        {/* THE FOUR CHANNELS, one sentence each. Together the two switches above
            do not answer "so what actually gets remembered, and when do I get
            asked?" — these do, and they are what makes the badge above
            predictable rather than surprising. */}
        <ul className="pl-6 space-y-0.5" data-testid="memory-channels">
          {LEARNING_CHANNEL_KEYS.map((key) => (
            <li key={key} className="text-[10px] text-muted-foreground leading-relaxed">
              {t(key)}
            </li>
          ))}
        </ul>
      </div>

      {/* ------------------------------------------------------------------
          4. STYLE (P3-M13c §3.3) — the fingerprint, read-only, and the way into
          the style memories themselves.

          Shown here because it is the other thing naby has worked out about the
          user, and because seeing it is the only control over it that makes
          sense: it is counted, not inferred, so there is nothing to approve.
          Below the sample floor it says so rather than showing a profile built
          from a handful of messages.
          ------------------------------------------------------------------ */}
      <div className="pt-1 border-t border-border/60 space-y-1" data-testid="style-fingerprint">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('memoryReview.styleTitle')}
        </div>
        {!style ? (
          <p className="text-xs text-muted-foreground">{t('memoryReview.styleEmpty')}</p>
        ) : style.sampleCount < styleMinSamples ? (
          <p className="text-xs text-muted-foreground">
            {t('memoryReview.styleLearning', {
              count: style.sampleCount,
              needed: styleMinSamples,
            })}
          </p>
        ) : (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-foreground">
            <span>{t('memoryReview.styleSentence', { chars: Math.round(style.avgSentenceChars) })}</span>
            <span>
              {t('memoryReview.styleEndings', {
                formal: Math.round(style.endings.formal * 100),
                polite: Math.round(style.endings.polite * 100),
              })}
            </span>
            <span>{t('memoryReview.styleQuestions', { pct: Math.round(style.questionRatio * 100) })}</span>
            <span>{t('memoryReview.styleLists', { pct: Math.round(style.listRatio * 100) })}</span>
            <span className="text-muted-foreground">
              {t('memoryReview.styleSamples', { count: style.sampleCount })}
            </span>
          </div>
        )}
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          {t('memoryReview.styleHint')}
        </p>
      </div>

      {/* The DEEP LINK, outside the fingerprint block above so that block stays
          what it says it is: read-only, no controls (memoryBrowser.test.ts).
          The fingerprint is counted from messages; these are the style rules naby
          actually holds, and they are ordinary memory — so they are read in the
          ordinary browser, narrowed. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => setBrowserOpen('all')}
          className="text-xs px-2 py-1 rounded border border-border hover:bg-accent text-foreground"
          data-testid="memory-open-browser"
        >
          {t('memoryReview.openBrowser')}
        </button>
        <button
          onClick={() => setBrowserOpen('style')}
          className="text-xs px-2 py-1 rounded border border-border hover:bg-accent text-foreground"
          data-testid="memory-open-style-browser"
        >
          {t('memoryReview.openStyleBrowser')}
        </button>
      </div>

      {/* ------------------------------------------------------------------
          5. REFERENCE. What "proposed" means, and the provenance-addressed bulk
          delete — the poisoning rollback (§6).

          THE ROLLBACK MOVED BEHIND THE DISCLOSURE, not away. It is a pair of
          destructive buttons that answer a question most sessions never ask
          ("something has gone wrong, undo a whole source"), and standing open at
          the foot of the tab it was competing for attention with the decisions
          that DO need answering. One tap, on the same screen, with the sentence
          that explains it right above.
          ------------------------------------------------------------------ */}
      <SettingsDetails>
        <p>{t('memoryReview.proposedNote')}</p>
        <div className="pt-1">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {t('memoryReview.bulkTitle')}
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <button
              onClick={() => handleBulk({ action: 'deleteBySource', source: 'external' })}
              disabled={busy}
              className="text-xs px-2 py-1 rounded border border-border hover:bg-red-500/10 hover:border-red-500/40 text-red-600 dark:text-red-400 disabled:opacity-50"
            >
              {t('memoryReview.deleteExternal')}
            </button>
            {sessionId ? (
              <button
                onClick={() => handleBulk({ action: 'deleteBySource', sessionId })}
                disabled={busy}
                className="text-xs px-2 py-1 rounded border border-border hover:bg-red-500/10 hover:border-red-500/40 text-red-600 dark:text-red-400 disabled:opacity-50"
              >
                {t('memoryReview.deleteThisSession')}
              </button>
            ) : null}
          </div>
        </div>
      </SettingsDetails>

      {/* The browser. Rendered from here because this is where it is opened from,
          and it stacks ABOVE the settings modal that contains this card. */}
      <MemoryBrowserModal
        isOpen={browserOpen !== false}
        onClose={() => {
          setBrowserOpen(false);
          // The browser can confirm, edit and delete; the counts above have to
          // reflect that when it closes, or the card would keep showing the
          // numbers from before the user's work.
          void reload();
        }}
        {...(browserOpen === 'style' ? { initialFilters: STYLE_DEEP_LINK } : {})}
        {...(sessionId ? { sessionId } : {})}
        {...(cwd ? { cwd } : {})}
      />
    </div>
  );
}
