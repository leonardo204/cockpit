'use client';

/**
 * The memory SUMMARY CARD, rendered inside SettingsModal.
 *
 * WHAT IT USED TO BE, AND WHY IT CHANGED (P3-M10, memory-hygiene §1/§4). This was
 * the full review list: every memory in the selected scope, inline, with its
 * provenance and its buttons. That made the size of the Settings pane a function
 * of how much naby had learned — the better the product worked, the longer the
 * settings screen got, until the panel below it was several scrolls away. The
 * list moved to a dedicated full-height browser (`MemoryBrowserModal`) and what
 * stays here is FIXED SIZE, whatever the memory grows to:
 *
 *   * counts per scope (confirmed / waiting / unused),
 *   * the newest three PROPOSALS with confirm+delete inline, because a pending
 *     decision is the one thing that should not need a second click to find,
 *   * the two switches this section owns — learn-at-all (§3) and auto-confirm
 *     (§5.4) — and the button that opens the browser.
 *
 * WHY THE PROPOSALS STAYED AND THE REST WENT. The panel's job in Settings is to
 * answer "is there anything I need to do?". Three pending rows answer it; four
 * hundred confirmed ones are a filing cabinet, and a filing cabinet belongs
 * behind a door.
 *
 * IT IS STILL THE LAST DEFENSIVE LAYER. Confirming a `proposed` row is the ONLY
 * path external-origin memory becomes confirmed (memory-contracts §4 invariant
 * 1), and the poisoning rollback (delete-by-source) is still here — both are
 * things a user reaches for when something has gone wrong, and neither should
 * have moved further away.
 *
 * PERF + LAYOUT. Mounted only while the modal is open. Flat by contract (no
 * card, no tint — settingsLayout.test.ts asserts it); the proposal rows keep
 * their borders because a repeated list item is what a border is still for.
 */

import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';
import { ScopeBadge, type NabyScopeId } from './nabyScope';
// Type-only import: erased at compile time, so no runtime/node code enters the
// browser bundle. The shapes are the runtime's own (contract §3).
import type {
  MemoryItem,
  MemoryScope,
} from '../../../../../../dist/naby-runtime.mjs';
import { BootstrapCard } from './BootstrapCard';
import { MemoryBrowserModal } from './MemoryBrowserModal';
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
};

type SummaryResponse = {
  scopes: ScopeSummary[];
  recentProposed: MemoryItem[];
  corroboration?: Record<string, number>;
  autoConfirm?: boolean;
  corroborationThreshold?: number;
};

type MemoryActionBody =
  | { action: 'confirm'; id: string }
  | { action: 'delete'; id: string }
  | { action: 'deleteBySource'; source?: string; sessionId?: string }
  | { action: 'autoConfirm.set'; enabled: boolean };

async function fetchSummary(
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
): Promise<{ ok: boolean; learningEnabled?: boolean; error?: string }> {
  try {
    const res = await fetch('/api/naby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as
      | { learningEnabled?: boolean; error?: string }
      | null;
    if (!res.ok) return { ok: false, error: json?.error ?? `request failed (${res.status})` };
    return { ok: true, ...(json ?? {}) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// One pending proposal, inline on the card.
// ---------------------------------------------------------------------------

const ProposalRow = memo(function ProposalRow({
  item,
  cwd,
  busy,
  onConfirm,
  onDelete,
}: {
  item: MemoryItem;
  cwd?: string;
  busy: boolean;
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
        <ScopeBadge scope={item.scope as NabyScopeId} cwd={cwd} />
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
// The card.
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

export function NabyMemoryReview({
  isOpen,
  sessionId,
  cwd,
}: {
  isOpen: boolean;
  sessionId?: string;
  cwd?: string;
}) {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [autoConfirm, setAutoConfirm] = useState(false);
  const [learningEnabled, setLearningEnabled] = useState(true);
  const [threshold, setThreshold] = useState(3);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await fetchSummary(sessionId, cwd);
    if (res.ok) {
      setSummary(res.data);
      setAutoConfirm(res.data.autoConfirm === true);
      if (typeof res.data.corroborationThreshold === 'number') {
        setThreshold(res.data.corroborationThreshold);
      }
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
  const totalRows = scopes.reduce((n, s) => n + s.confirmed + s.proposed, 0);

  return (
    <div className="space-y-3">
      {/* Plain muted prose — the section's own description, not a callout. */}
      <p className="text-xs text-muted-foreground leading-relaxed">
        {t('memoryReview.description')}
      </p>

      {/* P15-07: the cold-start interview, shown only while it still has anything
          to ask. It writes CONFIRMED user memory, so the counts below refresh. */}
      <BootstrapCard isOpen={isOpen} onSaved={() => void reload()} />

      {/* The counts — the fixed-size replacement for the unbounded inline list. */}
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
              </div>
            ))}
          </div>
        )}
      </div>

      {/* The pending decisions, inline. Nothing else from the list survived here
          — see the file header for why these did. */}
      {proposals.length > 0 ? (
        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {t('memoryReview.summaryPending')}
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

      <div>
        <button
          onClick={() => setBrowserOpen(true)}
          className="text-xs px-2 py-1 rounded border border-border hover:bg-accent text-foreground"
          data-testid="memory-open-browser"
        >
          {t('memoryReview.openBrowser')}
        </button>
      </div>

      {/* P3-M10 §3 — LEARN AT ALL. First of the two switches, because it is the
          bigger one: it decides whether anything below it ever has input. The
          hint states the asymmetry that surprises people — off stops CAPTURE,
          not RECALL. */}
      <div className="pt-1 border-t border-border/60 space-y-1">
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
      </div>

      {/* P3-M8b §5.4 — the auto-confirm opt-in. Off by default and stated
          plainly, including the one thing it does NOT do: external-origin memory
          is never confirmed without a person, setting or no setting. */}
      <div className="pt-1 border-t border-border/60 space-y-1">
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
      </div>

      {/* Bulk cleanup — provenance-addressed delete (the poisoning rollback).
          Kept on the card rather than moved into the browser: it is what someone
          reaches for when memory has gone wrong, and that is not the moment to
          make them find a new screen first. */}
      <div className="pt-1 border-t border-border/60 space-y-1.5">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('memoryReview.bulkTitle')}
        </div>
        <div className="flex flex-wrap gap-1.5">
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

      {/* What "proposed" means — supplemental prose, so it waits until it is
          asked for (the shared disclosure, settingsLayout.test.ts). */}
      <SettingsDetails>
        <p>{t('memoryReview.proposedNote')}</p>
      </SettingsDetails>

      {/* The browser. Rendered from here because this is where it is opened from,
          and it stacks ABOVE the settings modal that contains this card. */}
      <MemoryBrowserModal
        isOpen={browserOpen}
        onClose={() => {
          setBrowserOpen(false);
          // The browser can confirm, edit and delete; the counts above have to
          // reflect that when it closes, or the card would keep showing the
          // numbers from before the user's work.
          void reload();
        }}
        {...(sessionId ? { sessionId } : {})}
        {...(cwd ? { cwd } : {})}
      />
    </div>
  );
}
