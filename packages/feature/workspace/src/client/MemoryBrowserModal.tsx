'use client';

/**
 * Phase 3 P3-M10 — THE MEMORY BROWSER (specs/phase-3-memory-hygiene.md §4).
 *
 * WHY IT IS A SEPARATE SURFACE. Until now every memory naby held was listed
 * INLINE inside a Settings section, which meant the Settings pane grew without
 * bound as the agent learned — a panel whose size is a function of how well the
 * product is working. §1 calls that out as the reason the UI had to be
 * restructured. Settings now shows a fixed-size SUMMARY CARD
 * (`NabyMemoryReview`) and this modal holds everything that scales: search,
 * filters, pagination, and the per-row sovereignty actions (§3).
 *
 * IT SITS ABOVE SETTINGS, NOT INSIDE IT. SettingsModal renders at `z-50`; this is
 * `z-[100]`, between it and the `z-[200]` layer the app reserves for context
 * menus and toasts. Opening it from Settings therefore covers Settings rather
 * than being clipped by its scroll container — the same mistake documented in
 * shell/CLAUDE.md about escaping popovers, one level up.
 *
 * THE FILTERS ARE SERVER-SIDE, ALL OF THEM. It would be easy to fetch a page and
 * filter it in the browser, and it would be wrong twice: the page is 50 rows out
 * of possibly thousands, so client-side filtering would search only what happened
 * to be on screen, and "stale" is DERIVED from the store's access history (§2.2)
 * which the client cannot compute at all. Every chip is a query parameter.
 *
 * PERF. Mounted only while open, like the settings panels. Search is DEBOUNCED —
 * a keystroke-per-request against a paginated endpoint is how a local app starts
 * feeling remote — and each row is a `memo`'d child fed per-item primitives and
 * stable callbacks, matching the repo's referential-stability rule.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';
import { ScopeBadge, ScopeSelector, type NabyScopeId } from './nabyScope';
// Type-only: erased at compile time, so no node code enters the browser bundle.
import type {
  MemoryItem,
  MemoryScope,
  MemoryStatus,
  MemoryType,
  TrustTier,
} from '../../../../../../dist/naby-runtime.mjs';

// ---------------------------------------------------------------------------
// Wire types + helpers (same shape/style as NabyMemoryReview's).
// ---------------------------------------------------------------------------

export type MemoryPage = {
  scope: MemoryScope;
  scopeKey: string;
  items: MemoryItem[];
  corroboration?: Record<string, number>;
  /** P3-M13a §3.1 — replaced row id → the KEY of the memory that replaced it.
   *  Resolved server-side because the replacement may not be on this page. */
  supersededBy?: Record<string, string>;
  total: number;
  limit: number;
  offset: number;
  staleBefore: number | null;
};

type BrowserAction =
  | { action: 'confirm'; id: string }
  | { action: 'delete'; id: string }
  | { action: 'edit'; id: string; value: string }
  | { action: 'keepAlive'; id: string }
  // P3-M13a §3.1: the UNDO. Supersession is automatic, so it has to be
  // reversible by the person whose memory it is — that is the trade the spec
  // makes, and this button is naby's half of it.
  | { action: 'revertSupersession'; id: string };

/** The filter chips' values, kept in one object so a change to any of them can
 *  reset the page offset in a single place — a filter change that kept the
 *  offset would land the user on page 5 of a 1-page result and look empty. */
export type MemoryFilters = {
  scope: MemoryScope;
  status: MemoryStatus | 'all';
  type: MemoryType | 'all';
  stale: boolean;
  /** P3-M13a: show only REPLACED rows. Off means "no filter", not "current
   *  only" — a replaced memory is still the user's, and hiding it by default
   *  from a browser whose whole job is showing them what naby holds would be the
   *  quiet deletion §3.1 refuses. */
  superseded: boolean;
  /**
   * A KEY NAMESPACE to narrow to (settings-ia-reorg §3.4) — `style/` is the one
   * the memory tab deep links with. Empty = no filter.
   *
   * NOT the search box. `search` matches key OR value as a substring, so a memory
   * whose TEXT mentions "style/" would come back from it; this asks the exact
   * question the deep link means ("the rows that ARE style preferences"), and the
   * store answers it with an anchored match on the key alone.
   */
  keyPrefix: string;
  search: string;
};

