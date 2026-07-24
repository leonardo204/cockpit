'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ProjectSidebar, ProjectInfo } from './ProjectSidebar';
import { EmptyState } from './EmptyState';
import { SessionBrowser } from './SessionBrowser';
import { SettingsModal } from './SettingsModal';
// F1-06. Renders itself only when the desktop app has no provider key yet;
// returns null in every other case (including the browser dev server).
import { NabyOnboardingWizard } from './NabyProviderSetup';
import { TokenStatsModal } from '@cockpit/feature-agent';
import { NoteModal } from './NoteModal';
import { SessionCompleteToastContainer, showSessionCompleteToast } from '@cockpit/feature-agent';
import { APP_TITLE, appTitleForCwd } from '@cockpit/shared-utils';
import { useEffectQuery } from '@cockpit/effect-react';
import { fetchProjects, saveProjects as saveProjectsEffect } from './effect/projectClient';

interface ProjectsData {
  projects: ProjectInfo[];
  activeIndex: number;
  collapsed: boolean;
}

/**
 * Stamp "the user opened this just now" on one project.
 *
 * THIS LIST IS THE RECENTS LIST. `~/.cockpit/projects.json` already records the
 * projects the user opened in this app and already survives a restart, so the
 * home screen reads it rather than a second store that could disagree with it.
 * The only thing recents needed on top was an ordering key, which is this.
 *
 * Returns a NEW array only when something changed, so the many call sites that
 * pass the result straight to `saveProjects` do not churn state needlessly.
 */
function touchOpened(projects: ProjectInfo[], cwd: string): ProjectInfo[] {
  const now = Date.now();
  let changed = false;
  const next = projects.map((p) => {
    if (p.cwd !== cwd) return p;
    changed = true;
    return { ...p, lastOpenedAt: now };
  });
  return changed ? next : projects;
}

/** A project entering the list is, by definition, being opened now. */
function newProject(cwd: string): ProjectInfo {
  return { cwd, lastOpenedAt: Date.now() };
}

interface WorkspaceProps {
  initialCwd?: string;
  initialSessionId?: string;
}

