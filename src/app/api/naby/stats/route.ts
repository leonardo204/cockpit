// Re-export from @cockpit/feature-agent/server. Handler logic lives in the
// package; this file is the Next.js mount point for /api/naby/stats.
//
// NAMED re-export (not `export *`): the package module also exports the plain
// `buildNabyStats` function + types the handler is built from, which Next's
// route-field validation would reject.
export { GET } from '@cockpit/feature-agent/server/api/nabyStats';

// Declared HERE (not re-exported): Next reads these by static analysis of the
// route module itself. The store is opened on demand, so this route must run on
// the node runtime and must never be statically rendered.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
