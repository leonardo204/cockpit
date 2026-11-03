/**
 * The stored shape of project groups (specs/project-groups.md §3) and the ONE
 * normalizer for it.
 *
 * Lives here, not in feature-workspace, because two packages read the same
 * setting: the sidebar and `/api/projects` (feature-workspace) edit it, and
 * naby's cross-project tools (feature-agent, specs/cross-project-context.md R2)
 * decide from it which projects share a group. feature-agent must not depend
 * on feature-workspace, and two normalizers would be two answers to "is this
 * cwd in that group?" — so both import this one. feature-workspace's
 * `projectGroups.ts` re-exports it unchanged.
 */

/** The settings key the groups are stored under. */
export const PROJECT_GROUPS_SETTING_KEY = 'sidebar.projectGroups';

export interface ProjectGroup {
  readonly id: string;
  readonly name: string;
  readonly collapsed: boolean;
  /** Members. A cwd is in at most one group. Order carries no meaning. */
  readonly cwds: ReadonlyArray<string>;
}

/** Longest group name kept; longer ones are cut, not rejected. */
export const PROJECT_GROUP_NAME_MAX = 60;

/** Trim and cut a name to the stored limit. '' means "not a valid name". */
export function cleanGroupName(name: unknown): string {
  if (typeof name !== 'string') return '';
  return name.trim().slice(0, PROJECT_GROUP_NAME_MAX).trim();
}

/**
 * Coerce anything into a valid group list. Never throws.
 *
 * - Accepts the stored envelope `{ groups: [...] }` or a bare array.
 * - Drops entries that are not objects, have no id (or a duplicate one), or
 *   whose name is empty after trimming. Names are cut to 60 chars.
 * - With `knownCwds`, drops members that are not in the project list — a
 *   removed project leaves its group with it.
 * - A cwd listed by two groups stays only in the first.
 */
export function normalizeGroups(
  raw: unknown,
  knownCwds?: ReadonlyArray<string>,
): ProjectGroup[] {
  const list: unknown =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as { groups?: unknown }).groups
      : raw;
  if (!Array.isArray(list)) return [];
  const known = knownCwds ? new Set(knownCwds) : null;
  const seenIds = new Set<string>();
  const claimed = new Set<string>();
  const out: ProjectGroup[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id.trim() : '';
    if (!id || seenIds.has(id)) continue;
    const name = cleanGroupName(e.name);
    if (!name) continue;
    const cwds: string[] = [];
    if (Array.isArray(e.cwds)) {
      for (const c of e.cwds) {
        if (typeof c !== 'string' || !c) continue;
        if (claimed.has(c)) continue;
        if (known && !known.has(c)) continue;
        claimed.add(c);
        cwds.push(c);
      }
    }
    seenIds.add(id);
    out.push({ id, name, collapsed: e.collapsed === true, cwds });
  }
  return out;
}

/** Read the stored settings value. Broken JSON reads as "no groups". */
export function parseStoredGroups(
  raw: string | undefined | null,
  knownCwds?: ReadonlyArray<string>,
): ProjectGroup[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return normalizeGroups(parsed, knownCwds);
}

/** The stored settings value (`sidebar.projectGroups`). */
export function serializeGroups(groups: ReadonlyArray<ProjectGroup>): string {
  return JSON.stringify({ groups });
}
