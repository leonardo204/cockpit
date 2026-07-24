'use client';

/**
 * The engine chip — a CLICKABLE quick-switch over WHICH model answers, sitting
 * in the chat header where the read-only "Engine: <label>" status used to be.
 *
 * WHY IT EXISTS. The engine choice already lives in Settings → AI provider
 * (NabyProviderSetup's NabyEngineSelector), but reaching for a modal every time
 * you want to bounce between "Claude (subscription)" and a paid provider is the
 * kind of friction that makes the choice feel heavier than it is. selectEngine
 * re-reads the saved settings at the START OF EVERY TURN, so a switch here takes
 * effect on the very next message with no reload and no new session — which
 * makes a one-click header shortcut the right shape for it.
 *
 * SAME ACTIONS, SMALLER SURFACE. This is a shortcut, not a second source of
 * truth: it POSTs the exact `settings.set` action the modal's selector does, and
 * reads the exact `/api/naby` GET the modal reads, so the header and Settings can
 * never disagree. Key entry stays in Settings — a provider with no API key is
 * shown here but is NOT selectable (picking it would only fail at send time);
 * the "Manage in Settings" link at the foot routes there for the full surface.
 *
 * THE OPTIONS (mirrors NabyEngineSelector):
 *   * Automatic          → choose('', '')            a configured provider, else
 *                                                     Claude (subscription).
 *   * Claude (subscription) → choose('dev-claude','') only when devEngineAvailable
 *                                                     (the Agent SDK resolves).
 *   * each provider p    → choose('ai-sdk', p.id)     ready ones are selectable;
 *                                                     not-configured ones are shown
 *                                                     but disabled with a hint.
 *
 * THE CHIP LABEL. Before a turn: the SELECTED engine (provider `label · model`,
 * "Claude (subscription)", or "No engine") from the same GET — so it reflects
 * WHAT THE NEXT TURN WILL USE, not a hardcoded string. Once a turn resolves the
 * model, `liveModel` (from the server's system/init) is preferred, because the
 * truth of what actually answered beats the pre-turn intent.
 *
 * ONE OWNER FOR THE ENGINE READ. Chat.tsx used to run its own /api/naby effect
 * just to label this slot; that logic now lives here so there is a single reader
 * of the engine/provider state in this row. (ClaudeLoginStatus's fetch is a
 * separate concern — the local Claude sign-in — and stays where it is.)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { deriveEngineName } from './engineName';

type NabyProvider = { id: string; label: string; model: string; ready: boolean };

type NabyEngineState = {
  engine: { ok: boolean; id?: string; summary?: string };
  settings: { enginePreference?: string; selectedProvider?: string };
  devEngineAvailable: boolean;
  providers: NabyProvider[];
  /** CO-06 — the DEV-ONLY ChatGPT sign-in, read from the SAME GET (not the
   *  preload bridge, which the iframe cannot reach). `signedIn` is the
   *  authoritative "is the owner signed in right now" answer the server reads
   *  from the vault; it refines the seal-gated ChatGPT row's selectability. */
  chatgptLogin?: { available: boolean; signedIn: boolean };
};

/** The provider id of the DEV-ONLY ChatGPT subscription provider. `/api/naby`
 *  surfaces it in `providers` only when the dev seal is open, and a provider's
 *  id IS its kind — the same string engineName.ts maps to "ChatGPT". Kept as a
 *  local literal (mirroring NabyProviderSetup's CHATGPT_OAUTH_KIND) so this pure
 *  client file needs no import from the server-only runtime bundle. */
const CHATGPT_OAUTH_ID = 'openai-chatgpt-oauth';

/** Background poll: covers a settings change made elsewhere (the Settings modal,
 *  another tab) landing on this chip without a manual refresh. Unhurried on
 *  purpose — focus/visibility catch the common cases far sooner. */
const POLL_MS = 30_000;

type EngineSwitcherProps = {
  /** The engine's RESOLVED model for this session, captured live from the turn's
   *  system/init. Preferred over the pre-turn selected label when present. */
  liveModel: string | null;
  /** Host-handled: open the app Settings modal (AI provider surface) for key
   *  entry / the full configuration a not-configured provider needs. */
  onOpenSettings?: () => void;
  /** Reports the short name of the engine that will answer (Claude / GPT /
   *  Gemini / ChatGPT / AI) up to the host. This chip is the single owner of the
   *  /api/naby engine read, so it also owns deriving that name — the "thinking"
   *  bubble in the message list labels the turn with whoever actually answers. */
  onEngineName?: (name: string) => void;
  /** Reports the RESOLVED engine identity up to the host so Chat can SWITCH which
   *  account chip the bottom bar shows (Claude vs ChatGPT vs none). This chip is
   *  the single owner of the /api/naby engine read, so it is the one place that
   *  knows the current engine id + selected provider — the same fields it labels
   *  itself from. `engineId` is 'dev-claude' | 'ai-sdk' (or null before a read);
   *  `selectedProvider` is the provider profile id under 'ai-sdk'. */
  onActiveEngine?: (active: { engineId: string | null; selectedProvider: string | null }) => void;
  /** The user PICKED an engine here (not a passive poll). The host uses this to
   *  drop a mid-conversation "switched" notice; fired on the click, before the
   *  new selection has propagated, so the host debounces to read final values. */
  onUserSelect?: () => void;
};

