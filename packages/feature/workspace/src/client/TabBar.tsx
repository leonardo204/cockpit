'use client';

import React from 'react';

import { TabInfo } from './useTabState';
import { Tooltip } from '@cockpit/shared-ui';
import { useTranslation } from 'react-i18next';

// ============================================
// Tab circle-number icon component
// ============================================

function TabNumberIcon({ number, isActive }: { number: number; isActive: boolean }) {
  return (
    <svg
      className={`w-5 h-5 flex-shrink-0 ${isActive ? 'text-brand' : 'text-muted-foreground'}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <circle cx="12" cy="12" r="9" />
      <text
        x="12"
        y="16"
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontSize="12"
        fontWeight="500"
      >
        {number}
      </text>
    </svg>
  );
}

// ============================================
// NewTabButton — plain new-tab button
// ============================================
//
// Naby has a SINGLE runtime engine, so the old engine-picker dropdown (Claude
// Code / Claude 2 / Codex / DeepSeek / Kimi / Ollama) was removed: every new
// tab uses the default Naby engine (engine undefined → /api/chat → nabySpec).
// This is now just a `+` button that creates a fresh tab directly.

function NewTabButton({ onNewTab }: { onNewTab: () => void }) {
  return (
    <button
      onClick={onNewTab}
      className="flex-shrink-0 p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
      title="New tab"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
      </svg>
    </button>
  );
}

// ============================================
// TabBar component
// ============================================

interface TabBarProps {
  tabs: TabInfo[];
  activeTabId: string;
  unreadTabs: Set<string>;
  dragTabIndex: number | null;
  dragOverTabIndex: number | null;
  isPinned?: (tabId: string) => boolean;
  /** P3-M10 (memory-hygiene §3): whether this tab's session is TEMPORARY —
   *  nothing is learned from it. Reported as a badge, never toggled here: the
   *  toggle is in the context menu, next to pin and rename. */
  isNoLearn?: (tabId: string) => boolean;
  /** Right-click on a tab. Pin/unpin and rename live in that menu now — the
   *  hover icon they replaced was read as a bell and never found. */
  onTabContextMenu?: (tabId: string, x: number, y: number) => void;
  /** The tab currently being renamed, if any; its label becomes an input. */
  renamingTabId?: string | null;
  onRenameCommit?: (tabId: string, title: string) => void;
  onRenameCancel?: () => void;
  onSwitchTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: () => void;
  /** Open the current project's session list. Only passed when a project
   *  (cwd) is open — when omitted, the entry button is not rendered. */
  onOpenProjectSessions?: () => void;
  onDragStart: (index: number) => void;
  onDragOver: (e: React.DragEvent, index: number) => void;
  /** Whether dropping here would do anything. A refused drop shows the "no"
   *  cursor and no insert line, rather than looking like a broken drag. */
  canDropAt?: (index: number) => boolean;
  onDrop: (index: number) => void;
  onDragEnd: () => void;
}

export function TabBar({
  tabs,
  activeTabId,
  unreadTabs,
  dragTabIndex,
  dragOverTabIndex,
  isPinned,
  isNoLearn,
  onTabContextMenu,
  renamingTabId,
  onRenameCommit,
  onRenameCancel,
  onSwitchTab,
  onCloseTab,
  onNewTab,
  onOpenProjectSessions,
  onDragStart,
  onDragOver,
  canDropAt,
  onDrop,
  onDragEnd,
}: TabBarProps) {
  const { t } = useTranslation();
  return (
    <div className="border-b border-border bg-card shrink-0">
      <div className="flex items-center px-2 gap-1 overflow-x-auto">
        {tabs.map((tab, index) => (
          <Tooltip key={tab.id} content={tab.title} delay={200} className="flex-1 min-w-16 max-w-[260px]">
            <div
              draggable
              onDragStart={(e) => {
                // THE DRAG MUST CARRY DATA. Chromium refuses to fire `drop` for
                // a drag whose dataTransfer is empty: dragstart and dragover
                // both fire (the tab dims, the insert line shows) and then the
                // tab simply springs back, which reads as "reordering is
                // broken" rather than as a missing API call. The payload itself
                // is unused — the index props carry the real information — but
                // it has to exist.
                e.dataTransfer.setData('text/plain', tab.id);
                e.dataTransfer.effectAllowed = 'move';
                onDragStart(index);
              }}
              onDragOver={(e) => {
                // A cross-group drop is refused by design (pinning is an
                // explicit choice, never a side effect of a drag). Say so with
                // the cursor: an accepted-looking drag that then springs back
                // is indistinguishable from a bug.
                if (canDropAt && !canDropAt(index)) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'none';
                  return;
                }
                e.dataTransfer.dropEffect = 'move';
                onDragOver(e, index);
              }}
              onDrop={(e) => {
                // Without this the browser handles the drop itself (navigating
                // to the dropped text), and the handler below never runs.
                e.preventDefault();
                onDrop(index);
              }}
              onDragEnd={onDragEnd}
              onContextMenu={(e) => {
                e.preventDefault();
                onTabContextMenu?.(tab.id, e.clientX, e.clientY);
              }}
              className={`group flex items-center gap-1 px-3 py-1.5 text-sm cursor-pointer rounded-t-lg border-t-[1.5px] transition-colors ${
                tab.id === activeTabId
                  ? 'border-brand bg-slate-4 text-foreground font-medium'
                  : 'border-transparent text-muted-foreground hover:bg-secondary/50'
              } ${dragTabIndex === index ? 'opacity-50' : ''} ${
                dragOverTabIndex === index ? 'border-l-2 border-brand' : ''
              }`}
              onClick={() => onSwitchTab(tab.id)}
            >
              {/* Circle number + status badge (top-right). The number doubles
                  as the Cmd/Ctrl+N shortcut hint (see TabManager keydown);
                  only the first 9 tabs are reachable that way. */}
              <div
                className="relative flex-shrink-0"
                title={index < 9 ? `⌘${index + 1}` : undefined}
              >
                <TabNumberIcon number={index + 1} isActive={tab.id === activeTabId} />
                {/* Loading pulse dot - top-right */}
                {tab.isLoading && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-orange-9 animate-pulse" />
                )}
                {/* Unread red dot badge - top-right (hidden while loading to avoid overlap) */}
                {!tab.isLoading && unreadTabs.has(tab.id) && tab.id !== activeTabId && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500" />
                )}
                {/* Pinned indicator. NOT a button: pinning moved into the
                    right-click menu, because as a hover-only icon in the corner
                    of a tab it was mistaken for a bell and never used. This only
                    reports state. */}
                {isPinned?.(tab.id) && !tab.isLoading && !(unreadTabs.has(tab.id) && tab.id !== activeTabId) && (
                  <span
                    className="absolute -top-1 -right-1 w-3.5 h-3.5 flex items-center justify-center rounded-full bg-card text-brand"
                    title={t('tabBar.pinned')}
                    aria-label={t('tabBar.pinned')}
                  >
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                      <path d="M15 4.5l-4 4L7 10l-2 2 7 7 2-2 1.5-4 4-4z" />
                      <path d="M9 15l-4.5 4.5" />
                    </svg>
                  </span>
                )}
              </div>
              {renamingTabId === tab.id ? (
                <input
                  autoFocus
                  data-testid="tab-rename-input"
                  defaultValue={tab.title}
                  onClick={(e) => e.stopPropagation()}
                  // Commit on blur as well as Enter: clicking away is what most
                  // people do, and losing the typed name there would be rude.
                  onBlur={(e) => onRenameCommit?.(tab.id, e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') onRenameCommit?.(tab.id, e.currentTarget.value);
                    if (e.key === 'Escape') onRenameCancel?.();
                  }}
                  className="flex-1 min-w-0 px-1 py-0 text-sm bg-background border border-brand rounded outline-none"
                />
              ) : (
                <span className="flex-1 min-w-0 truncate">{tab.title}</span>
              )}
              {/* P3-M10 §3 — the TEMPORARY-session marker. Beside the title
                  rather than stacked in the corner with the pin/unread badges,
                  which already contend for that spot: this one has to be visible
                  at a glance WHILE typing, because it is the difference between a
                  conversation naby learns from and one it does not. State only,
                  never a button — the toggle is in the right-click menu. */}
              {isNoLearn?.(tab.id) && (
                <span
                  className="shrink-0 text-muted-foreground"
                  title={t('tabBar.noLearnBadge')}
                  aria-label={t('tabBar.noLearnBadge')}
                  data-testid="tab-no-learn-badge"
                >
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
                    <circle cx="12" cy="12" r="2.5" />
                    <path d="M3 3l18 18" />
                  </svg>
                </span>
              )}
              {/* No per-tab engine badge: Naby runs a single engine, so every
                  tab is the same runtime and a tag would be noise. */}
              {/* Close is offered on EVERY tab, including the last one.
                  Upstream gated this on `tabs.length > 1` because closing the
                  last tab left the shell with nothing to render. That is no
                  longer true: `closeTab` seeds a fresh tab and asks the parent
                  window for the home screen (see useTabState.closeTab), so the
                  gate now only removes a control the user expects to be there. */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
                className="ml-1 p-0.5 rounded hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity"
                title={t('tabBar.closeTab')}
                aria-label={t('tabBar.closeTab')}
                data-testid="tab-close"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </Tooltip>
        ))}
        {/* Plain new-tab button (single Naby engine, no picker) */}
        <NewTabButton onNewTab={onNewTab} />
        {/* Project sessions entry — only when a project (cwd) is open. Sits
            right after the new-tab button. Chat-bubble icon reads as
            "conversations" and sizes to match NewTabButton. */}
        {onOpenProjectSessions && (
          <button
            onClick={onOpenProjectSessions}
            className="flex-shrink-0 p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
            title={t('sessions.projectSessions')}
            aria-label={t('sessions.projectSessions')}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
