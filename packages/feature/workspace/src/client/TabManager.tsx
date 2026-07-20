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

import { useState, useEffect, useCallback } from 'react';
import { ProjectSessionsModal } from '@cockpit/feature-agent';
import { ChatProvider } from '@cockpit/feature-agent';
import { PanelPortalProvider } from '@cockpit/shared-ui';
import { useTabState } from './useTabState';
import { TabManagerTopBar } from './TabManagerTopBar';
import { TabBar } from './TabBar';
import { ChatPanel } from '@cockpit/feature-agent';
import { usePinnedSessions } from '@cockpit/feature-agent';
import { useScheduledTasks } from '@cockpit/feature-agent';
import { Effect } from 'effect';
import { IframeBus, Topics } from '@cockpit/effect-services';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { updateSessionStatus, markScheduledTasksReadBySession } from './effect/stateClient';

interface TabManagerProps {
  initialCwd?: string;
  initialSessionId?: string;
}

export function TabManager({ initialCwd, initialSessionId }: TabManagerProps) {
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
    handleNewClaude2Tab,
    handleNewCodexTab,
    handleNewKimiTab,
    handleNewOllamaTab,
    handleNewDeepseekTab,
    handleOpenSession,
    updateTabState,
    updateTabOllamaModel,
    updateTabDeepseekModel,
    updateTabPlanMode,
    handleTabDragStart,
    handleTabDragOver,
    handleTabDrop,
    handleTabDragEnd,
  } = useTabState({ initialCwd, initialSessionId, activeView: 'agent' });

  // Pin state management
  const { isPinned, pinSession, unpinSession } = usePinnedSessions();

  // Scheduled tasks
  const { createTask: createScheduledTask } = useScheduledTasks();

  const isTabPinned = useCallback((tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    return tab?.sessionId ? isPinned(tab.sessionId) : false;
  }, [tabs, isPinned]);

  const handleTogglePin = useCallback((tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab?.sessionId) return;
    if (isPinned(tab.sessionId)) {
      unpinSession(tab.sessionId);
    } else {
      pinSession(tab.sessionId, tab.cwd || initialCwd || '', tab.title);
    }
  }, [tabs, isPinned, pinSession, unpinSession, initialCwd]);

  // UI state
  const [isProjectSessionsOpen, setIsProjectSessionsOpen] = useState(false);
  // Forced chat refresh signal: bumped when a SWITCH_SESSION jump targets a session whose
  // tab already exists. Activating an already-active tab produces no isActive rising edge
  // in Chat, so without this a jump from the scheduled-tasks / recent / pinned panels would
  // never re-fetch messages appended externally (e.g. a scheduled-task run).
  const [sessionRefresh, setSessionRefresh] = useState<{ sessionId: string; nonce: number } | null>(null);

  // Globally swallow Cmd+S so the browser's "Save Page As..." never leaks through.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === 's') {
        e.preventDefault();
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

  return (
    <ChatProvider>
    <div className="flex h-screen bg-card">
      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar - always visible */}
        <TabManagerTopBar initialCwd={initialCwd} />

        {/* Tab bar + Chat */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <PanelPortalProvider>
            <div className="w-full h-full flex flex-col">
              <TabBar
                tabs={tabs}
                activeTabId={activeTabId}
                unreadTabs={unreadTabs}
                dragTabIndex={dragTabIndex}
                dragOverTabIndex={dragOverTabIndex}
                isPinned={isTabPinned}
                onTogglePin={handleTogglePin}
                onSwitchTab={switchTab}
                onCloseTab={closeTab}
                onNewTab={handleNewTab}
                onNewClaude2Tab={handleNewClaude2Tab}
                onNewCodexTab={handleNewCodexTab}
                onNewKimiTab={handleNewKimiTab}
                onNewOllamaTab={handleNewOllamaTab}
                onNewDeepseekTab={handleNewDeepseekTab}
                onOpenProjectSessions={initialCwd ? () => setIsProjectSessionsOpen(true) : undefined}
                onDragStart={handleTabDragStart}
                onDragOver={handleTabDragOver}
                onDrop={handleTabDrop}
                onDragEnd={handleTabDragEnd}
              />
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
                      ollamaModel={tab.ollamaModel}
                      onOllamaModelChange={updateTabOllamaModel}
                      deepseekModel={tab.deepseekModel}
                      onDeepseekModelChange={updateTabDeepseekModel}
                      planMode={tab.planMode}
                      onPlanModeChange={updateTabPlanMode}
                      isActive={tab.id === activeTabId}
                      refreshSignal={sessionRefresh}
                      onStateChange={updateTabState}
                      onOpenNote={initialCwd ? handleOpenNote : undefined}
                      onCreateScheduledTask={createScheduledTask}
                      onOpenSession={handleOpenSession}
                    />
                  </div>
                ))}
              </div>
            </div>
          </PanelPortalProvider>
        </div>
      </div>

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
