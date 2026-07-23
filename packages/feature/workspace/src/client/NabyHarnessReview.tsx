'use client';

/**
 * Phase 1.6 HP-04 + HP-06 — the harness IMPORT + REVIEW panel, rendered inside
 * SettingsModal below the command manager.
 *
 * WHAT IT DOES. It answers the owner's original question — "import someone else's
 * harness, pull in just certain skills". A trigger button imports a scope's
 * on-disk `~/.claude` (user) or `<project>/.claude` (project) commands, skills,
 * and subagents through the store's import gate; hooks are dropped and reported.
 * Because the items are EXTERNAL, the gate lands every one DISABLED — they are
 * inert until the owner reviews and ENABLES them here (contract §4 invariant 1).
 * The panel then lists every kind with kind/status filters, shows each item's
 * provenance (trust tier + origin), and offers enable/disable, per-item delete,
 * and a one-click "revert this import" that removes everything imported from that
 * `.claude` base by origin prefix (rollback of a bad set).
 *
 * WHY SEPARATE FROM NabyCommandManager. The command manager (HP-02) is the CRUD
 * surface for a user's OWN commands; this is the review surface for IMPORTED
 * items of ALL kinds. Keeping them apart keeps the command CRUD focused and lets
 * the review UI speak the trust/provenance language imports need.
 *
 * PERF. Lives in a modal that only mounts while open, off the always-rendered
 * three-panel hot path; still, callbacks are `useCallback`-stable and each row is
 * a `memo`'d child fed per-item primitives + stable callbacks (repo rule).
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';
// Shared scope identity. The org/team scope is UI-gated here via ScopeSelector +
// visibleScopes — the store / server API / HP-08 org logic below are untouched,
// only the org filter/target buttons are hidden until org infra exists.
import { ScopeBadge, ScopeHeader, ScopeSelector, type NabyScopeId } from './nabyScope';
// Type-only: erased at compile time, so no runtime/node code enters the browser
// bundle. Shapes are the runtime's own (contract §3).
import type {
  HarnessItem,
  HarnessKind,
  HarnessScope,
  HarnessSet,
  HarnessStatus,
  HarnessTrust,
} from '../../../../../../dist/naby-runtime.mjs';

// The import-summary WIRE shape (mirrors the server's HarnessImportSummary).
// Declared locally so the client never imports the server importer module.
interface ImportSummary {
  scope: HarnessScope;
  scopeKey: string;
  baseDir: string;
  baseExists: boolean;
  imported: { command: number; skill: number; subagent: number };
  skippedHooks: number;
  skipped: Array<{ origin: string; kind?: HarnessKind; reason: string }>;
  failed: Array<{ origin: string; error: string }>;
  items: HarnessItem[];
}

// ---------------------------------------------------------------------------
// Wire helpers.
// ---------------------------------------------------------------------------

type HarnessListResponse = { scope: HarnessScope; scopeKey: string; items: HarnessItem[] };

async function listAll(
  scope: HarnessScope,
  scopeKey: string | undefined,
): Promise<{ ok: true; data: HarnessListResponse } | { ok: false; error: string }> {
  try {
    const params = new URLSearchParams({ scope, kind: 'all' });
    if (scopeKey) params.set('scopeKey', scopeKey);
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

// The conflict shape the importSet action reports (mirrors the server's
// HarnessImportSetConflict) — an incoming item that landed under a distinct name
// because a local ENABLED item already owned its (scope,kind,name).
interface ImportSetConflict {
  kind: HarnessKind;
  requestedName: string;
  landedName: string;
}

type ActionBody =
  | { action: 'import'; scope: HarnessScope; scopeKey?: string; cwd?: string }
  | { action: 'setEnabled'; id: string; enabled: boolean }
  | { action: 'delete'; id: string }
  | { action: 'revertOrigin'; scope: HarnessScope; scopeKey?: string; originPrefix: string }
  | {
      action: 'exportSet';
      scope: HarnessScope;
      scopeKey?: string;
      name: string;
      version: string;
      ids?: string[];
    }
  | {
      action: 'importSet';
      set: HarnessSet;
      scope: HarnessScope;
      scopeKey?: string;
      ids?: string[];
    };

async function post<T = { ok: boolean }>(
  body: ActionBody,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch('/api/harness', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok) return { ok: false, error: json?.error ?? `request failed (${res.status})` };
    return { ok: true, data: json as T };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Trigger a browser download of a JSON document (the exported set). Pure DOM —
// the shell's local download pattern: Blob → object URL → a transient anchor
// click → revoke. No dialog/alert is used (extension-safe).
function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has committed the download first.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Make a filesystem-safe slug from a set name for the download filename. */
function slug(s: string): string {
  return s.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'set';
}

