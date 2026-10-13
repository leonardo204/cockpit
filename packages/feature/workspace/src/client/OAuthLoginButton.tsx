'use client';

/**
 * A browser sign-in button for ONE server (org-harness-sync §3.8,
 * mcp-oauth-catalog §4.1) — the Atlassian card, the quick-connect rows, the
 * general MCP list's OAuth rows and the add form all draw this.
 *
 * WHAT IT OWNS: the click that starts a sign-in (the caller's `start` posts the
 * request and opens the authorization URL), the 2 s poll that watches the
 * server's per-server state until the sign-in lands, fails or times out, the
 * cancel, and the toast at the end. WHAT IT DOES NOT: any request shape. The
 * caller passes `start` / `cancel` / `read`, so the same button serves the
 * Atlassian actions (`atlassian.*`, which answer with the org harness state) and
 * the generic ones (`mcpOAuth.*`) without knowing either.
 *
 * A sign-in already running when the button mounts (Settings reopened mid
 * sign-in) is polled too, so its row updates without a reload.
 *
 * No token ever reaches this component — only the status the server reports.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';

const POLL_MS = 2000;
const POLL_LIMIT_MS = 5 * 60 * 1000 + 10_000;

/** What the poll needs to know about the server, per read. */
export type OAuthLoginState = { pending: boolean; connected: boolean; lastError?: string };

export type OAuthLoginStartReply = { ok: true; authorizationUrl?: string } | { ok: false; error: string };

export function OAuthLoginButton({
  testId,
  pending: serverPending,
  label,
  start,
  cancel,
  read,
  onSettled,
  doneMessage,
  failedMessage,
  variant = 'default',
}: {
  testId: string;
  /** The server says a sign-in for this server is running now. */
  pending: boolean;
  /** The idle button's text (already translated). */
  label: string;
  /** Post the start and open the authorization URL. */
  start: () => Promise<OAuthLoginStartReply>;
  cancel: () => Promise<void>;
  /** One status read; `null` = could not read (the poll tries again). */
  read: () => Promise<OAuthLoginState | null>;
  /** The poll ended (signed in, failed, cancelled elsewhere, or gave up). */
  onSettled?: (s: OAuthLoginState) => void;
  doneMessage: string;
  failedMessage: (error: string) => string;
  /** `single`: while pending, ONE button (Cancel) beside a waiting note — the
   *  quick-connect rows' four-state button (mcp-oauth-catalog §3.1). */
  variant?: 'default' | 'single';
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // The callbacks change identity with every parent render; the poll reads the
  // latest through refs so it never restarts because of that.
  const readRef = useRef(read);
  const settledRef = useRef(onSettled);
  const doneRef = useRef(doneMessage);
  const failedRef = useRef(failedMessage);
  useEffect(() => {
    readRef.current = read;
    settledRef.current = onSettled;
    doneRef.current = doneMessage;
    failedRef.current = failedMessage;
  });

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    setPolling(false);
  }, []);
  useEffect(() => stopPolling, [stopPolling]);

  const poll = useCallback(() => {
    stopPolling();
    setPolling(true);
    const started = Date.now();
    pollRef.current = setInterval(() => {
      void readRef.current().then((s) => {
        if (!s) return;
        if (!s.pending || Date.now() - started > POLL_LIMIT_MS) {
          stopPolling();
          setUrl(null);
          settledRef.current?.(s);
          if (s.connected) toast(doneRef.current, 'success');
          else if (s.lastError) toast(failedRef.current(s.lastError), 'error');
        }
      });
    }, POLL_MS);
  }, [stopPolling]);

  // A sign-in that was already running when this mounted.
  useEffect(() => {
    if (serverPending && !pollRef.current) poll();
  }, [serverPending, poll]);

  const login = useCallback(async () => {
    setBusy(true);
    const r = await start();
    setBusy(false);
    if (!r.ok) {
      toast(failedRef.current(r.error), 'error');
      return;
    }
    if (r.authorizationUrl) {
      setUrl(r.authorizationUrl);
      poll();
    } else {
      // Completed without a browser (cannot normally happen): read once.
      const s = await readRef.current();
      if (s) settledRef.current?.(s);
    }
  }, [poll, start]);

  const stop = useCallback(async () => {
    stopPolling();
    setUrl(null);
    await cancel();
    const s = await readRef.current();
    if (s) settledRef.current?.(s);
  }, [cancel, stopPolling]);

  const pending = Boolean(url) || serverPending || polling;
  const waiting = t('orgHarness.atlassian.waiting', { defaultValue: 'Waiting for the browser…' });
  const cancelLabel = t('orgHarness.atlassian.cancel', { defaultValue: 'Cancel' });

  return (
    <div className="space-y-1" data-testid={testId}>
      <div className="flex items-center gap-2">
        {variant === 'single' && pending ? (
          <span className="text-xs text-muted-foreground">{waiting}</span>
        ) : (
          <button
            type="button"
            disabled={busy || pending}
            onClick={() => void login()}
            className="text-xs px-2 py-1 rounded border border-border text-foreground hover:bg-muted disabled:opacity-50"
          >
            {pending ? waiting : label}
          </button>
        )}
        {pending ? (
          <button
            type="button"
            onClick={() => void stop()}
            className="text-xs px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground"
          >
            {cancelLabel}
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
