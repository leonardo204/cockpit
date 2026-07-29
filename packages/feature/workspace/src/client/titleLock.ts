/**
 * Which title wins — the user's or the one derived from the conversation.
 *
 * Extracted from useTabState's reducer so the rule can be asserted directly.
 * It is one `if`, and it is the entire "renaming sticks" requirement: get it
 * wrong and the label silently reverts on the next turn, which looks like the
 * rename never saved.
 */

export interface TitleState {
  title: string;
  titleLocked?: boolean;
}

export interface TitleUpdate {
  title?: string;
  /** Sent by an explicit rename. */
  lockTitle?: boolean;
  /** Sent to release the lock (an empty rename). */
  titleLocked?: false;
}

export function applyTitleUpdate<T extends TitleState>(tab: T, update: TitleUpdate): T {
  const { lockTitle, ...rest } = update;
  const next: T = { ...tab, ...rest };
  if (lockTitle) {
    return { ...next, titleLocked: true };
  } else if (tab.titleLocked && rest.title !== undefined) {
    // Locked: the derived title arrives on every turn and must not overwrite
    // the name the user chose.
    next.title = tab.title;
  }
  return next;
}
