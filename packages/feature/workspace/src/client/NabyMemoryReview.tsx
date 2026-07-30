'use client';

/**
 * Phase 1.5 P15-06 — the scoped-memory review + delete panel, rendered inside
 * SettingsModal.
 *
 * WHY IT IS A UI AND NOT JUST A STORE OP. Scoped memory is durable, cross-session
 * personalization (contract §2/§3): `user`-scope rows outlive the session and
 * project they were learned in. That durability is exactly what makes an
 * `external`-origin memory dangerous — a `proposed` row planted by injected web
 * content persists until someone looks. This panel is the LAST DEFENSIVE LAYER:
 * it shows every memory WITH ITS PROVENANCE (which trust tier it came from, the
 * session it was learned in, why) and lets the user DELETE the wrong ones — one
 * row, or a whole source at once (the poisoning rollback). It is also the only
 * place a `proposed` row is CONFIRMED (contract §4 invariant 1) — no threshold
 * can do it, only a person here.
 *
 * THE VALUE IS SHOWN ON PURPOSE. Unlike the MCP section (which hides token-ish
 * header values), a memory `value` is the user's own remembered content; you
 * cannot vet a memory you are not allowed to read. So the row is rendered whole.
 *
 * SCOPE KEYING. `user` scope needs no key from the client — the server fills the
 * single-user-machine constant. `session`/`project` are addressed by the active
 * `sessionId`/`cwd` this component is handed; when the needed key is absent
 * (e.g. Settings opened with no session) the scope shows an unavailable notice
 * rather than a broken request. `org` has no local id yet, so it is unavailable
 * too — kept in the filter so the surface is complete when in-house rollout adds
 * one.
 *
 * PERF. This lives in a modal that only mounts while open, so it is not on the
 * always-rendered three-panel hot path; still, callbacks are `useCallback`-stable
 * and each row is a `memo`'d child fed per-item primitives, matching the repo's
 * referential-stability rule.
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';
// Shared scope identity: icon/colour/label per scope, the scope selector, the
// full-scope banner, and the per-row scope badge. Org is UI-gated in there.
import { ScopeBadge, ScopeHeader, ScopeSelector, type NabyScopeId } from './nabyScope';
// Type-only import: erased at compile time, so no runtime/node code enters the
// browser bundle. The shapes are the runtime's own (contract §3) — never
// redefined here.
import type {
  MemoryItem,
  MemoryScope,
  MemoryStatus,
  MemoryType,
  TrustTier,
} from '../../../../../../dist/naby-runtime.mjs';
import { BootstrapCard } from './BootstrapCard';

// ---------------------------------------------------------------------------
// Wire helpers — the same shape/style as NabyProviderSetup's nabyGet/nabyPost.
// ---------------------------------------------------------------------------

type MemoryListResponse = {
  scope: MemoryScope;
  scopeKey: string;
  items: MemoryItem[];
  /** P3-M8b: distinct sessions agreeing with each row's current value, by id. */
  corroboration?: Record<string, number>;
  /** P3-M8b: whether corroborated proposals are confirmed without a click. */
  autoConfirm?: boolean;
  /** P3-M8b: how many sessions that takes. Sent by the server so this file
   *  never has to hold a copy of a runtime constant (see memory.ts). */
  corroborationThreshold?: number;
};

type MemoryActionBody =
  | { action: 'confirm'; id: string }
  | { action: 'delete'; id: string }
  | { action: 'deleteBySource'; source?: TrustTier; sessionId?: string }
  | { action: 'autoConfirm.set'; enabled: boolean };

