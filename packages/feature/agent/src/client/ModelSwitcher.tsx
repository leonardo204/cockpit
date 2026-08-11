'use client';

/**
 * The model chip — a CLICKABLE quick-switch over WHICH model the selected engine
 * uses, sitting in the chat header BETWEEN the EngineSwitcher and the account
 * chip (Claude / ChatGPT). It only appears for engines that expose a per-turn
 * model choice: the Claude subscription (Agent SDK) and the dev-only ChatGPT
 * subscription. A metered API-key provider has no switcher — its model is a
 * profile setting, not a per-turn pick — so this renders nothing there.
 *
 * HOW IT APPLIES. `model` is already a first-class field of the turn payload
 * (DispatchParams.model → requestedModel), so a pick takes effect on the very
 * next message with no reload: the chosen slug is reported up to Chat via
 * `onModelChange`, which threads it into the /api/chat POST body. '' means
 * "send no model" → the engine's own default answers (Claude picks; ChatGPT
 * falls back to its default slug server-side).
 *
 * HOW IT PERSISTS. The pick is saved with the `model.set` action keyed by the
 * engine's SCOPE (the ChatGPT provider id, or a fixed key for Claude), read back
 * from the same /api/naby GET's `selectedModels` map — so a reload restores it
 * and the payload keeps carrying it. Same iframe-safe fetch discipline as every
 * other bottom-bar control (`window.naby` does not exist in the project iframe).
 *
 * WHERE THE CANDIDATES COME FROM. For Claude, the LIVE list is fetched from
 * `models.list`, which asks the Agent SDK what this sign-in is entitled to — so a
 * newly released model appears without rebuilding naby, and a model the plan does
 * not include is never offered. modelCatalog's constant is the fallback for before
 * the first answer arrives (or when nobody is signed in). ChatGPT has no
 * equivalent live source, so it stays curated.
 *
 * GEMINI IS THE THIRD SCOPE, and it is live-only. One Google API key opens the
 * whole catalog, so — unlike Azure or OpenAI, where the key addresses the one
 * model the profile names — the model is a genuine per-turn choice. Its
 * candidates come from `models.list` provider:'google', which is the SAME cached
 * list the Settings form offers; there is no second source and no curated
 * constant to go stale. THE KEY IS NEVER HERE: the server resolves it, asks
 * Google, and answers with model ids.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  CHATGPT_OAUTH_PROVIDER_ID,
  CLAUDE_MODEL_SCOPE,
  GOOGLE_MODEL_SCOPE,
  claudeOptionsFrom,
  defaultModelForScope,
  googleOptionsFrom,
  modelLabel,
  modelScopeFor,
  modelsForScope,
  scopeHasLiveCatalog,
  type LiveModel,
  type ModelOption,
} from './modelCatalog';

type ModelSwitcherProps = {
  /** The resolved engine identity from EngineSwitcher (the single owner of the
   *  /api/naby engine read). Drives which catalog/scope this switcher shows. */
  activeEngine: { engineId: string | null; selectedProvider: string | null } | null;
  /** Reports the EFFECTIVE model up to Chat so it can thread it into the turn
   *  payload. '' = no override (engine default). Fires on load and on pick. */
  onModelChange?: (model: string) => void;
  /** The user PICKED a model here (not a passive scope re-read). The host uses
   *  this to drop a mid-conversation "switched" notice. */
  onUserSelect?: () => void;
};

/** What the /api/naby GET adds for this switcher: the persisted pick per scope. */
type NabyModelState = {
  selectedModels?: Record<string, string>;
};

