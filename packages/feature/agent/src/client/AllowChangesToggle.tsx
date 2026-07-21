'use client';

/**
 * "Allow changes" — the app-wide gate policy toggle, shown next to Plan mode.
 *
 * WHAT IT CONTROLS. The naby engine reads a single global setting
 * (`gate.allowChanges`, default ON when unset) once per turn:
 *   * ON  — the agent may run commands and write/edit files, like the bare
 *           `claude` CLI. Every call is still logged through the gate.
 *   * OFF — read-only observation: mutation/exec is denied from the main loop
 *           and from inside any subagent (the Phase-1 harness floor).
 *
 * WHY A SEPARATE COMPONENT, NOT INLINE STATE IN Chat. The setting is GLOBAL, not
 * per-tab: every chat tab reflects the same value, and flipping it in one tab
 * must be the truth everywhere on the next message. So this owns no per-tab
 * state — it reads the authoritative value from `/api/naby` and writes it back,
 * the same read/write shape `ClaudeLoginStatus` uses for the sign-in status.
 *
 * NO SECRETS. `gate.allowChanges` is an ordinary application setting; nothing
 * here reads, sends, or logs any credential.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldCheck, ShieldAlert } from 'lucide-react';

export function AllowChangesToggle() {
  const { t } = useTranslation();
  const [allowChanges, setAllowChanges] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  // Guards a state update after unmount — every chat tab mounts one of these.
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/naby');
      if (!res.ok) return;
      const data = (await res.json()) as { gate?: { allowChanges?: boolean } };
      // An older server without the gate block simply omits it; default to the
      // engine's own default (ON) rather than rendering an indeterminate box.
      if (aliveRef.current && typeof data.gate?.allowChanges === 'boolean') {
        setAllowChanges(data.gate.allowChanges);
      } else if (aliveRef.current) {
        setAllowChanges(true);
      }
    } catch {
      // A failed poll keeps the last known answer; the send path surfaces any
      // real gate behaviour far more clearly than this control could.
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    // Re-read on focus so a flip made in another tab/window is reflected here
    // without a manual refresh. Cheap: one local request, no secret.
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      aliveRef.current = false;
      window.removeEventListener('focus', onFocus);
    };
  }, [load]);

  const toggle = useCallback(
    async (next: boolean) => {
      // Optimistic: the box moves immediately; a failed write rolls it back so
      // the control never lies about the persisted value.
      const previous = allowChanges;
      setAllowChanges(next);
      setSaving(true);
      try {
        const res = await fetch('/api/naby', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'gate.set', allowChanges: next }),
        });
        if (!res.ok && aliveRef.current) setAllowChanges(previous ?? true);
      } catch {
        if (aliveRef.current) setAllowChanges(previous ?? true);
      } finally {
        if (aliveRef.current) setSaving(false);
      }
    },
    [allowChanges],
  );

  // Until the first read resolves, render nothing rather than guess a value the
  // user might then see flip under them.
  if (allowChanges === null) return null;

  const on = allowChanges;
  return (
    <label
      className="flex items-center gap-1.5 ml-2 pl-3 border-l border-border text-xs cursor-pointer select-none"
      data-testid="allow-changes-toggle-label"
      title={
        on
          ? t('chat.allowChangesHintOn', {
              defaultValue:
                'Allow changes is ON: the agent can edit files and run commands. Every action is still logged. Uncheck for read-only (observe).',
            })
          : t('chat.allowChangesHintOff', {
              defaultValue:
                'Read-only (observe): the agent can inspect but cannot edit files or run commands. Check to allow full access.',
            })
      }
    >
      <input
        type="checkbox"
        data-testid="allow-changes-toggle"
        checked={on}
        disabled={saving}
        onChange={(e) => void toggle(e.target.checked)}
        className="accent-brand disabled:opacity-50"
      />
      <span className="flex items-center gap-1 text-foreground">
        {on ? (
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
        ) : (
          <ShieldAlert className="w-3.5 h-3.5 text-amber-500" />
        )}
        {t('chat.allowChanges', { defaultValue: 'Allow changes' })}
      </span>
      <span className="text-muted-foreground" data-testid="allow-changes-state">
        {on
          ? t('chat.allowChangesOn', { defaultValue: 'full access' })
          : t('chat.allowChangesOff', { defaultValue: 'read-only · observe' })}
      </span>
    </label>
  );
}
