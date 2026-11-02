/**
 * Project display names (specs/project-groups.md §8).
 *
 * A project is named after its folder unless the user renamed it. The rename
 * lives in the store's `projects.title`, which is ALSO where the folder name is
 * written as the default for a new row — so "renamed" means "a title that is
 * non-empty and not the folder name", never just "a title is present".
 *
 * Pure, and shared by the sidebar and `/api/projects`, so both sides agree on
 * what counts as a rename and what a reset looks like.
 */
import { projectNameFromCwd } from '@cockpit/shared-utils';

/** Longest name a project can be given (R8.2). */
export const PROJECT_TITLE_MAX = 80;

/** The folder name — the name a project has when nobody renamed it. */
export function folderNameOf(cwd: string): string {
  return projectNameFromCwd(cwd) || cwd;
}

/**
 * The user's name for `cwd`, or undefined when there is none: empty after
 * trimming, or the folder name itself (R8.3). Capped at PROJECT_TITLE_MAX.
 */
export function customProjectTitle(cwd: string, title: string | null | undefined): string | undefined {
  const name = (title ?? '').trim().slice(0, PROJECT_TITLE_MAX).trim();
  return name && name !== folderNameOf(cwd) ? name : undefined;
}

/** What the sidebar shows for a project. */
export function projectDisplayName(project: { cwd: string; title?: string }): string {
  return customProjectTitle(project.cwd, project.title) ?? folderNameOf(project.cwd);
}

/**
 * Set (or, with an empty / folder-name title, clear) one project's name in a
 * list. Returns the SAME array when nothing changes, so a commit that leaves the
 * name as it was costs no state update and no save.
 */
export function withProjectTitle<P extends { cwd: string; title?: string }>(
  projects: P[],
  cwd: string,
  title: string,
): P[] {
  const next = customProjectTitle(cwd, title);
  let changed = false;
  const out = projects.map((p) => {
    if (p.cwd !== cwd || customProjectTitle(p.cwd, p.title) === next) return p;
    changed = true;
    if (next !== undefined) return { ...p, title: next };
    const { title: _dropped, ...rest } = p;
    return rest as P;
  });
  return changed ? out : projects;
}