export function ModelSwitcher({ activeEngine, onModelChange, onUserSelect }: ModelSwitcherProps) {
  const { t } = useTranslation();
  const scope = modelScopeFor(activeEngine?.engineId ?? null, activeEngine?.selectedProvider ?? null);
  // The live Claude catalog. Null until the first answer; the curated fallback
  // covers that window so the picker is never empty.
  const [liveClaude, setLiveClaude] = useState<LiveModel[] | null>(null);
  // The live Gemini catalog (model ids). Null until the first answer, and with no
  // curated fallback behind it — see googleOptionsFrom.
  const [liveGoogle, setLiveGoogle] = useState<string[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [value, setValue] = useState<string>('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const aliveRef = useRef(true);
  const rootRef = useRef<HTMLSpanElement>(null);
  // The SCROLLING part of the menu (the options), which is the only element
  // allowed to clip: see the list container below.
  const listRef = useRef<HTMLDivElement>(null);
  // Ref-stable so the scope effect below never re-runs just because the parent
  // re-created the callback (shell perf convention).
  const onModelChangeRef = useRef(onModelChange);
  onModelChangeRef.current = onModelChange;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // On every scope change: a metered provider (scope null) clears any override
  // so a model picked for the previous engine never leaks onto it; a switchable
  // engine reads its persisted pick (falling back to the scope default) and
  // reports it up so the very next payload carries the right model.
  useEffect(() => {
    if (!scope) {
      setValue('');
      onModelChangeRef.current?.('');
      return;
    }
    let alive = true;
    (async () => {
      let persisted = '';
      try {
        const res = await fetch('/api/naby');
        if (res.ok) {
          const data = (await res.json()) as NabyModelState;
          persisted = data.selectedModels?.[scope] ?? '';
        }
      } catch {
        // Keep the default; the send path surfaces any real failure clearly.
      }
      const eff = persisted || defaultModelForScope(scope);
      if (alive && aliveRef.current) {
        setValue(eff);
        onModelChangeRef.current?.(eff);
      }
    })();
    return () => {
      alive = false;
    };
  }, [scope]);

  // -- THE LIVE CATALOGS (Claude, Gemini) ------------------------------------
  //
  // `models.list` serves a cached answer for a day, so repeated calls cost one
  // probe — which is what makes it safe to ask for on a menu open.
  const loadModels = useCallback(
    async (refresh: boolean) => {
      if (!scopeHasLiveCatalog(scope)) return;
      if (refresh) setRefreshing(true);
      try {
        const res = await fetch('/api/naby', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'models.list',
            ...(scope === GOOGLE_MODEL_SCOPE ? { provider: GOOGLE_MODEL_SCOPE } : {}),
            ...(refresh ? { refresh: true } : {}),
          }),
        });
        const json = (await res.json().catch(() => null)) as
          | { ok?: boolean; models?: { claude?: LiveModel[]; google?: string[] } }
          | null;
        if (!aliveRef.current || !json?.ok) return;
        if (scope === GOOGLE_MODEL_SCOPE) {
          const list = json.models?.google;
          // An empty answer means "no key saved yet, or the lookup failed". Keep
          // whatever was already shown rather than blanking the picker mid-use.
          if (Array.isArray(list) && list.length > 0) setLiveGoogle(list);
          return;
        }
        const list = json.models?.claude;
        // An empty answer leaves the curated fallback in place rather than
        // emptying the picker — not signed in should not mean "no models".
        if (Array.isArray(list) && list.length > 0) setLiveClaude(list);
      } catch {
        /* the fallback list stays; the send path surfaces any real failure */
      } finally {
        if (aliveRef.current) setRefreshing(false);
      }
    },
    [scope],
  );

  useEffect(() => {
    if (open) void loadModels(false);
  }, [open, loadModels]);

  // GEMINI HAS TO LOAD BEFORE THE CHIP RENDERS, not on menu open like Claude's.
  // Claude has a curated fallback, so its chip exists to be clicked while the
  // live list is still unknown; Gemini has none, so an empty list renders no chip
  // — and a chip that is never rendered can never be opened to trigger the load
  // that would fill it. One cached round trip per scope change, no polling.
  useEffect(() => {
    if (scope === GOOGLE_MODEL_SCOPE) void loadModels(false);
  }, [scope, loadModels]);

  // Close on an outside click or Escape — a popover in the three-panel layout
  // must not linger once the user has moved on.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // OPENING THE MENU MUST SHOW WHAT IS ALREADY CHOSEN. Google's live catalog is
  // 30+ models, so the pick is routinely far down the list; a menu that always
  // opens at the top cannot be used to confirm what is selected, which is half
  // of what this chip is for.
  //
  // The LIST is scrolled, never `scrollIntoView()`: that walks up every
  // scrollable ancestor, and in the three-panel layout the nearest ones are the
  // chat panel and the swipe container — it would slide the whole panel to
  // reveal a menu that is already on screen. Setting `scrollTop` on the one box
  // that scrolls cannot move anything else.
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>('[data-active="true"]');
    if (!active) return;
    const centered = active.offsetTop - (list.clientHeight - active.offsetHeight) / 2;
    list.scrollTop = Math.max(0, Math.min(centered, list.scrollHeight - list.clientHeight));
    // Re-runs when a catalog arrives while the menu is open (the refresh
    // button, or the cached lookup resolving) — the rows move, so the position
    // has to be taken again.
  }, [open, liveClaude, liveGoogle]);

  const onUserSelectRef = useRef(onUserSelect);
  onUserSelectRef.current = onUserSelect;

  const pick = useCallback(
    async (model: string) => {
      if (!scope) return;
      setBusy(true);
      // A user pick — let the host post a mid-conversation switch notice.
      onUserSelectRef.current?.();
      // Optimistic: relabel + drive the next payload immediately; persistence
      // catches up so a reload restores the same choice.
      setValue(model);
      onModelChangeRef.current?.(model);
      try {
        await fetch('/api/naby', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'model.set', providerId: scope, model }),
        });
      } catch {
        // The optimistic value still drives this session's turns; only the
        // persisted copy is at risk, which the next successful pick repairs.
      } finally {
        if (aliveRef.current) {
          setBusy(false);
          setOpen(false);
        }
      }
    },
    [scope],
  );

  // No per-turn model choice for this engine (metered API-key provider, or no
  // engine resolved yet) → nothing to show.
  if (!scope) return null;
  const options: ModelOption[] =
    scope === CLAUDE_MODEL_SCOPE
      ? claudeOptionsFrom(liveClaude)
      : scope === GOOGLE_MODEL_SCOPE
        ? googleOptionsFrom(liveGoogle)
        : modelsForScope(scope);
  if (options.length === 0) return null;
  // Label from whatever list is in play, so a live-only id does not render raw.
  const currentLabel = options.find((o) => o.value === value)?.label ?? modelLabel(scope, value);

  return (
    <span ref={rootRef} className="relative inline-flex items-center text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-muted-foreground hover:bg-accent disabled:opacity-50 select-none"
        data-testid="model-switcher"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('modelSwitcher.title', { defaultValue: 'Which model' })}
      >
        {t('modelSwitcher.label', { defaultValue: 'Model' })}
        <span className="text-foreground/70">{currentLabel}</span>
        <ChevronDown className="w-3 h-3 flex-shrink-0 opacity-60" />
      </button>

      {open && (
        // NO `overflow-hidden` HERE, and none on any ancestor: this menu escapes
        // the chip (`absolute top-full`) in the three-panel layout, and a
        // clipping ancestor would erase it exactly the way one on the sidebar
        // root erased its three popovers (CLAUDE.md, UI Layout). The scrolling
        // is done by the options list INSIDE, which is the part that scrolls.
        <div
          role="menu"
          data-testid="model-switcher-menu"
          className="absolute top-full left-0 mt-1 z-50 w-64 rounded-md border border-border bg-popover text-popover-foreground shadow-lg p-2 flex flex-col gap-1"
        >
          <div className="flex items-center justify-between gap-2 px-1 py-0.5">
            <span className="text-[0.786rem] uppercase tracking-wide text-muted-foreground">
              {t('modelSwitcher.title', { defaultValue: 'Which model' })}
            </span>
            {scopeHasLiveCatalog(scope) && (
              // The list is cached for a day, so this is how a model released
              // today shows up today — without rebuilding the app.
              <button
                type="button"
                onClick={() => void loadModels(true)}
                disabled={refreshing}
                className="text-[0.786rem] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
                title={
                  scope === GOOGLE_MODEL_SCOPE
                    ? t('modelSwitcher.refreshHintGoogle', {
                        defaultValue: 'Ask Google which Gemini models this key can use',
                      })
                    : t('modelSwitcher.refreshHint', {
                        defaultValue: 'Ask your Claude sign-in which models it can use',
                      })
                }
              >
                {refreshing
                  ? t('modelSwitcher.refreshing', { defaultValue: 'Checking…' })
                  : t('modelSwitcher.refresh', { defaultValue: 'Refresh' })}
              </button>
            )}
          </div>
          {/* THE ONLY BOX THAT SCROLLS. Google's live catalog answers with 30+
              models and the menu grew past the bottom of the window; capped
              here at ~5 rows, the rest reachable by scrolling.

              The header above stays OUTSIDE this box on purpose: it holds the
              only control that is not a model ("Refresh", which is how a model
              released today shows up today) and the list's title, and both
              become unreachable the moment they scroll away.

              The `Default` row, by contrast, stays IN the list. It is not
              structurally distinct across scopes — Claude's live catalog has no
              `''` row at all, its default is an ordinary entry the SDK returns
              — so pinning "the default" would be a rule that holds for two of
              the three scopes and quietly mis-renders the third. The pick being
              visible on open is handled properly instead, by the scroll
              positioning above, which covers Default like any other row. */}
          <div
            ref={listRef}
            data-testid="model-switcher-list"
            className="flex flex-col gap-1 max-h-56 overflow-y-auto"
          >
          {options.map((o) => {
            const active = o.value === value;
            return (
              <button
                key={o.value || 'default'}
                type="button"
                onClick={() => void pick(o.value)}
                disabled={busy}
                data-testid={`model-option-${o.value || 'default'}`}
                // Read by the open-scroll effect above to find the current pick.
                // An attribute rather than a ref map: the list is rebuilt from a
                // live catalog, and a ref per row would have to be reconciled
                // with it on every refresh.
                data-active={active ? 'true' : 'false'}
                className={`w-full flex-shrink-0 text-left px-2 py-1.5 rounded border transition-colors ${
                  active
                    ? 'border-brand bg-brand/5'
                    : 'border-border hover:border-brand/50 hover:bg-accent/40'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-foreground">{o.label}</span>
                  {active && (
                    <span className="text-xs text-brand" data-testid="model-option-active">
                      ✓
                    </span>
                  )}
                </div>
                {o.hint && <p className="text-xs text-muted-foreground">{o.hint}</p>}
              </button>
            );
          })}
          </div>
        </div>
      )}
    </span>
  );
}
