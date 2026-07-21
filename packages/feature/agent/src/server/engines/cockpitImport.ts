/**
 * One-time cockpit → Naby import (Phase C, part 1).
 *
 * The project LIST and the session↔project LINKS used to live in cockpit files
 * (`~/.cockpit/projects.json` and, per project, `~/.cockpit/projects/<enc>/
 * session.json`). Phase C moves both into the Naby store (`app.db`). This module
 * carries the existing data across ONCE, so a user who already has projects and
 * ~102 sessions does not lose them when the routes start reading from the store.
 *
 * WHAT IT DOES, and just as importantly what it does NOT do:
 *   - Reads `~/.cockpit/projects.json`; for each project it `upsertProject`s the
 *     row (title defaulting to the cwd basename) and, when the file recorded a
 *     `lastOpenedAt`, seeds it so the MRU order survives the move.
 *   - Reads each project's `session.json` `sessions[]` and, for every id that
 *     ALREADY EXISTS in the Naby store, `setSessionProject`s it — backfilling the
 *     owning-project link onto the sessions that predate Phase B (they were
 *     created with no cwd). It NEVER creates a session that is not already in the
 *     store: the cockpit files are not a source of session truth, only of the
 *     project grouping.
 *
 * IDEMPOTENT AND NON-FATAL. It runs at most once, guarded by a Naby setting
 * (`cockpit-import-v1`) written on success. A missing or malformed cockpit file
 * is treated as "nothing to import", never an error: the import must never stop
 * the server from starting. Re-running (guard cleared) is safe — every op is an
 * upsert/link, so a second pass changes nothing.
 */

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { COCKPIT_DIR, getSessionFilePath } from '@cockpit/shared-utils';
import type { Store } from '../../../../../../../dist/naby-runtime.mjs';

/** The guard setting. Bump the suffix if a future import needs to re-run. */
const IMPORT_GUARD_KEY = 'cockpit-import-v1';

/** projects.json — the cockpit project list (see feature-workspace project.ts). */
interface CockpitProjectInfo {
  cwd?: string;
  sessionId?: string;
  lastOpenedAt?: number;
}
interface CockpitProjectsData {
  projects?: CockpitProjectInfo[];
}
/** session.json — a project's session list (see /api/project-state). */
interface CockpitSessionState {
  sessions?: string[];
}

/** Parse a JSON file, returning undefined for missing/malformed — never throws. */
function readJsonSync<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return undefined;
  }
}

/**
 * Import the cockpit project list + session links into the store, once.
 * Safe to call on every server start: the guard makes all but the first a no-op.
 */
export function ensureCockpitImport(store: Store): void {
  try {
    if (store.getSetting(IMPORT_GUARD_KEY)) return;

    const projectsFile = join(COCKPIT_DIR, 'projects.json');
    const data = readJsonSync<CockpitProjectsData>(projectsFile);
    const projects = data?.projects ?? [];

    let projectsImported = 0;
    let sessionsLinked = 0;
    let sessionsMissing = 0;

    for (const p of projects) {
      const cwd = p?.cwd;
      if (typeof cwd !== 'string' || cwd.length === 0) continue;

      // Create/patch the project row. Title defaults to the cwd basename (the
      // wire format never carried a title — display name is derived from cwd).
      // Seed lastOpenedAt only when the cockpit file recorded one, so MRU order
      // carries over; otherwise upsert leaves it at the row's own now().
      store.upsertProject(cwd, {
        title: basename(cwd) || cwd,
        ...(typeof p.lastOpenedAt === 'number' ? { lastOpenedAt: p.lastOpenedAt } : {}),
      });
      projectsImported += 1;

      // Backfill session→project links from the per-project session.json.
      const state = readJsonSync<CockpitSessionState>(getSessionFilePath(cwd));
      const sessionIds = state?.sessions ?? [];
      for (const sessionId of sessionIds) {
        if (typeof sessionId !== 'string' || sessionId.length === 0) continue;
        // Only link sessions that ALREADY exist in Naby — never mint one.
        if (store.getSession(sessionId)) {
          store.setSessionProject(sessionId, cwd);
          sessionsLinked += 1;
        } else {
          sessionsMissing += 1;
        }
      }
    }

    // Mark done AFTER a clean pass, so a throw before here lets a later start
    // retry (the ops are idempotent, so the retry is harmless).
    store.setSetting(IMPORT_GUARD_KEY, new Date().toISOString());
    console.log(
      `[cockpit-import] done: ${projectsImported} project(s), ` +
        `${sessionsLinked} session link(s) backfilled, ` +
        `${sessionsMissing} listed session(s) absent from Naby (skipped).`,
    );
  } catch (e) {
    // A broken/missing cockpit file must never stop the server. Log and move on;
    // the guard stays unset so a later start can retry.
    console.warn(
      `[cockpit-import] skipped (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
