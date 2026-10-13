// packages/feature/agent/src/server/lib/mcpOAuthServers.ts
//
// THE `mcpOAuth.*` ACTIONS — browser sign-in for any remote MCP row
// (specs/mcp-oauth-catalog.md §3, §4.1). api/naby.ts only routes to these.
//
//   probe       the URL check of the general form (§3.2): one unauthenticated
//               request and, on a 401, the discovery a login would run. Stores
//               nothing.
//   login       starts a sign-in through the per-server manager (mcpOAuthLogin.ts)
//               and answers with the authorization URL. THE ROW IS WRITTEN ONLY
//               AFTER THE SIGN-IN SUCCEEDS: a row written first would fail to
//               connect on every turn until the user finished (the same reason
//               as org-harness-sync §4.4).
//   cancel      ends that server's pending sign-in.
//   disconnect  removes the row AND the sign-in (`mcp.oauth.<server>`).
//
// PRESET NAMES ARE REFUSED HERE, AT THE ENTRY (§4.1). skill-hub, atlassian and
// cic have their own actions (`systemMcp.*`, `atlassian.*`); the Atlassian
// sign-in still runs through the same per-server manager underneath.
//
// A NAME THAT IS ALREADY SOMEONE ELSE'S. A login for a name that has a row is
// allowed when that row is the same remote server (same URL — a re-login, or an
// agent-proposed row being approved by signing in) or when the caller is the
// edit form for that very row (`replace`). Anything else is "a server with the
// same name already exists" — never an overwrite (§3.1).

import {
  clearMcpOAuth,
  mcpOAuthStatus,
  probeMcpOAuth,
  validateMcpEntry,
  type McpEntry,
  type McpOAuthProbeResult,
  type McpOAuthStatus,
  type Store,
} from '../../../../../../../dist/naby-runtime.mjs';
import {
  cancelServerOAuthLogin,
  clearServerOAuthLastError,
  mcpOAuthLoginFetch,
  readServerOAuthView,
  serverOAuthLastError,
  serverOAuthLoginNames,
  serverOAuthLoginPending,
  startServerOAuthLogin,
  type McpOAuthServerView,
} from './mcpOAuthLogin';
import {
  findMcpOAuthCatalogEntry,
  isMcpOAuthCatalogRow,
  MCP_OAUTH_CATALOG,
  mcpOAuthCatalogUrl,
} from './mcpOAuthCatalog';
import { SYSTEM_MCP_PRESET_NAMES } from './systemMcp';

export type McpOAuthRefusal = { ok: false; error: string; errorKey?: string };

/** A System MCP preset name — refused by every `mcpOAuth.*` action. */
export function isPresetName(server: string): boolean {
  return SYSTEM_MCP_PRESET_NAMES.includes(server);
}

function checkServerName(server: unknown): { ok: true; server: string } | McpOAuthRefusal {
  if (typeof server !== 'string' || !server.trim()) return { ok: false, error: 'server is required' };
  const name = server.trim();
  if (isPresetName(name)) {
    return {
      ok: false,
      error: `"${name}" is a built-in server; use its own row in Settings`,
      errorKey: 'mcpOAuth.presetName',
    };
  }
  return { ok: true, server: name };
}

// -- probe ---------------------------------------------------------------------

export async function probeMcpOAuthAction(body: {
  url?: unknown;
  transport?: unknown;
}): Promise<{ ok: true; probe: McpOAuthProbeResult } | McpOAuthRefusal> {
  if (typeof body.url !== 'string' || !body.url.trim()) return { ok: false, error: 'url is required' };
  const transport = body.transport === 'sse' ? 'sse' : body.transport === 'http' || body.transport === undefined ? 'http' : null;
  if (!transport) return { ok: false, error: 'transport must be http or sse' };
  const fetch = mcpOAuthLoginFetch();
  const probe = await probeMcpOAuth({ url: body.url.trim(), transport, ...(fetch ? { fetch } : {}) });
  return { ok: true, probe };
}

// -- login ---------------------------------------------------------------------

