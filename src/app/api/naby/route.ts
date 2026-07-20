// Re-export from @cockpit/feature-agent/server. Handler logic lives in the
// package; this file is the Next.js mount point.
//
// NAMED re-exports rather than `export *`: Next validates that a route module
// exports ONLY route fields, and this package module also exports the plain
// functions and types the handlers are built from (`readNabyState`,
// `runNabyAction`), which would fail that check.
export { GET, POST } from '@cockpit/feature-agent/server/api/naby';

// Declared HERE rather than re-exported: Next reads these two by static
// analysis of the route module itself and warns that it cannot recognize a
// re-exported one. The store is opened on demand and the MCP "Test" action
// spawns child processes, so both values are load-bearing — this route must run
// on the node runtime and must never be statically rendered.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
