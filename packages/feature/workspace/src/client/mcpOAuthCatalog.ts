/**
 * QUICK CONNECT, AS THE RENDERER SEES IT (mcp-oauth-catalog §4.2).
 *
 * The list itself lives on the server
 * (`@cockpit/feature-agent/server/lib/mcpOAuthCatalog`), because the server
 * module imports the runtime bundle — and with it `node:sqlite` — which a client
 * bundle must not pull in. This is the half the Settings rows need: a name and
 * two i18n keys per entry, mirrored the way the System MCP presets are
 * (`systemMcpPresets.ts`).
 *
 * NO URL HERE. The login action resolves a catalog name to the catalog's URL on
 * the server, and the server says which row is the quick-connect row (the
 * `mcpOAuth.catalog` block of the GET), so the client never has to know where
 * these servers live.
 *
 * `mcpOAuthCatalog.test.ts` imports both lists and fails when they drift.
 */

export type McpOAuthCatalogEntryView = {
  /** The MCP row name — the `server` argument of every `mcpOAuth.*` action. */
  name: string;
  titleKey: string;
  descriptionKey: string;
};

export const MCP_OAUTH_CATALOG: readonly McpOAuthCatalogEntryView[] = [
  {
    name: 'notion',
    titleKey: 'mcpOAuth.catalog.notion.title',
    descriptionKey: 'mcpOAuth.catalog.notion.description',
  },
  {
    name: 'linear',
    titleKey: 'mcpOAuth.catalog.linear.title',
    descriptionKey: 'mcpOAuth.catalog.linear.description',
  },
  {
    name: 'asana',
    titleKey: 'mcpOAuth.catalog.asana.title',
    descriptionKey: 'mcpOAuth.catalog.asana.description',
  },
  {
    name: 'sentry',
    titleKey: 'mcpOAuth.catalog.sentry.title',
    descriptionKey: 'mcpOAuth.catalog.sentry.description',
  },
];

export const MCP_OAUTH_CATALOG_NAMES: readonly string[] = MCP_OAUTH_CATALOG.map((c) => c.name);
