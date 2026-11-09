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
import { MemoryChoiceCard } from './MemoryChoiceCard';
import { MemoryText } from './MemoryText';

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
  /** `memory.autoApply` (memory-auto-apply R31). */
  autoApply?: boolean;
  corroborationThreshold?: number;
  lastReflectionAt?: number;
  /** memory-auto-apply R29 group 1 — see the API. */
  needsCheck?: { questions: MemoryQuestionRow[]; proposed: NeedsCheckRow[] };
  /** memory-auto-apply R29 group 2 — see the API. */
  recentLearned?: RecentRow[];
};

/** One open question (memory-auto-apply §5), as the API renders it. */
export type MemoryQuestionRow = {
  id: string;
  kind: 'conflict' | 'overwrite';
  a: { id?: string; key: string; value: string; learnedAt: number };
  b: { id?: string; key: string; value: string; learnedAt: number };
};

/** A proposal waiting for the user, with why (R11/R29). */
export type NeedsCheckRow = { item: MemoryItem; reason: string; isGlobalStyle: boolean };

/** One line of "recently learned" (R29). */
export type RecentRow = {
  id: string;
  undo: 'cancel' | 'revertSupersession';
  kind: string;
  key: string;
  value: string;
  oldValue?: string;
  summary?: string;
  oldSummary?: string;
  at: number;
  migrated?: boolean;
};

type MemoryActionBody =
  | { action: 'confirm'; id: string }
  | { action: 'delete'; id: string }
  | { action: 'deleteBySource'; source?: string; sessionId?: string }
  | { action: 'autoApply.set'; enabled: boolean }
  // P3-M13a §3.1 — the undo behind a replacement notice.
  | { action: 'revertSupersession'; id: string }
  // memory-auto-apply R10/R29 — undo what learning did; answer a question.
  | { action: 'cancel'; id: string }
  | { action: 'questions.answer'; id: string; answer: 'a' | 'b' | 'both' | 'later' };

