'use client';

/**
 * The Atlassian browser sign-in button (org-harness-sync §3.8), shared by the
 * org harness card and the System MCP row.
 *
 * `atlassian.login` starts the server's loopback listener and answers with the
 * authorization URL; this opens it with `window.open`, which the app hands to the
 * system browser (electron/boot.ts window-open handler), then polls
 * `orgHarness.get` until the sign-in lands or fails. No token ever reaches this
 * component — only the status the server reports.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';
import type { AtlassianView, OrgHarnessView } from './orgHarnessView';
import { atlassianLoginKey } from './orgHarnessView';

const POLL_MS = 2000;
const POLL_LIMIT_MS = 5 * 60 * 1000 + 10_000;

async function post(body: Record<string, unknown>): Promise<
  { ok: true; orgHarness?: OrgHarnessView; authorizationUrl?: string } | { ok: false; error: string }
> {
  try {
    const res = await fetch('/api/naby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; orgHarness?: OrgHarnessView; authorizationUrl?: string; error?: string }
      | null;
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? `request failed (${res.status})` };
    return {
      ok: true,
      ...(json.orgHarness ? { orgHarness: json.orgHarness } : {}),
      ...(typeof json.authorizationUrl === 'string' ? { authorizationUrl: json.authorizationUrl } : {}),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function AtlassianLoginButton({
  atlassian,
  onState,
}: {
  atlassian: AtlassianView | undefined;
  /** Receives every fresh org harness state (so the parent re-renders). */
  onState: (v: OrgHarnessView) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);
  useEffect(() => stopPolling, [stopPolling]);

  const poll = useCallback(() => {
    stopPolling();
    const started = Date.now();
    pollRef.current = setInterval(() => {
      void post({ action: 'orgHarness.get' }).then((r) => {
        if (!r.ok || !r.orgHarness) return;
        onState(r.orgHarness);
        const a = r.orgHarness.atlassian;
        if (!a?.loginPending || Date.now() - started > POLL_LIMIT_MS) {
          stopPolling();
          setUrl(null);
          if (a?.status === 'connected') {
            toast(t('orgHarness.atlassian.loginDone', { defaultValue: 'Signed in to Atlassian.' }), 'success');
          } else if (a?.lastLoginError) {
            toast(t('orgHarness.atlassian.loginFailed', { error: a.lastLoginError, defaultValue: 'Atlassian sign-in failed: {{error}}' }), 'error');
          }
        }
      });
    }, POLL_MS);
  }, [onState, stopPolling, t]);

  const login = useCallback(async () => {
    setBusy(true);
    const r = await post({ action: 'atlassian.login' });
    setBusy(false);
    if (!r.ok) {
      toast(t('orgHarness.atlassian.loginFailed', { error: r.error, defaultValue: 'Atlassian sign-in failed: {{error}}' }), 'error');
      return;
    }
    if (r.orgHarness) onState(r.orgHarness);
    if (r.authorizationUrl) {
      setUrl(r.authorizationUrl);
      // The app routes this to the OS browser; a plain browser opens a tab.
      window.open(r.authorizationUrl, '_blank', 'noopener');
      poll();
    }
  }, [onState, poll, t]);

  const cancel = useCallback(async () => {
    stopPolling();
    setUrl(null);
    const r = await post({ action: 'atlassian.cancelLogin' });
    if (r.ok && r.orgHarness) onState(r.orgHarness);
  }, [onState, stopPolling]);

  const pending = Boolean(url) || Boolean(atlassian?.loginPending);
  const label = atlassian ? atlassianLoginKey(atlassian) : 'orgHarness.atlassian.login';

  return (
    <div className="space-y-1" data-testid="atlassian-login">
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy || pending}
          onClick={() => void login()}
          className="text-xs px-2 py-1 rounded border border-border text-foreground hover:bg-muted disabled:opacity-50"
        >
          {pending
            ? t('orgHarness.atlassian.waiting', { defaultValue: 'Waiting for the browser…' })
            : t(label, {
                defaultValue: label.endsWith('relogin') ? 'Log in to Atlassian again' : 'Log in to Atlassian',
              })}
        </button>
        {pending ? (
          <button
            type="button"
            onClick={() => void cancel()}
            className="text-xs px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground"
          >
            {t('orgHarness.atlassian.cancel', { defaultValue: 'Cancel' })}
          </button>
        ) : null}
      </div>
      {url ? (
        <p className="text-[0.714rem] text-muted-foreground break-all">
          {t('orgHarness.atlassian.openHint', {
            defaultValue: 'If no browser window opened, open this address:',
          })}{' '}
          <a href={url} target="_blank" rel="noopener noreferrer" className="underline">
            {url}
          </a>
        </p>
      ) : null}
    </div>
  );
}
