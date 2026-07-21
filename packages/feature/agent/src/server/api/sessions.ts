/**
 * /api/sessions — legacy "all sessions, grouped by project".
 *
 * RE-BACKED ONTO THE NABY STORE (Phase C-2). No current UI fetches this route
 * (its only reference is the Next.js mount shim); it is kept alive but pointed
 * at `app.db` so it can never again scan `CLAUDE_PROJECTS_DIR`. Slated for
 * removal in Phase E — until then it returns the same `ProjectGroup[]` shape,
 * sourced from the store.
 */
import { basename } from 'node:path';
import { Effect } from 'effect';
import { handler } from '@cockpit/effect-runtime/server';
import { AppError } from '@cockpit/effect-core';
import { getStore } from '../engines/naby';
import { buildSessionInfo, type NabySessionInfo } from './sessions/nabyBrowse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ProjectGroup {
  name: string;
  fullPath: string;
  sessions: NabySessionInfo[];
}

export const GET = handler(() =>
  Effect.try({
    try: (): ProjectGroup[] => {
      const store = getStore();
      const groups: ProjectGroup[] = [];
      for (const p of store.listProjects()) {
        const sessions = store
          .listSessionsByProject(p.cwd)
          .map((ref) => buildSessionInfo(ref));
        if (sessions.length > 0) {
          groups.push({
            name: p.title && p.title.trim() ? p.title : basename(p.cwd) || p.cwd,
            fullPath: p.cwd,
            sessions,
          });
        }
      }
      groups.sort((a, b) => a.name.localeCompare(b.name));
      return groups;
    },
    catch: (cause) => new AppError({ message: 'Failed to load sessions', cause }),
  }).pipe(
    Effect.map(
      (groups) =>
        new Response(JSON.stringify(groups), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    )
  )
);
