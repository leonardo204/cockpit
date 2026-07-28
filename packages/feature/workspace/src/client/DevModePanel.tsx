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

type UnlockOutcome = 'unlocked' | 'mismatch' | 'unavailable' | 'not-persisted';

interface DevModeBridge {
  status(): Promise<Result<DevModeStatus>>;
  unlock(key: string): Promise<Result<UnlockOutcome>>;
  lock(): Promise<Result<void>>;
}

/** Which message to show. `'transport'` is the bridge itself failing. */
type Failure = Exclude<UnlockOutcome, 'unlocked'> | 'transport';

const FAILURE_KEY: Record<Failure, string> = {
  mismatch: 'devMode.wrongKey',
  'not-persisted': 'devMode.notPersisted',
  unavailable: 'devMode.unavailable',
  transport: 'devMode.failed',
};

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
  const [failure, setFailure] = useState<Failure | null>(null);
  // Off by default — this is a secret. But a masked field that rejects a key the
  // user knows is right is undiagnosable: an active Korean IME, a smart-quoted
  // paste and a trailing newline all look identical as dots. Let them look.
  const [reveal, setReveal] = useState(false);

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
    setFailure(null);
    try {
      // Sent verbatim. The main process tries the exact string first and the
      // trimmed one as a fallback, so a key with real edge whitespace still
      // works while a stray pasted newline stops being a silent rejection.
      const r = await api.unlock(key);
      if (!r.ok) setFailure('transport');
      else if (r.value !== 'unlocked') setFailure(r.value);
      else {
        setKey(''); // never leave the key sitting in the DOM
        setReveal(false);
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [key, refresh]);

  const relock = useCallback(async () => {
    await bridge()?.lock();
    setFailure(null);
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
              type={reveal ? 'text' : 'password'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
              placeholder={t('devMode.placeholder')}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="flex-1 px-2 py-1.5 text-xs font-mono rounded-md bg-background border border-border text-foreground focus:outline-none focus:ring-1 focus:ring-brand"
            />
            <button
              onClick={() => setReveal((v) => !v)}
              className="px-3 py-1.5 text-xs rounded-md bg-accent text-foreground hover:bg-accent/80 transition-colors"
            >
              {t(reveal ? 'devMode.hide' : 'devMode.reveal')}
            </button>
            <button
              onClick={submit}
              disabled={busy || !key.trim()}
              className="px-3 py-1.5 text-xs rounded-md bg-accent text-foreground hover:bg-accent/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {t('devMode.unlock')}
            </button>
          </div>
          {/* Character count, always. It is the one clue that survives masking:
              a key of the wrong length is a paste or an IME problem, not a
              memory problem, and the user can see that at a glance. */}
          {key.length > 0 && (
            <p className="text-xs text-muted-foreground/60">
              {/* `n`, not `count` — i18next treats `count` as a plural selector
                  and would look for charCount_one / charCount_other. */}
              {t('devMode.charCount', { n: key.length })}
            </p>
          )}
          {failure && <p className="text-xs text-red-500">{t(FAILURE_KEY[failure])}</p>}
        </div>
      )}
    </div>
  );
}
