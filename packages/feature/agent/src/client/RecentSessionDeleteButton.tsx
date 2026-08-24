'use client';

import { useTranslation } from 'react-i18next';
import { type RecentDeleteTarget } from './recentSessionDelete';

/**
 * The × at the right of a recent-sessions row — ONE control, shared by the
 * sidebar popover and its expanded modal so the two lists cannot drift on what
 * the glyph means.
 *
 * One click closes the session, which in this app deletes it (see
 * recentSessionDelete.ts). There is no confirmation, exactly as there is none on
 * a tab close or on the sidebar tree's row ×; the honesty budget is spent on
 * LEGIBILITY instead — destructive red treatment on hover, and a tooltip /
 * aria-label that says the conversation is deleted rather than hidden from a
 * list. A control that deletes must not read as a dismissal.
 *
 * Reveal follows the established sidebar pattern
 * (`opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100`) plus
 * `focus:opacity-100`, so it is not mouse-only: it is a real focusable
 * <button>, and a keyboard activation runs the same handler — including the
 * stopPropagation that keeps the click from also opening the session.
 */
interface RecentSessionDeleteButtonProps {
  session: RecentDeleteTarget;
  /** The deletion itself — the parent owns the IO and the optimistic removal. */
  onDelete: (cwd: string, sessionId: string) => void;
  /** Size/spacing tweaks per host list. */
  className?: string;
}

export function RecentSessionDeleteButton({
  session,
  onDelete,
  className = '',
}: RecentSessionDeleteButtonProps) {
  const { t } = useTranslation();

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    // The row around this button is itself a click target that opens the
    // session. Stopping here covers pointer AND keyboard activation, because
    // Enter/Space on a <button> dispatch a click event just the same.
    e.stopPropagation();
    e.preventDefault();
    onDelete(session.cwd, session.sessionId);
  };

  // EVERY ROW GETS THE SAME BUTTON. There used to be a disabled variant for a
  // projectless row (cwd ''), because the removal request had to name a project;
  // the channel carries a projectless shape now, so there is one control and no
  // refused state to explain. See recentSessionDelete.ts.
  return (
    <button
      type="button"
      data-testid="recent-session-delete"
      data-session-id={session.sessionId}
      onClick={handleClick}
      // Names the consequence: the conversation goes, not just this row.
      title={t('sessions.deleteSessionFromRecent')}
      aria-label={t('sessions.deleteSessionFromRecent')}
      className={`flex-shrink-0 p-1 rounded hover:bg-red-500/20 text-muted-foreground hover:text-red-500 focus:text-red-500 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100 ${className}`}
    >
      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  );
}
