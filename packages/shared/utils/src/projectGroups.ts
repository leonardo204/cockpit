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

// ─────────────────────────────────────────────────────────
// What the sidebar renders, and the numbers it shows.
//
// Here, not in feature-workspace, for the reason the normalizer is: the
// sidebar draws these numbers and naby's tools resolve "3번" against them
// (specs/project-groups.md §9 R33, cross-project-context R7a). One function,
// one order rule — two copies would let the screen and the server disagree on
// which project "RMS 3" is.
// ─────────────────────────────────────────────────────────

export interface SidebarProjectEntry<P> {
  readonly project: P;
  /** Index into the ORIGINAL `projects` array — what activeIndex and every
   *  select/remove/reorder callback speak. */
  readonly index: number;
}

export interface SidebarGroupSection<P> {
  readonly group: ProjectGroup;
  /** Members present in `projects`, in global project order. */
  readonly items: ReadonlyArray<SidebarProjectEntry<P>>;
}

export interface SidebarModel<P> {
  readonly groups: ReadonlyArray<SidebarGroupSection<P>>;
  readonly ungrouped: ReadonlyArray<SidebarProjectEntry<P>>;
}

/**
 * Split the project list into group sections (in group order) and the
 * ungrouped rest. Members that are not in `projects` are ignored, so a stale
 * client copy of the groups can never render a ghost row.
 */
export function buildSidebarModel<P extends { cwd: string }>(
  projects: ReadonlyArray<P>,
  groups: ReadonlyArray<ProjectGroup>,
): SidebarModel<P> {
  const owner = new Map<string, string>();
  for (const g of groups) for (const c of g.cwds) if (!owner.has(c)) owner.set(c, g.id);
  const byGroup = new Map<string, SidebarProjectEntry<P>[]>(groups.map((g) => [g.id, []]));
  const ungrouped: SidebarProjectEntry<P>[] = [];
  projects.forEach((project, index) => {
    const gid = owner.get(project.cwd);
    (gid ? byGroup.get(gid)! : ungrouped).push({ project, index });
  });
  return {
    groups: groups.map((group) => ({ group, items: byGroup.get(group.id)! })),
    ungrouped,
  };
}

/** A project's displayed number (project-groups §9). */
export interface ProjectNumber {
  /** The section's group, or null for the ungrouped area. */
  readonly groupId: string | null;
  readonly groupName: string | null;
  /** 1-based, counted inside the section in display order. */
  readonly number: number;
}

/**
 * R30–R33: the number every project shows in the sidebar, by cwd. Numbering
 * restarts at 1 in each section — each group, and the ungrouped area as one
 * more section — in the sidebar model's own order, so it is exactly what the
 * screen draws. A group's `collapsed` flag plays no part (R31). Nothing is
 * stored (R32): reorder the list and the numbers follow on the next call.
 */
export function projectNumbers<P extends { cwd: string }>(
  projects: ReadonlyArray<P>,
  groups: ReadonlyArray<ProjectGroup>,
): Map<string, ProjectNumber> {
  const model = buildSidebarModel(projects, groups);
  const out = new Map<string, ProjectNumber>();
  for (const { group, items } of model.groups) {
    items.forEach(({ project }, i) => {
      if (!out.has(project.cwd)) out.set(project.cwd, { groupId: group.id, groupName: group.name, number: i + 1 });
    });
  }
  model.ungrouped.forEach(({ project }, i) => {
    if (!out.has(project.cwd)) out.set(project.cwd, { groupId: null, groupName: null, number: i + 1 });
  });
  return out;
}

// ─────────────────────────────────────────────────────────
// The sidebar's own project order.
//
// The `projects` table orders by `last_opened_at` (most recent first), and
// that stamp moves on its own — opening a project stamps it in place without
// moving its row, and every naby turn touches its project. So the table's order
// drifts from what the screen shows within minutes, and "3번" resolved on the
// server against it would name the wrong project (project-groups §9 R33). Every
// list save therefore also records the order the screen holds, and both the
// project list read and the server's number lookup put the projects in it.
// ─────────────────────────────────────────────────────────

/** The settings key holding the sidebar's project order (a JSON array of cwds). */
export const PROJECT_ORDER_SETTING_KEY = 'sidebar.projectOrder';

/** The stored order as a list of cwds. Broken or absent reads as []. */
export function parseStoredProjectOrder(raw: string | undefined | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of parsed) {
      if (typeof c !== 'string' || !c || seen.has(c)) continue;
      seen.add(c);
      out.push(c);
    }
    return out;
  } catch {
    return [];
  }
}

export function serializeProjectOrder(cwds: ReadonlyArray<string>): string {
  return JSON.stringify(cwds.filter((c, i, all) => !!c && all.indexOf(c) === i));
}

/**
 * Put `projects` in the stored sidebar order: the cwds the order names, in its
 * order, then any project it does not name (added since the last save) in the
 * order they came. Never drops or invents a project. Returns the input array
 * itself when no order is stored.
 */
export function orderProjects<P extends { cwd: string }>(
  projects: ReadonlyArray<P>,
  order: ReadonlyArray<string>,
): ReadonlyArray<P> {
  if (order.length === 0) return projects;
  const rank = new Map(order.map((c, i) => [c, i]));
  const named = projects.filter((p) => rank.has(p.cwd)).sort((a, b) => rank.get(a.cwd)! - rank.get(b.cwd)!);
  const rest = projects.filter((p) => !rank.has(p.cwd));
  return [...named, ...rest];
}
