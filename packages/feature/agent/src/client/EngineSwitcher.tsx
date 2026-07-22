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

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type NabyProvider = { id: string; label: string; model: string; ready: boolean };

type NabyEngineState = {
  engine: { ok: boolean; id?: string; summary?: string };
  settings: { enginePreference?: string; selectedProvider?: string };
  devEngineAvailable: boolean;
  providers: NabyProvider[];
};

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
};

/** The selected engine's short label, from the same fields the Settings selector
 *  reads. Kept in sync with NabyEngineSelector's option labels by construction. */
function selectedLabel(state: NabyEngineState | null): string {
  if (!state) return '…';
  const id = state.engine?.id;
  if (id === 'ai-sdk') {
    const pid = state.settings?.selectedProvider;
    const p = state.providers?.find((x) => x.id === pid) ?? state.providers?.[0];
    return p ? (p.model ? `${p.label} · ${p.model}` : p.label) : 'API provider';
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

export function EngineSwitcher({ liveModel, onOpenSettings }: EngineSwitcherProps) {
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
    [load],
  );

  // The chip prefers the live-resolved model once a turn has started; before
  // that, the selected engine's label from /api/naby.
  const chipLabel = liveModel ?? selectedLabel(state);

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
