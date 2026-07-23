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

// ---------------------------------------------------------------------------
// Wire helpers — the same shape/style as NabyProviderSetup's nabyGet/nabyPost.
// ---------------------------------------------------------------------------

type MemoryListResponse = { scope: MemoryScope; scopeKey: string; items: MemoryItem[] };

type MemoryActionBody =
  | { action: 'confirm'; id: string }
  | { action: 'delete'; id: string }
  | { action: 'deleteBySource'; source?: TrustTier; sessionId?: string };

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

const MemoryRow = memo(function MemoryRow({
  item,
  busy,
  onConfirm,
  onDelete,
}: {
  item: MemoryItem;
  busy: boolean;
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
        <span
          className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
            isProposed
              ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
              : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
          }`}
        >
          {isProposed ? t('memoryReview.badgeProposed') : t('memoryReview.badgeConfirmed')}
        </span>
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

const SCOPE_OPTIONS: { scope: MemoryScope; labelKey: string }[] = [
  { scope: 'user', labelKey: 'memoryReview.scopeUser' },
  { scope: 'session', labelKey: 'memoryReview.scopeSession' },
  { scope: 'project', labelKey: 'memoryReview.scopeProject' },
  { scope: 'org', labelKey: 'memoryReview.scopeOrg' },
];

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
    } else {
      setItems([]);
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

  const busy = busyId !== null;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t('memoryReview.description')}</p>

      {/* Scope filter */}
      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
          {t('memoryReview.scope')}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {SCOPE_OPTIONS.map((o) => (
            <button
              key={o.scope}
              onClick={() => setScope(o.scope)}
              className={`text-xs px-2 py-1 rounded border transition-colors ${
                scope === o.scope
                  ? 'border-brand bg-brand/10 text-brand'
                  : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              {t(o.labelKey)}
            </button>
          ))}
        </div>
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
          {items.map((item) => (
            <MemoryRow
              key={item.id}
              item={item}
              busy={busy}
              onConfirm={handleConfirm}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

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