/** The i18n key for one "recently learned" line, by what happened (R29). */
export function recentRowKey(kind: string): string {
  switch (kind) {
    case 'applied':
      return 'memoryReview.recentApplied';
    case 'tidy-equivalent':
      return 'memoryReview.recentMerged';
    case 'tidy-refines':
    case 'refined':
      return 'memoryReview.recentRefined';
    case 'changed':
    case 'tidy-contradicts':
    case 'superseded':
    default:
      return 'memoryReview.recentChanged';
  }
}

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
  reason,
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
  /** memory-auto-apply R11/R29: why it waits — a hold code. */
  reason?: string;
  onConfirm: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  // R30: the evidence is one tap away rather than always open — the card must not
  // grow with what the model wrote, and most rows need no second look.
  const [showEvidence, setShowEvidence] = useState(false);
  const hasEvidence = Boolean(item.provenance.evidenceQuote || item.provenance.basisKind || item.provenance.sessionId);
  return (
    <div className="rounded-lg border border-border p-2.5 space-y-1.5" data-testid="memory-proposal">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium text-foreground break-words">{item.key}</div>
          {/* CLAMPED to two lines. The card must not grow with the length of
              whatever the model wrote; the browser shows the whole thing. */}
          <MemoryText value={item.value} {...(item.summary ? { summary: item.summary } : {})} className="text-sm text-foreground/90" />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {manualOnly ? (
            <span
              title={t('memoryReview.manualApprovalTitle')}
              className="text-[0.714rem] px-1.5 py-0.5 rounded-full font-medium bg-muted text-muted-foreground"
              data-testid="memory-manual-approval"
            >
              {t('memoryReview.manualApproval')}
            </span>
          ) : null}
          <ScopeBadge scope={item.scope as NabyScopeId} cwd={cwd} />
        </div>
      </div>
      {reason ? (
        <div className="text-[0.714rem] text-muted-foreground" data-testid="memory-hold-reason">
          {t(`chat.memoryHold.${reason}`, { defaultValue: t('chat.memoryHold.default') })}
        </div>
      ) : null}
      {showEvidence ? (
        <div className="text-[0.714rem] text-muted-foreground space-y-0.5" data-testid="memory-evidence">
          {item.provenance.evidenceQuote ? (
            <div className="break-words">{t('memoryReview.evidenceQuote', { quote: item.provenance.evidenceQuote })}</div>
          ) : null}
          {item.provenance.basisKind ? (
            <div>
              {t(item.provenance.basisKind === 'stated' ? 'memoryReview.basisStated' : 'memoryReview.basisInferred')}
            </div>
          ) : null}
          {item.provenance.sessionId ? (
            <div>{t('memoryReview.learnedIn', { session: item.provenance.sessionId.slice(0, 8) })}</div>
          ) : null}
        </div>
      ) : null}
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
          className="text-xs px-2 py-1 rounded border border-border hover:bg-destructive/10 hover:border-destructive/40 text-destructive disabled:opacity-50"
        >
          {t('memoryReview.delete')}
        </button>
        {hasEvidence ? (
          <button
            onClick={() => setShowEvidence((v) => !v)}
            aria-expanded={showEvidence}
            className="text-xs px-1 text-muted-foreground hover:text-foreground"
          >
            {t('memoryReview.evidenceToggle')}
          </button>
        ) : null}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// One open question (memory-auto-apply §5), answerable here as well as in the
// popup — the popup is rare by design (R27), so this is where a snoozed one waits.
// ---------------------------------------------------------------------------

const QuestionRow = memo(function QuestionRow({
  question,
  busy,
  onAnswer,
}: {
  question: MemoryQuestionRow;
  busy: boolean;
  onAnswer: (id: string, answer: 'a' | 'b' | 'both') => void;
}) {
  const { t, i18n } = useTranslation();
  const metaOf = (side: 'a' | 'b') =>
    side === 'b' && question.kind === 'overwrite'
      ? t('memoryQuestion.newCandidate')
      : t('memoryQuestion.learnedAt', {
          date: new Date(question[side].learnedAt).toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' }),
        });
  return (
    <div className="rounded-lg border border-border p-3 space-y-2" data-testid="memory-question">
      <div>
        <div className="text-sm font-medium text-foreground">{t('memoryReview.questionLine')}</div>
        <div className="text-xs text-muted-foreground">{t('memoryReview.questionHint')}</div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {(['a', 'b'] as const).map((side) => (
          <MemoryChoiceCard
            key={side}
            value={question[side].value}
            meta={metaOf(side)}
            pickLabel={t('memoryReview.pickThis')}
            moreLabel={t('memoryQuestion.showMore')}
            lessLabel={t('memoryQuestion.showLess')}
            disabled={busy}
            onPick={() => onAnswer(question.id, side)}
          />
        ))}
      </div>
      <div className="flex justify-end">
        <button
          onClick={() => onAnswer(question.id, 'both')}
          disabled={busy}
          className="text-xs px-2 py-1 rounded border border-border hover:bg-accent text-foreground disabled:opacity-50"
        >
          {t('memoryReview.keepBoth')}
        </button>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// One line of "recently learned" (memory-auto-apply R29), with its undo.
// ---------------------------------------------------------------------------

const RecentLearnedRow = memo(function RecentLearnedRow({
  row,
  busy,
  onUndo,
}: {
  row: RecentRow;
  busy: boolean;
  onUndo: (row: RecentRow) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start justify-between gap-2 py-1" data-testid="memory-recent-row">
      <div className="text-xs text-foreground/90 break-words line-clamp-3 min-w-0">
        {t(recentRowKey(row.kind), { value: row.summary ?? row.value, old: row.oldSummary ?? row.oldValue ?? '' })}
      </div>
      <button
        onClick={() => onUndo(row)}
        disabled={busy}
        title={t('memoryReview.undoTitle')}
        className="shrink-0 text-xs px-2 py-0.5 rounded border border-border hover:bg-accent text-foreground disabled:opacity-50"
      >
        {t('memoryReview.undo')}
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
  const [autoApply, setAutoApply] = useState(true);
  const [learningEnabled, setLearningEnabled] = useState(true);
  // P3-M13c §3.3: READ-ONLY. There is deliberately no control here — the profile
  // is counted from the user's own messages and the only thing to do with it is
  // see it (and, if it is wrong, turn learning off or clear the memory that
  // shaped it). null means "not enough evidence yet", which is a normal state.
  const [style, setStyle] = useState<StyleFingerprint | null>(null);
  const [styleMinSamples, setStyleMinSamples] = useState(20);
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
      setAutoApply(res.data.autoApply !== false);
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

  // memory-auto-apply R29: undo one "recently learned" line — the review's
  // own undo for what it did, or the supersession revert for a replacement a
  // person's confirm made.
  const handleUndo = useCallback(
    (row: RecentRow) =>
      void runAction(
        row.id,
        row.undo === 'cancel' ? { action: 'cancel', id: row.id } : { action: 'revertSupersession', id: row.id },
        'memoryReview.undone',
      ),
    [runAction],
  );

  const handleAnswer = useCallback(
    (id: string, answer: 'a' | 'b' | 'both') =>
      void runAction(id, { action: 'questions.answer', id, answer }, 'memoryReview.answered'),
    [runAction],
  );

  const handleBulk = useCallback(
    (body: MemoryActionBody) => void runAction('__bulk__', body, 'memoryReview.deleted'),
    [runAction],
  );

  const handleAutoApply = useCallback(
    async (enabled: boolean) => {
      // Optimistic, then reconciled by the reload: the checkbox has to answer the
      // click immediately, and the reload is what makes a failed write visible
      // (it puts the box back where the server says it is).
      setAutoApply(enabled);
      setBusyId('__setting__');
      try {
        const res = await memoryPost({ action: 'autoApply.set', enabled });
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
  // memory-auto-apply R29: the two groups. "Needs checking" holds the open
  // questions and the proposals waiting for a person (a row still inside its
  // review is not here); "recently learned" holds what naby started using this
  // week and what the tidy pass did, each with its undo.
  const questions = summary?.needsCheck?.questions ?? [];
  const proposals = (summary?.needsCheck?.proposed ?? []).filter((row) => !row.item.key.startsWith(STYLE_KEY_PREFIX));
  const styleProposals = (summary?.needsCheck?.proposed ?? []).filter((row) => row.item.key.startsWith(STYLE_KEY_PREFIX));
  const recent = summary?.recentLearned ?? [];
  const migratedCount = recent.filter((row) => row.migrated).length;
  const totalRows = scopes.reduce((n, s) => n + s.confirmed + s.proposed, 0);
  // The whole group disappears when there is nothing in it (R29) — see the header.
  const hasInbox = questions.length > 0 || proposals.length > 0 || styleProposals.length > 0;
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
          1. NEEDS CHECKING (memory-auto-apply R29, formerly the decisions inbox
          of settings-ia-reorg §3.3). First, because it is the only thing on this
          tab waiting for the user: open questions and the proposals held for a
          person, each with why. Absent entirely when empty (R32).
          ------------------------------------------------------------------ */}
      {hasInbox ? (
        <div className="space-y-2" data-testid="memory-inbox">
          {/* THE HEADING CARRIES THE COUNT, from `pendingCount` — the same field
              the server counts uncapped — rather than from the lengths of the
              lists below. A "1" with no noun beside it was read as an
              unexplained ornament; a number over the rows it counts is not. */}
          <div
            className="text-[0.714rem] uppercase tracking-wide text-muted-foreground"
            data-testid="memory-inbox-heading"
          >
            {t('memoryReview.needsCheckTitle')}
            {' · '}
            {t('memoryReview.summaryPendingCount', { count: summary?.pendingCount ?? 0 })}
          </div>

          {questions.length > 0 ? (
            <div className="space-y-1.5" data-testid="memory-questions">
              {questions.map((q) => (
                <QuestionRow key={q.id} question={q} busy={busy} onAnswer={handleAnswer} />
              ))}
            </div>
          ) : null}

          {proposals.length > 0 ? (
            <div className="space-y-1.5" data-testid="memory-proposals">
              <div className="text-[0.714rem] text-muted-foreground">
                {t('memoryReview.inboxMemory')}
              </div>
              {proposals.map(({ item, reason }) => (
                <ProposalRow
                  key={item.id}
                  item={item}
                  cwd={cwd}
                  busy={busy}
                  reason={reason}
                  onConfirm={handleConfirm}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          ) : null}

          {/* Style proposals — the same row, one badge different: the global ones
              can never be switched on by anything but a person (P3-M13c §3.3). */}
          {styleProposals.length > 0 ? (
            <div className="space-y-1.5" data-testid="memory-style-proposals">
              <div className="text-[0.714rem] text-muted-foreground">
                {t('memoryReview.inboxStyle')}
              </div>
              {styleProposals.map(({ item, reason, isGlobalStyle }) => (
                <ProposalRow
                  key={item.id}
                  item={item}
                  cwd={cwd}
                  busy={busy}
                  reason={reason}
                  manualOnly={isGlobalStyle}
                  onConfirm={handleConfirm}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ------------------------------------------------------------------
          1b. RECENTLY LEARNED (memory-auto-apply R29) — a record, not an
          approval queue: what naby started using this week, what it changed,
          and what the tidy pass merged. Every line is undoable, because the
          machine did these without asking (R19: nothing here deleted anything).
          ------------------------------------------------------------------ */}
      {recent.length > 0 ? (
        <div className="space-y-1" data-testid="memory-recent">
          <div className="text-[0.714rem] uppercase tracking-wide text-muted-foreground">
            {t('memoryReview.recentTitle')}
          </div>
          {migratedCount > 0 ? (
            <div className="text-[0.714rem] text-muted-foreground" data-testid="memory-recent-migrated">
              {t('memoryReview.recentMigrated', { count: migratedCount })}
            </div>
          ) : null}
          {recent.map((row) => (
            <RecentLearnedRow key={`${row.undo}:${row.id}`} row={row} busy={busy} onUndo={handleUndo} />
          ))}
        </div>
      ) : null}

      {/* ------------------------------------------------------------------
          2. THE SUMMARY LINE — what is true right now, plus the evidence that
          the automatic half is running.
          ------------------------------------------------------------------ */}
      <div className="space-y-1.5" data-testid="memory-summary">
        <div className="text-[0.714rem] uppercase tracking-wide text-muted-foreground">
          {t('memoryReview.summaryTitle')}
        </div>
        {loading && !summary ? (
          <p className="text-xs text-muted-foreground">{t('memoryReview.loading')}</p>
        ) : error ? (
          <p className="text-xs text-destructive">
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
                  <span className="text-warning">
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
        <p className="text-[0.714rem] text-muted-foreground" data-testid="memory-last-reflection">
          {t(reflection.key, { count: reflection.count })}
        </p>
      </div>

      {/* ------------------------------------------------------------------
          3. HOW IT LEARNS — both switches, and the four channels they govern.
          ------------------------------------------------------------------ */}
      <div className="pt-1 border-t border-border/60 space-y-1.5" data-testid="memory-learning-method">
        <div className="text-[0.714rem] uppercase tracking-wide text-muted-foreground">
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
        <p className="text-[0.714rem] text-muted-foreground leading-relaxed pl-6">
          {t('memoryReview.learningHint')}
        </p>

        {/* memory-auto-apply R31 — USE WHAT IT LEARNS RIGHT AWAY. It replaced
            the corroboration opt-in. The hint states the one thing it never
            does: outside content always waits for the user, switch or no switch. */}
        <label className="flex items-start gap-2 text-xs text-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={autoApply}
            disabled={busy}
            onChange={(e) => void handleAutoApply(e.target.checked)}
            className="mt-0.5 accent-brand disabled:opacity-50"
            data-testid="memory-auto-apply-toggle"
          />
          <span>{t('memoryReview.autoApplyLabel')}</span>
        </label>
        <p className="text-[0.714rem] text-muted-foreground leading-relaxed pl-6">
          {t('memoryReview.autoApplyHint')}
        </p>

        {/* THE FOUR CHANNELS, one sentence each. Together the two switches above
            do not answer "so what actually gets remembered, and when do I get
            asked?" — these do, and they are what makes the badge above
            predictable rather than surprising. */}
        <ul className="pl-6 space-y-0.5" data-testid="memory-channels">
          {LEARNING_CHANNEL_KEYS.map((key) => (
            <li key={key} className="text-[0.714rem] text-muted-foreground leading-relaxed">
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
        <div className="text-[0.714rem] uppercase tracking-wide text-muted-foreground">
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
        <p className="text-[0.714rem] text-muted-foreground leading-relaxed">
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
          <div className="text-[0.714rem] uppercase tracking-wide text-muted-foreground">
            {t('memoryReview.bulkTitle')}
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <button
              onClick={() => handleBulk({ action: 'deleteBySource', source: 'external' })}
              disabled={busy}
              className="text-xs px-2 py-1 rounded border border-border hover:bg-destructive/10 hover:border-destructive/40 text-destructive disabled:opacity-50"
            >
              {t('memoryReview.deleteExternal')}
            </button>
            {sessionId ? (
              <button
                onClick={() => handleBulk({ action: 'deleteBySource', sessionId })}
                disabled={busy}
                className="text-xs px-2 py-1 rounded border border-border hover:bg-destructive/10 hover:border-destructive/40 text-destructive disabled:opacity-50"
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
