/**
 * Tab ORDER and DRAG rules, extracted so they can be asserted.
 *
 * These two rules are the whole of the pinned-tab feature that can be gotten
 * wrong quietly: which tab sits where, and which drags are allowed. Leaving
 * them inline in TabManager would make them reachable only by rendering the
 * app, which is how the sidebar clipping bug survived a release.
 */

export interface OrderableTab {
  id: string;
  sessionId?: string;
}

/** Rank of a session in the pinned set, or -1 when it is not pinned. */
export function pinRankOf(pinnedIds: readonly string[], sessionId?: string): number {
  if (!sessionId) return -1;
  return pinnedIds.indexOf(sessionId);
}

/**
 * Pinned tabs are parked at the LEFT, stacked in pin order (earliest first);
 * everything else keeps the order the user put it in.
 *
 * Derived rather than stored, and that is what makes unpinning free: the tab
 * array never changes when a tab is pinned, so releasing the pin drops the tab
 * straight back into the slot it came from with nothing to remember.
 */
export function orderTabs<T extends OrderableTab>(
  tabs: readonly T[],
  pinnedIds: readonly string[],
): T[] {
  const unpinned = tabs.filter((t) => pinRankOf(pinnedIds, t.sessionId) < 0);
  const pinned = tabs
    .filter((t) => pinRankOf(pinnedIds, t.sessionId) >= 0)
    .sort((a, b) => pinRankOf(pinnedIds, a.sessionId) - pinRankOf(pinnedIds, b.sessionId));
  return [...pinned, ...unpinned];
}

export type DropPlan =
  | { kind: 'none' }
  | { kind: 'reorder-tabs'; fromId: string; toId: string }
  | { kind: 'reorder-pins'; pinnedIds: string[] };

/**
 * What a drop should do — or refuse to do.
 *
 * A DRAG ONLY EVER REORDERS. It cannot pin and it cannot unpin; those live in
 * the right-click menu.
 *
 * This was tried the other way round in between — a drop across the boundary
 * pinned or unpinned — and it had to come back, because it meant a pinned tab
 * could not be moved at all without losing its pin whenever it was the only one
 * pinned. Losing a deliberate choice as a side effect of a move is worse than a
 * drag that declines: the decline is at least visible, since the tab bar shows
 * the "no" cursor wherever a drop would do nothing.
 */
export function planDrop<T extends OrderableTab>(
  displayTabs: readonly T[],
  pinnedIds: readonly string[],
  fromIndex: number | null,
  toIndex: number,
): DropPlan {
  const from = fromIndex === null ? undefined : displayTabs[fromIndex];
  const to = displayTabs[toIndex];
  if (!from || !to || from.id === to.id) return { kind: 'none' };

  const fromRank = pinRankOf(pinnedIds, from.sessionId);
  const toRank = pinRankOf(pinnedIds, to.sessionId);
  if (fromRank >= 0 !== toRank >= 0) return { kind: 'none' };

  if (fromRank < 0) return { kind: 'reorder-tabs', fromId: from.id, toId: to.id };

  const next = [...pinnedIds];
  const [moved] = next.splice(fromRank, 1);
  next.splice(toRank, 0, moved);
  return { kind: 'reorder-pins', pinnedIds: next };
}
