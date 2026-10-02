import { closableSessionId, isChatTab } from './tabKinds';
import { untitledTabTitle } from './untitledTabTitle';
import type { TabInfo } from './useTabState';

/**
 * CLEAR CONTEXT — Claude Code's `/clear`, as a tab action.
 *
 * The conversation is not deleted. The tab keeps its place in the strip and its
 * project, and starts over as a blank chat; the old session stays in the session
 * history and can be reopened like any other. That is what `/clear` does too —
 * a fresh context in the same seat, with the previous one still on disk.
 *
 * A NEW TAB ID, not the same tab with its session unset. The chat panel is keyed
 * by tab id and holds the transcript it loaded; reusing the id would leave the old
 * messages on screen above a conversation that no longer has them in context —
 * exactly the confusion a clear exists to remove.
 *
 * Returns null when there is nothing to clear: an unknown tab, a document tab
 * (no conversation), or a chat tab that has no session yet (already clear).
 */
export function clearTabInPlace(
  tabs: readonly TabInfo[],
  tabId: string,
  now: number,
): { tabs: TabInfo[]; newTabId: string; closedSessionId: string } | null {
  const index = tabs.findIndex((t) => t.id === tabId);
  const target = tabs[index];
  if (!target || !isChatTab(target)) return null;
  const closedSessionId = closableSessionId(target);
  if (!closedSessionId) return null;

  const newTabId = `tab-${now}`;
  const blank: TabInfo = {
    id: newTabId,
    cwd: target.cwd,
    title: untitledTabTitle(newTabId, undefined, now),
    // The seat's settings carry over; the conversation does not.
    ...(target.engine ? { engine: target.engine } : {}),
    ...(target.planMode ? { planMode: target.planMode } : {}),
  };
  const next = [...tabs];
  next[index] = blank;
  return { tabs: next, newTabId, closedSessionId };
}