async function memoryGet(
  scope: MemoryScope,
  scopeKey: string | undefined,
  status: MemoryStatus | undefined,
): Promise<{ ok: true; data: MemoryListResponse } | { ok: false; error: string }> {
  try {
    const params = new URLSearchParams({ scope });
    if (scopeKey) params.set('scopeKey', scopeKey);
    if (status) params.set('status', status);
    const res = await fetch(`/api/memory?${params.toString()}`);
    const json = (await res.json().catch(() => null)) as
      | (MemoryListResponse & { error?: string })
      | null;
    if (!res.ok) return { ok: false, error: json?.error ?? `request failed (${res.status})` };
    return { ok: true, data: json as MemoryListResponse };
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

// ---------------------------------------------------------------------------
// One row. `memo`'d and fed per-item primitives + stable callbacks so a sibling
// action does not re-render the whole list.
// ---------------------------------------------------------------------------

const TYPE_LABELS: Record<MemoryType, string> = {
  working: 'memoryReview.typeWorking',
  episodic: 'memoryReview.typeEpisodic',
  semantic: 'memoryReview.typeSemantic',
  procedural: 'memoryReview.typeProcedural',
};

const TRUST_LABELS: Record<TrustTier, string> = {
  user: 'memoryReview.trustUser',
  artifact: 'memoryReview.trustArtifact',
  external: 'memoryReview.trustExternal',
};

/** From how many sessions a row is worth BADGING. One is every row that exists;
 *  two is the first moment a fact has outlived the conversation it came from,
 *  which is the thing a reviewer actually wants pointed out. */
const CORROBORATION_BADGE_MIN = 2;

const MemoryRow = memo(function MemoryRow({
  item,
  scope,
  cwd,
  busy,
  corroboration,
  onConfirm,
  onDelete,
}: {
  item: MemoryItem;
  scope: NabyScopeId;
  cwd?: string;
  busy: boolean;
  /** How many distinct sessions agree with this row's current value (P3-M8b). */
  corroboration: number;
  onConfirm: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  const isProposed = item.status === 'proposed';
  const shortSession = item.provenance.sessionId
    ? item.provenance.sessionId.slice(0, 8)
    : undefined;

  return (
    <div className="rounded-lg border border-border p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium text-foreground break-words">{item.key}</div>
          <div className="text-sm text-foreground/90 break-words whitespace-pre-wrap">
            {item.value}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* P3-M8b: cross-session corroboration. Shown only once a SECOND
              session has said the same thing — on every row it would be noise,
              and the point of the badge is that this one is different. */}
          {corroboration >= CORROBORATION_BADGE_MIN ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-sky-500/15 text-sky-600 dark:text-sky-400">
              {t('memoryReview.corroborated', { count: corroboration })}
            </span>
          ) : null}
          {/* Which scope this row lives in — global vs this project etc. */}
          <ScopeBadge scope={scope} cwd={cwd} />
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
              isProposed
                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
            }`}
          >
            {isProposed ? t('memoryReview.badgeProposed') : t('memoryReview.badgeConfirmed')}
          </span>
        </div>
      </div>

      {/* Provenance — the load-bearing part of a REVIEW surface. */}
      <div className="flex flex-wrap gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
        <span className="px-1.5 py-0.5 rounded bg-accent">{t(TYPE_LABELS[item.type])}</span>
        <span className="px-1.5 py-0.5 rounded bg-accent">
          {t(TRUST_LABELS[item.provenance.source])}
        </span>
        {shortSession ? <span>{t('memoryReview.learnedIn', { session: shortSession })}</span> : null}
        {item.provenance.basis ? (
          <span className="break-words">{t('memoryReview.basis', { basis: item.provenance.basis })}</span>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        {isProposed ? (
          <button
            onClick={() => onConfirm(item.id)}
            disabled={busy}
            title={t('memoryReview.confirmTitle')}
            className="text-xs px-2 py-1 rounded border border-border hover:bg-accent text-foreground disabled:opacity-50"
          >
            {t('memoryReview.confirm')}
          </button>
        ) : null}
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
// The panel.
// ---------------------------------------------------------------------------

// The scopes memory is addressable by, in display order. `org` is present but
// UI-gated by the shared ScopeSelector (hidden until org infra exists).
const MEMORY_SCOPES: NabyScopeId[] = ['user', 'session', 'project', 'org'];

const STATUS_OPTIONS: { value: MemoryStatus | 'all'; labelKey: string }[] = [
  { value: 'all', labelKey: 'memoryReview.statusAll' },
  { value: 'proposed', labelKey: 'memoryReview.statusProposed' },
  { value: 'confirmed', labelKey: 'memoryReview.statusConfirmed' },
];

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
  const [scope, setScope] = useState<MemoryScope>('user');
  const [status, setStatus] = useState<MemoryStatus | 'all'>('all');
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [corroboration, setCorroboration] = useState<Record<string, number>>({});
  const [autoConfirm, setAutoConfirm] = useState(false);
  // Server-supplied; the fallback only ever shows for the instant before the
  // first response lands.
  const [threshold, setThreshold] = useState(3);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // The scopeKey the client can supply per scope. `user` is server-defaulted so
  // it needs none; `session`/`project` are addressed by the active ids; `org`
  // has no local id yet. `null` => this scope cannot be queried right now.
  const scopeKey = useMemo<string | null | undefined>(() => {
    switch (scope) {
      case 'user':
        return undefined; // server fills the single-user constant
      case 'session':
        return sessionId ?? null;
      case 'project':
        return cwd ?? null;
      case 'org':
        return null; // no local org id in single-user builds
    }
  }, [scope, sessionId, cwd]);

  const available = scopeKey !== null;

  const reload = useCallback(async () => {
    if (scopeKey === null) {
      setItems([]);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const res = await memoryGet(
      scope,
      scopeKey ?? undefined,
      status === 'all' ? undefined : status,
    );
    if (res.ok) {
      setItems(res.data.items);
      setCorroboration(res.data.corroboration ?? {});
      setAutoConfirm(res.data.autoConfirm === true);
      if (typeof res.data.corroborationThreshold === 'number') {
        setThreshold(res.data.corroborationThreshold);
      }
    } else {
      setItems([]);
      setCorroboration({});
      setError(res.error);
    }
    setLoading(false);
  }, [scope, scopeKey, status]);

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
    async (body: MemoryActionBody) => {
      setBusyId('__bulk__');
      try {
        const res = await memoryPost(body);
        if (res.ok) {
          toast(t('memoryReview.deleted'), 'success');
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

  /**
   * P3-M8b §5.4 — proposals first, best-corroborated first inside that.
   *
   * The queue's whole job is to put the reviewer in front of the decisions that
   * are both PENDING and best evidenced. A `proposed` row is the only one that
   * needs an answer, and among those the one three separate conversations kept
   * arriving at is the one most likely to be true — so it should not be sitting
   * below a one-off from last Tuesday just because it was created earlier.
   */
  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'proposed' ? -1 : 1;
      const ca = corroboration[a.id] ?? 0;
      const cb = corroboration[b.id] ?? 0;
      if (ca !== cb) return cb - ca;
      return b.updatedAt - a.updatedAt;
    });
  }, [items, corroboration]);

  const busy = busyId !== null;

  return (
    <div className="space-y-3">
      <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground leading-relaxed">
        {t('memoryReview.description')}
      </p>

      {/* P15-07: the cold-start interview, shown only while it still has anything
          to ask. It writes CONFIRMED user memory, so the list below refreshes. */}
      <BootstrapCard isOpen={isOpen} onSaved={() => void reload()} />

      {/* Scope filter + banner: which memories you are looking at (global vs
          this project vs this session), stated plainly. */}
      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('memoryReview.scope')}
        </div>
        <ScopeSelector
          scopes={MEMORY_SCOPES}
          value={scope}
          onChange={(s) => setScope(s as MemoryScope)}
        />
        <ScopeHeader scope={scope} cwd={cwd} />
      </div>

      {/* Status filter */}
      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
          {t('memoryReview.status')}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {STATUS_OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => setStatus(o.value)}
              className={`text-xs px-2 py-1 rounded border transition-colors ${
                status === o.value
                  ? 'border-brand bg-brand/10 text-brand'
                  : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              {t(o.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      {!available ? (
        <p className="text-xs text-muted-foreground italic">{t('memoryReview.sessionUnavailable')}</p>
      ) : loading ? (
        <p className="text-xs text-muted-foreground">{t('memoryReview.loading')}</p>
      ) : error ? (
        <p className="text-xs text-red-600 dark:text-red-400">
          {t('memoryReview.loadError', { error })}
        </p>
      ) : items.length === 0 ? (
        <div className="text-xs text-muted-foreground space-y-1 py-2">
          <p>{t('memoryReview.empty')}</p>
          <p className="text-muted-foreground/60">{t('memoryReview.emptyHint')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {sortedItems.map((item) => (
            <MemoryRow
              key={item.id}
              item={item}
              scope={scope as NabyScopeId}
              cwd={cwd}
              busy={busy}
              corroboration={corroboration[item.id] ?? 0}
              onConfirm={handleConfirm}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {/* P3-M8b §5.4 — the opt-in. Off by default and stated plainly, including
          the one thing it does NOT do: external-origin memory is never confirmed
          without a person, setting or no setting (memory-contracts §4). */}
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

      {/* Bulk cleanup — provenance-addressed delete (the poisoning rollback). */}
      {available ? (
        <div className="pt-1 border-t border-border/60 space-y-1.5">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {t('memoryReview.bulkTitle')}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => void handleBulk({ action: 'deleteBySource', source: 'external' })}
              disabled={busy}
              className="text-xs px-2 py-1 rounded border border-border hover:bg-red-500/10 hover:border-red-500/40 text-red-600 dark:text-red-400 disabled:opacity-50"
            >
              {t('memoryReview.deleteExternal')}
            </button>
            {sessionId ? (
              <button
                onClick={() => void handleBulk({ action: 'deleteBySource', sessionId })}
                disabled={busy}
                className="text-xs px-2 py-1 rounded border border-border hover:bg-red-500/10 hover:border-red-500/40 text-red-600 dark:text-red-400 disabled:opacity-50"
              >
                {t('memoryReview.deleteThisSession')}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
