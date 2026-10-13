'use client';

/**
 * REMOTE MCP BROWSER SIGN-IN IN SETTINGS → CONNECTIONS (mcp-oauth-catalog §3).
 *
 *   `McpQuickConnectSection`  the "Quick connect" rows above the general MCP list:
 *                             Notion, Linear, Asana, Sentry, one button each
 *   `McpOAuthLoginButton`     the sign-in button for one server, over the generic
 *                             `mcpOAuth.*` actions — used by the quick-connect
 *                             rows, the general list's OAuth rows, an approved
 *                             proposal that needs a sign-in, and the add form
 *   `McpOAuthStatusBadge`     connected / sign in again / not signed in
 *
 * THE FOUR STATES OF A QUICK-CONNECT ROW (§3.1), and what its one button does:
 *
 *   not connected   Connect       starts the browser sign-in
 *   signing in      Cancel        ends the pending sign-in
 *   connected       Disconnect    removes the row and the tokens
 *   sign in again   Log in again  starts the browser sign-in again
 *
 * plus a fifth that is not a state of the server: another row already has the
 * name. Then the row says so and offers nothing — quick connect never overwrites
 * a server the user set up themselves.
 *
 * The server decides every one of these (`mcpOAuth` on the GET); nothing here
 * derives a state from the MCP list, and no URL is known on this side.
 */

import { useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  cancelMcpOAuthLoginFlow,
  disconnectMcpOAuth,
  readMcpOAuthStatus,
  startMcpOAuthLoginFlow,
  type McpOAuthCatalogView,
  type McpOAuthServerView,
} from '@cockpit/feature-agent';
import { MCP_OAUTH_CATALOG } from './mcpOAuthCatalog';
import { OAuthLoginButton, type OAuthLoginState, type OAuthLoginStartReply } from './OAuthLoginButton';

/** The sign-in button for one remote MCP server. */
export function McpOAuthLoginButton({
  server,
  displayName,
  pending,
  label,
  url,
  transport,
  resourceMetadataUrl,
  replace,
  onSettled,
  variant,
}: {
  server: string;
  /** How the toasts name the server (a quick-connect title, or the row name). */
  displayName: string;
  pending: boolean;
  label: string;
  /** For a server that is not in quick connect: where to sign in. */
  url?: string;
  transport?: 'http' | 'sse';
  /** What the URL check found (§3.2), so the login's discovery starts there. */
  resourceMetadataUrl?: string;
  /** The edit form of that very row. */
  replace?: boolean;
  onSettled?: (s: OAuthLoginState) => void;
  variant?: 'default' | 'single';
}) {
  const { t } = useTranslation();

  const start = useCallback(async (): Promise<OAuthLoginStartReply> => {
    const r = await startMcpOAuthLoginFlow(server, {
      ...(url ? { url } : {}),
      ...(transport ? { transport } : {}),
      ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
      ...(replace ? { replace } : {}),
    });
    if (!r.ok) {
      return { ok: false, error: r.errorKey ? t(r.errorKey, { name: server, defaultValue: r.error }) : r.error };
    }
    return { ok: true, ...(r.authorizationUrl ? { authorizationUrl: r.authorizationUrl } : {}) };
  }, [replace, resourceMetadataUrl, server, t, transport, url]);

  const cancel = useCallback(async () => {
    await cancelMcpOAuthLoginFlow(server);
  }, [server]);

  const read = useCallback(async (): Promise<OAuthLoginState | null> => {
    const r = await readMcpOAuthStatus();
    if (!r.ok || !r.mcpOAuth) return null;
    // A server with no row, no sign-in running and nothing to report is one
    // whose sign-in was cancelled before it ever made a row.
    const v: McpOAuthServerView = r.mcpOAuth.servers[server] ?? { status: 'none', pending: false };
    return {
      pending: v.pending,
      connected: v.status === 'connected',
      ...(v.lastError ? { lastError: v.lastError } : {}),
    };
  }, [server]);

  return (
    <OAuthLoginButton
      testId={`mcp-oauth-login-${server}`}
      pending={pending}
      label={label}
      start={start}
      cancel={cancel}
      read={read}
      {...(onSettled ? { onSettled } : {})}
      {...(variant ? { variant } : {})}
      doneMessage={t('mcpOAuth.loginDone', { name: displayName, defaultValue: 'Connected to {{name}}.' })}
      failedMessage={(error) =>
        t('mcpOAuth.loginFailed', { name: displayName, error, defaultValue: '{{name}} sign-in failed: {{error}}' })
      }
    />
  );
}