/** Client-side envelope guard for an uploaded/pasted set. The SERVER re-validates
 *  and the store re-derives trust, so this is only to give a clear parse error
 *  before the round-trip — never a trust boundary. */
function isHarnessSetShape(v: unknown): v is HarnessSet {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  if (typeof s.name !== 'string' || typeof s.version !== 'string') return false;
  if (!Array.isArray(s.items)) return false;
  return s.items.every((it) => {
    if (!it || typeof it !== 'object') return false;
    const row = it as Record<string, unknown>;
    return typeof row.id === 'string' && typeof row.kind === 'string' && typeof row.name === 'string';
  });
}

// ---------------------------------------------------------------------------
// One imported/owned harness row.
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<HarnessKind, string> = {
  command: 'harnessReview.kindCommand',
  skill: 'harnessReview.kindSkill',
  subagent: 'harnessReview.kindSubagent',
};

const TRUST_LABEL: Record<HarnessTrust, string> = {
  user: 'harnessReview.trustUser',
  artifact: 'harnessReview.trustArtifact',
  external: 'harnessReview.trustExternal',
};

/** A tool-bearing skill/subagent cannot execute until Phase 2.5 — surface that so
 *  enabling one is not mistaken for a fully working capability (strategy §6). */
function needsPhase25(item: HarnessItem): boolean {
  const refs =
    item.kind === 'skill'
      ? item.skill?.toolRefs
      : item.kind === 'subagent'
        ? item.subagent?.toolRefs
        : undefined;
  return Array.isArray(refs) && refs.length > 0;
}

