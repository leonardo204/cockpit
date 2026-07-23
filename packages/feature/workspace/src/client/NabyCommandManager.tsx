'use client';

/**
 * Phase 1.6 HP-02 — the Naby-owned command CRUD panel, rendered inside
 * SettingsModal next to the Memory review (P15-06).
 *
 * WHY IT IS A UI. The shell slash palette used to be HARDCODED (`/qa`, `/fx`, …)
 * with no way for the owner to add or remove a command — the first slice of the
 * dev/prod harness cliff. This panel makes commands Naby-OWNED, scoped rows: the
 * user CREATES a command (verb + template body + optional argumentHint), EDITS
 * it, DELETES it, or toggles it ENABLED/DISABLED. An enabled command shows in the
 * chat slash dropdown (merged with builtins) and expands identically on all five
 * providers AND the dev engine, because expansion happens above the engine seam.
 *
 * SCOPE KEYING. `user` scope needs no key from the client — the server fills the
 * single-user-machine constant (`DEFAULT_USER_ID`). `project` is addressed by the
 * active `cwd` this component is handed; when it is absent (Settings opened with
 * no project) the project scope shows an unavailable notice rather than a broken
 * request. Mirrors NabyMemoryReview's keying.
 *
 * PERF. Lives in a modal that only mounts while open, so it is off the
 * always-rendered three-panel hot path; still, callbacks are `useCallback`-stable
 * and each row is a `memo`'d child fed per-item primitives + stable callbacks,
 * matching the repo's referential-stability rule.
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';
// Shared scope identity (icon/colour/label, selector, banner, row badge). Org is
// UI-gated in there.
import { ScopeBadge, ScopeHeader, ScopeSelector, projectName, type NabyScopeId } from './nabyScope';
// Type-only import: erased at compile time, so no runtime/node code enters the
// browser bundle. The shapes are the runtime's own (contract §3) — never
// redefined here.
import type { HarnessItem, HarnessScope, HarnessStatus } from '../../../../../../dist/naby-runtime.mjs';

// ---------------------------------------------------------------------------
// Wire helpers — same shape/style as NabyMemoryReview's memoryGet/memoryPost.
// ---------------------------------------------------------------------------

type HarnessListResponse = { scope: HarnessScope; scopeKey: string; items: HarnessItem[] };

type HarnessActionBody =
  | {
      action: 'create';
      scope: HarnessScope;
      scopeKey?: string;
      name: string;
      description?: string;
      template: string;
      argumentHint?: string;
    }
  | {
      action: 'update';
      id: string;
      name?: string;
      description?: string;
      template?: string;
      argumentHint?: string;
    }
  | { action: 'delete'; id: string }
  | { action: 'setEnabled'; id: string; enabled: boolean };

async function harnessGet(
  scope: HarnessScope,
  scopeKey: string | undefined,
  status: HarnessStatus | undefined,
): Promise<{ ok: true; data: HarnessListResponse } | { ok: false; error: string }> {
  try {
    const params = new URLSearchParams({ scope });
    if (scopeKey) params.set('scopeKey', scopeKey);
    if (status) params.set('status', status);
    const res = await fetch(`/api/harness?${params.toString()}`);
    const json = (await res.json().catch(() => null)) as
      | (HarnessListResponse & { error?: string })
      | null;
    if (!res.ok) return { ok: false, error: json?.error ?? `request failed (${res.status})` };
    return { ok: true, data: json as HarnessListResponse };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function harnessPost(body: HarnessActionBody): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/harness', {
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

const CommandRow = memo(function CommandRow({
  item,
  scope,
  cwd,
  busy,
  onEdit,
  onToggle,
  onDelete,
}: {
  item: HarnessItem;
  scope: NabyScopeId;
  cwd?: string;
  busy: boolean;
  onEdit: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  const enabled = item.status === 'enabled';

  return (
    <div className="rounded-lg border border-border p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-mono font-medium text-foreground break-words">/{item.name}</div>
          {item.description ? (
            <div className="text-xs text-muted-foreground break-words">{item.description}</div>
          ) : null}
          <div className="text-sm text-foreground/90 break-words whitespace-pre-wrap mt-1 line-clamp-3">
            {item.command?.template}
          </div>
          {item.command?.argumentHint ? (
            <div className="text-[10px] text-muted-foreground mt-1">
              {t('commandManager.argumentHintLabel')}: <span className="font-mono">{item.command.argumentHint}</span>
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Which scope this command lives in — global vs this project. */}
          <ScopeBadge scope={scope} cwd={cwd} />
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
              enabled
                ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
            }`}
          >
            {enabled ? t('commandManager.badgeEnabled') : t('commandManager.badgeDisabled')}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => onEdit(item.id)}
          disabled={busy}
          className="text-xs px-2 py-1 rounded border border-border hover:bg-accent text-foreground disabled:opacity-50"
        >
          {t('commandManager.edit')}
        </button>
        <button
          onClick={() => onToggle(item.id, !enabled)}
          disabled={busy}
          className="text-xs px-2 py-1 rounded border border-border hover:bg-accent text-foreground disabled:opacity-50"
        >
          {enabled ? t('commandManager.disable') : t('commandManager.enable')}
        </button>
        <button
          onClick={() => onDelete(item.id)}
          disabled={busy}
          className="text-xs px-2 py-1 rounded border border-border hover:bg-red-500/10 hover:border-red-500/40 text-red-600 dark:text-red-400 disabled:opacity-50"
        >
          {t('commandManager.delete')}
        </button>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// The panel.
// ---------------------------------------------------------------------------

// Commands are addressable by global (`user`) and this-project scope. Rendered
// via the shared ScopeSelector.
const COMMAND_SCOPES: NabyScopeId[] = ['user', 'project'];

interface DraftState {
  id: string | null; // null = creating, non-null = editing that id
  name: string;
  template: string;
  argumentHint: string;
  description: string;
}

const EMPTY_DRAFT: DraftState = { id: null, name: '', template: '', argumentHint: '', description: '' };

export function NabyCommandManager({
  isOpen,
  cwd,
}: {
  isOpen: boolean;
  cwd?: string;
}) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<HarnessScope>('user');
  const [items, setItems] = useState<HarnessItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);

  // The scopeKey the client can supply per scope. `user` is server-defaulted so
  // it needs none; `project` is addressed by the active cwd. `null` => this scope
  // cannot be queried right now (no project open).
  const scopeKey = useMemo<string | null | undefined>(() => {
    switch (scope) {
      case 'user':
        return undefined; // server fills the single-user constant
      case 'project':
        return cwd ?? null;
      case 'org':
        return null; // no local org id in single-user builds
    }
  }, [scope, cwd]);

  const available = scopeKey !== null;

  const reload = useCallback(async () => {
    if (scopeKey === null) {
      setItems([]);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    // Both enabled and disabled — this is the management surface, not the palette.
    const res = await harnessGet(scope, scopeKey ?? undefined, undefined);
    if (res.ok) {
      setItems(res.data.items);
    } else {
      setItems([]);
      setError(res.error);
    }
    setLoading(false);
  }, [scope, scopeKey]);

  useEffect(() => {
    if (isOpen) void reload();
  }, [isOpen, reload]);

  // Leaving a scope (or closing) abandons an in-progress draft so it does not
  // leak into another scope's create form.
  useEffect(() => {
    setDraft(null);
  }, [scope]);

  const startCreate = useCallback(() => setDraft({ ...EMPTY_DRAFT }), []);

  const startEdit = useCallback(
    (id: string) => {
      const it = items.find((i) => i.id === id);
      if (!it) return;
      setDraft({
        id: it.id,
        name: it.name,
        template: it.command?.template ?? '',
        argumentHint: it.command?.argumentHint ?? '',
        description: it.description ?? '',
      });
    },
    [items],
  );

  const cancelDraft = useCallback(() => setDraft(null), []);

  const submitDraft = useCallback(async () => {
    if (!draft) return;
    const name = draft.name.trim().replace(/^\//, '');
    if (!name) {
      toast(t('commandManager.errorNameRequired'), 'error');
      return;
    }
    if (!draft.template.trim()) {
      toast(t('commandManager.errorTemplateRequired'), 'error');
      return;
    }
    setBusyId('__draft__');
    try {
      const body: HarnessActionBody =
        draft.id === null
          ? {
              action: 'create',
              scope,
              ...(scopeKey ? { scopeKey } : {}),
              name,
              template: draft.template,
              ...(draft.argumentHint.trim() ? { argumentHint: draft.argumentHint.trim() } : {}),
              ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
            }
          : {
              action: 'update',
              id: draft.id,
              name,
              template: draft.template,
              argumentHint: draft.argumentHint.trim(),
              description: draft.description.trim(),
            };
      const res = await harnessPost(body);
      if (res.ok) {
        toast(t(draft.id === null ? 'commandManager.created' : 'commandManager.updated'), 'success');
        setDraft(null);
        await reload();
      } else {
        toast(t('commandManager.actionError', { error: res.error ?? '' }), 'error');
      }
    } finally {
      setBusyId(null);
    }
  }, [draft, scope, scopeKey, reload, t]);

  const runRowAction = useCallback(
    async (id: string, body: HarnessActionBody, successKey: string) => {
      setBusyId(id);
      try {
        const res = await harnessPost(body);
        if (res.ok) {
          toast(t(successKey), 'success');
          await reload();
        } else {
          toast(t('commandManager.actionError', { error: res.error ?? '' }), 'error');
        }
      } finally {
        setBusyId(null);
      }
    },
    [reload, t],
  );

  const handleToggle = useCallback(
    (id: string, enabled: boolean) =>
      void runRowAction(
        id,
        { action: 'setEnabled', id, enabled },
        enabled ? 'commandManager.enabled' : 'commandManager.disabled',
      ),
    [runRowAction],
  );

  const handleDelete = useCallback(
    (id: string) => void runRowAction(id, { action: 'delete', id }, 'commandManager.deleted'),
    [runRowAction],
  );

  const busy = busyId !== null;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t('commandManager.description')}</p>

      {/* Scope filter + banner: whether these commands are global (every
          project) or bound to this project. */}
      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('commandManager.scope')}
        </div>
        <ScopeSelector
          scopes={COMMAND_SCOPES}
          value={scope as NabyScopeId}
          onChange={(s) => setScope(s as HarnessScope)}
        />
        <ScopeHeader scope={scope as NabyScopeId} cwd={cwd} />
      </div>

      {/* Create / Edit form */}
      {available ? (
        draft ? (
          <div className="rounded-lg border border-brand/40 p-3 space-y-2 bg-brand/5">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {draft.id === null ? t('commandManager.createTitle') : t('commandManager.editTitle')}
              </div>
              {/* Make the SAVE TARGET scope explicit so a new command is never
                  accidentally created global when the user meant this project. */}
              <span className="text-[10px] text-muted-foreground">
                {scope === 'user'
                  ? t('scope.targetGlobal')
                  : t('scope.targetProject', { name: projectName(cwd) || t('scope.noProject') })}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-sm font-mono text-muted-foreground">/</span>
              <input
                value={draft.name}
                onChange={(e) => setDraft((d) => (d ? { ...d, name: e.target.value } : d))}
                placeholder={t('commandManager.namePlaceholder')}
                className="flex-1 text-sm px-2 py-1 border border-border rounded bg-card text-foreground font-mono focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <textarea
              value={draft.template}
              onChange={(e) => setDraft((d) => (d ? { ...d, template: e.target.value } : d))}
              placeholder={t('commandManager.templatePlaceholder')}
              rows={4}
              className="w-full text-sm px-2 py-1 border border-border rounded bg-card text-foreground resize-y focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <input
              value={draft.argumentHint}
              onChange={(e) => setDraft((d) => (d ? { ...d, argumentHint: e.target.value } : d))}
              placeholder={t('commandManager.argumentHintPlaceholder')}
              className="w-full text-sm px-2 py-1 border border-border rounded bg-card text-foreground font-mono focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <input
              value={draft.description}
              onChange={(e) => setDraft((d) => (d ? { ...d, description: e.target.value } : d))}
              placeholder={t('commandManager.descriptionPlaceholder')}
              className="w-full text-sm px-2 py-1 border border-border rounded bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={() => void submitDraft()}
                disabled={busy}
                className="text-xs px-3 py-1 rounded border border-brand bg-brand/10 text-brand hover:bg-brand/20 disabled:opacity-50"
              >
                {t('commandManager.save')}
              </button>
              <button
                onClick={cancelDraft}
                disabled={busy}
                className="text-xs px-3 py-1 rounded border border-border hover:bg-accent text-foreground disabled:opacity-50"
              >
                {t('commandManager.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={startCreate}
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded border border-brand bg-brand/10 text-brand hover:bg-brand/20 disabled:opacity-50"
          >
            {t('commandManager.newCommand')}
          </button>
        )
      ) : null}

      {/* List */}
      {!available ? (
        <p className="text-xs text-muted-foreground italic">{t('commandManager.projectUnavailable')}</p>
      ) : loading ? (
        <p className="text-xs text-muted-foreground">{t('commandManager.loading')}</p>
      ) : error ? (
        <p className="text-xs text-red-600 dark:text-red-400">
          {t('commandManager.loadError', { error })}
        </p>
      ) : items.length === 0 ? (
        <div className="text-xs text-muted-foreground space-y-1 py-2">
          <p>{t('commandManager.empty')}</p>
          <p className="text-muted-foreground/60">{t('commandManager.emptyHint')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <CommandRow
              key={item.id}
              item={item}
              scope={scope as NabyScopeId}
              cwd={cwd}
              busy={busy}
              onEdit={startEdit}
              onToggle={handleToggle}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