/** The one namespace the UI deep links into today: `style/<target>/<slug>`, the
 *  key shape P3-M13c mints style preferences under. Spelled here rather than
 *  imported from the runtime because this file is a browser bundle and the
 *  runtime import in it is type-only — the SERVER is where the predicate that
 *  matters (`isStyleMemoryKey`) actually runs. */
export const STYLE_KEY_PREFIX = 'style/';

/**
 * Build the list query string from the filters + page.
 *
 * EXPORTED AND PURE so the parameter mapping can be asserted without rendering
 * anything: which chip becomes which parameter is the part that silently breaks
 * (a filter that stops being sent looks exactly like a filter that found
 * everything).
 */
export function buildMemoryQuery(
  filters: MemoryFilters,
  page: { limit: number; offset: number },
  scopeKey?: string,
): string {
  const params = new URLSearchParams({ scope: filters.scope });
  if (scopeKey) params.set('scopeKey', scopeKey);
  if (filters.status !== 'all') params.set('status', filters.status);
  if (filters.type !== 'all') params.set('type', filters.type);
  if (filters.stale) params.set('stale', '1');
  if (filters.superseded) params.set('superseded', '1');
  const prefix = filters.keyPrefix.trim();
  if (prefix) params.set('keyPrefix', prefix);
  const term = filters.search.trim();
  if (term) params.set('search', term);
  params.set('limit', String(page.limit));
  params.set('offset', String(page.offset));
  return params.toString();
}

