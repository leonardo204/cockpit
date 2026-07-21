/**
 * /api/sessions/projects — the project list for the "Browse all sessions"
 * surface (SessionBrowser).
 *
 * RE-BACKED ONTO THE NABY STORE (Phase C-2). This list is now exactly the
 * projects the user opened THROUGH NABY (`app.db` projects table), MRU-ordered.
 * It NO LONGER scans `~/.claude/projects`, `~/.claude2`, `COCKPIT_PROJECTS_DIR`,
 * ollama-sessions, or codex/kimi transcript dirs — which is the headline fix:
 * the browser used to list every directory the underlying `claude` CLI was ever
 * run in (unrelated repos, temp dirs); now it lists only Naby's own projects.
 *
 * The WIRE CONTRACT is unchanged — the client still reads
 * `ProjectInfo { name, fullPath, encodedPath, sessionCount }` — so the UI is
 * identical, only the data source moved. `encodedPath` is `encodePath(cwd)`
 * (the same form the old dir-name-based list produced); the per-project route
 * resolves it (and ProjectSessionsModal's alternate encoding) back to a cwd.
 */
import { basename } from 'node:path';
import { Effect } from 'effect';
import { encodePath } from '@cockpit/shared-utils';
import { handler } from '@cockpit/effect-runtime/server';
import { AppError } from '@cockpit/effect-core';
import { getStore } from '../../engines/naby';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ProjectInfo {
  name: string;        // Last path component (used for sorting/display)
  fullPath: string;    // Full path (used for display + client-side filtering)
  encodedPath: string; // Encoded cwd (used to query the per-project sessions route)
  sessionCount: number;
}

export const GET = handler(() =>
  Effect.try({
    try: (): ProjectInfo[] => {
      const store = getStore();
      const projects = store.listProjects().map((p): ProjectInfo => ({
        name: p.title && p.title.trim() ? p.title : basename(p.cwd) || p.cwd,
        fullPath: p.cwd,
        encodedPath: encodePath(p.cwd),
        // Count of sessions LINKED to this project in the store — no directory
        // scan, no .jsonl counting.
        sessionCount: store.listSessionsByProject(p.cwd).length,
      }));
      // Preserve the old alphabetical-by-basename ordering the browser expects.
      projects.sort((a, b) => a.name.localeCompare(b.name));
      return projects;
    },
    catch: (cause) => new AppError({ message: 'Failed to list projects', cause }),
  }).pipe(
    Effect.map(
      (projects) =>
        new Response(JSON.stringify(projects), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    )
  )
);
