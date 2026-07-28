'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * UpdatePanel — "check for updates", by hand.
 *
 * The updater already ran on its own: 20 seconds after launch, then every six
 * hours, downloading in the background and offering a restart when a build is
 * ready. What was missing was any way to ASK. A user who has just been told a
 * new version exists should not have to quit and reopen the app, or wait six
 * hours, to find out whether it has arrived — and when the answer is "you are
 * already current", saying so plainly is the whole feature.
 *
 * Everything here is main-process state reached over the preload bridge
 * (`window.naby.updates`); there is no HTTP route and no store involvement. The
 * bridge is deliberately narrow: status in, three commands out, no token or
 * feed URL ever crosses.
 *
 * `unsupported` is a real state, not an error. An unsigned macOS build cannot
 * replace itself (Squirrel validates the running app's designated requirement),
 * so the panel offers the releases page instead of a button that would fail.
 */

type UpdateState = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'unsupported';

interface UpdateStatus {
  state: UpdateState;
  version?: string;
  percent?: number;
  reason?: string;
  error?: string;
  releasesUrl: string;
  currentVersion: string;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

interface UpdatesBridge {
  get(): Promise<Result<UpdateStatus>>;
  check(): Promise<Result<UpdateStatus>>;
  install(): Promise<Result<void>>;
  openReleasesPage(): Promise<Result<void>>;
  onStatus(cb: (s: UpdateStatus) => void): () => void;
}

function bridge(): UpdatesBridge | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { naby?: { updates?: UpdatesBridge } };
  return w.naby?.updates ?? null;
}

const unwrap = <T,>(r: Result<T> | undefined): T | null =>
  r && r.ok ? r.value : null;

export function UpdatePanel() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  // Set only by a check the USER started, so the "you are up to date" line
  // appears because they asked — not because a background check happened to
  // settle while Settings was open.
  const [checkedByUser, setCheckedByUser] = useState(false);

  // Current status on mount, then live pushes. Without the initial read a panel
  // opened after the last push would render empty until something changed.
  useEffect(() => {
    const api = bridge();
    if (!api) return;
    let alive = true;
    void api.get().then((r) => {
      if (alive) setStatus(unwrap(r));
    });
    const off = api.onStatus((s) => {
      if (alive) setStatus(s);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const check = useCallback(async () => {
    const api = bridge();
    if (!api) return;
    setBusy(true);
    setCheckedByUser(true);
    try {
      // Resolves when the check SETTLES, not when it starts, so the button can
      // stay disabled for the whole round trip.
      const next = unwrap(await api.check());
      if (next) setStatus(next);
    } finally {
      setBusy(false);
    }
  }, []);

  const install = useCallback(async () => {
    await bridge()?.install();
  }, []);

  const openReleases = useCallback(async () => {
    await bridge()?.openReleasesPage();
  }, []);

  const api = bridge();
  if (!api) {
    // Browser/dev context — the bridge only exists inside Electron.
    return (
      <p className="text-xs text-muted-foreground/60">{t('updates.desktopOnly')}</p>
    );
  }

  const state = status?.state ?? 'idle';
  const checking = busy || state === 'checking';

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          onClick={check}
          disabled={checking || state === 'downloading'}
          className="px-3 py-1.5 text-xs rounded-md bg-accent text-foreground hover:bg-accent/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {checking ? t('updates.checking') : t('updates.check')}
        </button>

        {state === 'ready' && (
          <button
            onClick={install}
            className="px-3 py-1.5 text-xs rounded-md bg-brand text-white hover:opacity-90 transition-opacity"
          >
            {t('updates.restartNow')}
          </button>
        )}

        {state === 'unsupported' && (
          <button
            onClick={openReleases}
            className="px-3 py-1.5 text-xs rounded-md bg-accent text-foreground hover:bg-accent/80 transition-colors"
          >
            {t('updates.openReleases')}
          </button>
        )}
      </div>

      <div className="text-xs text-muted-foreground">
        {state === 'downloading' ? (
          <span>
            {t('updates.downloading', { version: status?.version ?? '' })}
            {typeof status?.percent === 'number' ? ` · ${Math.round(status.percent)}%` : ''}
          </span>
        ) : state === 'available' ? (
          <span>{t('updates.available', { version: status?.version ?? '' })}</span>
        ) : state === 'ready' ? (
          <span>{t('updates.ready', { version: status?.version ?? '' })}</span>
        ) : state === 'unsupported' ? (
          <span>{t('updates.unsupported')}</span>
        ) : status?.error ? (
          <span className="text-red-500">{t('updates.failed')}</span>
        ) : checkedByUser && !checking ? (
          // The answer to the question they actually asked.
          <span>{t('updates.upToDate', { version: status?.currentVersion ?? '' })}</span>
        ) : null}
      </div>
    </div>
  );
}