async function fetchPage(
  query: string,
): Promise<{ ok: true; data: MemoryPage } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/memory?${query}`);
    const json = (await res.json().catch(() => null)) as (MemoryPage & { error?: string }) | null;
    if (!res.ok) return { ok: false, error: json?.error ?? `request failed (${res.status})` };
    return { ok: true, data: json as MemoryPage };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function postAction(body: BrowserAction): Promise<{ ok: boolean; error?: string }> {
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

/** The browser's page size — the client half of the server's `MEMORY_PAGE_SIZE`
 *  (§4). The server CLAMPS to its own value, so a disagreement can only ever make
 *  this smaller, never unbounded. */
export const PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// One row.
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

const CORROBORATION_BADGE_MIN = 2;

const BrowserRow = memo(function BrowserRow({
  item,
  scope,
  cwd,
  busy,
  corroboration,
  /** The list's stale cutoff, or null when the filter is off — a row is badged
   *  "unused" against the SERVER's window rather than a number copied here. */
  staleBefore,
  /** The KEY of the memory that replaced this one, when it was replaced. A
   *  primitive, so the row stays `memo`-friendly. */
  replacedBy,
  onConfirm,
  onDelete,
  onEdit,
  onKeepAlive,
  onRevert,
}: {
  item: MemoryItem;
  scope: NabyScopeId;
  cwd?: string;
  busy: boolean;
  corroboration: number;
  staleBefore: number | null;
  replacedBy?: string;
  onConfirm: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, value: string) => void;
  onKeepAlive: (id: string) => void;
  onRevert: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.value);
  const isProposed = item.status === 'proposed';
  const isSuperseded = item.supersededAt !== undefined;
  const lastUsed = item.lastInjectedAt ?? item.updatedAt;
  const isStale = staleBefore !== null && item.status === 'confirmed' && lastUsed < staleBefore;

  // The draft follows the item when the list reloads under it (a confirm, a
  // sibling's delete). Without this an edit box left open would keep showing the
  // value from before someone else's change.
  useEffect(() => {
    if (!editing) setDraft(item.value);
  }, [item.value, editing]);

  const save = useCallback(() => {
    const next = draft.trim();
    // An empty edit is not a delete-by-accident: the box simply closes. Deleting
    // is a separate, labelled button, and it should stay that way.
    if (next && next !== item.value) onEdit(item.id, next);
    setEditing(false);
  }, [draft, item.id, item.value, onEdit]);

  return (
    <div className="rounded-lg border border-border p-3 space-y-2" data-testid="memory-row">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-foreground break-words">{item.key}</div>
          {editing ? (
            <textarea
              value={draft}
              autoFocus
              rows={3}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Escape abandons, Cmd/Ctrl+Enter saves — a plain Enter has to
                // stay a newline, because memory values are sentences.
                if (e.key === 'Escape') setEditing(false);
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
              }}
              className="mt-1 w-full text-sm rounded border border-border bg-background p-2 text-foreground"
            />
          ) : (
            <div className="text-sm text-foreground/90 break-words whitespace-pre-wrap">
              {item.value}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {corroboration >= CORROBORATION_BADGE_MIN ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-sky-500/15 text-sky-600 dark:text-sky-400">
              {t('memoryReview.corroborated', { count: corroboration })}
            </span>
          ) : null}
          {isStale ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-slate-500/15 text-slate-600 dark:text-slate-400">
              {t('memoryReview.staleBadge')}
            </span>
          ) : null}
          {isSuperseded ? (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-violet-500/15 text-violet-600 dark:text-violet-400"
              data-testid="memory-superseded-badge"
            >
              {t('memoryReview.supersededBadge')}
            </span>
          ) : null}
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

      {/* Provenance — the load-bearing part of a REVIEW surface, plus (M10) when
          this memory was last actually used, which is what "unused" means. */}
      <div className="flex flex-wrap gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
        <span className="px-1.5 py-0.5 rounded bg-accent">{t(TYPE_LABELS[item.type])}</span>
        <span className="px-1.5 py-0.5 rounded bg-accent">
          {t(TRUST_LABELS[item.provenance.source])}
        </span>
        {item.provenance.sessionId ? (
          <span>
            {t('memoryReview.learnedIn', { session: item.provenance.sessionId.slice(0, 8) })}
          </span>
        ) : null}
        {item.provenance.basis ? (
          <span className="break-words">
            {t('memoryReview.basis', { basis: item.provenance.basis })}
          </span>
        ) : null}
        <span>
          {item.lastInjectedAt
            ? t('memoryReview.lastUsed', {
                when: new Date(item.lastInjectedAt).toLocaleDateString(),
              })
            : t('memoryReview.neverUsed')}
        </span>
        {/* THE CHAIN (P3-M13a §3.1). A replaced memory has to say what replaced
            it, or "this is not being used" is an unexplained state the user can
            only resolve by guessing. */}
        {isSuperseded ? (
          <span className="break-words" data-testid="memory-superseded-chain">
            {replacedBy
              ? t('memoryReview.supersededBy', { key: replacedBy })
              : t('memoryReview.supersededByGone')}
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {editing ? (
          <>
            <button
              onClick={save}
              disabled={busy}
              className="text-xs px-2 py-1 rounded border border-brand bg-brand/10 text-brand disabled:opacity-50"
            >
              {t('memoryReview.editSave')}
            </button>
            <button
              onClick={() => setEditing(false)}
              className="text-xs px-2 py-1 rounded border border-border hover:bg-accent text-muted-foreground"
            >
              {t('memoryReview.editCancel')}
            </button>
          </>
        ) : (
          <>
            {/* A REPLACED row's only meaningful action is bringing it back —
                confirming or keeping alive a memory that is not being used
                would be buttons that appear to do nothing. Delete stays, since
                deleting is always available. */}
            {isSuperseded ? (
              <button
                onClick={() => onRevert(item.id)}
                disabled={busy}
                title={t('memoryReview.revertTitle')}
                data-testid="memory-revert"
                className="text-xs px-2 py-1 rounded border border-border hover:bg-accent text-foreground disabled:opacity-50"
              >
                {t('memoryReview.revert')}
              </button>
            ) : null}
            {isProposed && !isSuperseded ? (
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
              onClick={() => setEditing(true)}
              disabled={busy}
              title={t('memoryReview.editTitle')}
              className="text-xs px-2 py-1 rounded border border-border hover:bg-accent text-foreground disabled:opacity-50"
            >
              {t('memoryReview.edit')}
            </button>
            {/* "Keep" is only meaningful for a row the decay queue can hold —
                a confirmed one. On a proposal the answer is confirm or delete. */}
            {!isProposed && !isSuperseded ? (
              <button
                onClick={() => onKeepAlive(item.id)}
                disabled={busy}
                title={t('memoryReview.keepAliveTitle')}
                className="text-xs px-2 py-1 rounded border border-border hover:bg-accent text-foreground disabled:opacity-50"
              >
                {t('memoryReview.keepAlive')}
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
          </>
        )}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// The modal.
// ---------------------------------------------------------------------------

const BROWSER_SCOPES: NabyScopeId[] = ['user', 'session', 'project', 'org'];

const STATUS_CHIPS: { value: MemoryStatus | 'all'; labelKey: string }[] = [
  { value: 'all', labelKey: 'memoryReview.statusAll' },
  { value: 'proposed', labelKey: 'memoryReview.statusProposed' },
  { value: 'confirmed', labelKey: 'memoryReview.statusConfirmed' },
];

const TYPE_CHIPS: { value: MemoryType | 'all'; labelKey: string }[] = [
  { value: 'all', labelKey: 'memoryReview.filterAll' },
  { value: 'working', labelKey: 'memoryReview.typeWorking' },
  { value: 'episodic', labelKey: 'memoryReview.typeEpisodic' },
  { value: 'semantic', labelKey: 'memoryReview.typeSemantic' },
  { value: 'procedural', labelKey: 'memoryReview.typeProcedural' },
];

/** How long a pause in typing counts as "done typing". Long enough that a normal
 *  typing speed produces one request per word rather than per letter; short
 *  enough that the list feels like it is following along. */
const SEARCH_DEBOUNCE_MS = 250;

/** The filters a freshly opened browser starts with: everything, current first
 *  page. A deep link overrides parts of this — see `initialFilters`. */
const DEFAULT_FILTERS: MemoryFilters = {
  scope: 'user',
  status: 'all',
  type: 'all',
  stale: false,
  superseded: false,
  keyPrefix: '',
  search: '',
};

export function MemoryBrowserModal({
  isOpen,
  onClose,
  sessionId,
  cwd,
  initialFilters,
}: {
  isOpen: boolean;
  onClose: () => void;
  sessionId?: string;
  cwd?: string;
  /**
   * A DEEP LINK (settings-ia-reorg §3.4): what the browser should already be
   * narrowed to when it opens. Applied on each open rather than once at mount,
   * so opening it from the style group lands on style rows even if the browser
   * was last closed showing something else.
   *
   * The chips stay live afterwards — this seeds the filters, it does not lock
   * them. A view the user cannot widen is a dead end, which is the one thing a
   * browser must not be.
   */
  initialFilters?: Partial<MemoryFilters>;
}) {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<MemoryFilters>({ ...DEFAULT_FILTERS, ...initialFilters });
  // The box's own value, separate from the DEBOUNCED term the query uses: the
  // input must echo every keystroke immediately, while the request must not.
  const [searchInput, setSearchInput] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<MemoryPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // THE DEEP LINK, applied on each OPEN and only when there is one. A seed that
  // reset the filters every time would throw away the chips a user set the last
  // time they opened the browser from the plain button; a seed applied once at
  // mount would never arrive, because this component is mounted (closed) for the
  // whole life of the settings card that owns it. Held in a ref so an inline
  // object literal from the caller cannot re-run the effect on every render.
  const seedRef = useRef(initialFilters);
  seedRef.current = initialFilters;
  useEffect(() => {
    const seed = seedRef.current;
    if (!isOpen || !seed || Object.keys(seed).length === 0) return;
    setFilters({ ...DEFAULT_FILTERS, ...seed });
    setSearchInput(seed.search ?? '');
    setOffset(0);
  }, [isOpen]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((f) => (f.search === searchInput ? f : { ...f, search: searchInput }));
      // A NEW SEARCH STARTS AT PAGE 1. Keeping the offset would show page 3 of a
      // result that now has one page, which renders as "no matches" for a term
      // that plainly matches.
      setOffset(0);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  /** The scopeKey this scope is addressable by, or null when it is not
   *  addressable at all right now (no session / no project / no org id). */
  const scopeKey = useMemo<string | null | undefined>(() => {
    switch (filters.scope) {
      case 'user':
        return undefined; // the server fills the single-user constant
      case 'session':
        return sessionId ?? null;
      case 'project':
        return cwd ?? null;
      default:
        return null;
    }
  }, [filters.scope, sessionId, cwd]);

  const available = scopeKey !== null;

  const reload = useCallback(async () => {
    if (scopeKey === null) {
      setPage(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const res = await fetchPage(
      buildMemoryQuery(filters, { limit: PAGE_SIZE, offset }, scopeKey ?? undefined),
    );
    if (res.ok) setPage(res.data);
    else {
      setPage(null);
      setError(res.error);
    }
    setLoading(false);
  }, [filters, offset, scopeKey]);

  useEffect(() => {
    if (isOpen) void reload();
  }, [isOpen, reload]);

  // ESC closes, matching every other overlay in the app.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const run = useCallback(
    async (id: string, body: BrowserAction, successKey: string) => {
      setBusyId(id);
      try {
        const res = await postAction(body);
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
    (id: string) => void run(id, { action: 'confirm', id }, 'memoryReview.confirmed'),
    [run],
  );
  const handleDelete = useCallback(
    (id: string) => void run(id, { action: 'delete', id }, 'memoryReview.deleted'),
    [run],
  );
  const handleEdit = useCallback(
    (id: string, value: string) => void run(id, { action: 'edit', id, value }, 'memoryReview.edited'),
    [run],
  );
  const handleKeepAlive = useCallback(
    (id: string) => void run(id, { action: 'keepAlive', id }, 'memoryReview.kept'),
    [run],
  );
  const handleRevert = useCallback(
    (id: string) =>
      void run(id, { action: 'revertSupersession', id }, 'memoryReview.reverted'),
    [run],
  );

  /** Change one filter and go back to the first page — see the search effect for
   *  why every filter change has to do the second half. */
  const setFilter = useCallback((patch: Partial<MemoryFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setOffset(0);
  }, []);

  // The scroll container, reset to the top on every page change: paging while
  // scrolled halfway down lands you halfway down the NEXT page, which reads as
  // rows having been skipped.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [offset, filters]);

  if (!isOpen) return null;

  const total = page?.total ?? 0;
  const shownFrom = total === 0 ? 0 : offset + 1;
  const shownTo = Math.min(offset + PAGE_SIZE, total);
  const busy = busyId !== null;
  const chip = (selected: boolean) =>
    `text-xs px-2 py-1 rounded border transition-colors ${
      selected
        ? 'border-brand bg-brand/10 text-brand'
        : 'border-border text-muted-foreground hover:text-foreground'
    }`;

  return (
    // z-[100]: ABOVE SettingsModal (z-50, which opens it) and below the z-[200]
    // layer reserved for context menus and toasts, so a toast raised by an action
    // in here still lands on top of it.
    <div className="fixed inset-0 z-[100] flex items-center justify-center" data-testid="memory-browser">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-card rounded-lg shadow-xl w-[min(86vw,1200px)] min-w-[min(720px,calc(100vw-2rem))] h-[85vh] mx-4 flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">{t('memoryReview.browserTitle')}</h2>
          <button
            onClick={onClose}
            aria-label={t('memoryReview.browserClose')}
            className="text-xs px-2 py-1 rounded border border-border hover:bg-accent text-muted-foreground"
          >
            {t('memoryReview.browserClose')}
          </button>
        </div>

        {/* Filters — every one of them a server-side query parameter (see the
            file header for why none of this is done on the client). */}
        <div className="px-4 py-3 space-y-2 border-b border-border">
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t('memoryReview.searchPlaceholder')}
            className="w-full text-sm rounded border border-border bg-background px-2 py-1.5 text-foreground"
            data-testid="memory-search"
          />
          <ScopeSelector
            scopes={BROWSER_SCOPES}
            value={filters.scope as NabyScopeId}
            onChange={(s) => setFilter({ scope: s as MemoryScope })}
          />
          <div className="flex flex-wrap gap-1.5">
            {STATUS_CHIPS.map((o) => (
              <button
                key={o.value}
                onClick={() => setFilter({ status: o.value })}
                className={chip(filters.status === o.value)}
              >
                {t(o.labelKey)}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {TYPE_CHIPS.map((o) => (
              <button
                key={o.value}
                onClick={() => setFilter({ type: o.value })}
                className={chip(filters.type === o.value)}
              >
                {t(o.labelKey)}
              </button>
            ))}
            <button
              onClick={() => setFilter({ stale: !filters.stale })}
              title={t('memoryReview.filterStaleTitle')}
              className={chip(filters.stale)}
              data-testid="memory-stale-chip"
            >
              {t('memoryReview.filterStale')}
            </button>
            {/* P3-M13a §3.1: replaced memories are KEPT, so they need somewhere
                to be found. Off by default — the chip narrows to them rather
                than hiding them the rest of the time. */}
            <button
              onClick={() => setFilter({ superseded: !filters.superseded })}
              title={t('memoryReview.filterSupersededTitle')}
              className={chip(filters.superseded)}
              data-testid="memory-superseded-chip"
            >
              {t('memoryReview.filterSuperseded')}
            </button>
            {/* THE NAMESPACE CHIP (settings-ia-reorg §3.4). It exists so the deep
                link from the style group is not a state the user cannot see or
                get out of: arriving here narrowed, the chip is lit and pressing
                it widens back to everything. */}
            <button
              onClick={() =>
                setFilter({ keyPrefix: filters.keyPrefix === STYLE_KEY_PREFIX ? '' : STYLE_KEY_PREFIX })
              }
              title={t('memoryReview.filterStyleTitle')}
              className={chip(filters.keyPrefix === STYLE_KEY_PREFIX)}
              data-testid="memory-style-chip"
            >
              {t('memoryReview.filterStyle')}
            </button>
          </div>
        </div>

        <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2">
          {!available ? (
            <p className="text-xs text-muted-foreground italic">
              {t('memoryReview.sessionUnavailable')}
            </p>
          ) : loading ? (
            <p className="text-xs text-muted-foreground">{t('memoryReview.loading')}</p>
          ) : error ? (
            <p className="text-xs text-red-600 dark:text-red-400">
              {t('memoryReview.loadError', { error })}
            </p>
          ) : (page?.items.length ?? 0) === 0 ? (
            <p className="text-xs text-muted-foreground">{t('memoryReview.noMatches')}</p>
          ) : (
            page?.items.map((item) => (
              <BrowserRow
                key={item.id}
                item={item}
                scope={filters.scope as NabyScopeId}
                cwd={cwd}
                busy={busy}
                corroboration={page.corroboration?.[item.id] ?? 0}
                staleBefore={page.staleBefore}
                {...(page.supersededBy?.[item.id]
                  ? { replacedBy: page.supersededBy[item.id] }
                  : {})}
                onConfirm={handleConfirm}
                onDelete={handleDelete}
                onEdit={handleEdit}
                onKeepAlive={handleKeepAlive}
                onRevert={handleRevert}
              />
            ))
          )}
        </div>

        {/* Pagination. The counts come from the SERVER's total for this exact
            filter, so the range statement can never describe a different set
            than the rows above it. */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border">
          <span className="text-[11px] text-muted-foreground" data-testid="memory-page-range">
            {t('memoryReview.pageOf', { from: shownFrom, to: shownTo, total })}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
              disabled={offset === 0 || loading}
              className="text-xs px-2 py-1 rounded border border-border hover:bg-accent text-foreground disabled:opacity-40"
            >
              {t('memoryReview.prevPage')}
            </button>
            <button
              onClick={() => setOffset((o) => o + PAGE_SIZE)}
              disabled={shownTo >= total || loading}
              className="text-xs px-2 py-1 rounded border border-border hover:bg-accent text-foreground disabled:opacity-40"
            >
              {t('memoryReview.nextPage')}
            </button>
          </div>
        </div>

        {/* What an edit actually does (§3). Stated where the edit button is,
            because "this is now attributed to you and its evidence was reset" is
            not something a user can infer from a text box. */}
        <p className="px-4 pb-3 text-[10px] text-muted-foreground leading-relaxed">
          {t('memoryReview.editNote')}
        </p>
      </div>
    </div>
  );
}
