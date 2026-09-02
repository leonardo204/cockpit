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
import { PanelPortalProvider, ResizeHandle, toast } from '@cockpit/shared-ui';
import { useTabState } from './useTabState';
import { TabManagerTopBar } from './TabManagerTopBar';
import { TabBar } from './TabBar';
import { TabContextMenu, type TabContextMenuState } from './TabContextMenu';
import { useNoLearnSessions } from './useNoLearnSessions';
import { orderTabs, planDrop, pinRankOf } from './tabOrder';
import { isChatTab, isDiffTab, isMarkdownTab } from './tabKinds';
import { MarkdownDocument } from './MarkdownDocument';
import { DiffDocument } from './DiffDocument';
import { deleteSession } from './projectSessionTree';
import {
  FileBrowserPanel,
  FILES_DEFAULT_WIDTH,
  FILES_MAX_WIDTH,
  FILES_MIN_WIDTH,
} from './FileBrowserPanel';
import { GitPanel } from './GitPanel';
import { fetchProjects, saveFilesWidth as saveFilesWidthEffect } from './effect/projectClient';
import { ChatPanel } from '@cockpit/feature-agent';
import { insertFileRef, insertFileRefWhenReady } from '@cockpit/feature-agent';
import { usePinnedSessions } from '@cockpit/feature-agent';
import {
  setActiveDocOpener,
  clearActiveDocOpener,
  type DocOpenRequest,
} from '@cockpit/feature-agent';
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
    openMarkdownTab,
    openDiffTab,
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
  // The handoff summary happens SERVER-SIDE and is a MODEL CALL, so it takes
  // seconds — long enough that the honest reading of a silent UI was "the click
  // did nothing", and the natural response (clicking again) minted a SECOND
  // session with a second summary behind it.
  //
  // So the wait is now stated in the two places the user is already looking: the
  // tab grows a spinner, and the menu item — reopened during the wait — says
  // what is happening and refuses a repeat. `continuingRef` is what actually
  // enforces the refusal; the state exists to RENDER it. Two clicks in one tick
  // would both read the pre-update set, which is exactly the case the ref covers.
  // (Same shape as ContextLimitBanner's `inFlight`, which offers this action from
  // the other end.)
  const [continuingTabs, setContinuingTabs] = useState<ReadonlySet<string>>(() => new Set());
  const continuingRef = useRef<Set<string>>(new Set());
  const publishContinuing = useCallback(() => {
    setContinuingTabs(new Set(continuingRef.current));
  }, []);
  const isTabContinuing = useCallback(
    (tabId: string) => continuingTabs.has(tabId),
    [continuingTabs],
  );

  // The words travel from here, like every other name this client sends: the server
  // has no locale.
  const handleContinueInNewTab = useCallback(async (tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId);
    // Per SESSION, like pinning and the temporary flag: a blank tab has no
    // conversation to hand off. The menu item is disabled in that state, and this
    // is the matching guard.
    if (!tab?.sessionId) return;
    if (continuingRef.current.has(tabId)) return;
    continuingRef.current.add(tabId);
    publishContinuing();
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
      if (!res.ok || !json?.ok || !json.sessionId) {
        // SAY SO. A refused request used to end in the same silence a slow one
        // did, which left the two indistinguishable — and the spinner this now
        // clears would otherwise have promised a tab that is never coming.
        toast(
          t('tabBar.continueFailed', { defaultValue: 'Could not continue in a new tab' }),
          'error',
        );
        return;
      }
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
      // conversation they can still use. Nothing to undo — but it is said out
      // loud, because the spinner made a promise this branch cannot keep.
      toast(
        t('tabBar.continueFailed', { defaultValue: 'Could not continue in a new tab' }),
        'error',
      );
    } finally {
      // EVERY exit clears the mark, including the ones above that `return`. A
      // spinner that never stops is worse than no spinner at all: it says the
      // app is still working on something it has already given up on.
      continuingRef.current.delete(tabId);
      publishContinuing();
    }
  }, [tabs, initialCwd, t, publishContinuing]);

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

  // THE LIVE TAB LIST, read by effects that must NOT re-run when tabs change.
  // Two need it: the pinned restore directly below, and the Cmd/Ctrl+1..9
  // listener further down. One ref rather than one each — two copies of "what is
  // open right now" is how an effect ends up trusting the wrong one.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // ── Pinned tabs come back when the project opens ─────────────────────────
  //
  // A pin is a standing request that a session stay reachable, so it is put back
  // in a tab of its own when the project opens.
  //
  // THIS USED TO BE "the ONE exception" to a rule that no longer exists. That
  // rule was "opening a project starts a fresh session"; it now resumes the
  // session the user was last in (projectOpenPlan.ts). What is still refused is
  // what the rule was actually protecting against — rebuilding the whole
  // multi-tab layout — so a pin remains the only thing that opens EXTRA tabs.
  //
  // The two land on independent fetches and race, in either order, and BOTH
  // orders had to be closed:
  //
  //   pinned first   `projectOpenPlan` sees the id already on screen and makes
  //                  the seed tab FOCUS it instead of adopting it.
  //   plan first     this loop must see the adoption. It reads `openTabsRef`
  //                  rather than the `tabs` snapshot in its closure, because the
  //                  adoption is a `setTabs` that may not have reached this
  //                  effect's render — reading the stale copy would find the
  //                  session absent and open a second tab holding it.
  //
  // `handleOpenSession` cannot dedupe on its own: forking deliberately opens a
  // second tab on a session that is already open, so the check belongs here.
  //
  // Runs once per project open, after the pinned set has loaded. `restoredRef`
  // guards the second pass that arrives when the pinned list refreshes, which
  // would otherwise reopen a tab the user had just closed.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !initialCwd || pinnedSessions.length === 0) return;
    restoredRef.current = true;
    const open = new Set(tabsRef.current.map((t) => t.sessionId).filter(Boolean));
    for (const p of pinnedSessions) {
      if (p.cwd !== initialCwd || open.has(p.sessionId)) continue;
      handleOpenSession(p.sessionId, p.customTitle);
    }
    // `tabs` stays out of the deps on purpose: re-running on every tab change
    // would fight the user's own closes. The ref is what makes that safe — the
    // effect still runs once, but it reads the CURRENT tabs when it does.
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
    // A DOCUMENT TAB HAS NO MENU, because this menu has nothing to offer it.
    // Every item is a per-SESSION action — pin, rename, temporary-session, and
    // continue-in-a-new-tab all key off `sessionId`, and a document names none —
    // so on a markdown tab the menu would open with four controls that either do
    // nothing (pin, rename: both early-return without a session) or are disabled.
    // Four dead items read as a broken menu; no menu reads as "not a thing you do
    // to a document", which is the truth. Closing the tab is still the ✕ on it
    // and still Cmd/Ctrl+W, neither of which goes through here.
    if (tab && isMarkdownTab(tab)) return;
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
  // ── The right-side dock ───────────────────────────────────────────────────
  //
  // ONE PANEL AT A TIME, not two booleans. The file browser and the git panel
  // are both project-scoped side panels of the same width, and a reader wants
  // one of them showing — mounting both would squeeze the chat column between
  // two trees. So this is which panel the dock is showing, and `null` is closed;
  // the two top-bar buttons swap the view rather than each opening a dock.
  //
  // Project-scoped, so both need a cwd.
  const [rightPanel, setRightPanel] = useState<'files' | 'git' | null>(null);
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

  // ── Promote a previewed document into a tab ───────────────────────────────
  //
  // The file browser owns the preview modal, so the request arrives from there
  // with the document the reader is ACTUALLY on (they may have followed relative
  // links out of the file they double-clicked). The project cwd is supplied
  // here, because it is this host that knows it and the viewer cannot resolve an
  // image or a relative link without one.
  //
  // Referentially stable — an unstable callback into the file browser would
  // defeat the memo its tree relies on (shell/CLAUDE.md, React conventions).
  const handleOpenDocumentInTab = useCallback((rel: string) => {
    if (!initialCwd) return;
    openMarkdownTab(initialCwd, rel);
  }, [initialCwd, openMarkdownTab]);

  // ── A path written in a message opens as a document ──────────────────────
  //
  // The assistant ends a job by saying where it put the file, and that path was
  // only ever selectable text. The message bubble linkifies it (filePathLinks.ts
  // decides what counts, and mints the link out of the path's OWN text so the
  // label cannot misdescribe its target) and asks THIS host to open it, because
  // opening tabs is what this host does.
  //
  // Through a bus rather than a prop: the bubble is four components down and is
  // `memo`'d against exactly the prop churn a threaded callback would add. Same
  // singleton shape as `fileRefBus` in the other direction — see docOpenBus.ts.
  //
  // `cwd` comes from the REQUEST, not from `initialCwd`: a document outside the
  // project is opened against its own folder, which is what lets a report in
  // ~/Downloads open without loosening the server's containment guard.
  useEffect(() => {
    const open = ({ cwd, rel }: DocOpenRequest) => openMarkdownTab(cwd, rel);
    setActiveDocOpener(open);
    return () => clearActiveDocOpener(open);
  }, [openMarkdownTab]);

  /**
   * The git panel names a diff; the tab list is what can hold one.
   *
   * The cwd is added HERE rather than passed into the panel's callback, because
   * the panel already has one and a second copy travelling through a click
   * handler is a second thing that can be the wrong project.
   */
  const handleOpenDiff = useCallback(
    (target: { path?: string; staged?: boolean; commit?: string }) => {
      if (!initialCwd) return;
      openDiffTab({ cwd: initialCwd, ...target });
    },
    [initialCwd, openDiffTab],
  );

  /**
   * The last CHAT tab that was on screen — where a question goes.
   *
   * A ref rather than state: it is read inside a click handler and must not
   * re-render anything when it moves. It trails `activeTabId` by design, so
   * opening a diff and asking about it lands the question back in the
   * conversation you came from rather than in the oldest tab in the strip.
   */
  const lastChatTabIdRef = useRef<string | null>(null);
  useEffect(() => {
    const active = tabs.find((t) => t.id === activeTabId);
    if (active && isChatTab(active)) lastChatTabIdRef.current = active.id;
  }, [tabs, activeTabId]);

  /**
   * "Ask naby about this" — from the git panel, or from a diff tab.
   *
   * IT SWITCHES TABS FIRST, and that is the whole fix rather than a nicety. A
   * ChatInput registers as the insertion target only while ITS tab is active
   * (ChatInput.tsx), so from a diff tab — which IS the active tab — there is no
   * registered input and the question had nowhere to go. It reported "open a
   * conversation first" at a moment when one was open and merely not in front.
   *
   * So: make a chat tab active, then hand over the text. The insert waits for
   * the input that is about to mount rather than being attempted against the one
   * that just went away.
   */
  const handleAskNaby = useCallback(
    (text: string) => {
      const body = text.endsWith(' ') ? text : `${text} `;
      const active = tabs.find((t) => t.id === activeTabId);
      if (active && isChatTab(active)) {
        // Already looking at a conversation — no switch, no waiting.
        if (!insertFileRef(body)) insertFileRefWhenReady(body);
        return;
      }
      const target =
        tabs.find((t) => t.id === lastChatTabIdRef.current && isChatTab(t)) ?? tabs.find(isChatTab);
      if (!target) {
        // Genuinely no conversation to ask in — the only case the old message
        // was ever the right one.
        toast(t('git.askNoChat', { defaultValue: 'Open a conversation first, then try again.' }), 'error');
        return;
      }
      switchTab(target.id);
      insertFileRefWhenReady(body);
    },
    [tabs, activeTabId, switchTab, t],
  );

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

  // Cmd/Ctrl+1..9 tab switching needs switchTab without re-registering the
  // keydown listener on every tab change. Ref indirection keeps the effect's dep
  // array empty (single stable listener) while always reading the current value.
  // The live tab list it reads is `tabsRef`, declared above the pinned restore
  // because that effect needs it too.
  const switchTabRef = useRef(switchTab);
  switchTabRef.current = switchTab;
  // Cmd/Ctrl+W (close the active tab) reads through the same indirection.
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const closeTabRef = useRef(closeTab);
  closeTabRef.current = closeTab;
  // Cmd/Ctrl+T (open a new tab) reads through the same indirection.
  const handleNewTabRef = useRef(handleNewTab);
  handleNewTabRef.current = handleNewTab;

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
      // Cmd/Ctrl+T → open a NEW tab, the mirror of the Cmd/Ctrl+W above and the
      // same gesture a browser answers with. It reaches this handler for the
      // same reason: the Electron application menu (electron/menu-template.ts)
      // binds no accelerator to it, so nothing upstream swallows the key. The
      // modifier guard at the top of this listener already accepts either
      // modifier, so Ctrl+T is the Windows and Linux half at no extra cost —
      // and the `+` button's tooltip names whichever one this platform uses.
      if (e.key === 't') {
        e.preventDefault();
        handleNewTabRef.current();
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
          filesOpen={rightPanel === 'files'}
          // Clicking the panel that is already showing closes the dock; clicking
          // the other one SWAPS to it rather than closing first. Two clicks to
          // move between them would be the wrong answer to a button that is
          // right there.
          onToggleFiles={
            initialCwd ? () => setRightPanel((p) => (p === 'files' ? null : 'files')) : undefined
          }
          gitOpen={rightPanel === 'git'}
          onToggleGit={
            initialCwd ? () => setRightPanel((p) => (p === 'git' ? null : 'git')) : undefined
          }
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
                isContinuing={isTabContinuing}
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
                  // LIVE, unlike the flags the menu captured at open time: a
                  // handoff can start and finish while the menu is on screen,
                  // and the item has to disable itself when it does.
                  state={{ ...menu, isContinuing: continuingTabs.has(menu.tabId) }}
                  onClose={() => setMenu(null)}
                  onTogglePin={handleTogglePin}
                  onRename={setRenamingTabId}
                  onToggleNoLearn={handleToggleNoLearn}
                  onContinueInNewTab={handleContinueInNewTab}
                />
              )}
              {/* ── WHERE `sendMessage` GOES WHILE A DOCUMENT TAB IS ACTIVE ──
                  A DECISION, NOT AN ACCIDENT. `ChatContext.setActiveTab` is a
                  last-writer-wins ref that every `chatCtx.sendMessage` /
                  `useAIBridge()` caller resolves through, and only Chat writes
                  it — on the rising edge of its own `isActive`. A markdown tab
                  renders no Chat, so nothing writes it, and the ref keeps
                  pointing at the chat tab the user was last in.

                  THAT IS THE INTENDED BEHAVIOUR AND IT IS DELIBERATE. A document
                  tab is a reference surface, not a conversation; someone who
                  triggers "ask about this" while reading means the conversation
                  they came from, and that conversation is still open, still
                  mounted and one click away — they will see the message land.
                  This is NOT the hazard the selection popup had to close: there
                  the target was a throwaway session that may already have been
                  deleted, so a message could vanish entirely. Here the target is
                  a live tab.

                  The alternative — warn and drop — was rejected because it turns
                  a working affordance into silence for no gain. The markdown
                  branch below therefore touches ChatContext not at all; if a
                  future document-side action ever needs to CHOOSE a chat, it
                  must name one rather than inherit this default. */}
              <div className="flex-1 overflow-hidden relative">
                {tabs.map((tab) => (
                  <div
                    key={tab.id}
                    className={`h-full ${tab.id === activeTabId ? 'block' : 'hidden'}`}
                  >
                    {/* THE ONE PLACE A TAB'S KIND IS DISPATCHED ON. This map used
                        to render <ChatPanel> unconditionally — tabs were chats by
                        construction — and everything else about markdown tabs
                        follows from making that a choice. Both branches stay
                        MOUNTED while hidden, like every tab here, so a document
                        keeps its scroll and its outline while the user works in
                        the conversation next to it. That is the point of the
                        promotion; re-fetching the file on every switch would be a
                        modal with extra steps. */}
                    {isDiffTab(tab) ? (
                      <DiffDocument
                        cwd={tab.cwd ?? initialCwd ?? ''}
                        path={tab.diffPath}
                        staged={tab.diffStaged}
                        commit={tab.diffCommit}
                        onAsk={handleAskNaby}
                      />
                    ) : isMarkdownTab(tab) ? (
                      <MarkdownDocument
                        // No `onOpenInTab`: it IS the tab. The modal's promote
                        // control is the entry point, and offering it here would
                        // be a button that re-opens what you are looking at.
                        cwd={tab.cwd || initialCwd || ''}
                        rel={tab.rel || ''}
                      />
                    ) : (
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
                    )}
                  </div>
                ))}
              </div>
            </div>
          </PanelPortalProvider>
        </div>
      </div>

      {/* The right-side dock (VSCode-style). Sibling of the chat column so it is
          stable across chat-tab switches; only mounted while a panel is showing
          and a project cwd exists.

          THE DIVIDER IS SHARED, and so is the stored width: the dock is one
          space that two panels take turns in, and a width that reset on every
          swap would read as the app forgetting how wide you like it. */}
      {initialCwd && rightPanel !== null && (
        <>
          {/* `side="right"` because the panel it sizes is on the right of the
              handle: dragging LEFT makes it wider. */}
          <ResizeHandle
            width={filesWidth}
            min={FILES_MIN_WIDTH}
            max={FILES_MAX_WIDTH}
            side="right"
            onResize={handleFilesResize}
            onResizeEnd={handleFilesResizeEnd}
            label={t('workspace.resizeFiles')}
          />
          {rightPanel === 'files' ? (
            <FileBrowserPanel
              cwd={initialCwd}
              onClose={() => setRightPanel(null)}
              width={filesWidth}
              resizing={isResizingFiles}
              onOpenInTab={handleOpenDocumentInTab}
            />
          ) : (
            <GitPanel
              cwd={initialCwd}
              onClose={() => setRightPanel(null)}
              width={filesWidth}
              resizing={isResizingFiles}
              onOpenDiff={handleOpenDiff}
              onAsk={handleAskNaby}
            />
          )}
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
