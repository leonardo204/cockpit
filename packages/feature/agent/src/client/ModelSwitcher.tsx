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
 * The candidate lists live in modelCatalog.ts (researched per engine, not a
 * runtime export — there is no per-provider model list in the runtime).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  defaultModelForScope,
  modelLabel,
  modelScopeFor,
  modelsForScope,
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
  const [value, setValue] = useState<string>('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const aliveRef = useRef(true);
  const rootRef = useRef<HTMLSpanElement>(null);
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
  const options = modelsForScope(scope);
  if (options.length === 0) return null;

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
        <span className="text-foreground/70">{modelLabel(scope, value)}</span>
        <ChevronDown className="w-3 h-3 flex-shrink-0 opacity-60" />
      </button>

      {open && (
        <div
          role="menu"
          data-testid="model-switcher-menu"
          className="absolute top-full left-0 mt-1 z-50 w-64 rounded-md border border-border bg-popover text-popover-foreground shadow-lg p-2 flex flex-col gap-1"
        >
          <span className="px-1 py-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
            {t('modelSwitcher.title', { defaultValue: 'Which model' })}
          </span>
          {options.map((o) => {
            const active = o.value === value;
            return (
              <button
                key={o.value || 'default'}
                type="button"
                onClick={() => void pick(o.value)}
                disabled={busy}
                data-testid={`model-option-${o.value || 'default'}`}
                className={`w-full text-left px-2 py-1.5 rounded border transition-colors ${
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
      )}
    </span>
  );
}
