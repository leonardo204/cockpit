'use client';

/**
 * Browser sign-in requests for ANY remote MCP server (mcp-oauth-catalog §4.1):
 * quick connect, the add form's URL check, and the per-row (re-)login of the
 * general MCP list. The Atlassian preset keeps its own requests
 * (`atlassianLogin.ts`) because the chat status bar and the org harness card
 * read its richer state; underneath, the server runs both through one
 * per-server sign-in manager.
 *
 * `window.open` is handed to the system browser by the app's window-open
 * handler (electron/boot.ts); in a plain browser it opens a tab.
 *
 * These servers are not in the chat status bar (§4.3), so nothing here
 * announces `ConnectionsChanged`.
 */

/** One browser-OAuth server, as the server reports it. No token. */
export type McpOAuthServerView = {
  status: 'connected' | 'relogin' | 'none';
  pending: boolean;
  lastError?: string;
};

/** One quick-connect entry: its state, and whether another row has its name. */
export type McpOAuthCatalogView = McpOAuthServerView & {
  conflict: boolean;
  /** The quick-connect row exists (the general list hides it). */
  present: boolean;
};

export type McpOAuthStatusView = {
  servers: Record<string, McpOAuthServerView>;
  catalog: Record<string, McpOAuthCatalogView>;
};

export type McpOAuthProbeView = {
  verdict: 'open' | 'oauth' | 'no-registration' | 'unreachable';
  status?: number;
  error?: string;
  resourceMetadataUrl?: string;
};

export type McpOAuthReply =
  | { ok: true; mcpOAuth?: McpOAuthStatusView; authorizationUrl?: string; probe?: McpOAuthProbeView }
  | { ok: false; error: string; errorKey?: string };

async function post(body: Record<string, unknown>): Promise<McpOAuthReply> {
  try {
    const res = await fetch('/api/naby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as
      | {
          ok?: boolean;
          mcpOAuth?: McpOAuthStatusView;
          authorizationUrl?: string;
          probe?: McpOAuthProbeView;
          error?: string;
          errorKey?: string;
        }
      | null;
    if (!res.ok || !json?.ok) {
      return {
        ok: false,
        error: json?.error ?? `request failed (${res.status})`,
        ...(json?.errorKey ? { errorKey: json.errorKey } : {}),
      };
    }
    return {
      ok: true,
      ...(json.mcpOAuth ? { mcpOAuth: json.mcpOAuth } : {}),
      ...(typeof json.authorizationUrl === 'string' ? { authorizationUrl: json.authorizationUrl } : {}),
      ...(json.probe ? { probe: json.probe } : {}),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Start a sign-in for `server` and open the authorization URL. `url` is needed
 * for a server that is not in quick connect (the add form, a proposed row);
 * `replace` says the caller is the edit form of that very row.
 */
export async function startMcpOAuthLoginFlow(
  server: string,
  opts: { url?: string; transport?: 'http' | 'sse'; resourceMetadataUrl?: string; replace?: boolean } = {},
): Promise<McpOAuthReply> {
  const r = await post({ action: 'mcpOAuth.login', server, ...opts });
  if (r.ok && r.authorizationUrl && typeof window !== 'undefined') {
    window.open(r.authorizationUrl, '_blank', 'noopener');
  }
  return r;
}

export function cancelMcpOAuthLoginFlow(server: string): Promise<McpOAuthReply> {
  return post({ action: 'mcpOAuth.cancel', server });
}

/** Remove the row and its sign-in. */
export function disconnectMcpOAuth(server: string): Promise<McpOAuthReply> {
  return post({ action: 'mcpOAuth.disconnect', server });
}

/** The login button's 2 s poll. */
export function readMcpOAuthStatus(): Promise<McpOAuthReply> {
  return post({ action: 'mcpOAuth.status' });
}

/** The add form's URL check (§3.2). Stores nothing. */
export function probeMcpOAuthUrl(url: string, transport: 'http' | 'sse'): Promise<McpOAuthReply> {
  return post({ action: 'mcpOAuth.probe', url, transport });
}
