// packages/feature/agent/src/server/lib/mcpOAuthCatalog.ts
//
// QUICK CONNECT — the well-known remote MCP servers that sign in through the
// browser (specs/mcp-oauth-catalog.md §3.1, §4.2).
//
// Each entry is a name, the server's MCP URL and two i18n keys. That is all: the
// sign-in itself is the runtime's generic browser OAuth (dynamic registration, a
// public client with PKCE S256, no requested scope), and the row a successful
// sign-in creates is an ordinary `{transport: 'http', url, auth: 'oauth'}` row —
// the runtime does not know this list exists.
//
// THE ONE PLACE THE LIST LIVES. The renderer has a mirror
// (`@cockpit/feature-workspace` `client/mcpOAuthCatalog.ts`) with the names and
// keys only — no URL — and a test that fails when the two drift. The URL stays
// here: the login action uses THIS one for a catalog name, so a client can never
// point "Connect Notion" somewhere else.
//
// WHICH ROW IS "THE" CATALOG ROW. A row is the quick-connect row when it has the
// catalog name, a remote transport, `auth: 'oauth'` and the catalog URL. A row
// with the name and anything else (a stdio server the user called `notion`, a
// header-token row, an agent's proposal) is the USER's: it stays in the general
// list, and the quick-connect row says the name is taken instead of overwriting it.
//
// NO NETWORK IN TESTS. `setMcpOAuthCatalogUrl` points an entry at a local fake;
// nothing in the suite may reach the real servers.

import type { McpEntry } from '../../../../../../../dist/naby-runtime.mjs';

export type McpOAuthCatalogEntry = {
  /** The MCP row name — and so the tool prefix (`mcp__<name>__<tool>`) and the
   *  token key (`mcp.oauth.<name>`). Never renamed once shipped. */
  readonly name: string;
  readonly url: string;
  readonly titleKey: string;
  readonly descriptionKey: string;
};

/** Checked against each server's public metadata on 2026-10-13 (§2): all four
 *  publish a registration endpoint, `none` as a token-endpoint auth method and
 *  S256. Asana's older `/sse` address is deliberately not used. */
export const MCP_OAUTH_CATALOG: readonly McpOAuthCatalogEntry[] = [
  {
    name: 'notion',
    url: 'https://mcp.notion.com/mcp',
    titleKey: 'mcpOAuth.catalog.notion.title',
    descriptionKey: 'mcpOAuth.catalog.notion.description',
  },
  {
    name: 'linear',
    url: 'https://mcp.linear.app/mcp',
    titleKey: 'mcpOAuth.catalog.linear.title',
    descriptionKey: 'mcpOAuth.catalog.linear.description',
  },
  {
    name: 'asana',
    url: 'https://mcp.asana.com/v2/mcp',
    titleKey: 'mcpOAuth.catalog.asana.title',
    descriptionKey: 'mcpOAuth.catalog.asana.description',
  },
  {
    name: 'sentry',
    url: 'https://mcp.sentry.dev/mcp',
    titleKey: 'mcpOAuth.catalog.sentry.title',
    descriptionKey: 'mcpOAuth.catalog.sentry.description',
  },
];

export const MCP_OAUTH_CATALOG_NAMES: readonly string[] = MCP_OAUTH_CATALOG.map((c) => c.name);

export function findMcpOAuthCatalogEntry(name: string): McpOAuthCatalogEntry | undefined {
  return MCP_OAUTH_CATALOG.find((c) => c.name === name);
}

const urlOverride = new Map<string, string>();
/** Test seam: point one catalog entry at a local fake. `undefined` restores it. */
export function setMcpOAuthCatalogUrl(name: string, url: string | undefined): void {
  if (url === undefined) urlOverride.delete(name);
  else urlOverride.set(name, url);
}

/** The URL a catalog entry signs in to and connects to. */
export function mcpOAuthCatalogUrl(entry: McpOAuthCatalogEntry): string {
  return urlOverride.get(entry.name) ?? entry.url;
}

/** Whether `row` is the quick-connect row of `entry` (see the header). */
export function isMcpOAuthCatalogRow(row: McpEntry | undefined, entry: McpOAuthCatalogEntry): boolean {
  return (
    row !== undefined &&
    row.name === entry.name &&
    row.transport !== 'stdio' &&
    row.auth === 'oauth' &&
    row.url === mcpOAuthCatalogUrl(entry)
  );
}
