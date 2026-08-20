'use client';

/**
 * Chat tab host.
 *
 * F1-03 chat-first trim: this used to be the 3-panel swipe shell (Agent /
 * Explorer / Console) driven by `SwipeableViewContainer`. The Explorer and
 * Console panels lived in `@cockpit/feature-explorer` / `-console`, which are
 * deleted, so the container collapsed to its single remaining panel: the tab
 * bar plus the chat. The `initialView` / `activeView` / project-settings
 * `activeView` persistence, the git branch + worktree bar, the alias manager
 * and the HTML-apps launcher all went with the panels they drove.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ProjectSessionsModal } from '@cockpit/feature-agent';
import { ChatProvider } from '@cockpit/feature-agent';
import { PanelPortalProvider, ResizeHandle } from '@cockpit/shared-ui';
import { useTabState } from './useTabState';
import { TabManagerTopBar } from './TabManagerTopBar';
import { TabBar } from './TabBar';
import { TabContextMenu, type TabContextMenuState } from './TabContextMenu';
import { useNoLearnSessions } from './useNoLearnSessions';
import { orderTabs, planDrop, pinRankOf } from './tabOrder';
import { deleteSession } from './projectSessionTree';
import {
  FileBrowserPanel,
  FILES_DEFAULT_WIDTH,
  FILES_MAX_WIDTH,
  FILES_MIN_WIDTH,
} from './FileBrowserPanel';
import { fetchProjects, saveFilesWidth as saveFilesWidthEffect } from './effect/projectClient';
import { ChatPanel } from '@cockpit/feature-agent';
import { usePinnedSessions } from '@cockpit/feature-agent';
import { useScheduledTasks } from '@cockpit/feature-agent';
import { Effect } from 'effect';
import { IframeBus, Topics } from '@cockpit/effect-services';
import { publishTopic } from '@cockpit/effect-react';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { updateSessionStatus, renameSession, markScheduledTasksReadBySession } from './effect/stateClient';

interface TabManagerProps {
  initialCwd?: string;
  initialSessionId?: string;
}

export function TabManager({ initialCwd, initialSessionId }: TabManagerProps) {
  const { t } = useTranslation();
  // Tab state management. `activeView` is pinned to 'agent' — the only panel
  // left — so unread bookkeeping keeps treating the chat as foreground.
  const {
    tabs,
    activeTabId,
    unreadTabs,
    dragTabIndex,
    dragOverTabIndex,
    closeTab,
    switchTab,
    handleSelectSession,
    handleNewTab,
    handleOpenSession,
    updateTabState,
    updateTabPlanMode,
    handleTabDragStart,
    handleTabDragOver,
    reorderTabs,
    handleTabDragEnd,
  } = useTabState({ initialCwd, initialSessionId, activeView: 'agent' });

  // Pin state management. `pinnedSessions` is ORDERED — the server lists by pin
  // time (schema v7), earliest first — and that order is what the tab bar uses.
  const { pinnedSessions, isPinned, pinSession, unpinSession, reorder } = usePinnedSessions();

  // Scheduled tasks
  const { createTask: createScheduledTask } = useScheduledTasks();

  const isTabPinned = useCallback((tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    return tab?.sessionId ? isPinned(tab.sessionId) : false;
  }, [tabs, isPinned]);

  // P3-M10 (memory-hygiene §3): which sessions are TEMPORARY — nothing is
  // learned from them. Loaded as a set in one request; see the hook.
  const { isNoLearn, setNoLearn } = useNoLearnSessions();

  const isTabNoLearn = useCallback((tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId);
    return isNoLearn(tab?.sessionId);
  }, [tabs, isNoLearn]);

  const handleToggleNoLearn = useCallback((tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId);
    // Per SESSION, like pinning: a blank tab is not one until its first turn
    // creates it, so there is nothing to mark yet. The menu item is disabled in
    // that state, and this is the matching guard.
    if (!tab?.sessionId) return;
    void setNoLearn(tab.sessionId, !isNoLearn(tab.sessionId));
  }, [tabs, isNoLearn, setNoLearn]);

  // ── Continue this conversation in a new tab (session-context-management §2.2)
  //
  // The same action the threshold banner offers, reached from the tab it is about.
  // The handoff summary happens SERVER-SIDE and can take a few seconds, which is
  // why the menu item does not wait for it visibly — the new tab appears when the
  // reply lands (or immediately, when there is no handoff to write).
  //
  // The words travel from here, like every other name this client sends: the server
  // has no locale.
  const handleContinueInNewTab = useCallback(async (tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId);
    // Per SESSION, like pinning and the temporary flag: a blank tab has no
    // conversation to hand off. The menu item is disabled in that state, and this
    // is the matching guard.
    if (!tab?.sessionId) return;
    const cwd = tab.cwd || initialCwd || '';
    try {
      const res = await fetch('/api/naby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'session.continueInNewTab',
          sessionId: tab.sessionId,
          ...(cwd ? { cwd } : {}),
          title: t('tabBar.continuedTitle', {
            title: tab.title || new Date().toLocaleDateString(),
            defaultValue: 'Continued — {{title}}',
          }),
        }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; sessionId?: string; cwd?: string }
        | null;
      if (!res.ok || !json?.ok || !json.sessionId) return;
      // The existing "open this project at this session" path — the one the
      // fast-growth button and the session-list rows already publish.
      //
      // The server's cwd wins when this tab has none: it answers with the project
      // the new session was linked to (the SOURCE session's, when the request
      // carried none), which is the only way a cwd-less tab can navigate at all.
      const openIn = json.cwd ?? cwd;
      if (openIn) publishTopic(Topics.OpenProject, { cwd: openIn, sessionId: json.sessionId });
    } catch {
      // A failed continue leaves the user exactly where they were, which is the
      // conversation they can still use. Nothing to undo.
    }
  }, [tabs, initialCwd, t]);

  const handleTogglePin = useCallback((tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    // A tab with no session has nothing to pin yet: pinning is per SESSION, and
    // a blank tab is not one until its first turn creates it.
    if (!tab?.sessionId) return;
    if (isPinned(tab.sessionId)) {
      unpinSession(tab.sessionId);
    } else {
      pinSession(tab.sessionId, tab.cwd || initialCwd || '', tab.title);
    }
  }, [tabs, isPinned, pinSession, unpinSession, initialCwd]);

  // ── Tab ORDER: unpinned first, pinned parked at the right ────────────────
  //
  // Pinned tabs are stacked in PIN order (earliest leftmost), which is the order
  // the server hands back. Everything else keeps the order the user dragged it
  // into. Deriving this instead of storing it means a pin/unpin never has to
  // rewrite the tab array — the tab simply changes groups.
  // The rules themselves live in ./tabOrder, so they can be asserted without
  // rendering the app — see tabOrder.test.ts.
  const pinnedIds = useMemo(() => pinnedSessions.map((p) => p.sessionId), [pinnedSessions]);
  const displayTabs = useMemo(() => orderTabs(tabs, pinnedIds), [tabs, pinnedIds]);

  // ── Drag: order only. Pinning is the menu's job ──────────────────────────
  //
  // The rules are in ./tabOrder (tabOrder.test.ts). A drop across the boundary
  // was briefly made to pin/unpin, and it had to be undone: with one pinned
  // tab, every possible drop target was unpinned, so moving the tab always cost
  // the pin. A move must not undo a deliberate choice. Cross-group drops are
  // declined VISIBLY — the bar shows the "no" cursor — rather than silently.
  /** Whether a drop at this index would do anything — the tab bar uses it to
   *  show a "no" cursor instead of silently swallowing the drag. */
  const canDropAt = useCallback((targetIndex: number) => {
    return planDrop(displayTabs, pinnedIds, dragTabIndex, targetIndex).kind !== 'none';
  }, [displayTabs, pinnedIds, dragTabIndex]);

  const handleGroupedDrop = useCallback((targetIndex: number) => {
    const plan = planDrop(displayTabs, pinnedIds, dragTabIndex, targetIndex);
    handleTabDragEnd();
    if (plan.kind === 'reorder-tabs') {
      reorderTabs(plan.fromId, plan.toId);
    } else if (plan.kind === 'reorder-pins') {
      // Reordering the pinned group means reordering the PINNED SET itself: the
      // route takes the whole ordered set and stamps pin order from the array
      // index, so this one write is what persists the order across restarts.
      // Every id is already in the set, so nothing can be unpinned by a move.
      const byId = new Map(pinnedSessions.map((p) => [p.sessionId, p]));
      reorder(plan.pinnedIds.map((id) => byId.get(id)!).filter(Boolean));
    }
  }, [displayTabs, pinnedIds, dragTabIndex, handleTabDragEnd, reorderTabs, pinnedSessions, reorder]);

  // ── Pinned tabs come back when the project opens ─────────────────────────
  //
  // This is the ONE exception to the rule in useTabState that opening a project
  // starts a fresh session and never rebuilds the old tab layout. That rule
  // exists because silently reconnecting the last session was a real complaint;
  // a pin is the opposite of silent — the user asked for that session to stay.
  //
  // Runs once per project open, after the pinned set has loaded. `restoredRef`
  // guards the second pass that arrives when the pinned list refreshes, which
  // would otherwise reopen a tab the user had just closed.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !initialCwd || pinnedSessions.length === 0) return;
    restoredRef.current = true;
    const open = new Set(tabs.map((t) => t.sessionId).filter(Boolean));
    for (const p of pinnedSessions) {
      if (p.cwd !== initialCwd || open.has(p.sessionId)) continue;
      handleOpenSession(p.sessionId, p.customTitle);
    }
    // `tabs` is read as a snapshot on purpose: re-running on every tab change
    // would fight the user's own closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCwd, pinnedSessions, handleOpenSession]);

  // ── A rename made ANYWHERE reaches the tab ───────────────────────────────
  //
  // The name is stored once (`session.customTitle.<id>`), but the tab carries
  // its own copy of the label, so a rename done in the sidebar's pinned list
  // used to show up there and nowhere else. Whenever the pinned set arrives —
  // on load and after any pin/rename — its overrides are pushed onto the
  // matching tabs and locked, so the derived title stops fighting them.
  useEffect(() => {
    for (const p of pinnedSessions) {
      if (!p.customTitle) continue;
      const tab = tabs.find((t) => t.sessionId === p.sessionId);
      if (!tab || tab.title === p.customTitle) continue;
      updateTabState(tab.id, { title: p.customTitle, lockTitle: true });
    }
  }, [pinnedSessions, tabs, updateTabState]);

  // ── Right-click menu + rename ────────────────────────────────────────────
  const [menu, setMenu] = useState<TabContextMenuState | null>(null);
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);

  const openTabMenu = useCallback((tabId: string, x: number, y: number) => {
    const tab = tabs.find((t) => t.id === tabId);
    setMenu({
      tabId,
      x,
      y,
      isPinned: pinRankOf(pinnedIds, tab?.sessionId) >= 0,
      // Read at OPEN time, like `isPinned`, so each label states what the click
      // will do rather than being recomputed while the menu is on screen.
      isNoLearn: isNoLearn(tab?.sessionId),
      hasSession: Boolean(tab?.sessionId),
    });
  }, [tabs, pinnedIds, isNoLearn]);

  /**
   * Commit a rename. An EMPTY name is not a name — it clears the override and
   * hands the tab back to the automatic title, which is the only way back once
   * a title has been fixed.
   */
  const commitRename = useCallback((tabId: string, raw: string) => {
    setRenamingTabId(null);
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab?.sessionId) return;
    const title = raw.trim();
    // An empty name hands the tab BACK to the automatic title — the only way to
    // undo a rename — so the lock is released with it.
    updateTabState(tabId, title ? { title, lockTitle: true } : { titleLocked: false });
    BrowserRuntime.runFork(
      renameSession(tab.sessionId, title, tab.cwd || initialCwd || '').pipe(
        Effect.orElse(() => Effect.void),
      ),
    );
    // The name is one setting, but the pinned list holds its own copy and only
    // refetches when told. Without this a rename showed up in Recent sessions
    // (which rebuilds per request) and nowhere else, which looks like it only
    // half-saved.
    publishTopic(Topics.PinnedSessionsChanged, {});
  }, [tabs, updateTabState, initialCwd]);

  // UI state
  const [isProjectSessionsOpen, setIsProjectSessionsOpen] = useState(false);
  // Right-side file browser (VSCode-style). Project-scoped, so it needs a cwd.
  const [isFilesOpen, setIsFilesOpen] = useState(false);
  // Its width, dragged by the divider beside it. An app-wide preference (the
  // same `ui.*` store the sidebar width uses), NOT per project: a person who
  // likes a wide file tree likes it in every project, and having it change on
  // each switch would read as the panel forgetting.
  const [filesWidth, setFilesWidth] = useState(FILES_DEFAULT_WIDTH);
  const [isResizingFiles, setIsResizingFiles] = useState(false);

  // Read the stored width once. This runs in the project IFRAME, which shares
  // the server (and therefore the settings store) with the outer window but not
  // its React state — hence its own fetch rather than a prop.
  useEffect(() => {
    let cancelled = false;
    void BrowserRuntime.runPromise(fetchProjects.pipe(Effect.either)).then((exit) => {
      if (cancelled || exit._tag === 'Left') return;
      const stored = exit.right.filesWidth;
      if (typeof stored === 'number') setFilesWidth(stored);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleFilesResize = useCallback((next: number) => {
    setIsResizingFiles(true);
    setFilesWidth(next);
  }, []);

  // Persisted once the gesture ends, not on every pointer move.
  const handleFilesResizeEnd = useCallback((next: number) => {
    setIsResizingFiles(false);
    setFilesWidth(next);
    void BrowserRuntime.runPromise(saveFilesWidthEffect(next).pipe(Effect.either)).then((exit) => {
      if (exit._tag === 'Left') console.error('Failed to save file browser width:', exit.left);
    });
  }, []);
  // Forced chat refresh signal: bumped when a SWITCH_SESSION jump targets a session whose
  // tab already exists. Activating an already-active tab produces no isActive rising edge
  // in Chat, so without this a jump from the scheduled-tasks / recent / pinned panels would
  // never re-fetch messages appended externally (e.g. a scheduled-task run).
  const [sessionRefresh, setSessionRefresh] = useState<{ sessionId: string; nonce: number } | null>(null);

  // Cmd/Ctrl+1..9 tab switching needs the live tab list + switchTab without
  // re-registering the keydown listener on every tab change. Ref indirection
  // keeps the effect's dep array empty (single stable listener) while always
  // reading the current values.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const switchTabRef = useRef(switchTab);
  switchTabRef.current = switchTab;
  // Cmd/Ctrl+W (close the active tab) reads through the same indirection.
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const closeTabRef = useRef(closeTab);
  closeTabRef.current = closeTab;

  // Global keyboard shortcuts for the chat host. This listener lives on the
  // project iframe's own window (the same window the tab UI renders into), so
  // it fires whenever focus is inside the iframe — which is where the chat and
  // tab bar are. (The parent-window listener in Workspace.tsx cannot see these
  // events because iframe keydowns don't bubble to the parent; that is exactly
  // why the tab shortcut belongs here, next to the existing Cmd+S swallow that
  // already relies on this behaviour.)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      // Swallow Cmd+S so the browser's "Save Page As..." never leaks through.
      if (e.key === 's') {
        e.preventDefault();
        return;
      }
      // Cmd/Ctrl+W → close the ACTIVE session tab, the way a browser closes a
      // browser tab. The key only reaches this handler because the Electron
      // application menu (electron/menu.ts) deliberately does not bind it to
      // "close window". On the LAST tab, closeTab already does the right thing:
      // it leaves a fresh blank tab behind and publishes GoHome, so the window
      // lands on the home screen instead of vanishing.
      if (e.key === 'w') {
        e.preventDefault();
        const activeId = activeTabIdRef.current;
        if (activeId) closeTabRef.current(activeId);
        return;
      }
      // Cmd/Ctrl+1..9 → switch to the Nth tab. 1..8 are positional; 9 always
      // jumps to the LAST tab (common convention). Out-of-range positions
      // (e.g. Cmd+5 with 3 tabs) are ignored so the browser default is left
      // untouched.
      if (e.key >= '1' && e.key <= '9') {
        const currentTabs = tabsRef.current;
        if (currentTabs.length === 0) return;
        const digit = Number(e.key);
        const targetIndex = digit === 9 ? currentTabs.length - 1 : digit - 1;
        if (targetIndex >= 0 && targetIndex < currentTabs.length) {
          e.preventDefault();
          switchTabRef.current(currentTabs[targetIndex].id);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Listen for messages from the parent window (used by Workspace to switch sessions)
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'SWITCH_SESSION') {
        const { sessionId } = event.data;
        if (sessionId) {
          handleSelectSession(sessionId);
          // User viewed this session → write state.json as normal (skip sessions still loading to avoid clearing the unread indicator prematurely)
          const targetTab = tabs.find(t => t.sessionId === sessionId);
          // Existing tab (possibly already active → no rising edge): force Chat to
          // re-fetch the latest messages from disk. New tabs load history in full anyway.
          if (targetTab) {
            setSessionRefresh(prev => ({ sessionId, nonce: (prev?.nonce ?? 0) + 1 }));
          }
          if (initialCwd && !targetTab?.isLoading) {
            BrowserRuntime.runFork(
              updateSessionStatus(initialCwd, sessionId, 'normal').pipe(
                Effect.orElse(() => Effect.void)
              )
            );
            // Also clear scheduled-task unread for this session: jumping in via
            // SWITCH_SESSION (recent/pinned sessions) otherwise never decrements
            // the scheduled-task unread badge — only the scheduled-tasks panel did.
            BrowserRuntime.runFork(
              markScheduledTasksReadBySession(sessionId).pipe(
                Effect.orElse(() => Effect.void)
              )
            );
          }
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [handleSelectSession, initialCwd, tabs]);

  // Open note
  const handleOpenNote = useCallback(() => {
    if (!initialCwd) return;
    BrowserRuntime.runFork(
      Effect.flatMap(IframeBus, (bus) =>
        bus.publish(Topics.OpenNote, { cwd: initialCwd })
      )
    );
  }, [initialCwd]);

  // Open the app Settings modal. It lives in the PARENT window (Workspace), so —
  // like the note modal above — the request crosses the iframe boundary over the
  // bus rather than being handled here. No cwd needed: Settings is app-wide.
  const handleOpenSettings = useCallback(() => {
    BrowserRuntime.runFork(
      Effect.flatMap(IframeBus, (bus) => bus.publish(Topics.OpenSettings, {}))
    );
  }, []);

  // THROW A SESSION AWAY. The selection popup's discard-on-close, and nothing
  // else — a popup conversation the user did not keep should leave no trace.
  //
  // Deliberately the EXISTING deleteSession, which is the same
  // `closedSessionIds` route a tab close already takes: the server runs
  // `store.deleteSession(sid)`, dropping the session and everything keyed to it,
  // then broadcasts `project-state-changed`. A second delete path would be a
  // second answer to one question.
  const handleDiscardSession = useCallback((sessionId: string) => {
    if (!initialCwd) return;
    BrowserRuntime.runFork(
      deleteSession(initialCwd, sessionId).pipe(
        Effect.tapError((e) =>
          Effect.sync(() => console.error('Failed to discard popup session:', e))
        ),
        Effect.catchAll(() => Effect.void)
      )
    );
  }, [initialCwd]);

  return (
    <ChatProvider>
    <div className="flex h-screen bg-card">
      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar - always visible */}
        <TabManagerTopBar
          initialCwd={initialCwd}
          filesOpen={isFilesOpen}
          onToggleFiles={initialCwd ? () => setIsFilesOpen((v) => !v) : undefined}
        />

        {/* Tab bar + Chat */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <PanelPortalProvider>
            <div className="w-full h-full flex flex-col">
              <TabBar
                tabs={displayTabs}
                activeTabId={activeTabId}
                unreadTabs={unreadTabs}
                dragTabIndex={dragTabIndex}
                dragOverTabIndex={dragOverTabIndex}
                isPinned={isTabPinned}
                isNoLearn={isTabNoLearn}
                onTabContextMenu={openTabMenu}
                renamingTabId={renamingTabId}
                onRenameCommit={commitRename}
                onRenameCancel={() => setRenamingTabId(null)}
                onSwitchTab={switchTab}
                onCloseTab={closeTab}
                onNewTab={handleNewTab}
                onOpenProjectSessions={initialCwd ? () => setIsProjectSessionsOpen(true) : undefined}
                onDragStart={handleTabDragStart}
                onDragOver={handleTabDragOver}
                canDropAt={canDropAt}
                onDrop={handleGroupedDrop}
                onDragEnd={handleTabDragEnd}
              />
              {menu && (
                <TabContextMenu
                  state={menu}
                  onClose={() => setMenu(null)}
                  onTogglePin={handleTogglePin}
                  onRename={setRenamingTabId}
                  onToggleNoLearn={handleToggleNoLearn}
                  onContinueInNewTab={handleContinueInNewTab}
                />
              )}
              <div className="flex-1 overflow-hidden relative">
                {tabs.map((tab) => (
                  <div
                    key={tab.id}
                    className={`h-full ${tab.id === activeTabId ? 'block' : 'hidden'}`}
                  >
                    <ChatPanel
                      tabId={tab.id}
                      cwd={tab.cwd}
                      sessionId={tab.sessionId}
                      engine={tab.engine}
                      planMode={tab.planMode}
                      onPlanModeChange={updateTabPlanMode}
                      isActive={tab.id === activeTabId}
                      refreshSignal={sessionRefresh}
                      onStateChange={updateTabState}
                      onOpenNote={initialCwd ? handleOpenNote : undefined}
                      onCreateScheduledTask={createScheduledTask}
                      onOpenSession={handleOpenSession}
                      onDiscardSession={handleDiscardSession}
                      onOpenSettings={handleOpenSettings}
                    />
                  </div>
                ))}
              </div>
            </div>
          </PanelPortalProvider>
        </div>
      </div>

      {/* Right-side file browser (VSCode-style). Sibling of the chat column so it
          is stable across chat-tab switches; only mounted while toggled open and
          a project cwd exists. */}
      {initialCwd && isFilesOpen && (
        <>
          {/* Its divider. `side="right"` because the panel it sizes is on the
              right of the handle: dragging LEFT makes it wider. */}
          <ResizeHandle
            width={filesWidth}
            min={FILES_MIN_WIDTH}
            max={FILES_MAX_WIDTH}
            side="right"
            onResize={handleFilesResize}
            onResizeEnd={handleFilesResizeEnd}
            label={t('workspace.resizeFiles')}
          />
          <FileBrowserPanel
            cwd={initialCwd}
            onClose={() => setIsFilesOpen(false)}
            width={filesWidth}
            resizing={isResizingFiles}
          />
        </>
      )}

      {/* Project Sessions Modal */}
      {initialCwd && (
        <ProjectSessionsModal
          isOpen={isProjectSessionsOpen}
          onClose={() => setIsProjectSessionsOpen(false)}
          cwd={initialCwd}
          onSelectSession={handleSelectSession}
        />
      )}
    </div>
    </ChatProvider>
  );
}
