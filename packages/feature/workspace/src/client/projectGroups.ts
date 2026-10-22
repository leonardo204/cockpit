/**
 * Project groups — user-defined folders over the sidebar's project list
 * (specs/project-groups.md).
 *
 * PURE. No React, no IO: the sidebar calls these to edit groups and to build
 * what it renders, and `/api/projects` calls the same `normalizeGroups` /
 * `parseStoredGroups` so the client and the server agree on what a valid
 * group set is.
 *
 * TWO ORDERS, ON PURPOSE. A group's `cwds` is MEMBERSHIP only. The order the
 * projects show in — inside a group as much as outside one — is the order of
 * the global `projects` array, so the existing drag-reorder keeps working
 * unchanged and `activeIndex` keeps meaning an index into that array. The
 * order of the `groups` array is the order the group headers show in.
 */

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

/** A short random id (`g_` + 8 base36 chars), unique enough for one user's groups. */
export function newGroupId(existing: ReadonlyArray<ProjectGroup> = []): string {
  const taken = new Set(existing.map((g) => g.id));
  for (;;) {
    const id = `g_${Math.random().toString(36).slice(2, 10).padEnd(8, '0')}`;
    if (!taken.has(id)) return id;
  }
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
// Edits. Each returns the SAME array when nothing changed, so a caller can
// skip the save with a reference check.
// ─────────────────────────────────────────────────────────

/** Append a new, expanded, empty group. An empty name is a no-op. */
export function createGroup(
  groups: ReadonlyArray<ProjectGroup>,
  name: string,
  id: string = newGroupId(groups),
): ReadonlyArray<ProjectGroup> {
  const clean = cleanGroupName(name);
  if (!clean || groups.some((g) => g.id === id)) return groups;
  return [...groups, { id, name: clean, collapsed: false, cwds: [] }];
}

/** Rename. An empty name (or the same name) is a no-op, not a delete. */
export function renameGroup(
  groups: ReadonlyArray<ProjectGroup>,
  id: string,
  name: string,
): ReadonlyArray<ProjectGroup> {
  const clean = cleanGroupName(name);
  if (!clean) return groups;
  const target = groups.find((g) => g.id === id);
  if (!target || target.name === clean) return groups;
  return groups.map((g) => (g.id === id ? { ...g, name: clean } : g));
}

/** Delete the group only; its projects fall back to "no group". */
export function deleteGroup(
  groups: ReadonlyArray<ProjectGroup>,
  id: string,
): ReadonlyArray<ProjectGroup> {
  return groups.some((g) => g.id === id) ? groups.filter((g) => g.id !== id) : groups;
}

export function toggleGroupCollapsed(
  groups: ReadonlyArray<ProjectGroup>,
  id: string,
): ReadonlyArray<ProjectGroup> {
  if (!groups.some((g) => g.id === id)) return groups;
  return groups.map((g) => (g.id === id ? { ...g, collapsed: !g.collapsed } : g));
}

/**
 * Move a group header before or after another one. The `groups` array order IS
 * the display order, so this is all group reordering needs. Dropping a group
 * on itself, or on a neighbour slot it already occupies, is a no-op.
 */
export function reorderGroups(
  groups: ReadonlyArray<ProjectGroup>,
  fromId: string,
  toId: string,
  position: 'before' | 'after',
): ReadonlyArray<ProjectGroup> {
  if (fromId === toId) return groups;
  const from = groups.findIndex((g) => g.id === fromId);
  if (from < 0 || groups.findIndex((g) => g.id === toId) < 0) return groups;
  const next = [...groups];
  const [moved] = next.splice(from, 1);
  const to = next.findIndex((g) => g.id === toId);
  next.splice(position === 'before' ? to : to + 1, 0, moved);
  return next.every((g, i) => g === groups[i]) ? groups : next;
}

/** The id of the group `cwd` belongs to, or null when it is ungrouped. */
export function groupIdOf(groups: ReadonlyArray<ProjectGroup>, cwd: string): string | null {
  return groups.find((g) => g.cwds.includes(cwd))?.id ?? null;
}

/** Put `cwd` in `groupId` (null = no group), taking it out of any other. */
export function assignProject(
  groups: ReadonlyArray<ProjectGroup>,
  cwd: string,
  groupId: string | null,
): ReadonlyArray<ProjectGroup> {
  if (groupIdOf(groups, cwd) === groupId) return groups;
  if (groupId !== null && !groups.some((g) => g.id === groupId)) return groups;
  return groups.map((g) => {
    if (g.id === groupId) return { ...g, cwds: [...g.cwds, cwd] };
    if (g.cwds.includes(cwd)) return { ...g, cwds: g.cwds.filter((c) => c !== cwd) };
    return g;
  });
}

// ─────────────────────────────────────────────────────────
// Moving a project by drag.
// ─────────────────────────────────────────────────────────

export type ProjectDropTarget =
  /** Dropped on another project's row (grouped or not). */
  | { readonly kind: 'project'; readonly index: number }
  /** Dropped on a group header or on an empty group's placeholder. */
  | { readonly kind: 'group'; readonly groupId: string }
  /** Dropped on the blank area at the end of the list: leave every group. */
  | { readonly kind: 'ungrouped-end' };

export interface ProjectMoveResult<P extends { cwd: string }> {
  readonly projects: ReadonlyArray<P>;
  readonly groups: ReadonlyArray<ProjectGroup>;
}

/**
 * Apply one project drop. Returns the same array references for whatever did
 * not change, so the caller saves only what moved.
 *
 * - Onto a row in the SAME area (same group, or both ungrouped): exactly the
 *   pre-groups reorder — remove at `from`, insert at the target index.
 * - Onto a row in ANOTHER area: the project joins that row's area and lands
 *   immediately before that row in the global order.
 * - Onto a group header: joins the group, placed right after the group's last
 *   member (an empty group leaves the global order alone).
 * - Onto the end area: leaves its group and moves to the end of the list.
 */
export function moveProject<P extends { cwd: string }>(
  projects: ReadonlyArray<P>,
  groups: ReadonlyArray<ProjectGroup>,
  from: number,
  target: ProjectDropTarget,
): ProjectMoveResult<P> {
  const dragged = projects[from];
  if (!dragged) return { projects, groups };
  const fromGroup = groupIdOf(groups, dragged.cwd);

  if (target.kind === 'project') {
    const over = projects[target.index];
    if (!over || target.index === from) return { projects, groups };
    const toGroup = groupIdOf(groups, over.cwd);
    if (toGroup === fromGroup) {
      const next = [...projects];
      const [removed] = next.splice(from, 1);
      next.splice(target.index, 0, removed);
      return { projects: next, groups };
    }
    const next = projects.filter((_, i) => i !== from);
    next.splice(next.indexOf(over), 0, dragged);
    return { projects: next, groups: assignProject(groups, dragged.cwd, toGroup) };
  }

  if (target.kind === 'group') {
    const group = groups.find((g) => g.id === target.groupId);
    if (!group || fromGroup === group.id) return { projects, groups };
    const nextGroups = assignProject(groups, dragged.cwd, group.id);
    const rest = projects.filter((_, i) => i !== from);
    let lastMember = -1;
    rest.forEach((p, i) => {
      if (group.cwds.includes(p.cwd)) lastMember = i;
    });
    if (lastMember < 0) return { projects, groups: nextGroups };
    const next = [...rest];
    next.splice(lastMember + 1, 0, dragged);
    const same = next.every((p, i) => p === projects[i]);
    return { projects: same ? projects : next, groups: nextGroups };
  }

  // ungrouped-end
  const nextGroups = assignProject(groups, dragged.cwd, null);
  if (from === projects.length - 1) return { projects, groups: nextGroups };
  const next = projects.filter((_, i) => i !== from);
  next.push(dragged);
  return { projects: next, groups: nextGroups };
}

// ─────────────────────────────────────────────────────────
// What the sidebar renders.
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
