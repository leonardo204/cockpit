'use client';

/**
 * The Atlassian browser sign-in button (org-harness-sync §3.8), shared by the
 * org harness card and the System MCP row.
 *
 * The button itself is the server-parameterized `OAuthLoginButton`
 * (mcp-oauth-catalog §4.1); this file only plugs the Atlassian requests into it.
 * Those requests (`atlassian.login`, opening the authorization URL,
 * `atlassian.cancelLogin`) are feature-agent's `atlassianLogin.ts`, which the
 * chat status bar uses too. The poll reads `orgHarness.get` (the card wants the
 * whole state) until the sign-in lands or fails, and tells the status bars when
 * it is over. No token ever reaches this component — only the status the server
 * reports.
 */

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  announceConnectionsChanged,
  cancelAtlassianLoginFlow,
  readOrgHarnessForLogin,
  startAtlassianLoginFlow,
} from '@cockpit/feature-agent';
import type { AtlassianView, OrgHarnessView } from './orgHarnessView';
import { atlassianLoginKey } from './orgHarnessView';
import { OAuthLoginButton, type OAuthLoginState, type OAuthLoginStartReply } from './OAuthLoginButton';

export function AtlassianLoginButton({
  atlassian,
  onState,
}: {
  atlassian: AtlassianView | undefined;
  /** Receives every fresh org harness state (so the parent re-renders). */
  onState: (v: OrgHarnessView) => void;
}) {
  const { t } = useTranslation();

  const start = useCallback(async (): Promise<OAuthLoginStartReply> => {
    // Opens the authorization URL itself (system browser in the app).
    const r = await startAtlassianLoginFlow<OrgHarnessView>();
    if (!r.ok) return r;
    if (r.orgHarness) onState(r.orgHarness);
    return { ok: true, ...(r.authorizationUrl ? { authorizationUrl: r.authorizationUrl } : {}) };
  }, [onState]);

  const cancel = useCallback(async () => {
    const r = await cancelAtlassianLoginFlow<OrgHarnessView>();
    if (r.ok && r.orgHarness) onState(r.orgHarness);
  }, [onState]);

  const read = useCallback(async (): Promise<OAuthLoginState | null> => {
    const r = await readOrgHarnessForLogin<OrgHarnessView>();
    if (!r.ok || !r.orgHarness) return null;
    onState(r.orgHarness);
    const a = r.orgHarness.atlassian;
    return {
      pending: Boolean(a?.loginPending),
      connected: a?.status === 'connected',
      ...(a?.lastLoginError ? { lastError: a.lastLoginError } : {}),
    };
  }, [onState]);

  // The chat status bars in the project frames turn green/amber now.
  const settled = useCallback(() => announceConnectionsChanged(), []);

  const label = atlassian ? atlassianLoginKey(atlassian) : 'orgHarness.atlassian.login';

  return (
    <OAuthLoginButton
      testId="atlassian-login"
      pending={Boolean(atlassian?.loginPending)}
      label={t(label, {
        defaultValue: label.endsWith('relogin') ? 'Log in to Atlassian again' : 'Log in to Atlassian',
      })}
      start={start}
      cancel={cancel}
      read={read}
      onSettled={settled}
      doneMessage={t('orgHarness.atlassian.loginDone', { defaultValue: 'Signed in to Atlassian.' })}
      failedMessage={(error) =>
        t('orgHarness.atlassian.loginFailed', { error, defaultValue: 'Atlassian sign-in failed: {{error}}' })
      }
    />
  );
}
