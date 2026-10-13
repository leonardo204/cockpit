// packages/feature/agent/src/server/lib/mcpOAuthLogin.ts
//
// BROWSER SIGN-INS IN PROGRESS, PER SERVER (specs/mcp-oauth-catalog.md §4.1).
//
// The runtime's `startMcpOAuthLogin` runs one sign-in: a loopback listener, the
// library's `auth()` up to the redirect, the code exchange when the browser comes
// back. What it does not keep is WHICH sign-ins are running — that is this
// module, and the only copy of it in the shell:
//
//   * ONE PENDING SIGN-IN PER SERVER. A second start for the same server cancels
//     the first (its listener closes, any tokens it set aside come back). Sign-ins
//     for DIFFERENT servers run side by side — each has its own loopback port.
//   * THE LAST FAILURE PER SERVER, for the Settings row and the status bar. A
//     cancel is not a failure; a success clears it.
//   * WHAT HAPPENS AFTER. The caller's `onSuccess` runs once the tokens are in the
//     store: the Atlassian swap (orgHarness.ts) or the row the generic actions
//     create only after a successful sign-in (mcpOAuthServers.ts).
//
// Both `atlassian.*` and `mcpOAuth.*` come through here; neither keeps a pending
// login of its own. Refusing a System MCP preset name is the ACTIONS' job (at
// their entry), not this module's — the Atlassian preset signs in through here too.
//
// NO TOKEN LEAVES THIS FILE: the views carry a status word, a boolean and an
// error sentence.

import {
  mcpOAuthStatus,
  startMcpOAuthLogin,
  type McpOAuthFetch,
  type McpOAuthLogin,
  type McpOAuthStatus,
  type Store,
} from '../../../../../../../dist/naby-runtime.mjs';

type Pending = { login: McpOAuthLogin; startedAt: number };

const pending = new Map<string, Pending>();
const lastError = new Map<string, string>();
/** Bumped by every start and cancel, so a start that was overtaken while its
 *  discovery was still running gives its listener up instead of becoming the
 *  pending sign-in. */
const generation = new Map<string, number>();

let fetchOverride: McpOAuthFetch | undefined;
/** Test seam: a fake network for every generic sign-in and probe. `undefined`
 *  restores the global fetch. (Atlassian keeps its own seam in orgHarness.ts.) */
export function setMcpOAuthLoginFetch(fn: McpOAuthFetch | undefined): void {
  fetchOverride = fn;
}
export function mcpOAuthLoginFetch(): McpOAuthFetch | undefined {
  return fetchOverride;
}

export type McpOAuthLoginStart = { ok: true; authorizationUrl: string } | { ok: false; error: string };

function bump(server: string): number {
  const next = (generation.get(server) ?? 0) + 1;
  generation.set(server, next);
  return next;
}

/**
 * Start a browser sign-in for `server`. Returns the authorization URL — the
 * CLIENT opens it. `onSuccess` runs after the callback stored the tokens; an
 * error it throws becomes the server's last error rather than an unhandled
 * rejection.
 */
export async function startServerOAuthLogin(
  store: Store,
  args: {
    server: string;
    serverUrl: string;
    fetch?: McpOAuthFetch;
    resourceMetadataUrl?: string;
    onSuccess?: () => void;
  },
): Promise<McpOAuthLoginStart> {
  const { server } = args;
  pending.get(server)?.login.cancel();
  pending.delete(server);
  lastError.delete(server);
  const gen = bump(server);
  let login: McpOAuthLogin;
  try {
    const fetch = args.fetch ?? fetchOverride;
    login = await startMcpOAuthLogin({
      store,
      server,
      serverUrl: args.serverUrl,
      ...(fetch ? { fetch } : {}),
      ...(args.resourceMetadataUrl ? { resourceMetadataUrl: args.resourceMetadataUrl } : {}),
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (generation.get(server) === gen) lastError.set(server, error);
    return { ok: false, error };
  }
  if (generation.get(server) !== gen) {
    // A newer start (or a cancel) arrived while this one was discovering.
    login.cancel();
    return { ok: false, error: 'cancelled' };
  }
  const mine: Pending = { login, startedAt: Date.now() };
  pending.set(server, mine);
  void login.done.then((r) => {
    if (pending.get(server) === mine) pending.delete(server);
    if (!r.ok) {
      if (r.error !== 'cancelled' && generation.get(server) === gen) lastError.set(server, r.error);
      return;
    }
    lastError.delete(server);
    try {
      args.onSuccess?.();
    } catch (e) {
      lastError.set(server, e instanceof Error ? e.message : String(e));
    }
  });
  return { ok: true, authorizationUrl: login.authorizationUrl };
}

/** End `server`'s pending sign-in, if any. The tokens it set aside come back. */
export function cancelServerOAuthLogin(server: string): void {
  bump(server);
  pending.get(server)?.login.cancel();
  pending.delete(server);
}

export function serverOAuthLoginPending(server: string): boolean {
  return pending.has(server);
}

export function serverOAuthLastError(server: string): string | undefined {
  return lastError.get(server);
}

/** Forget a server's last failure (its row was removed). */
export function clearServerOAuthLastError(server: string): void {
  lastError.delete(server);
}

/** Every server with a sign-in in progress or a failure to report. */
export function serverOAuthLoginNames(): string[] {
  return [...new Set([...pending.keys(), ...lastError.keys()])];
}

/** What the Settings rows and the login button's 2 s poll read for one server
 *  (§4.1). No token, no client id. */
export type McpOAuthServerView = {
  status: McpOAuthStatus;
  pending: boolean;
  lastError?: string;
};

export function readServerOAuthView(store: Pick<Store, 'getSetting'>, server: string): McpOAuthServerView {
  const err = lastError.get(server);
  return {
    status: mcpOAuthStatus(store, server),
    pending: pending.has(server),
    ...(err ? { lastError: err } : {}),
  };
}

/** Test-only: cancel everything and forget every failure. */
export function resetServerOAuthLoginsForTests(): void {
  for (const p of pending.values()) p.login.cancel();
  pending.clear();
  lastError.clear();
  generation.clear();
  fetchOverride = undefined;
}
