'use client';

/**
 * The Atlassian browser sign-in button (org-harness-sync §3.8), shared by the
 * org harness card and the System MCP row.
 *
 * The requests themselves (`atlassian.login`, opening the authorization URL,
 * `atlassian.cancelLogin`) are feature-agent's `atlassianLogin.ts`, which the
 * chat status bar uses too. This button adds its own 2 s poll of
 * `orgHarness.get` (the card wants the whole state) until the sign-in lands or
 * fails. No token ever reaches this component — only the status the server
 * reports.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';
import {
  announceConnectionsChanged,
  cancelAtlassianLoginFlow,
  readOrgHarnessForLogin,
  startAtlassianLoginFlow,
} from '@cockpit/feature-agent';
import type { AtlassianView, OrgHarnessView } from './orgHarnessView';
import { atlassianLoginKey } from './orgHarnessView';

const POLL_MS = 2000;
const POLL_LIMIT_MS = 5 * 60 * 1000 + 10_000;

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
      void readOrgHarnessForLogin<OrgHarnessView>().then((r) => {
        if (!r.ok || !r.orgHarness) return;
        onState(r.orgHarness);
        const a = r.orgHarness.atlassian;
        if (!a?.loginPending || Date.now() - started > POLL_LIMIT_MS) {
          stopPolling();
          setUrl(null);
          // The chat status bars in the project frames turn green/amber now.
          announceConnectionsChanged();
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
    // Opens the authorization URL itself (system browser in the app).
    const r = await startAtlassianLoginFlow<OrgHarnessView>();
    setBusy(false);
    if (!r.ok) {
      toast(t('orgHarness.atlassian.loginFailed', { error: r.error, defaultValue: 'Atlassian sign-in failed: {{error}}' }), 'error');
      return;
    }
    if (r.orgHarness) onState(r.orgHarness);
    if (r.authorizationUrl) {
      setUrl(r.authorizationUrl);
      poll();
    }
  }, [onState, poll, t]);

  const cancel = useCallback(async () => {
    stopPolling();
    setUrl(null);
    const r = await cancelAtlassianLoginFlow<OrgHarnessView>();
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
