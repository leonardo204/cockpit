'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * DevModePanel — unlock the dev-only providers inside a shipped build.
 *
 * A packaged build seals the Claude local sign-in and the ChatGPT subscription
 * path on purpose. That is right for users and unhelpful for whoever has to test
 * the release: reproducing a bug in the real artifact meant rebuilding it
 * unpackaged, which is a different binary from the one that shipped. This is the
 * key-gated exception.
 *
 * RENDERS NOTHING when the build has no door — the hash is baked at build time
 * from `FORCE_DEVMODE_KEY`, and a build made without that key reports
 * `available: false`. An official release therefore shows no field, no hint, and
 * no locked control to poke at.
 *
 * The distinction between `unlocked` and `activeNow` is load-bearing and is
 * shown, not hidden: `boot()` reads the seal once at startup, so a key entered
 * now governs the NEXT launch. Saying "restart to apply" is honest; silently
 * doing nothing until the user happens to restart is not.
 */

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

interface DevModeStatus {
  available: boolean;
  unlocked: boolean;
  activeNow: boolean;
}

interface DevModeBridge {
  status(): Promise<Result<DevModeStatus>>;
  unlock(key: string): Promise<Result<boolean>>;
  lock(): Promise<Result<void>>;
}

function bridge(): DevModeBridge | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { naby?: { devMode?: DevModeBridge } };
  return w.naby?.devMode ?? null;
}

export function DevModePanel() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<DevModeStatus | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    const api = bridge();
    if (!api) return;
    const r = await api.status();
    if (r.ok) setStatus(r.value);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submit = useCallback(async () => {
    const api = bridge();
    if (!api || !key.trim()) return;
    setBusy(true);
    setFailed(false);
    try {
      const r = await api.unlock(key);
      const okNow = r.ok && r.value === true;
      setFailed(!okNow);
      if (okNow) setKey(''); // never leave the key sitting in the DOM
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [key, refresh]);

  const relock = useCallback(async () => {
    await bridge()?.lock();
    setFailed(false);
    await refresh();
  }, [refresh]);

  // No bridge (browser dev server) or no door in this build: render nothing at
  // all. A disabled control would advertise a feature this binary does not have.
  if (!bridge() || !status?.available) return null;

  return (
    <div className="mt-6 pt-4 border-t border-border">
      <label className="block text-sm font-medium text-foreground mb-1">
        {t('devMode.title')}
      </label>
      <p className="text-xs text-muted-foreground/70 mb-2">{t('devMode.description')}</p>

      {status.unlocked ? (
        <div className="space-y-2">
          <p className="text-xs text-emerald-500">
            {status.activeNow ? t('devMode.active') : t('devMode.unlockedRestart')}
          </p>
          <button
            onClick={relock}
            className="px-3 py-1.5 text-xs rounded-md bg-accent text-foreground hover:bg-accent/80 transition-colors"
          >
            {t('devMode.lock')}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
              placeholder={t('devMode.placeholder')}
              className="flex-1 px-2 py-1.5 text-xs rounded-md bg-background border border-border text-foreground focus:outline-none focus:ring-1 focus:ring-brand"
            />
            <button
              onClick={submit}
              disabled={busy || !key.trim()}
              className="px-3 py-1.5 text-xs rounded-md bg-accent text-foreground hover:bg-accent/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {t('devMode.unlock')}
            </button>
          </div>
          {failed && <p className="text-xs text-red-500">{t('devMode.wrongKey')}</p>}
        </div>
      )}
    </div>
  );
}
