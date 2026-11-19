// packages/feature/agent/src/client/reconcileWindow.ts
//
// HOW MUCH OF THE TRANSCRIPT A TURN-END RECONCILE FETCHES.
//
// The reconcile that swaps a finished turn's `live-…` bubbles for their disk
// rows used to fetch with NO LIMIT — the whole session. On a long conversation
// the tab renders only the last pages, so the full transcript's first message
// was not on screen, `mergeIncrementalMessages` found no overlap and REPLACED
// the list with all of it: 132 rendered messages became 491, ~100k px of history
// landed above the viewport in one commit (field report 2026-11-19, reproduced
// in an isolated build). A reader scrolled up a little was then thrown back into
// old history — the browser's scroll anchoring could not compensate, because
// the anchor it had picked was the live bubble the same commit replaced.
//
// The window asked for is what the tab already shows (its turns are counted the
// way the server counts them: one per user-role message) plus the turn that just
// ended, never less than a first page. The window's first message is then one
// the tab has, the merge aligns on it, and older history stays as it is.

/** The first page the tab loads, mirrored from useChatHistory. */
export const RECONCILE_MIN_TURNS = 10;

export function reconcileTurnLimit(messages: ReadonlyArray<{ role: string }>): number {
  const rendered = messages.reduce((n, m) => (m.role === 'user' ? n + 1 : n), 0);
  return Math.max(RECONCILE_MIN_TURNS, rendered + 1);
}