const HarnessRow = memo(function HarnessRow({
  item,
  scope,
  cwd,
  busy,
  onToggle,
  onDelete,
}: {
  item: HarnessItem;
  scope: NabyScopeId;
  cwd?: string;
  busy: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  const enabled = item.status === 'enabled';
  const body =
    item.kind === 'command'
      ? item.command?.template
      : item.kind === 'skill'
        ? item.skill?.instructions
        : item.subagent?.systemPrompt;

  return (
    <div className="rounded-lg border border-border p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-brand/10 text-brand font-medium">
              {t(KIND_LABEL[item.kind])}
            </span>
            <span className="text-xs font-mono font-medium text-foreground break-words">
              {item.kind === 'command' ? `/${item.name}` : item.name}
            </span>
          </div>
          {item.description ? (
            <div className="text-xs text-muted-foreground break-words mt-0.5">{item.description}</div>
          ) : null}
          {body ? (
            <div className="text-sm text-foreground/90 break-words whitespace-pre-wrap mt-1 line-clamp-3">
              {body}
            </div>
          ) : null}
          <div className="text-[10px] text-muted-foreground mt-1 space-y-0.5">
            <div>
              {t('harnessReview.trustLabel')}:{' '}
              <span className="font-medium">{t(TRUST_LABEL[item.provenance.source])}</span>
            </div>
            {item.provenance.origin ? (
              <div className="break-all">
                {t('harnessReview.originLabel')}:{' '}
                <span className="font-mono">{item.provenance.origin}</span>
              </div>
            ) : null}
          </div>
          {needsPhase25(item) ? (
            <div className="text-[10px] text-amber-600 dark:text-amber-400 mt-1">
              {t('harnessReview.needsPhase25')}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Which scope this item lives in — global vs this project. */}
          <ScopeBadge scope={scope} cwd={cwd} />
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
              enabled
                ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
            }`}
          >
            {enabled ? t('harnessReview.badgeEnabled') : t('harnessReview.badgeDisabled')}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => onToggle(item.id, !enabled)}
          disabled={busy}
          className="text-xs px-2 py-1 rounded border border-border hover:bg-accent text-foreground disabled:opacity-50"
        >
          {enabled ? t('harnessReview.disable') : t('harnessReview.enable')}
        </button>
        <button
          onClick={() => onDelete(item.id)}
          disabled={busy}
          className="text-xs px-2 py-1 rounded border border-border hover:bg-red-500/10 hover:border-red-500/40 text-red-600 dark:text-red-400 disabled:opacity-50"
        >
          {t('harnessReview.delete')}
        </button>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// The panel.
// ---------------------------------------------------------------------------

// The scopes harness items are addressable by, in display order. `org` (HP-08:
// the team/org scope inherited by every user of an in-house build) is kept in
// the list but UI-gated by the shared ScopeSelector / visibleScopes — hidden
// until org infrastructure exists, never removed from the store/API.
const HARNESS_SCOPES: NabyScopeId[] = ['user', 'project', 'org'];

const KIND_FILTERS: { value: HarnessKind | 'all'; labelKey: string }[] = [
  { value: 'all', labelKey: 'harnessReview.kindAll' },
  { value: 'command', labelKey: 'harnessReview.kindCommand' },
  { value: 'skill', labelKey: 'harnessReview.kindSkill' },
  { value: 'subagent', labelKey: 'harnessReview.kindSubagent' },
];

const STATUS_FILTERS: { value: HarnessStatus | 'all'; labelKey: string }[] = [
  { value: 'all', labelKey: 'harnessReview.statusAll' },
  { value: 'enabled', labelKey: 'harnessReview.statusEnabled' },
  { value: 'disabled', labelKey: 'harnessReview.statusDisabled' },
];

// The scopes a set can be exported FROM / imported INTO — same list (and same
// org UI-gating) as the review filter. `project` needs an open project (cwd).
const SET_SCOPES: NabyScopeId[] = HARNESS_SCOPES;

/** Resolve the wire scopeKey override for a scope: `project` carries the cwd,
 *  `user`/`org` are server-defaulted (omit). Returns null when project has no cwd
 *  (unavailable). */
function scopeKeyOverride(
  scope: HarnessScope,
  cwd: string | undefined,
): { scopeKey?: string } | null {
  if (scope === 'project') return cwd ? { scopeKey: cwd } : null;
  return {};
}

// ---------------------------------------------------------------------------
// HP-05 export / import — the set bundle tools (download a scope as a file,
// upload/paste a file and merge selected items into a target scope).
// ---------------------------------------------------------------------------

const HarnessSetTools = memo(function HarnessSetTools({
  cwd,
  onImported,
}: {
  /** The active project cwd, addressing project-scope export/import. */
  cwd?: string;
  /** Called after a successful import so the review list can refresh. Receives
   *  the scope the items landed in so the parent can switch to it. */
  onImported: (landedScope: HarnessScope) => void;
}) {
  const { t } = useTranslation();

  // -- export state --
  const [exportScope, setExportScope] = useState<HarnessScope>('user');
  const [setName, setSetName] = useState('team-onboarding');
  const [setVersion, setSetVersion] = useState('1.0.0');
  const [exporting, setExporting] = useState(false);

  // -- import state --
  const [loaded, setLoaded] = useState<HarnessSet | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [importScope, setImportScope] = useState<HarnessScope>('user');
  const [importing, setImporting] = useState(false);
  const [landed, setLanded] = useState<{ count: number; conflicts: ImportSetConflict[] } | null>(
    null,
  );

  const exportOverride = scopeKeyOverride(exportScope, cwd);
  const importOverride = scopeKeyOverride(importScope, cwd);

  const doExport = useCallback(async () => {
    if (!exportOverride) return;
    setExporting(true);
    try {
      const res = await post<{ ok: boolean; set?: HarnessSet }>({
        action: 'exportSet',
        scope: exportScope,
        ...exportOverride,
        name: setName.trim() || 'harness-set',
        version: setVersion.trim() || '1.0.0',
      });
      if (res.ok && res.data.set) {
        const set = res.data.set;
        const count = set.items.length;
        if (count === 0) {
          toast(t('harnessSet.exportEmpty'), 'error');
        } else {
          downloadJson(`naby-harness-${slug(set.name)}-${slug(set.version)}.json`, set);
          toast(t('harnessSet.exportDone', { count }), 'success');
        }
      } else {
        toast(t('harnessSet.exportError', { error: res.ok ? 'no set' : res.error }), 'error');
      }
    } finally {
      setExporting(false);
    }
  }, [exportOverride, exportScope, setName, setVersion, t]);

  // Parse a set from raw text (file or paste), seeding the selection to ALL items.
  const loadFromText = useCallback(
    (text: string) => {
      try {
        const obj = JSON.parse(text) as unknown;
        if (!isHarnessSetShape(obj)) {
          throw new Error('not a HarnessSet (need name, version, items[])');
        }
        setLoaded(obj);
        setSelectedIds(new Set(obj.items.map((i) => i.id)));
        setParseError(null);
        setLanded(null);
        toast(
          t('harnessSet.loadedSet', {
            name: obj.name,
            version: obj.version,
            count: obj.items.length,
          }),
          'success',
        );
      } catch (e) {
        setLoaded(null);
        setParseError(e instanceof Error ? e.message : String(e));
      }
    },
    [t],
  );

  const onFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      const text = await file.text();
      loadFromText(text);
    },
    [loadFromText],
  );

  const toggleId = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    if (loaded) setSelectedIds(new Set(loaded.items.map((i) => i.id)));
  }, [loaded]);
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const clearLoaded = useCallback(() => {
    setLoaded(null);
    setSelectedIds(new Set());
    setPasteText('');
    setParseError(null);
    setLanded(null);
  }, []);

  const doImport = useCallback(async () => {
    if (!loaded || !importOverride) return;
    const ids = [...selectedIds];
    if (ids.length === 0) {
      toast(t('harnessSet.importNone'), 'error');
      return;
    }
    setImporting(true);
    try {
      const res = await post<{ ok: boolean; landed?: HarnessItem[]; conflicts?: ImportSetConflict[] }>(
        {
          action: 'importSet',
          set: loaded,
          scope: importScope,
          ...importOverride,
          ids,
        },
      );
      if (res.ok) {
        const count = res.data.landed?.length ?? 0;
        setLanded({ count, conflicts: res.data.conflicts ?? [] });
        toast(t('harnessSet.importDone', { count }), 'success');
        onImported(importScope);
      } else {
        toast(t('harnessSet.importError', { error: res.error }), 'error');
      }
    } finally {
      setImporting(false);
    }
  }, [loaded, importOverride, selectedIds, importScope, onImported, t]);

  // Scope picker for export-from / import-into. Uses the shared selector so org
  // stays UI-gated and each scope shows its icon/label; project is disabled when
  // no project is open.
  const scopeButtons = (
    current: HarnessScope,
    set: (s: HarnessScope) => void,
  ) => (
    <ScopeSelector
      scopes={SET_SCOPES}
      value={current as NabyScopeId}
      onChange={(s) => set(s as HarnessScope)}
      isDisabled={(s) => s === 'project' && !cwd}
    />
  );

  return (
    <div className="space-y-4 rounded-lg border border-border p-3">
      {/* EXPORT */}
      <div className="space-y-2">
        <div className="text-xs font-medium text-foreground">{t('harnessSet.exportTitle')}</div>
        <p className="text-[11px] text-muted-foreground">{t('harnessSet.exportDescription')}</p>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
            {t('harnessReview.scope')}
          </div>
          {scopeButtons(exportScope, setExportScope)}
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-muted-foreground">{t('harnessSet.nameLabel')}</span>
            <input
              value={setName}
              onChange={(e) => setSetName(e.target.value)}
              placeholder={t('harnessSet.namePlaceholder')}
              className="text-xs px-2 py-1 rounded border border-border bg-background text-foreground w-44"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-muted-foreground">{t('harnessSet.versionLabel')}</span>
            <input
              value={setVersion}
              onChange={(e) => setSetVersion(e.target.value)}
              placeholder={t('harnessSet.versionPlaceholder')}
              className="text-xs px-2 py-1 rounded border border-border bg-background text-foreground w-24"
            />
          </label>
        </div>
        <button
          onClick={() => void doExport()}
          disabled={exporting || !exportOverride}
          className="text-xs px-3 py-1.5 rounded border border-brand bg-brand/10 text-brand hover:bg-brand/20 disabled:opacity-50"
        >
          {exporting ? t('harnessSet.exporting') : t('harnessSet.exportButton')}
        </button>
      </div>

      <div className="border-t border-border" />

      {/* IMPORT */}
      <div className="space-y-2">
        <div className="text-xs font-medium text-foreground">{t('harnessSet.importTitle')}</div>
        <p className="text-[11px] text-muted-foreground">{t('harnessSet.importDescription')}</p>

        {/* File picker + paste fallback */}
        <input
          type="file"
          accept="application/json,.json"
          onChange={(e) => {
            void onFile(e.target.files?.[0]);
            // Reset so re-selecting the same file re-fires change.
            e.target.value = '';
          }}
          className="block text-xs text-muted-foreground file:mr-2 file:text-xs file:px-2 file:py-1 file:rounded file:border file:border-border file:bg-accent file:text-foreground"
        />
        <div className="text-[10px] text-muted-foreground">{t('harnessSet.orPaste')}</div>
        <div className="flex gap-2 items-start">
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder={t('harnessSet.pastePlaceholder')}
            rows={2}
            className="flex-1 text-[11px] font-mono px-2 py-1 rounded border border-border bg-background text-foreground resize-y"
          />
          <button
            onClick={() => loadFromText(pasteText)}
            disabled={pasteText.trim().length === 0}
            className="text-xs px-2 py-1 rounded border border-border hover:bg-accent text-foreground disabled:opacity-50 self-stretch"
          >
            {t('harnessSet.parse')}
          </button>
        </div>
        {parseError ? (
          <p className="text-[11px] text-red-600 dark:text-red-400">
            {t('harnessSet.parseError', { error: parseError })}
          </p>
        ) : null}

        {/* Loaded set → item selection + target scope + import */}
        {loaded ? (
          <div className="space-y-2 rounded-lg border border-border p-2.5 bg-muted/30">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-medium text-foreground">
                {t('harnessSet.loadedSet', {
                  name: loaded.name,
                  version: loaded.version,
                  count: loaded.items.length,
                })}
              </div>
              <button
                onClick={clearLoaded}
                className="text-[10px] px-1.5 py-0.5 rounded border border-border hover:bg-accent text-muted-foreground"
              >
                {t('harnessSet.clearLoaded')}
              </button>
            </div>

            <div className="flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {t('harnessSet.selectItems')}
              </div>
              <div className="flex gap-1.5">
                <button
                  onClick={selectAll}
                  className="text-[10px] px-1.5 py-0.5 rounded border border-border hover:bg-accent text-muted-foreground"
                >
                  {t('harnessSet.selectAll')}
                </button>
                <button
                  onClick={clearSelection}
                  className="text-[10px] px-1.5 py-0.5 rounded border border-border hover:bg-accent text-muted-foreground"
                >
                  {t('harnessSet.deselectAll')}
                </button>
              </div>
            </div>

            <div className="space-y-1 max-h-48 overflow-y-auto">
              {loaded.items.map((it) => (
                <label
                  key={it.id}
                  className="flex items-center gap-2 text-xs text-foreground cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(it.id)}
                    onChange={() => toggleId(it.id)}
                  />
                  <span className="text-[10px] px-1 py-0.5 rounded-full bg-brand/10 text-brand">
                    {t(KIND_LABEL[it.kind])}
                  </span>
                  <span className="font-mono break-all">
                    {it.kind === 'command' ? `/${it.name}` : it.name}
                  </span>
                </label>
              ))}
            </div>

            <div className="space-y-1.5">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {t('harnessSet.targetScope')}
              </div>
              {scopeButtons(importScope, setImportScope)}
              {/* Spell out the landing scope so imported items are never dropped
                  into the wrong place. */}
              <ScopeHeader scope={importScope as NabyScopeId} cwd={cwd} />
            </div>

            <button
              onClick={() => void doImport()}
              disabled={importing || !importOverride || selectedIds.size === 0}
              className="text-xs px-3 py-1.5 rounded border border-brand bg-brand/10 text-brand hover:bg-brand/20 disabled:opacity-50"
            >
              {importing
                ? t('harnessSet.importing')
                : `${t('harnessSet.importButton')} (${selectedIds.size})`}
            </button>

            {/* Landing result: everything disabled + any conflicts */}
            {landed ? (
              <div className="space-y-1 text-[11px] text-muted-foreground">
                <div className="text-emerald-600 dark:text-emerald-400">
                  {t('harnessSet.importDone', { count: landed.count })}
                </div>
                <div>{t('harnessSet.landedNote')}</div>
                {landed.conflicts.length > 0 ? (
                  <div className="space-y-0.5">
                    <div className="text-amber-600 dark:text-amber-400">
                      {t('harnessSet.conflictsTitle', { count: landed.conflicts.length })}
                    </div>
                    {landed.conflicts.map((c, i) => (
                      <div key={i} className="text-amber-600/90 dark:text-amber-400/90 break-words">
                        {t('harnessSet.conflictNote', {
                          requestedName: c.requestedName,
                          landedName: c.landedName,
                        })}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});

export function NabyHarnessReview({
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
  const [kindFilter, setKindFilter] = useState<HarnessKind | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<HarnessStatus | 'all'>('all');
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  // Bumped after a set import so the list reloads even when the landed scope
  // equals the currently-viewed one (a plain scope change would not refire).
  const [refreshTick, setRefreshTick] = useState(0);

  // `user` scope is server-defaulted; `project` needs the active cwd. null =>
  // this scope cannot be queried right now (no project open).
  const scopeKey = useMemo<string | null | undefined>(() => {
    switch (scope) {
      case 'user':
        return undefined;
      case 'project':
        return cwd ?? null;
      case 'org':
        // Server-defaulted to the in-house org constant (HP-08), like `user`.
        return undefined;
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
    const res = await listAll(scope, scopeKey ?? undefined);
    if (res.ok) setItems(res.data.items);
    else {
      setItems([]);
      setError(res.error);
    }
    setLoading(false);
    // refreshTick is a reload trigger; referenced so the callback identity
    // changes when a set import bumps it, refiring the effect below.
  }, [scope, scopeKey, refreshTick]);

  useEffect(() => {
    if (isOpen) void reload();
  }, [isOpen, reload]);

  // After a set import, switch the review to the landed scope and force a reload.
  const onSetImported = useCallback((landedScope: HarnessScope) => {
    setScope(landedScope);
    setRefreshTick((n) => n + 1);
  }, []);

  // Leaving a scope clears the last import summary so it does not look like it
  // belongs to the newly selected scope.
  useEffect(() => {
    setSummary(null);
  }, [scope]);

  const runImport = useCallback(async () => {
    if (!available) return;
    setBusyId('__import__');
    try {
      const res = await post<{ ok: boolean; summary?: ImportSummary }>({
        action: 'import',
        scope,
        ...(scope === 'project' && cwd ? { cwd } : {}),
      });
      if (res.ok && res.data.summary) {
        setSummary(res.data.summary);
        const s = res.data.summary;
        const total = s.imported.command + s.imported.skill + s.imported.subagent;
        toast(t('harnessImport.done', { count: total }), 'success');
        await reload();
      } else {
        toast(t('harnessImport.error', { error: res.ok ? 'no summary' : res.error }), 'error');
      }
    } finally {
      setBusyId(null);
    }
  }, [available, scope, cwd, reload, t]);

  const runRowAction = useCallback(
    async (id: string, body: ActionBody, successKey: string) => {
      setBusyId(id);
      try {
        const res = await post(body);
        if (res.ok) {
          toast(t(successKey), 'success');
          await reload();
        } else {
          toast(t('harnessReview.actionError', { error: res.error }), 'error');
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
        enabled ? 'harnessReview.enabled' : 'harnessReview.disabled',
      ),
    [runRowAction],
  );

  const handleDelete = useCallback(
    (id: string) => void runRowAction(id, { action: 'delete', id }, 'harnessReview.deleted'),
    [runRowAction],
  );

  // "Revert this import": remove every external row sharing this import's base.
  const revertImport = useCallback(async () => {
    if (!summary || !summary.baseDir) return;
    setBusyId('__revert__');
    try {
      const res = await post<{ ok: boolean; removed?: number }>({
        action: 'revertOrigin',
        scope,
        ...(scope === 'project' && cwd ? { scopeKey: cwd } : {}),
        originPrefix: summary.baseDir,
      });
      if (res.ok) {
        toast(t('harnessReview.reverted', { count: res.data.removed ?? 0 }), 'success');
        setSummary(null);
        await reload();
      } else {
        toast(t('harnessReview.actionError', { error: res.error }), 'error');
      }
    } finally {
      setBusyId(null);
    }
  }, [summary, scope, cwd, reload, t]);

  const visible = useMemo(
    () =>
      items.filter(
        (i) =>
          (kindFilter === 'all' || i.kind === kindFilter) &&
          (statusFilter === 'all' || i.status === statusFilter),
      ),
    [items, kindFilter, statusFilter],
  );

  const busy = busyId !== null;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t('harnessReview.description')}</p>
      <p className="text-[11px] text-amber-600 dark:text-amber-400">{t('harnessReview.reviewNote')}</p>

      {/* Scope filter + banner: whether these harness items are global (every
          project) or bound to this project. */}
      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('harnessReview.scope')}
        </div>
        <ScopeSelector
          scopes={HARNESS_SCOPES}
          value={scope as NabyScopeId}
          onChange={(s) => setScope(s as HarnessScope)}
        />
        <ScopeHeader scope={scope as NabyScopeId} cwd={cwd} />
      </div>

      {/* Set export/import (HP-05 + HP-08 org). Available in every scope — the
          bundle tools manage their own from/into scope selectors. */}
      <HarnessSetTools cwd={cwd} onImported={onSetImported} />

      {/* Import from ~/.claude / .claude (HP-04). Filesystem import only makes
          sense for user/project — the org scope is populated by a set import. */}
      {available && scope !== 'org' ? (
        <div className="space-y-2">
          <button
            onClick={() => void runImport()}
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded border border-brand bg-brand/10 text-brand hover:bg-brand/20 disabled:opacity-50"
          >
            {busyId === '__import__'
              ? t('harnessImport.importing')
              : scope === 'user'
                ? t('harnessImport.triggerUser')
                : t('harnessImport.triggerProject')}
          </button>

          {summary ? (
            <div className="rounded-lg border border-border p-2.5 space-y-1 bg-muted/30">
              <div className="text-[11px] font-medium text-foreground">
                {t('harnessImport.resultTitle')}
              </div>
              {!summary.baseExists ? (
                <div className="text-[11px] text-muted-foreground">
                  {t('harnessImport.resultNone', { base: summary.baseDir })}
                </div>
              ) : (
                <div className="text-[11px] text-muted-foreground space-y-0.5">
                  <div>
                    {t('harnessImport.resultImported', {
                      command: summary.imported.command,
                      skill: summary.imported.skill,
                      subagent: summary.imported.subagent,
                    })}
                  </div>
                  {summary.skippedHooks > 0 ? (
                    <div>{t('harnessImport.resultHooks', { count: summary.skippedHooks })}</div>
                  ) : null}
                  {summary.skipped.length > 0 ? (
                    <div>{t('harnessImport.resultSkipped', { count: summary.skipped.length })}</div>
                  ) : null}
                  {summary.failed.length > 0 ? (
                    <div className="text-red-600 dark:text-red-400">
                      {t('harnessImport.resultFailed', { count: summary.failed.length })}
                    </div>
                  ) : null}
                </div>
              )}
              {summary.baseExists &&
              summary.imported.command + summary.imported.skill + summary.imported.subagent > 0 ? (
                <button
                  onClick={() => void revertImport()}
                  disabled={busy}
                  className="text-[11px] px-2 py-1 rounded border border-border hover:bg-red-500/10 hover:border-red-500/40 text-red-600 dark:text-red-400 disabled:opacity-50"
                >
                  {t('harnessReview.revertImport')}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Kind + status filters */}
      {available ? (
        <div className="flex flex-wrap gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
              {t('harnessReview.kindFilterLabel')}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {KIND_FILTERS.map((o) => (
                <button
                  key={o.value}
                  onClick={() => setKindFilter(o.value)}
                  className={`text-xs px-2 py-1 rounded border transition-colors ${
                    kindFilter === o.value
                      ? 'border-brand bg-brand/10 text-brand'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {t(o.labelKey)}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
              {t('harnessReview.statusFilterLabel')}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {STATUS_FILTERS.map((o) => (
                <button
                  key={o.value}
                  onClick={() => setStatusFilter(o.value)}
                  className={`text-xs px-2 py-1 rounded border transition-colors ${
                    statusFilter === o.value
                      ? 'border-brand bg-brand/10 text-brand'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {t(o.labelKey)}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {/* List */}
      {!available ? (
        <p className="text-xs text-muted-foreground italic">{t('harnessReview.projectUnavailable')}</p>
      ) : loading ? (
        <p className="text-xs text-muted-foreground">{t('harnessReview.loading')}</p>
      ) : error ? (
        <p className="text-xs text-red-600 dark:text-red-400">
          {t('harnessReview.loadError', { error })}
        </p>
      ) : visible.length === 0 ? (
        <div className="text-xs text-muted-foreground space-y-1 py-2">
          <p>{t('harnessReview.empty')}</p>
          <p className="text-muted-foreground/60">{t('harnessReview.emptyHint')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map((item) => (
            <HarnessRow
              key={item.id}
              item={item}
              scope={scope as NabyScopeId}
              cwd={cwd}
              busy={busy}
              onToggle={handleToggle}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