/** connected / sign in again / not signed in — for an OAuth row. */
export function McpOAuthStatusBadge({ status }: { status: McpOAuthServerView['status'] }) {
  const { t } = useTranslation();
  const cls =
    status === 'connected'
      ? 'text-green-600 dark:text-green-400 border-green-500/50'
      : status === 'relogin'
        ? 'text-amber-600 dark:text-amber-400 border-amber-500/50'
        : 'text-muted-foreground border-border';
  return (
    <span
      className={`shrink-0 text-[0.714rem] tracking-wide border rounded px-1 py-px ${cls}`}
      data-testid="mcp-oauth-badge"
    >
      {t(`mcpOAuth.status.${status}`)}
    </span>
  );
}

/** One quick-connect row: name, one-line description, one button. */
function QuickConnectRow({
  name,
  titleKey,
  descriptionKey,
  view,
  onChanged,
}: {
  name: string;
  titleKey: string;
  descriptionKey: string;
  view: McpOAuthCatalogView;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const title = t(titleKey);

  const disconnect = useCallback(async () => {
    setBusy(true);
    await disconnectMcpOAuth(name);
    setBusy(false);
    onChanged();
  }, [name, onChanged]);

  let control: ReactNode;
  if (view.conflict) {
    control = <span className="text-xs text-muted-foreground">{t('mcpOAuth.nameTaken')}</span>;
  } else if (view.status === 'connected' && !view.pending) {
    control = (
      <button
        type="button"
        disabled={busy}
        onClick={() => void disconnect()}
        className="text-xs px-2 py-1 rounded border border-border text-muted-foreground hover:text-red-500 disabled:opacity-40"
      >
        {t('mcpOAuth.disconnect')}
      </button>
    );
  } else {
    control = (
      <McpOAuthLoginButton
        server={name}
        displayName={title}
        pending={view.pending}
        label={view.status === 'relogin' ? t('mcpOAuth.relogin') : t('mcpOAuth.connect')}
        onSettled={() => onChanged()}
        variant="single"
      />
    );
  }

  return (
    <div className="flex items-start justify-between gap-2 py-1" data-testid={`mcp-quick-connect-${name}`}>
      <div className="min-w-0">
        <p className="text-sm text-foreground flex items-center gap-1.5">
          {title}
          {view.present && !view.conflict && view.status !== 'none' ? (
            <McpOAuthStatusBadge status={view.status} />
          ) : null}
        </p>
        <p className="text-xs text-muted-foreground">{t(descriptionKey)}</p>
        {view.lastError && !view.pending ? (
          <p className="text-xs text-red-500 break-words">
            {t('mcpOAuth.loginFailed', { name: title, error: view.lastError })}
          </p>
        ) : null}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

/** The "Quick connect" subsection, above the general MCP list. */
export function McpQuickConnectSection({
  catalog,
  onChanged,
}: {
  catalog: Record<string, McpOAuthCatalogView> | undefined;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1 pt-2" data-testid="mcp-quick-connect">
      <p className="text-xs font-medium text-foreground">{t('mcpOAuth.quickConnect.title')}</p>
      <p className="text-xs text-muted-foreground">{t('mcpOAuth.quickConnect.description')}</p>
      <div className="border border-border rounded px-2 py-1 divide-y divide-border">
        {MCP_OAUTH_CATALOG.map((entry) => (
          <QuickConnectRow
            key={entry.name}
            name={entry.name}
            titleKey={entry.titleKey}
            descriptionKey={entry.descriptionKey}
            // A server the GET has not answered for yet reads as not connected.
            view={catalog?.[entry.name] ?? { status: 'none', pending: false, conflict: false, present: false }}
            onChanged={onChanged}
          />
        ))}
      </div>
    </div>
  );
}
