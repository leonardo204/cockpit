// Re-export from @cockpit/feature-agent/server. Handler logic lives in the
// package; this file is the Next.js mount point for /api/harness (Phase 1.6
// HP-02 — Naby-owned command CRUD).
//
// NAMED re-export (not `export *`): the package module also exports the plain
// `listHarnessCommands` / `runHarnessAction` functions + types the handlers are
// built from, which Next's route-field validation would reject.
export { GET, POST } from '@cockpit/feature-agent/server/api/harness';

// Declared HERE (not re-exported): Next reads these by static analysis of the
// route module itself. The store is opened on demand, so this route must run on
// the node runtime and must never be statically rendered.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
