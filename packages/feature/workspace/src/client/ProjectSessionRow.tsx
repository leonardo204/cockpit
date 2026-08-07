'use client';

import { memo } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * One session under a project in the sidebar tree.
 *
 * `memo`'d on purpose. The sidebar re-renders on every global-state push (a
 * WebSocket message arrives per status change, several a second while a run
 * streams) and every expanded project contributes a row per session, so this is
 * the component the list multiplies. Both callbacks take `(cwd, sessionId)` and
 * are hoisted to ProjectSidebar as single stable instances — a per-row arrow
 * would give every row a fresh prop identity and defeat the memo silently.
 */
interface ProjectSessionRowProps {
  cwd: string;
  sessionId: string;
  title: string;
  /** Marks the session currently open in this project's active tab. */
  isActive?: boolean;
  onSelect: (cwd: string, sessionId: string) => void;
  onDelete: (cwd: string, sessionId: string) => void;
}

export const ProjectSessionRow = memo(function ProjectSessionRow({
  cwd,
  sessionId,
  title,
  isActive = false,
  onSelect,
  onDelete,
}: ProjectSessionRowProps) {
  const { t } = useTranslation();
  const label = title || sessionId.slice(0, 8);

  return (
    <div
      data-testid="sidebar-session-row"
      data-cwd={cwd}
      data-session-id={sessionId}
      className={`group flex items-center gap-1 pl-8 pr-1 py-1 rounded-lg cursor-pointer transition-colors ${
        isActive
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
      }`}
      onClick={() => onSelect(cwd, sessionId)}
      title={label}
    >
      <span className="flex-1 truncate text-xs">{label}</span>
      {/* Hover-revealed delete. Same affordance as the tab bar's close ×, and
          the same consequence: this session is deleted, not merely hidden. No
          confirmation, because closing the tab does exactly this already. */}
      <button
        data-testid="sidebar-session-delete"
        data-session-id={sessionId}
        className="flex-shrink-0 p-1 rounded hover:bg-red-500/20 text-muted-foreground hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(cwd, sessionId);
        }}
        title={t('sessions.deleteSession')}
        aria-label={t('sessions.deleteSession')}
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
});
