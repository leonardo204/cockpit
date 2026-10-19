'use client';

/**
 * "Hand work to other tabs" — the app-wide switch for cross-session requests
 * (specs/cross-session-messaging.md R10, setting `sessions.crossSession.enabled`,
 * default ON). Off = naby is not given `naby_list_sessions` /
 * `naby_send_to_session` on the next turn.
 *
 * The same optimistic-then-confirm shape as the participant suggestions toggle
 * next to it: flip at once, put it back if the write did not land.
 */

import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';

async function nabyPost(
  body: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string; crossSessionEnabled?: boolean }> {
  try {
    const res = await fetch('/api/naby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; crossSessionEnabled?: boolean } | null;
    if (!json) return { ok: false, error: `request failed (${res.status})` };
    return { ...json, ok: !!json.ok && res.ok };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export const CrossSessionToggle = memo(function CrossSessionToggle({ isOpen }: { isOpen: boolean }) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    void nabyPost({ action: 'crossSession.get' }).then((res) => {
      if (alive && res.ok && typeof res.crossSessionEnabled === 'boolean') setEnabled(res.crossSessionEnabled);
    });
    return () => {
      alive = false;
    };
  }, [isOpen]);

  const onToggle = useCallback(async () => {
    const next = !enabled;
    setEnabled(next);
    setBusy(true);
    const res = await nabyPost({ action: 'crossSession.set', enabled: next });
    setBusy(false);
    if (!res.ok) {
      setEnabled(!next);
      toast(t('agentManager.crossSession.failed', { defaultValue: 'Could not save: {{error}}', error: res.error ?? '' }), 'error');
      return;
    }
    if (typeof res.crossSessionEnabled === 'boolean') setEnabled(res.crossSessionEnabled);
  }, [enabled, t]);

  const label = t('agentManager.crossSession.toggle', { defaultValue: 'Hand work to other tabs' });
  return (
    <label className="flex cursor-pointer items-start gap-2" data-testid="cross-session-toggle">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={enabled}
        disabled={busy}
        onChange={() => void onToggle()}
        aria-label={label}
      />
      <span className="min-w-0">
        <span className="block text-xs font-semibold text-foreground">{label}</span>
        <span className="block text-[0.714rem] text-muted-foreground">
          {t('agentManager.crossSession.hint', {
            defaultValue:
              'When you ask, naby sends a request to another tab of the same project, and that tab’s answer comes back here.',
          })}
        </span>
      </span>
    </label>
  );
});
