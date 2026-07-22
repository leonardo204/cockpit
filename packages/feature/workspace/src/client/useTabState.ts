'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { usePageVisible, useWebSocket } from '@cockpit/shared-ui';
import type { ChatEngine } from '@cockpit/feature-agent';
import { publishTopic } from '@cockpit/effect-react';
import { Topics } from '@cockpit/effect-services';
import { Effect } from 'effect';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import {
  loadProjectState,
  saveProjectState,
  updateSessionStatus as updateSessionStatusEff,
  markScheduledTasksReadBySession,
} from './effect/stateClient';

// ============================================
// Types
// ============================================

export interface TabInfo {
  id: string;
  cwd?: string;
  sessionId?: string;
  title: string;
  isLoading?: boolean;
  engine?: ChatEngine;
  planMode?: boolean;
}

// ============================================
// Hook
// ============================================

interface UseTabStateOptions {
  initialCwd?: string;
  initialSessionId?: string;
  /** Current view (agent/explorer/console), used to determine unread: active tab also marked unread when not on agent screen */
  activeView?: string;
}

export function useTabState({ initialCwd, initialSessionId, activeView }: UseTabStateOptions) {
  // Mark whether sessions have been loaded from server
  const hasLoadedRef = useRef(false);
  // Mark whether currently initializing (avoid triggering save during initialization)
  const isInitializingRef = useRef(true);
  const activeViewRef = useRef(activeView);
  useEffect(() => { activeViewRef.current = activeView; }, [activeView]);
  const pageVisible = usePageVisible();
  const pageVisibleRef = useRef(pageVisible);
  useEffect(() => { pageVisibleRef.current = pageVisible; }, [pageVisible]);

  // Initialize tabs (first create a temporary tab, later overwritten by server data).
  // Seed it with initialSessionId (from the URL) so that a project with no state.json yet
  // still opens the requested session: loadSessions' null-data branch keeps this default tab
  // as-is, and its data branch merges/activates initialSessionId anyway. This removes the
  // dependency on a post-onLoad SWITCH_SESSION message and its race with the restore.
  const [tabs, setTabs] = useState<TabInfo[]>(() => [{
    id: `tab-${Date.now()}`,
    cwd: initialCwd,
    sessionId: initialSessionId,
    title: initialSessionId ? `Session ${initialSessionId.slice(0, 6)}...` : 'New Chat',
  }]);
  const [activeTabId, setActiveTabId] = useState<string>(tabs[0]?.id ?? '');

  // Unread tabs (session completed but not yet viewed)
  const [unreadTabs, setUnreadTabs] = useState<Set<string>>(new Set());

  // Ref for tabs (avoid stale closures in callbacks)
  const tabsRef = useRef(tabs);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  const activeTabIdRef = useRef(activeTabId);
  useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);
  // Sessions explicitly closed in THIS tab since the last save. The next save sends them as
  // closedSessionIds so the server removes them from the shared union (the only removal path).
  const pendingClosedRef = useRef<Set<string>>(new Set());

  // Update session status in state.json (notify Workspace layer)
  const updateSessionStatus = useCallback((sessionId: string, status: string) => {
    if (!initialCwd || !sessionId) return;
    BrowserRuntime.runFork(
      updateSessionStatusEff(initialCwd, sessionId, status).pipe(
        Effect.catchAll(() => Effect.void)
      )
    );
  }, [initialCwd]);

  // Tab drag state
  const [dragTabIndex, setDragTabIndex] = useState<number | null>(null);
  const [dragOverTabIndex, setDragOverTabIndex] = useState<number | null>(null);

  // Load saved sessions from server and merge with URL params
  useEffect(() => {
    if (!initialCwd || hasLoadedRef.current) return;
    hasLoadedRef.current = true;

    // loadProjectState wraps Effect.catchAll -> Effect.succeed(null) internally so
    // runPromise never rejects; the outer try/catch would never fire. On failure
    // data === null and we fall through to the else branch.
    const loadSessions = async () => {
      const data = await BrowserRuntime.runPromise(
        loadProjectState(initialCwd).pipe(
          Effect.catchAll(() => Effect.succeed(null))
        )
      );
      if (data) {
        // NOTE: persisted session state may still carry a `chatModes` key written by
        // older builds (the removed SDK/PTY picker). It is simply not read — unknown
        // keys are ignored on load and dropped on the next save.
        const savedPlanModes: Record<string, boolean> = data.planModes || {};

        // PRODUCT RULE: opening a project starts a NEW session. We deliberately do
        // NOT rebuild the previous multi-tab layout from state.json — a fresh open
        // used to silently reconnect the last active session (the "기존 세션 연결"
        // complaint), which this app must not do. The saved sessions are NOT lost:
        // the save effect below is a union (it only ADDS, and removes solely via an
        // explicit closedSessionIds; see /api/project-state), so they stay on disk
        // and remain reachable through Recent Sessions / Browse all sessions.
        //
        // The one exception is an EXPLICIT open of a specific past session — a deep
        // link or a pick from the session browser — which arrives as initialSessionId.
        // That id is already seeded into the default tab (see the tabs initial state
        // above); here we only carry over its saved plan-mode. (Per-engine tab state
        // was removed with the engine picker — Naby is single-engine.)
        if (initialSessionId) {
          setTabs((prev) =>
            prev.map((t) =>
              t.sessionId === initialSessionId
                ? {
                    ...t,
                    planMode: savedPlanModes[initialSessionId] ?? t.planMode,
                  }
                : t,
            ),
          );
          setTimeout(() => {
            isInitializingRef.current = false;
          }, 0);
        } else {
          isInitializingRef.current = false;
        }
      } else {
        // loadProjectState failed: don't block init, keep the default tab list
        isInitializingRef.current = false;
      }
    };

    loadSessions();
  }, [initialCwd, initialSessionId]);

  // Save to server when tabs or activeTabId changes
  useEffect(() => {
    if (isInitializingRef.current || !initialCwd) return;

    const sessionIds = tabs
      .map(tab => tab.sessionId)
      .filter((id): id is string => !!id);

    const activeTab = tabs.find(t => t.id === activeTabId);
    const activeSessionId = activeTab?.sessionId;

    // Per-session plan-mode map. (Per-engine tab state — engines / ollamaModels /
    // deepseekModels — was removed with the engine picker; Naby is single-engine.)
    const planModes: Record<string, boolean> = {};
    for (const tab of tabs) {
      // Persist the explicit value for sessions THIS tab has open, so switching
      // back to the default actually overrides a previously-saved non-default.
      // The server merge is a union — an absent key keeps the old value, which
      // made "off"/"sdk" un-persistable (toggle off → key omitted → stale value
      // survives → re-applied on reload). Sessions open only in OTHER tabs aren't
      // in this payload, so the union still preserves their settings.
      if (tab.sessionId) {
        planModes[tab.sessionId] = !!tab.planMode;
      }
    }

    // Sessions closed in this tab since the last save → the server subtracts them from the
    // shared union (saves otherwise only ADD, never shrink). Snapshot but do NOT drain yet:
    // removal is the ONLY shrink path and the union has no memory, so a `closedSessionIds`
    // lost to a failed POST = a ghost session that re-materializes forever. Clear each id
    // only AFTER the save succeeds (and only those ids — closes that arrive mid-flight stay
    // pending for the next save).
    const closedSessionIds = [...pendingClosedRef.current];

    BrowserRuntime.runFork(
      saveProjectState({
        cwd: initialCwd,
        sessions: sessionIds,
        activeSessionId,
        planModes,
        ...(closedSessionIds.length ? { closedSessionIds } : {}),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            for (const id of closedSessionIds) pendingClosedRef.current.delete(id);
          })
        ),
        Effect.tapError((e) =>
          Effect.sync(() => console.error('Failed to save sessions:', e))
        ),
        Effect.catchAll(() => Effect.void)
      )
    );
  }, [tabs, activeTabId, initialCwd]);

  // Notify parent Workspace when switching tab (parent handles the ADDRESS-BAR
  // URL update) AND reflect the active session into THIS iframe's own URL.
  //
  // The iframe page is `/project?cwd=…`; its src (built by Workspace.getProjectUrl)
  // is frozen at project birth and never carries the live sessionId. So a full
  // `window.location.reload()` from inside the iframe (the top-bar Refresh) used
  // to reload `/project?cwd=…` with NO sessionId → useTabState started a blank
  // "New Chat" and the session the user was viewing was lost.
  //
  // Fix (BUG 2, Option A): stamp the active sessionId onto the iframe document's
  // OWN url via history.replaceState. It does not reload or re-fetch anything and
  // does not touch the parent's iframe src, so it is invisible until a reload —
  // at which point ProjectPage reads `sessionId` from the URL into
  // useTabState({ initialSessionId }), and the existing "explicit initialSessionId
  // reopens exactly that session" branch restores it (NOT the whole history).
  // This is why it does NOT reintroduce "opening a project from home restores all
  // old sessions": a fresh open still has no sessionId in getProjectUrl; only an
  // in-iframe reload of an already-active session carries it.
  useEffect(() => {
    if (isInitializingRef.current || !initialCwd) return;

    const activeTab = tabs.find(t => t.id === activeTabId);
    const sessionId = activeTab?.sessionId;

    // Keep the iframe's own URL in sync with the active tab so a reload restores
    // exactly this session (or, for a blank New Chat tab, no session).
    try {
      const url = new URL(window.location.href);
      if (sessionId) url.searchParams.set('sessionId', sessionId);
      else url.searchParams.delete('sessionId');
      window.history.replaceState(window.history.state, '', url.toString());
    } catch {
      /* non-browser / sandboxed context — URL sync is best-effort */
    }

    if (!sessionId) return;

    publishTopic(Topics.SessionChange, {
      cwd: initialCwd,
      sessionId,
    });
  }, [activeTabId, tabs, initialCwd]);

  // #10: keep in-app tabs in sync across browser tabs of the same project. The
  // /api/project-state broadcasts `project-state-changed` after every tab open/close.
  // We reconcile REMOVALS ONLY — the sessions named in the event's `closedSessionIds`.
  //
  // We deliberately do NOT add sessions from the persisted union. That ADD path
  // existed for cross-window sync, but with the "opening a project starts a NEW
  // session" rule (see loadSessions) it does the wrong thing: state.json keeps
  // every past session, so on the first save→broadcast after opening, reconcile
  // pulled the WHOLE history back in as tabs — the "I pressed + and my old
  // sessions reappeared" bug. Naby is a single-window desktop app, so there is no
  // second window whose newly-opened session we need to mirror; past sessions are
  // reached through the session browsers, never auto-restored here.
  const reconcileTabs = useCallback((closedIds: string[]) => {
    if (!initialCwd || closedIds.length === 0) return;
    const closedSet = new Set(closedIds);
    const prev = tabsRef.current;
    // remove only explicitly-closed sessions; keep placeholders + everything else
    const kept = prev.filter((t) => !t.sessionId || !closedSet.has(t.sessionId));
    if (kept.length === prev.length) return; // nothing we hold was closed
    // never leave the tab bar empty (tabs[0].id is read every render)
    const next =
      kept.length === 0
        ? [{ id: `tab-${Date.now()}`, cwd: initialCwd, title: 'New Chat' }]
        : kept;
    setTabs(next);
    // active tab closed elsewhere → fall back to the last remaining tab
    if (!next.some((t) => t.id === activeTabIdRef.current)) {
      setActiveTabId(next[next.length - 1].id);
    }
  }, [initialCwd]);

  useWebSocket({
    url: '/ws/global-state',
    enabled: !!initialCwd,
    onMessage: (raw) => {
      if (isInitializingRef.current || !initialCwd) return;
      const p = raw as { type?: string; cwd?: string; closedSessionIds?: string[] };
      if (p.type === 'project-state-changed' && p.cwd === initialCwd) {
        reconcileTabs(p.closedSessionIds ?? []);
      }
    },
  });

  // Add new tab
  // - appendToEnd=true (new chats from "+" menu, opening existing sessions from sidebar):
  //   append to the end of all tabs
  // - appendToEnd=false (forked chats): insert to the right of current tab
  const addTab = useCallback((cwd?: string, sessionId?: string, title?: string, engine?: ChatEngine, appendToEnd: boolean = false) => {
    const newTab: TabInfo = {
      id: `tab-${Date.now()}`,
      cwd,
      sessionId,
      title: title || (sessionId ? `Session ${sessionId.slice(0, 6)}...` : 'New Chat'),
      engine,
    };
    setTabs((prev) => {
      if (appendToEnd) {
        return [...prev, newTab];
      }
      const currentIndex = prev.findIndex((t) => t.id === activeTabId);
      if (currentIndex === -1) {
        return [...prev, newTab];
      }
      const newTabs = [...prev];
      newTabs.splice(currentIndex + 1, 0, newTab);
      return newTabs;
    });
    setActiveTabId(newTab.id);
  }, [activeTabId]);

  // Close tab
  //
  // CLOSING THE LAST TAB IS THE INTERESTING CASE. The tab bar now offers a close
  // button on every tab (the old `tabs.length > 1` gate is gone), so "no tabs
  // left" is reachable by design rather than only by a sync race. Two things
  // have to happen, and they are separate concerns:
  //
  //   1. This iframe must not be left as an empty shell. `tabs[0].id` is read
  //      every render, and an empty chat host is a broken-looking screen even if
  //      it does not throw — so a fresh blank tab is seeded, exactly as the
  //      cross-window reconcile path already does.
  //   2. The USER should not be looking at that blank tab. Closing your last
  //      conversation reads as "I am done with this project", and the honest
  //      destination is the home screen. That screen lives in the PARENT window
  //      (Workspace's EmptyState), so the iframe cannot navigate there itself —
  //      it publishes GoHome and the parent decides.
  //
  // The seeded tab is therefore not wasted work: it is what this iframe shows if
  // the user comes back to the project from the sidebar.
  const closeTab = useCallback((tabId: string) => {
    // Record an explicit close so the next save removes it from the shared union (and the
    // broadcast tells other browser tabs to remove exactly this session).
    const closing = tabsRef.current.find((t) => t.id === tabId);
    if (closing?.sessionId) pendingClosedRef.current.add(closing.sessionId);
    setTabs((prev) => {
      const newTabs = prev.filter((t) => t.id !== tabId);
      if (tabId === activeTabId && newTabs.length > 0) {
        setActiveTabId(newTabs[newTabs.length - 1].id);
      }
      if (newTabs.length === 0) {
        const newTab: TabInfo = {
          id: `tab-${Date.now()}`,
          cwd: initialCwd,
          title: 'New Chat',
        };
        setActiveTabId(newTab.id);
        // Published from inside the updater, but it is not a render-phase side
        // effect on this component: publishTopic posts a window message, which
        // is delivered asynchronously to the PARENT window. Scheduling it here
        // rather than in an effect keeps "the tab list became empty" and "go
        // home" as one atomic decision, with no extra state to keep in sync.
        if (initialCwd) {
          publishTopic(Topics.GoHome, { cwd: initialCwd });
        }
        return [newTab];
      }
      return newTabs;
    });
  }, [activeTabId, initialCwd]);

  // Handle sidebar session click - add new tab (appended to end)
  const handleSelectSession = useCallback((sid: string, title?: string) => {
    const existingTab = tabs.find((t) => t.sessionId === sid);
    if (existingTab) {
      setActiveTabId(existingTab.id);
    } else {
      addTab(initialCwd, sid, title, undefined, true);
    }
  }, [tabs, initialCwd, addTab]);

  // Create new blank tab (appended to end). Naby has a single runtime engine —
  // the engine picker was removed, so every new tab is a default tab (engine
  // undefined → the Naby `claude` path → /api/chat → nabySpec). dev/prod is
  // decided by whether an API key is configured, not by a per-tab choice.
  const handleNewTab = useCallback(() => {
    addTab(initialCwd, undefined, undefined, undefined, true);
  }, [initialCwd, addTab]);

  // Update plan mode (read-only planning) for a tab
  const updateTabPlanMode = useCallback((tabId: string, planMode: boolean) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId ? { ...tab, planMode } : tab
      )
    );
  }, []);

  // Open new session (for Fork, always creates a new tab)
  const handleOpenSession = useCallback((sid: string, title?: string) => {
    addTab(initialCwd, sid, title);
  }, [initialCwd, addTab]);

  // Update tab state (loading, sessionId)
  const updateTabState = useCallback((tabId: string, updates: { isLoading?: boolean; sessionId?: string; title?: string }) => {
    setTabs((prev) => {
      const oldTab = prev.find(t => t.id === tabId);
      if (oldTab?.isLoading && updates.isLoading === false) {
        // User "is watching" requires all 3 conditions:
        // 1. Is the current active tab
        // 2. On the agent screen (not explorer/console)
        // 3. iframe is visible to user (is the current active project)
        const isOnAgent = !activeViewRef.current || activeViewRef.current === 'agent';
        const isUserWatching = tabId === activeTabId && isOnAgent && pageVisibleRef.current;
        if (!isUserWatching) {
          setUnreadTabs(u => new Set(u).add(tabId));
          // state.json already set to 'unread' by /api/chat, no need to write
        } else {
          // User is watching → correct state.json to 'normal' (/api/chat defaults to 'unread')
          const sid = oldTab.sessionId || updates.sessionId;
          if (sid) updateSessionStatus(sid, 'normal');
        }
      }
      return prev.map((tab) =>
        tab.id === tabId ? { ...tab, ...updates } : tab
      );
    });
  }, [activeTabId, updateSessionStatus]);

  // Clear unread for current active tab when switching back to agent screen / switching tab / iframe becomes visible
  // Must satisfy both: on agent screen + iframe visible
  useEffect(() => {
    const isOnAgent = !activeView || activeView === 'agent';
    if (isOnAgent && pageVisible) {
      setUnreadTabs(u => {
        if (!u.has(activeTabId)) return u;
        const next = new Set(u);
        next.delete(activeTabId);
        // Sync write state.json
        const tab = tabsRef.current.find(t => t.id === activeTabId);
        if (tab?.sessionId) {
          updateSessionStatus(tab.sessionId, 'normal');
          // Clear scheduled task unread for this session
          BrowserRuntime.runFork(
            markScheduledTasksReadBySession(tab.sessionId).pipe(
              Effect.catchAll(() => Effect.void)
            )
          );
        }
        return next;
      });
    }
  }, [activeView, activeTabId, pageVisible, updateSessionStatus]);

  // Switch tab and clear unread
  const switchTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
    setUnreadTabs(u => {
      if (!u.has(tabId)) return u;
      const next = new Set(u);
      next.delete(tabId);
      // Sync write to state.json
      const tab = tabsRef.current.find(t => t.id === tabId);
      if (tab?.sessionId) {
        updateSessionStatus(tab.sessionId, 'normal');
        // Clear scheduled task unread for this session
        BrowserRuntime.runFork(
          markScheduledTasksReadBySession(tab.sessionId).pipe(
            Effect.catchAll(() => Effect.void)
          )
        );
      }
      return next;
    });
  }, [updateSessionStatus]);

  // Tab drag-to-reorder
  const handleTabDragStart = useCallback((index: number) => {
    setDragTabIndex(index);
  }, []);

  const handleTabDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (dragTabIndex !== null && dragTabIndex !== index) {
      setDragOverTabIndex(index);
    }
  }, [dragTabIndex]);

  const handleTabDrop = useCallback((targetIndex: number) => {
    if (dragTabIndex !== null && dragTabIndex !== targetIndex) {
      setTabs((prev) => {
        const newTabs = [...prev];
        const [removed] = newTabs.splice(dragTabIndex, 1);
        newTabs.splice(targetIndex, 0, removed);
        return newTabs;
      });
    }
    setDragTabIndex(null);
    setDragOverTabIndex(null);
  }, [dragTabIndex]);

  const handleTabDragEnd = useCallback(() => {
    setDragTabIndex(null);
    setDragOverTabIndex(null);
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  return {
    // State
    tabs,
    activeTabId,
    activeTab,
    unreadTabs,
    dragTabIndex,
    dragOverTabIndex,

    // Tab operations
    addTab,
    closeTab,
    switchTab,
    handleSelectSession,
    handleNewTab,
    handleOpenSession,
    updateTabState,
    updateTabPlanMode,

    // Drag operations
    handleTabDragStart,
    handleTabDragOver,
    handleTabDrop,
    handleTabDragEnd,
  };
}