export function Workspace({ initialCwd, initialSessionId }: WorkspaceProps) {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [isSessionBrowserOpen, setIsSessionBrowserOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isTokenStatsOpen, setIsTokenStatsOpen] = useState(false);
  const [isNoteOpen, setIsNoteOpen] = useState(false);
  const [noteProjectCwd, setNoteProjectCwd] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  // THE HOME SCREEN.
  //
  // There is no separate "home" route in this app after the F1-03 trim — the
  // landing view is EmptyState, the session/project browser Workspace already
  // shows when no project is open. So "go home" is that same view, shown on
  // demand rather than only when `projects.length === 0`.
  //
  // It is a VIEW flag, not a mutation: closing your last tab must not silently
  // delete the project from the sidebar. The project stays exactly where it was,
  // its iframe stays mounted (so returning to it is instant and loses no state),
  // and any action that expresses "I want to be in a project again" — picking a
  // session here, clicking a project in the sidebar, a jump from a toast —
  // clears the flag.
  // A COLD LAUNCH lands on home. The Electron window loads `/` with no `cwd`
  // param, so `initialCwd` is undefined on a normal start and set only when
  // deep-linking into a project. Starting `showHome` from `!initialCwd` makes a
  // fresh launch show the recents/home view instead of silently re-entering the
  // last-opened project — a returning user with a non-empty `projects.json` used
  // to boot straight into `activeIndex`, which read as "the app reopened my old
  // session for me." Every open path (`handleSelectProject`, `openProjectByCwd`,
  // `handleAddProject`, `OPEN_PROJECT`) already clears this flag, so picking a
  // recent from home still enters the project; `GO_HOME` still sets it back.
  const [showHome, setShowHome] = useState(!initialCwd);
  // Lazy load: only render project iframes that have been activated before (ever-growing set)
  const [loadedCwds, setLoadedCwds] = useState<Set<string>>(new Set());
  const iframeRefs = useRef<Map<string, HTMLIFrameElement>>(new Map());
  // Initial session (and view intent) for a project, frozen at the moment the project
  // is first added. Read by getProjectUrl to build the iframe src, so the selected
  // sessionId reaches useTabState deterministically via the URL instead of a racy
  // post-onLoad postMessage. Never mutated after birth (mutating it would change the
  // iframe src and force a full reload), so later in-iframe session switches don't touch it.
  const initialSessionIdsRef = useRef<Map<string, { sessionId: string; switchToAgent?: boolean }>>(new Map());
  // Track the current sessionId per project (used for URL updates, not iframe src)
  const projectSessionIdsRef = useRef<Map<string, string>>(new Map());
  // Project index saved before screenshot; restored when screenshot completes
  const preScreenshotIndexRef = useRef<number | null>(null);

  // useEffectQuery interrupts the Fiber on unmount (equivalent to AbortController) and
  // funnels all errors into AppError.
  const projectsQuery = useEffectQuery(fetchProjects, []);

  // Mirror the Effect result into local state; render layer stays in plain React.
  useEffect(() => {
    if (projectsQuery.status === 'success') {
      const data = projectsQuery.data;
      setProjects([...(data.projects || [])]);
      setActiveIndex(data.activeIndex || 0);
      setCollapsed(data.collapsed || false);
      setIsLoaded(true);
    } else if (projectsQuery.status === 'error') {
      console.error('Failed to load projects:', projectsQuery.error);
      setIsLoaded(true);
    }
  }, [projectsQuery]);

  // Save project list — fire-and-forget; failures only logged.
  const saveProjects = useCallback(
    async (
      newProjects: ProjectInfo[],
      newActiveIndex: number,
      newCollapsed: boolean,
    ) => {
      const { Effect } = await import('effect');
      const { BrowserRuntime } = await import('@cockpit/effect-runtime');
      const exit = await BrowserRuntime.runPromise(
        saveProjectsEffect({
          projects: newProjects,
          activeIndex: newActiveIndex,
          collapsed: newCollapsed,
        }).pipe(Effect.either)
      );
      if (exit._tag === 'Left') {
        console.error('Failed to save projects:', exit.left);
      }
    },
    []
  );

  // When activeIndex changes, add the corresponding project to the loaded set
  useEffect(() => {
    const cwd = projects[activeIndex]?.cwd;
    if (cwd) {
      setLoadedCwds(prev => prev.has(cwd) ? prev : new Set(prev).add(cwd));
    }
  }, [activeIndex, projects]);

  // Notify iframes of visibility changes (hidden iframes pause WebSocket and other resource-intensive operations)
  useEffect(() => {
    for (const [cwd, iframe] of iframeRefs.current.entries()) {
      const isActive = projects[activeIndex]?.cwd === cwd;
      iframe.contentWindow?.postMessage(
        { type: 'IFRAME_VISIBILITY', visible: isActive },
        '*'
      );
    }
  }, [activeIndex, projects]);

  // (Initial load moved to useEffectQuery + sync useEffect above)

  // Utility function to update the browser address bar URL
  const updateUrl = useCallback((cwd: string, sessionId?: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set('cwd', cwd);
    if (sessionId) {
      url.searchParams.set('sessionId', sessionId);
    } else {
      url.searchParams.delete('sessionId');
    }
    window.history.replaceState({}, '', url.toString());

    // Update the window title. The PRODUCT NAME leads (this app is Naby, not
    // the upstream it forked from); the working directory follows, because
    // "which project is this window" is the thing a user with several windows
    // actually needs from a title bar.
    document.title = appTitleForCwd(cwd);
  }, []);

  // Handle cwd and sessionId from URL parameters
  const hasHandledInitialRef = useRef(false);
  useEffect(() => {
    if (!isLoaded || hasHandledInitialRef.current || !initialCwd) return;
    hasHandledInitialRef.current = true;

    // If initialSessionId is provided, freeze it for the iframe URL and track it
    if (initialSessionId) {
      initialSessionIdsRef.current.set(initialCwd, { sessionId: initialSessionId });
      projectSessionIdsRef.current.set(initialCwd, initialSessionId);
    }

    // Check if the project already exists
    const existingIndex = projects.findIndex(p => p.cwd === initialCwd);

    if (existingIndex >= 0) {
      // Project already exists, switch to it
      const touched = touchOpened(projects, initialCwd);
      setProjects(touched);
      setActiveIndex(existingIndex);
      saveProjects(touched, existingIndex, collapsed);
    } else {
      // New project, add to list
      const newProjects = [...projects, newProject(initialCwd)];
      const newActiveIndex = newProjects.length - 1;
      setProjects(newProjects);
      setActiveIndex(newActiveIndex);
      saveProjects(newProjects, newActiveIndex, collapsed);
    }

    // Update URL
    updateUrl(initialCwd, initialSessionId);
  }, [isLoaded, initialCwd, initialSessionId, projects, activeIndex, collapsed, saveProjects, updateUrl]);

  // Listen for messages from iframes
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Session ID change notification (tab switch inside iframe)
      if (event.data?.type === 'SESSION_CHANGE' && event.data?.cwd && event.data?.sessionId) {
        const { cwd, sessionId } = event.data;
        // Record the current sessionId for this project
        projectSessionIdsRef.current.set(cwd, sessionId);
        // If this is the currently active project, update the URL
        const currentProject = projects[activeIndex];
        if (currentProject?.cwd === cwd) {
          updateUrl(cwd, sessionId);
        }
      }
      // Session complete notification (posted directly via postMessage when Chat completes, bypasses state.json watch)
      if (event.data?.type === 'SESSION_COMPLETE' && event.data?.cwd && event.data?.sessionId) {
        const { cwd, sessionId, lastUserMessage } = event.data;
        // Only show toast for projects other than the currently visible one (the user can already see the completion state for the active project)
        const currentProject = projects[activeIndex];
        if (currentProject?.cwd !== cwd) {
          const projectName = cwd.split('/').pop() || cwd;
          showSessionCompleteToast({ projectName, message: lastUserMessage, cwd, sessionId });
        }
      }
      // Open token stats
      if (event.data?.type === 'OPEN_TOKEN_STATS') {
        setIsTokenStatsOpen(true);
      }
      // Open the app Settings modal — asked for from inside a project iframe
      // (the engine switcher's "Manage in Settings", the chat header gear). The
      // modal itself is this parent window's, so the iframe can only request it.
      if (event.data?.type === 'OPEN_SETTINGS') {
        setIsSettingsOpen(true);
      }
      // Open project notes
      if (event.data?.type === 'OPEN_NOTE' && event.data?.cwd) {
        const cwd = event.data.cwd;
        setNoteProjectCwd(cwd);
        setIsNoteOpen(true);
      }
      // Screenshot preparation: save current project index, switch to target project
      if (event.data?.type === 'SCREENSHOT_PREPARE' && event.data?.cwd) {
        preScreenshotIndexRef.current = activeIndex;
        // Reuse OPEN_PROJECT logic to switch projects
        const cwd = event.data.cwd;
        const existingIndex = projects.findIndex(p => p.cwd === cwd);
        if (existingIndex >= 0 && existingIndex !== activeIndex) {
          setActiveIndex(existingIndex);
        }
        return;
      }
      // Screenshot complete: restore the previous project
      if (event.data?.type === 'SCREENSHOT_DONE') {
        if (preScreenshotIndexRef.current !== null && preScreenshotIndexRef.current !== activeIndex) {
          setActiveIndex(preScreenshotIndexRef.current);
        }
        preScreenshotIndexRef.current = null;
        return;
      }
      // The last tab inside a project was closed → show the home screen.
      // Guarded on the sender being the project currently on screen: a
      // background project tidying itself up must not yank the user out of the
      // one they are working in.
      if (event.data?.type === 'GO_HOME' && event.data?.cwd) {
        if (projects[activeIndex]?.cwd === event.data.cwd) {
          setShowHome(true);
          // The title still names the project we just left; on the home screen
          // that is simply wrong. The project itself is untouched — only the
          // label follows the view.
          document.title = APP_TITLE;
        }
        return;
      }
      // Request from inside an iframe to open or switch a project (worktree switch, session open, etc.)
      if (event.data?.type === 'OPEN_PROJECT' && event.data?.cwd) {
        const { cwd, sessionId } = event.data;
        const targetSessionId = sessionId || '';
        // Opening a project is the clearest possible "I am not on the home
        // screen any more".
        setShowHome(false);
        projectSessionIdsRef.current.set(cwd, targetSessionId);

        const existingIndex = projects.findIndex(p => p.cwd === cwd);
        if (existingIndex >= 0) {
          // Project already exists, switch to its iframe
          if (targetSessionId) {
            const iframe = iframeRefs.current.get(cwd);
            if (iframe?.contentWindow) {
              iframe.contentWindow.postMessage({ type: 'SWITCH_SESSION', sessionId: targetSessionId }, '*');
            } else {
              // Project is in the list but its iframe was never mounted (lazy load):
              // postMessage would hit nothing and the first mount would default to the
              // most recent session. Freeze the sessionId for the URL so getProjectUrl
              // carries it on mount via the deterministic initialSessionId path.
              initialSessionIdsRef.current.set(cwd, { sessionId: targetSessionId });
            }
          }
          const touched = touchOpened(projects, cwd);
          setProjects(touched);
          if (existingIndex !== activeIndex) {
            setActiveIndex(existingIndex);
          }
          saveProjects(touched, existingIndex, collapsed);
        } else {
          // New project, add to list
          const newProjects = [...projects, newProject(cwd)];
          const newActiveIndex = newProjects.length - 1;
          setProjects(newProjects);
          setActiveIndex(newActiveIndex);
          saveProjects(newProjects, newActiveIndex, collapsed);
          if (targetSessionId) {
            initialSessionIdsRef.current.set(cwd, { sessionId: targetSessionId });
          }
        }
        updateUrl(cwd, targetSessionId);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [projects, activeIndex, collapsed, updateUrl, saveProjects]);

  // Parent-window keyboard safety net.
  // iframes don't bubble keydown to the parent window, so the per-panel
  // listeners inside TabManager / FileBrowserModal don't run when focus is in
  // the left ProjectSidebar or one of the parent-window modals
  // (SessionBrowser / SettingsModal / NoteModal / TokenStatsModal).
  // Without this, Cmd+P pops the browser print dialog, Cmd+S triggers "Save
  // Page As...", Cmd+F shows the native find bar, etc. We swallow them at the
  // parent root as a no-op; any parent-window component that wants to react
  // to these keys can still register its own listener and run alongside.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      // Cmd/Ctrl + P / F / S (no Shift) — block browser defaults.
      if (!e.shiftKey && (e.key === 'p' || e.key === 'f' || e.key === 's')) {
        e.preventDefault();
        return;
      }
      // Ctrl+- / Ctrl+Shift+- — keep parity with the in-iframe behavior
      // (intercepted everywhere; no action at the parent level).
      if (e.ctrlKey && !e.metaKey && e.code === 'Minus') {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Select project
  const handleSelectProject = useCallback((index: number) => {
    setShowHome(false);
    setActiveIndex(index);
    const selectedCwd = projects[index]?.cwd;
    const touched = selectedCwd ? touchOpened(projects, selectedCwd) : projects;
    setProjects(touched);
    saveProjects(touched, index, collapsed);
    const selectedProject = projects[index];
    if (selectedProject?.cwd) {
      // Update URL (using the tracked sessionId)
      const sessionId = projectSessionIdsRef.current.get(selectedProject.cwd);
      updateUrl(selectedProject.cwd, sessionId);
    }
  }, [projects, collapsed, saveProjects, updateUrl]);

  // Remove project
  const handleRemoveProject = useCallback((index: number) => {
    const removed = projects[index];
    const newProjects = projects.filter((_, i) => i !== index);
    let newActiveIndex = activeIndex;

    // Adjust activeIndex
    if (index < activeIndex) {
      newActiveIndex = activeIndex - 1;
    } else if (index === activeIndex && newActiveIndex >= newProjects.length) {
      newActiveIndex = Math.max(0, newProjects.length - 1);
    }

    setProjects(newProjects);
    setActiveIndex(newActiveIndex);
    saveProjects(newProjects, newActiveIndex, collapsed);

    // Removing a project also discards its session history — otherwise the
    // sessions linger as ghosts in the session browsers. Fire-and-forget and
    // idempotent server-side, so a project that never had a state file is fine.
    if (removed?.cwd) {
      void (async () => {
        const [{ BrowserRuntime }, { deleteProjectState }] = await Promise.all([
          import('@cockpit/effect-runtime'),
          import('./effect/stateClient'),
        ]);
        const { Effect } = await import('effect');
        await BrowserRuntime.runPromise(
          deleteProjectState(removed.cwd).pipe(Effect.catchAll(() => Effect.void))
        );
      })();
    }
  }, [projects, activeIndex, collapsed, saveProjects]);

  // Open a project by path — the shared body behind every "add/open this
  // folder" affordance (sidebar project browser, home screen Open/Create, a
  // recents row). One implementation, so they cannot drift on the thing that
  // now matters: an opened project is recorded as opened.
  const openProjectByCwd = useCallback((cwd: string) => {
    setShowHome(false);
    const existingIndex = projects.findIndex(p => p.cwd === cwd);
    if (existingIndex >= 0) {
      const touched = touchOpened(projects, cwd);
      setProjects(touched);
      setActiveIndex(existingIndex);
      saveProjects(touched, existingIndex, collapsed);
    } else {
      const newProjects = [...projects, newProject(cwd)];
      const newActiveIndex = newProjects.length - 1;
      setProjects(newProjects);
      setActiveIndex(newActiveIndex);
      saveProjects(newProjects, newActiveIndex, collapsed);
    }
    updateUrl(cwd, projectSessionIdsRef.current.get(cwd));
  }, [projects, collapsed, saveProjects, updateUrl]);

  /** Pick a folder and open it — the one way a project is added, shared by the
   *  home screen's "Open" and the sidebar's "Open Project" so the two cannot
   *  drift apart. */
  const handlePickAndOpenProject = useCallback(async () => {
    // Dynamic imports to match how this file already reaches the Effect runtime
    // (see the handler above) and to keep the picker out of the initial bundle.
    const [{ BrowserRuntime }, { pickFolder }] = await Promise.all([
      import('@cockpit/effect-runtime'),
      import('./effect/workspaceClient'),
    ]);
    const exit = await BrowserRuntime.runPromiseExit(pickFolder());
    if (exit._tag === 'Success' && exit.value.folder) {
      openProjectByCwd(exit.value.folder);
    }
  }, [openProjectByCwd]);


  // Remove a project FROM THE LIST, addressed by path — what the home screen's
  // × does. Deliberately the same code path as the sidebar's remove: one list,
  // one removal. It rewrites ~/.cockpit/projects.json and NOTHING else — the
  // directory and its session transcripts (~/.claude/projects/…) are untouched,
  // so reopening the project brings its history back with it.
  const handleRemoveRecent = useCallback((cwd: string) => {
    const index = projects.findIndex(p => p.cwd === cwd);
    if (index >= 0) handleRemoveProject(index);
  }, [projects, handleRemoveProject]);

  // Reorder projects
  const handleReorderProjects = useCallback((newProjects: ProjectInfo[]) => {
    // Find the position of the currently active project in the new array
    const currentProject = projects[activeIndex];
    const newActiveIndex = newProjects.findIndex(p => p.cwd === currentProject?.cwd);

    setProjects(newProjects);
    setActiveIndex(newActiveIndex >= 0 ? newActiveIndex : 0);
    saveProjects(newProjects, newActiveIndex >= 0 ? newActiveIndex : 0, collapsed);
  }, [projects, activeIndex, collapsed, saveProjects]);

  // Toggle collapse
  const handleToggleCollapse = useCallback(() => {
    const newCollapsed = !collapsed;
    setCollapsed(newCollapsed);
    saveProjects(projects, activeIndex, newCollapsed);
  }, [projects, activeIndex, collapsed, saveProjects]);

  // Add project (selected from SessionBrowser or EmptyState)
  const handleAddProject = useCallback((cwd: string, sessionId: string) => {
    // Picking a session on the home screen is how the user leaves it.
    setShowHome(false);
    // Track sessionId
    projectSessionIdsRef.current.set(cwd, sessionId);

    // Check if the project already exists
    const existingIndex = projects.findIndex(p => p.cwd === cwd);

    if (existingIndex >= 0) {
      // Already exists, notify iframe to switch session
      const iframe = iframeRefs.current.get(cwd);
      if (iframe?.contentWindow) {
        iframe.contentWindow.postMessage({
          type: 'SWITCH_SESSION',
          sessionId,
          switchToAgent: true,
        }, '*');
      } else {
        // Project is in the list but its iframe was never mounted (lazy load):
        // freeze the sessionId (+ agent view intent) for the iframe URL so the
        // first mount opens the requested session instead of the most recent one.
        initialSessionIdsRef.current.set(cwd, { sessionId, switchToAgent: true });
      }
      const touched = touchOpened(projects, cwd);
      setProjects(touched);
      setActiveIndex(existingIndex);
      saveProjects(touched, existingIndex, collapsed);
    } else {
      // New project, append to list
      const newProjects = [...projects, newProject(cwd)];
      const newActiveIndex = newProjects.length - 1;
      setProjects(newProjects);
      setActiveIndex(newActiveIndex);
      saveProjects(newProjects, newActiveIndex, collapsed);
      // Freeze the selected sessionId (+ agent view intent) for the iframe URL
      initialSessionIdsRef.current.set(cwd, { sessionId, switchToAgent: true });
    }

    // Update URL
    updateUrl(cwd, sessionId);
    // Close SessionBrowser
    setIsSessionBrowserOpen(false);
  }, [projects, collapsed, saveProjects, updateUrl]);

  // Switch project/session (called from GlobalSessionMonitor)
  const handleSwitchProject = useCallback((cwd: string, sessionId: string) => {
    // Projectless (legacy) recent session: it has no directory to host a chat,
    // so there is no project iframe to switch to. Opening one anyway would push
    // a phantom empty-cwd entry into projects.json and render a broken blank
    // project + iframe. Handle the no-cwd case gracefully — do nothing harmful.
    // The session still lives in the store and stays listed/searchable in the
    // recent panel; it just can't be re-hosted without a working directory.
    if (!cwd) {
      console.warn('Cannot open a projectless session (no cwd):', sessionId);
      return;
    }
    // A jump from a completion toast or the global session monitor means the
    // user asked to be somewhere specific — never leave them on the home view.
    setShowHome(false);
    // Track sessionId
    projectSessionIdsRef.current.set(cwd, sessionId);

    const existingIndex = projects.findIndex(p => p.cwd === cwd);

    if (existingIndex >= 0) {
      // Project already exists, notify iframe to switch session
      const iframe = iframeRefs.current.get(cwd);
      if (iframe?.contentWindow) {
        iframe.contentWindow.postMessage({
          type: 'SWITCH_SESSION',
          sessionId,
          switchToAgent: true,
        }, '*');
      } else {
        // Project is in the list but its iframe was never mounted (lazy load):
        // freeze the sessionId (+ agent view intent) for the iframe URL so the
        // first mount opens the requested session instead of the most recent one.
        initialSessionIdsRef.current.set(cwd, { sessionId, switchToAgent: true });
      }
      const touched = touchOpened(projects, cwd);
      setProjects(touched);
      if (existingIndex !== activeIndex) {
        setActiveIndex(existingIndex);
      }
      saveProjects(touched, existingIndex, collapsed);
    } else {
      // New project, add to list
      const newProjects = [...projects, newProject(cwd)];
      const newActiveIndex = newProjects.length - 1;
      setProjects(newProjects);
      setActiveIndex(newActiveIndex);
      saveProjects(newProjects, newActiveIndex, collapsed);
      // Freeze the selected sessionId (+ agent view intent) for the iframe URL
      initialSessionIdsRef.current.set(cwd, { sessionId, switchToAgent: true });
    }

    // Update URL
    updateUrl(cwd, sessionId);
  }, [projects, activeIndex, collapsed, saveProjects, updateUrl]);

  // Build iframe URL. For a project opened with a specific session, carry the sessionId
  // in the URL so that useTabState inside the iframe activates it deterministically on
  // mount. The value is read from initialSessionIdsRef, which is frozen at project birth,
  // so the src string is stable across re-renders (in-iframe session switches never change
  // it → no iframe reload).
  //
  // F1-03: the `view=agent` intent parameter is gone — chat is the only panel now, so
  // "jump into a session" needs no view coordination.
  const getProjectUrl = (project: ProjectInfo) => {
    let url = `/project?cwd=${encodeURIComponent(project.cwd)}`;
    const initial = initialSessionIdsRef.current.get(project.cwd);
    if (initial?.sessionId) {
      url += `&sessionId=${encodeURIComponent(initial.sessionId)}`;
    }
    return url;
  };

  // Wait for initial load to complete
  if (!isLoaded) {
    return (
      <div className="h-screen flex items-center justify-center bg-card">
        <div className="flex items-center gap-2 text-muted-foreground">
          <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span>{t('workspace.loadingText')}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex bg-background overflow-hidden">
      {/* Left project list */}
      <ProjectSidebar
        projects={projects}
        activeIndex={activeIndex}
        collapsed={collapsed}
        currentCwd={projects[activeIndex]?.cwd}
        onSelectProject={handleSelectProject}
        onRemoveProject={handleRemoveProject}
        onReorderProjects={handleReorderProjects}
        onToggleCollapse={handleToggleCollapse}
        // The sidebar's "Open Project" now goes straight to the folder picker,
        // matching the home screen. It used to open the session browser — a
        // machine-wide scan of every project on disk, which is exactly the model
        // the recents list replaced. Two buttons with the same label doing
        // different things is worse than either one alone.
        onOpenSessionBrowser={handlePickAndOpenProject}
        // "Browse all sessions" (sidebar footer) opens the machine-wide
        // SessionBrowser modal — the only entry point to it now that the top
        // button is the folder picker.
        onBrowseAllSessions={() => setIsSessionBrowserOpen(true)}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenNote={(cwd) => { setNoteProjectCwd(cwd ?? null); setIsNoteOpen(true); }}
        onSwitchProject={handleSwitchProject}
        onAddProject={openProjectByCwd}
      />

      {/* Right content area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* The home screen. Shown when there is no project to show, and on
            demand when the user closed their last tab (`showHome`). */}
        {(projects.length === 0 || showHome) && (
          // The home screen lists the projects the user has opened IN THIS APP
          // — `projects` — not everything found under ~/.claude/projects. Past
          // sessions per project still come from that history; only the list of
          // projects changed hands.
          <EmptyState
            onSelectSession={handleAddProject}
            recents={projects}
            onOpenProject={openProjectByCwd}
            onRemoveRecent={handleRemoveRecent}
          />
        )}
        {projects.length > 0 && (
          // Project iframe container (lazy load: only render projects that have been activated).
          // HIDDEN rather than unmounted while the home screen is up: unmounting
          // would tear down every project's iframe — websockets, scroll position,
          // in-flight streams and all — and rebuild them on return. Going home is
          // a navigation, not a reset.
          <div className={`flex-1 relative overflow-hidden ${showHome ? 'hidden' : ''}`}>
            {projects.map((project, index) => (
              loadedCwds.has(project.cwd) && (
                <iframe
                  key={project.cwd}
                  ref={(el) => {
                    if (el) {
                      iframeRefs.current.set(project.cwd, el);
                    } else {
                      iframeRefs.current.delete(project.cwd);
                    }
                  }}
                  src={getProjectUrl(project)}
                  className={`absolute inset-0 w-full h-full border-0 ${
                    index === activeIndex ? 'block' : 'hidden'
                  }`}
                  title={`Project: ${project.cwd}`}
                />
              )
            ))}
          </div>
        )}
      </div>

      {/* SessionBrowser Modal */}
      <SessionBrowser
        isOpen={isSessionBrowserOpen}
        onClose={() => setIsSessionBrowserOpen(false)}
        onSelectSession={handleAddProject}
        onAddProject={(cwd) => {
          openProjectByCwd(cwd);
          setIsSessionBrowserOpen(false);
        }}
      />

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        // Active project cwd + its current session, so the Memory section
        // (P15-06) can address `session`/`project`-scoped memory. Read from the
        // ref at render time — the modal only reloads while open, so the value
        // captured when it opens is the right one. `user` scope needs neither.
        cwd={projects[activeIndex]?.cwd}
        sessionId={
          projects[activeIndex]?.cwd
            ? projectSessionIdsRef.current.get(projects[activeIndex].cwd)
            : undefined
        }
      />

      {/* Token Stats Modal */}
      <TokenStatsModal
        isOpen={isTokenStatsOpen}
        onClose={() => setIsTokenStatsOpen(false)}
      />

      {/* Note Modal */}
      <NoteModal
        isOpen={isNoteOpen}
        onClose={() => { setIsNoteOpen(false); setNoteProjectCwd(null); }}
        projectCwd={noteProjectCwd}
        projectName={noteProjectCwd ? noteProjectCwd.split('/').pop() : null}
      />

      {/* Bottom-left session complete notification */}
      <SessionCompleteToastContainer onNavigate={handleSwitchProject} />

      {/* First-run wizard (F1-06). Covers the workspace until a provider key
          exists or the user skips; re-enterable from Settings → AI provider. */}
      <NabyOnboardingWizard />
    </div>
  );
}
