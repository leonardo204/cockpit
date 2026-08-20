// packages/feature/agent/src/server/lib/projectDisplayName.ts
//
// WHAT TO CALL A PROJECT IN AN OUTBOUND MESSAGE (telegram-chat §0).
//
// Every message the bot sends about a session names its project, and the name
// has two possible sources: the `projects` row the user renamed (`Project.title`)
// and the directory's own basename. The user's own word wins — a project they
// deliberately called "고객 대시보드" must not come back as "dash-v2" on their
// phone — and the basename is the fallback for the ordinary case where nobody
// renamed anything.
//
// There is no `getProject(cwd)` on the Store: the projects table is keyed by cwd
// and the only route is `listProjects()`, which is an indexed read of a list
// bounded by the number of directories the user has ever opened. That is cheap
// enough once per outbound message; for a message that names SEVERAL projects
// (a session list) use `projectDisplayNames`, which pays for the read once.
//
// Structural, not `Store`-typed, on purpose: the callers here already accept
// stores that only implement part of the interface (the mirror's tests hand in a
// three-method fake), and a project name is not worth crashing a send over — a
// store with no `listProjects` simply falls through to the basename.

import { projectNameFromCwd } from '@cockpit/shared-utils';

/** The slice of the store this module reads. */
export type ProjectReader = {
  listProjects?: () => ReadonlyArray<{ cwd: string; title?: string }>;
};

/** The user-set title of the project at `cwd`, or '' when there is none. */
function storedTitle(store: ProjectReader | undefined, cwd: string): string {
  try {
    const rows = store?.listProjects?.();
    if (!rows) return '';
    for (const row of rows) {
      if (row.cwd === cwd) return (row.title ?? '').trim();
    }
    return '';
  } catch {
    // A store read must never be the reason a message does not go out.
    return '';
  }
}

/**
 * What to call the project at `cwd`: the user's title, else the folder name,
 * else '' when the session has no directory at all.
 *
 * '' is a MEANINGFUL answer — "this session belongs to no project" — and the
 * caller renders it as an explicit marker rather than a gap.
 */
export function projectDisplayName(
  store: ProjectReader | undefined,
  cwd: string | undefined | null,
): string {
  if (!cwd) return '';
  return storedTitle(store, cwd) || projectNameFromCwd(cwd);
}

/**
 * The same answer for many cwds off ONE `listProjects()` read — for a message
 * that names a project per line (`/sessions`). Rendering an 8-row list through
 * `projectDisplayName` would repeat the read eight times for one screen.
 */
export function projectDisplayNames(
  store: ProjectReader | undefined,
): (cwd: string | undefined | null) => string {
  let titles: Map<string, string>;
  try {
    titles = new Map(
      (store?.listProjects?.() ?? []).map((p) => [p.cwd, (p.title ?? '').trim()]),
    );
  } catch {
    titles = new Map();
  }
  return (cwd) => (cwd ? titles.get(cwd) || projectNameFromCwd(cwd) : '');
}