export async function startMcpOAuthAction(
  store: Store,
  body: { server?: unknown; url?: unknown; transport?: unknown; resourceMetadataUrl?: unknown; replace?: unknown },
): Promise<{ ok: true; authorizationUrl: string } | McpOAuthRefusal> {
  const named = checkServerName(body.server);
  if (!named.ok) return named;
  const server = named.server;
  const catalog = findMcpOAuthCatalogEntry(server);
  const typed = typeof body.url === 'string' && body.url.trim() ? body.url.trim() : undefined;
  // A catalog name signs in to the catalog's own URL unless the form typed one
  // (a user may run their own server under the same name — then it is theirs).
  const url = typed ?? (catalog ? mcpOAuthCatalogUrl(catalog) : undefined);
  if (!url) return { ok: false, error: 'url is required' };
  const transport: 'http' | 'sse' = body.transport === 'sse' ? 'sse' : 'http';
  const entry: McpEntry = { name: server, transport, url, auth: 'oauth', status: 'enabled' };
  const problems = validateMcpEntry(entry);
  if (problems.length > 0) return { ok: false, error: problems.join('; ') };
  if (!/^https?:$/.test(new URL(url).protocol)) return { ok: false, error: `"${url}" is not an http(s) URL` };

  const existing = store.listMcpEntries().find((e) => e.name === server);
  const sameServer = existing !== undefined && existing.transport !== 'stdio' && existing.url === url;
  if (existing && !sameServer && body.replace !== true) {
    return {
      ok: false,
      error: `an MCP server named "${server}" already exists`,
      errorKey: 'mcpOAuth.nameTaken',
    };
  }

  const resourceMetadataUrl =
    typeof body.resourceMetadataUrl === 'string' && body.resourceMetadataUrl.trim()
      ? body.resourceMetadataUrl.trim()
      : undefined;
  return startServerOAuthLogin(store, {
    server,
    serverUrl: url,
    ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
    // ONLY NOW does the row exist. Whatever else the row had (an agent's
    // proposal, a header-less draft) is replaced by the signed-in shape; a
    // per-row timeout is the one setting worth keeping.
    onSuccess: () => {
      const prev = store.listMcpEntries().find((e) => e.name === server);
      const timeoutMs = prev && prev.transport !== 'stdio' ? prev.timeoutMs : undefined;
      store.upsertMcpEntry({ ...entry, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
    },
  });
}

// -- cancel / disconnect ---------------------------------------------------------

export function cancelMcpOAuthAction(body: { server?: unknown }): { ok: true } | McpOAuthRefusal {
  const named = checkServerName(body.server);
  if (!named.ok) return named;
  cancelServerOAuthLogin(named.server);
  return { ok: true };
}

/** The row and the sign-in, together. Idempotent. */
export function disconnectMcpOAuthAction(store: Store, body: { server?: unknown }): { ok: true } | McpOAuthRefusal {
  const named = checkServerName(body.server);
  if (!named.ok) return named;
  forgetMcpServer(store, named.server);
  return { ok: true };
}

/**
 * Everything naby holds for one (non-preset) server: a pending sign-in, the row,
 * the tokens and the client registration. `mcp.remove` calls this too (§3.3) —
 * the tokens are keyed by name, and one left behind would silently sign in a
 * later row that happened to reuse the name.
 */
export function forgetMcpServer(store: Store, server: string): void {
  cancelServerOAuthLogin(server);
  clearServerOAuthLastError(server);
  store.removeMcpEntry(server);
  clearMcpOAuth(store, server);
}

// -- status --------------------------------------------------------------------

/** One quick-connect row's state (§3.1's four states plus the name clash). */
export type McpOAuthCatalogView = {
  /** `connected`/`relogin` only while the catalog row exists; otherwise `none`. */
  status: McpOAuthStatus;
  pending: boolean;
  lastError?: string;
  /** A row with this name exists and it is NOT the quick-connect row — the user's
   *  own server. The quick-connect row says so and offers nothing. */
  conflict: boolean;
  /** The quick-connect row exists (so the general list hides it). */
  present: boolean;
};

export type McpOAuthStatusView = {
  /** Every browser-OAuth row outside the presets, plus any server with a
   *  sign-in in progress or a failure to report (a new server from the add form
   *  has no row until its sign-in succeeds). */
  servers: Record<string, McpOAuthServerView>;
  catalog: Record<string, McpOAuthCatalogView>;
};

export function readMcpOAuthStatusView(store: Store): McpOAuthStatusView {
  const rows = store.listMcpEntries();
  const servers: Record<string, McpOAuthServerView> = {};
  for (const row of rows) {
    if (row.transport === 'stdio' || row.auth !== 'oauth' || isPresetName(row.name)) continue;
    servers[row.name] = readServerOAuthView(store, row.name);
  }
  for (const name of serverOAuthLoginNames()) {
    if (isPresetName(name) || servers[name]) continue;
    servers[name] = readServerOAuthView(store, name);
  }
  const catalog: Record<string, McpOAuthCatalogView> = {};
  for (const entry of MCP_OAUTH_CATALOG) {
    const row = rows.find((r) => r.name === entry.name);
    const present = isMcpOAuthCatalogRow(row, entry);
    const err = serverOAuthLastError(entry.name);
    catalog[entry.name] = {
      status: present ? mcpOAuthStatus(store, entry.name) : 'none',
      pending: serverOAuthLoginPending(entry.name),
      ...(err ? { lastError: err } : {}),
      conflict: row !== undefined && !present,
      present,
    };
  }
  return { servers, catalog };
}
