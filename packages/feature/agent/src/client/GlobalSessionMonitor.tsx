'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { RecentSessionsModal } from './RecentSessionsModal';
import { RecentSessionDeleteButton } from './RecentSessionDeleteButton';
import { recentTooltipPosition } from './recentTooltipAnchor';

export interface GlobalSession {
  cwd: string;
  sessionId: string;
  lastActive: number;
  status: string;
  title?: string;
  lastUserMessage?: string;
  firstMessages?: string[];
  lastMessages?: string[];
}

interface GlobalSessionMonitorProps {
  currentCwd?: string;
  onSwitchProject: (cwd: string, sessionId: string) => void;
  collapsed?: boolean;
  sessions: GlobalSession[];
  /**
   * Delete one session, resolving true once the server accepted it.
   *
   * The IO belongs to the OWNER OF THE LIST, not to this panel: `sessions` is a
   * prop here, so only the owner can drop the row optimistically — and it is
   * also the side of the app that may import `deleteSession` from the workspace
   * package without inverting the feature-agent ← feature-workspace dependency.
   */
  onDeleteSession: (cwd: string, sessionId: string) => Promise<boolean>;
}

export function GlobalSessionMonitor({ currentCwd, onSwitchProject, collapsed, sessions, onDeleteSession }: GlobalSessionMonitorProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [now, setNow] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Rich tooltip: which session is hovered + where to anchor it (fixed positioning
  // escapes the dropdown's overflow-y-auto clipping).
  //
  // ANCHORED TO THE WHOLE ROW, never to the open target inside it. The delete ×
  // sits at the row's right end, so measuring from the inner button put the
  // panel straight over the button — see recentTooltipAnchor.ts, which owns the
  // geometry and is where that rule is asserted.
  const [tooltip, setTooltip] = useState<{ session: GlobalSession; top: number; left: number } | null>(null);
  const showTooltip = useCallback((session: GlobalSession, e: React.MouseEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const { top, left } = recentTooltipPosition(rect, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    setTooltip({ session, top, left });
  }, []);
  const hideTooltip = useCallback(() => setTooltip(null), []);

  // Drop the tooltip whenever the dropdown closes (e.g. outside click / blur)
  useEffect(() => {
    if (!isOpen) setTooltip(null);
  }, [isOpen]);

  // Close on outside click (including clicking into an iframe)
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    // Clicking an iframe causes the parent window to lose focus
    const handleBlur = () => {
      setIsOpen(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('blur', handleBlur);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('blur', handleBlur);
    };
  }, [isOpen]);

  // Switch to the specified session (the iframe's SWITCH_SESSION handler marks it read in the store)
  const handleSessionClick = useCallback((session: GlobalSession) => {
    onSwitchProject(session.cwd, session.sessionId);
    setIsOpen(false);
    setTooltip(null);
  }, [onSwitchProject]);

  // Delete a session straight from the list. The owner of `sessions` performs
  // the removal (it holds the state and the effect); this only drops the rich
  // hover tooltip, which would otherwise stay pinned to a row that is gone.
  const handleDeleteSession = useCallback((cwd: string, sessionId: string) => {
    setTooltip(null);
    void onDeleteSession(cwd, sessionId);
  }, [onDeleteSession]);

  const loadingCount = sessions.filter(s => s.status === 'loading').length;
  const unreadCount = sessions.filter(s => s.status === 'unread').length;

  // Format timestamp
  const formatTime = useCallback((timestamp: number) => {
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return t('common.justNow');
    if (minutes < 60) return t('common.minutesAgo', { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('common.hoursAgo', { count: hours });
    return t('common.daysAgo', { count: Math.floor(hours / 24) });
  }, [t, now]);

  // Get project name. A projectless session arrives with cwd '' — it is still a
  // real session, opened by sessionId, so it gets a label rather than a blank.
  const getProjectName = (cwd: string) => cwd.split('/').pop() || cwd || t('sessions.noProject');

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => { setNow(Date.now()); setIsOpen(!isOpen); }}
        className={`relative flex items-center gap-2 px-2 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ${
          collapsed ? 'w-full justify-center' : 'w-full'
        }`}
        title={t('sessions.recentSessions')}
      >
        {/* Lightning icon indicates active state */}
        <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        {!collapsed && <span className="text-sm flex-1 text-left">{t('sessions.recentSessions')}</span>}
        {/* Badge: loading orange pulse + unread red static, displayed independently */}
        {loadingCount > 0 && (
          <span className={`min-w-[18px] h-[18px] px-1 text-white text-xs font-medium rounded-full flex items-center justify-center bg-orange-9 animate-pulse ${
            collapsed ? 'absolute -top-1 -right-1' : ''
          }`}>
            {loadingCount}
          </span>
        )}
        {unreadCount > 0 && (
          <span className={`min-w-[18px] h-[18px] px-1 text-white text-xs font-medium rounded-full flex items-center justify-center bg-red-500 ${
            collapsed && !loadingCount ? 'absolute -top-1 -right-1' : ''
          }`}>
            {unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown list - pops up to the upper right */}
      {isOpen && (
        <div className="absolute left-full bottom-0 ml-2 w-80 h-[450px] bg-popover border border-border rounded-lg shadow-lg z-50 flex flex-col">
          <div className="px-3 py-2 border-b border-border bg-muted/50 flex-shrink-0 rounded-t-lg flex items-center">
            <span className="text-sm font-medium">{t('sessions.recentSessions')}</span>
            {loadingCount > 0 && (
              <span className="ml-2 text-xs text-orange-11">({t('sessions.runningCount', { count: loadingCount })})</span>
            )}
            {unreadCount > 0 && (
              <span className="ml-2 text-xs text-red-500">({t('sessions.unreadCount', { count: unreadCount })})</span>
            )}
            {/* Expand into the full searchable recent-sessions panel (up to 100) */}
            <button
              onClick={() => { setNow(Date.now()); setIsOpen(false); setTooltip(null); setSearchOpen(true); }}
              className="ml-auto p-1 -mr-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
              title={t('sessions.searchRecentSessions')}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
              </svg>
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {sessions.length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                {t('sessions.noSessions')}
              </div>
            ) : (
              sessions.map((session, index) => (
                /* THE ROW IS NO LONGER ONE <button>. The delete control is a
                   button of its own, and a button inside a button is invalid
                   HTML that React refuses to hydrate — so the row became a flex
                   container holding two siblings: the open target and the ×.
                   Being siblings, the × cannot fall through to "open" by
                   bubbling at all; it also stops propagation, which is what
                   covers the modal's nested case with the same handler. */
                <div
                  key={`${session.cwd}-${session.sessionId}`}
                  /* HOVER IS TRACKED ON THE ROW, not on the open target inside
                     it. Two things follow, and both are the fix for "the popup
                     hides the ×": the preview is anchored past the row's right
                     edge (× included) instead of past the button's, and moving
                     the pointer from the text onto the × never leaves the
                     hovered element, so nothing flickers on the way there. */
                  onMouseEnter={(e) => showTooltip(session, e)}
                  onMouseLeave={hideTooltip}
                  className={`group flex items-start pr-1 hover:bg-accent transition-colors ${
                    index !== sessions.length - 1 ? 'border-b border-border/50' : ''
                  } ${currentCwd === session.cwd ? 'bg-accent/50' : ''}`}
                >
                  <button
                    onClick={() => handleSessionClick(session)}
                    className="flex-1 min-w-0 px-3 py-2 text-left flex items-start gap-2"
                  >
                    {/* Status indicator: loading blinking orange dot / unread red static dot / normal gray dot */}
                    <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${
                      session.status === 'loading'
                        ? 'bg-orange-9 animate-pulse'
                        : session.status === 'unread'
                          ? 'bg-red-500'
                          : 'bg-muted-foreground/30'
                    }`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm truncate">
                          {getProjectName(session.cwd)}
                        </span>
                        {session.status === 'loading' && (
                          <span className="text-xs text-orange-11 flex-shrink-0">{t('sessions.running')}</span>
                        )}
                        {session.status === 'unread' && (
                          <span className="text-xs text-red-500 flex-shrink-0">{t('sessions.done')}</span>
                        )}
                        <span className="text-xs text-muted-foreground flex-shrink-0">
                          {formatTime(session.lastActive)}
                        </span>
                      </div>
                      {session.title && (
                        <div className="text-xs font-medium text-foreground truncate" title={session.title}>
                          {session.title}
                        </div>
                      )}
                      {session.lastUserMessage && (
                        <div className="text-xs text-foreground/80 truncate">
                          {session.lastUserMessage}
                        </div>
                      )}
                    </div>
                  </button>
                  {/* Hover-revealed close at the RIGHT of the row. One click,
                      no confirmation — the same channel and the same
                      consequence as closing the session's tab. */}
                  <span className="flex items-center self-stretch py-2">
                    <RecentSessionDeleteButton
                      session={session}
                      onDelete={handleDeleteSession}
                    />
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Rich hover tooltip: cwd path + first/last user-message preview (mirrors ProjectSessionsModal cards) */}
      {tooltip && (
        <div
          className="fixed z-[60] w-72 max-h-[260px] overflow-y-auto bg-popover border border-border rounded-lg shadow-lg p-3 pointer-events-none"
          style={{ top: tooltip.top, left: tooltip.left }}
        >
          <div className="text-xs font-medium text-foreground truncate">{getProjectName(tooltip.session.cwd)}</div>
          {tooltip.session.title && (
            <div className="text-xs font-medium text-foreground truncate mt-0.5" title={tooltip.session.title}>
              {tooltip.session.title}
            </div>
          )}
          {((tooltip.session.firstMessages?.length ?? 0) > 0 || (tooltip.session.lastMessages?.length ?? 0) > 0) ? (
            <div className="space-y-0.5 text-xs border-t border-border/50 mt-2 pt-2">
              {tooltip.session.firstMessages?.map((msg, idx) => (
                <div key={`f-${idx}`} className="text-foreground/90 truncate">
                  <span className="text-slate-9 mr-1">•</span>
                  {msg}
                </div>
              ))}
              {(tooltip.session.lastMessages?.length ?? 0) > 0 && (
                <div className="text-slate-9 text-center py-0.5">···</div>
              )}
              {tooltip.session.lastMessages?.map((msg, idx) => (
                <div key={`l-${idx}`} className="text-foreground/90 truncate">
                  <span className="text-slate-9 mr-1">•</span>
                  {msg}
                </div>
              ))}
            </div>
          ) : tooltip.session.lastUserMessage ? (
            /* Fallback (e.g. running sessions skipped on the WS path): show whatever message the item already has */
            <div className="text-xs text-foreground/90 border-t border-border/50 mt-2 pt-2 line-clamp-3 break-words">
              {tooltip.session.lastUserMessage}
            </div>
          ) : null}
        </div>
      )}

      {/* Searchable full recent-sessions panel (up to 100) */}
      <RecentSessionsModal
        isOpen={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSwitchProject={onSwitchProject}
        onDeleteSession={onDeleteSession}
      />
    </div>
  );
}