/** The selected engine's PROVIDER label — never the model, which now has its own
 *  chip beside this one. From the same fields the Settings selector reads, so the
 *  header and Settings never disagree. */
function selectedLabel(state: NabyEngineState | null): string {
  if (!state) return '…';
  const id = state.engine?.id;
  if (id === 'ai-sdk') {
    const pid = state.settings?.selectedProvider;
    const p = state.providers?.find((x) => x.id === pid) ?? state.providers?.[0];
    return p ? p.label : 'API provider';
  }
  if (id === 'dev-claude') return 'Claude (subscription)';
  return 'No engine';
}

type Option = {
  id: string;
  label: string;
  hint: string;
  active: boolean;
  /** A not-configured provider is shown for discoverability but cannot be picked
   *  — choosing it would only fail at send time. Manage-in-Settings routes there. */
  selectable: boolean;
  onPick: (() => void) | null;
};

export function EngineSwitcher({ liveModel, onOpenSettings, onEngineName, onActiveEngine, onUserSelect }: EngineSwitcherProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<NabyEngineState | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Guards a state update after a chat tab is closed mid-request.
  const aliveRef = useRef(true);
  const rootRef = useRef<HTMLSpanElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/naby');
      if (!res.ok) return;
      const data = (await res.json()) as NabyEngineState;
      // `chatgptLogin.signedIn` rides in the SAME GET, so the ChatGPT row's
      // ready-state tracks a sign-in/out done in Settings without a manual
      // refresh — and it works inside the iframe, unlike the old preload probe.
      if (aliveRef.current) setState(data);
    } catch {
      // Keep the last known label; the send path surfaces any real failure with
      // a far better message than a stale chip could.
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    const onFocus = () => void load();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      aliveRef.current = false;
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  // Re-read when a turn resolves the model: a settings change made elsewhere is
  // reflected, and the selected label re-syncs with what actually answered.
  useEffect(() => {
    if (liveModel) void load();
  }, [liveModel, load]);

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

  // POST the same `settings.set` action the Settings selector does, then reload
  // so the chip relabels immediately, and close the popover.
  const choose = useCallback(
    async (enginePreference: string, selectedProvider: string) => {
      // A user pick (every choose() call comes from an option click) — let the
      // host post a mid-conversation switch notice once the change propagates.
      onUserSelect?.();
      setBusy(true);
      try {
        await fetch('/api/naby', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'settings.set', enginePreference, selectedProvider }),
        });
        await load();
      } finally {
        if (aliveRef.current) {
          setBusy(false);
          setOpen(false);
        }
      }
    },
    [load, onUserSelect],
  );

  // The chip shows the PROVIDER that answers — NOT the model, which now lives in
  // the ModelSwitcher chip beside this one. (`liveModel` is still consumed below
  // for the thinking-bubble name and the re-fetch trigger, just not shown here.)
  // The ChatGPT subscription provider carries a long dev-caveat label meant for
  // the Settings card, so the chip shows its clean short name instead.
  const chatgptSelected =
    state?.engine?.id === 'ai-sdk' && state?.settings.selectedProvider === CHATGPT_OAUTH_ID;
  const chipLabel = chatgptSelected
    ? t('chatgptOauth.title', { defaultValue: 'ChatGPT (subscription)' })
    : selectedLabel(state);

  // The short brand name of whoever answers this turn, derived from the SAME
  // fields the chip reads. A provider's `id` IS its kind in /api/naby (profiles
  // are stored id:kind), so the selected provider's id feeds the kind mapping;
  // 'automatic' (no explicit selection) resolves to the first provider, matching
  // selectedLabel's fallback. Reported up so the "thinking" bubble can name it.
  const engineName = useMemo(() => {
    const id = state?.engine?.id;
    const providerKind =
      id === 'ai-sdk'
        ? state?.providers.find((p) => p.id === state?.settings.selectedProvider)?.id ??
          state?.providers[0]?.id ??
          null
        : null;
    return deriveEngineName({ engineId: id ?? null, providerKind, liveModel });
  }, [state, liveModel]);

  useEffect(() => {
    onEngineName?.(engineName);
  }, [engineName, onEngineName]);

  // Report the resolved engine identity up so Chat can switch the bottom-bar
  // account chip. Keyed on the two primitive fields (not a fresh object) so it
  // fires only on an actual engine/provider change, not every render.
  const activeEngineId = state?.engine?.id ?? null;
  const activeSelectedProvider = state?.settings.selectedProvider ?? null;
  useEffect(() => {
    onActiveEngine?.({ engineId: activeEngineId, selectedProvider: activeSelectedProvider });
  }, [activeEngineId, activeSelectedProvider, onActiveEngine]);

  // Build the option list exactly as NabyEngineSelector does, so the two agree.
  const pref = state?.settings.enginePreference ?? '';
  const selectedProvider = state?.settings.selectedProvider ?? '';
  const options: Option[] = [
    {
      id: 'auto',
      label: t('engineSwitcher.automatic', { defaultValue: 'Automatic' }),
      hint: t('engineSwitcher.automaticHint', {
        defaultValue: 'Use a provider you have set up; otherwise Claude (subscription), if available.',
      }),
      active: pref === '' && selectedProvider === '',
      selectable: true,
      onPick: () => void choose('', ''),
    },
  ];
  if (state?.devEngineAvailable) {
    options.push({
      id: 'dev-claude',
      label: 'Claude (subscription)',
      hint: t('engineSwitcher.devClaudeHint', {
        defaultValue: 'Uses the Claude sign-in on this computer (Agent SDK). No API key, no per-message charge.',
      }),
      active: pref === 'dev-claude',
      selectable: true,
      onPick: () => void choose('dev-claude', ''),
    });
  }
  for (const p of state?.providers ?? []) {
    if (p.id === CHATGPT_OAUTH_ID) {
      // DEV-ONLY ChatGPT subscription. Ready is the AUTHORITATIVE sign-in from
      // the server's `chatgptLogin` block (read from the vault) when present, else
      // the coarse provider `ready`. A clean subscription label/hint replaces the
      // long dev-caveat label and the "billed" wording that only fits a metered
      // key. Picking it is the exact same action the Settings card's "use for
      // chats" runs.
      const ready = state?.chatgptLogin ? state.chatgptLogin.available && state.chatgptLogin.signedIn : p.ready;
      options.push({
        id: p.id,
        label: t('chatgptOauth.title', { defaultValue: 'ChatGPT (subscription)' }),
        hint: ready
          ? t('engineSwitcher.chatgptHint', {
              defaultValue: 'Answers on your signed-in ChatGPT subscription. No per-message charge.',
            })
          : t('engineSwitcher.chatgptSignInNeeded', {
              defaultValue: 'Sign in with ChatGPT in Settings to use this.',
            }),
        active: pref === 'ai-sdk' && selectedProvider === p.id,
        selectable: ready,
        onPick: ready ? () => void choose('ai-sdk', p.id) : null,
      });
      continue;
    }
    options.push({
      id: p.id,
      label: p.label,
      hint: p.ready
        ? `${p.model} — billed to your ${p.label} account.`
        : t('engineSwitcher.notConfigured', { defaultValue: 'not configured' }),
      active: pref === 'ai-sdk' && selectedProvider === p.id,
      selectable: p.ready,
      onPick: p.ready ? () => void choose('ai-sdk', p.id) : null,
    });
  }

  return (
    <span
      ref={rootRef}
      className="relative inline-flex items-center text-xs"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-muted-foreground hover:bg-accent disabled:opacity-50 select-none"
        data-testid="engine-status"
        aria-haspopup="menu"
        aria-expanded={open}
        title={state?.engine?.summary ?? undefined}
      >
        {t('chat.engineStatus', { defaultValue: 'Engine' })}
        <span className="text-foreground/70">{chipLabel}</span>
        <ChevronDown className="w-3 h-3 flex-shrink-0 opacity-60" />
      </button>

      {open && (
        <div
          role="menu"
          data-testid="engine-switcher-menu"
          className="absolute top-full left-0 mt-1 z-50 w-72 rounded-md border border-border bg-popover text-popover-foreground shadow-lg p-2 flex flex-col gap-1"
        >
          <span className="px-1 py-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
            {t('engineSwitcher.title', { defaultValue: 'Which model answers' })}
          </span>
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => o.onPick?.()}
              disabled={busy || !o.selectable}
              data-testid={`engine-option-${o.id}`}
              className={`w-full text-left px-2 py-1.5 rounded border transition-colors ${
                o.active
                  ? 'border-brand bg-brand/5'
                  : o.selectable
                    ? 'border-border hover:border-brand/50 hover:bg-accent/40'
                    : 'border-border opacity-60 cursor-not-allowed'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-foreground">{o.label}</span>
                {o.active && (
                  <span className="text-xs text-brand" data-testid="engine-option-active">
                    ✓
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{o.hint}</p>
            </button>
          ))}

          {/* The runtime's own sentence about what will actually happen — the
              single source of truth, not re-derived here. */}
          {state?.engine?.summary && (
            <p className={`px-1 text-xs ${state.engine.ok ? 'text-muted-foreground' : 'text-amber-500'}`}>
              {state.engine.summary}
            </p>
          )}

          <div className="border-t border-border" />

          {/* Key entry / full config lives in Settings; a not-configured provider
              needs it, and this is the one link out to it. */}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onOpenSettings?.();
            }}
            disabled={!onOpenSettings}
            data-testid="engine-switcher-settings"
            className="text-left px-2 py-1 rounded text-muted-foreground hover:bg-accent disabled:opacity-50"
          >
            {t('engineSwitcher.manageInSettings', { defaultValue: 'Manage in Settings' })}
          </button>
        </div>
      )}
    </span>
  );
}
