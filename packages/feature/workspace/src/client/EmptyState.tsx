'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import {
  loadSessionProjects,
  loadSessionsByProject,
  pickFolder,
  createProject,
} from './effect/workspaceClient';

interface SessionInfo {
  path: string;
  title: string;
  modifiedAt: string;
  firstMessages: string[];
  lastMessages: string[];
}

/** One row of the machine-wide session scan — used ONLY as metadata for a
 *  project the user has already added (session count + the encoded path the
 *  sessions API is keyed by). It no longer decides what the list contains. */
interface ScannedProject {
  name: string;
  fullPath: string;
  encodedPath: string;
  sessionCount: number;
}

interface ProjectState {
  isExpanded: boolean;
  isLoading: boolean;
  sessions: SessionInfo[];
  error: string | null;
}

/** A project the user has opened in this app. Persisted in ~/.cockpit/projects.json. */
export interface RecentProject {
  cwd: string;
  lastOpenedAt?: number;
}

interface EmptyStateProps {
  /** Open a project at a specific past session (a row's session list). */
  onSelectSession: (cwd: string, sessionId: string) => void;
  /**
   * The projects the user has opened in this app, newest-added last. THE LIST
   * IS THIS AND NOTHING ELSE — the home screen used to render every directory
   * found under ~/.claude/projects, which is a scan of the user's disk rather
   * than a list of their projects.
   */
  recents: RecentProject[];
  /** Open a project by path (a row's main button, Open, Create). */
  onOpenProject: (cwd: string) => void;
  /** Drop a project from the recents list. Touches no files. */
  onRemoveRecent: (cwd: string) => void;
}

/**
 * Mirrors `encodePath` in @cockpit/shared-utils, which cannot be imported here:
 * that module resolves `os.homedir()` at load time and would drag the server
 * path helpers into the browser bundle. Only used as a FALLBACK — a project
 * that has sessions is matched against the scan by its real path first, so
 * this only has to be right for projects with no session history at all
 * (where it produces an empty list, which is the correct answer anyway).
 */
function encodeProjectPath(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

function projectName(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

export function EmptyState({
  onSelectSession,
  recents,
  onOpenProject,
  onRemoveRecent,
}: EmptyStateProps) {
  const { t } = useTranslation();
  const [scanned, setScanned] = useState<ScannedProject[]>([]);
  const [projectStates, setProjectStates] = useState<Record<string, ProjectState>>({});
  const [searchKeyword, setSearchKeyword] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // "Open" / "Create" state.
  const [isPicking, setIsPicking] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  // Session metadata for the projects already in the list. Failure is silent
  // on purpose: it costs a session count, never a row — a user must still see
  // and be able to open the projects they added if the scan is unavailable.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const exit = await BrowserRuntime.runPromiseExit(loadSessionProjects<ScannedProject>());
      if (!cancelled && exit._tag === 'Success') {
        setScanned(exit.value as ScannedProject[]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => searchInputRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, []);

  const metaByPath = useMemo(() => {
    const map = new Map<string, ScannedProject>();
    for (const p of scanned) map.set(p.fullPath, p);
    return map;
  }, [scanned]);

  // Most-recent-first. Entries written before `lastOpenedAt` existed sort last
  // rather than disappearing.
  const rows = useMemo(() => {
    const keyword = searchKeyword.toLowerCase();
    return recents
      .filter((r) => r.cwd.toLowerCase().includes(keyword))
      .map((r) => {
        const meta = metaByPath.get(r.cwd);
        return {
          cwd: r.cwd,
          lastOpenedAt: r.lastOpenedAt ?? 0,
          name: projectName(r.cwd),
          encodedPath: meta?.encodedPath ?? encodeProjectPath(r.cwd),
          sessionCount: meta?.sessionCount ?? 0,
        };
      })
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  }, [recents, metaByPath, searchKeyword]);

  const loadProjectSessions = useCallback(async (encodedPath: string) => {
    setProjectStates((prev) => ({
      ...prev,
      [encodedPath]: {
        ...prev[encodedPath],
        isExpanded: true,
        isLoading: true,
        sessions: [],
        error: null,
      },
    }));

    const exit = await BrowserRuntime.runPromiseExit(loadSessionsByProject<SessionInfo>(encodedPath));
    setProjectStates((prev) => ({
      ...prev,
      [encodedPath]:
        exit._tag === 'Success'
          ? { ...prev[encodedPath], isLoading: false, sessions: exit.value as SessionInfo[] }
          : { ...prev[encodedPath], isLoading: false, error: 'Failed to load sessions' },
    }));
  }, []);

  const toggleProject = useCallback(
    (encodedPath: string) => {
      const currentState = projectStates[encodedPath];
      if (currentState?.isExpanded) {
        setProjectStates((prev) => ({
          ...prev,
          [encodedPath]: { ...prev[encodedPath], isExpanded: false },
        }));
      } else if (!currentState?.sessions?.length) {
        void loadProjectSessions(encodedPath);
      } else {
        setProjectStates((prev) => ({
          ...prev,
          [encodedPath]: { ...prev[encodedPath], isExpanded: true },
        }));
      }
    },
    [projectStates, loadProjectSessions],
  );

  const handleSessionClick = (cwd: string, sessionPath: string) => {
    const fileName = sessionPath.split('/').pop() || '';
    onSelectSession(cwd, fileName.replace('.jsonl', ''));
  };

  // "Open" — the OS folder picker, the same path the sidebar's project browser
  // uses (/api/pick-folder). Adding a project is deliberate; this is the only
  // way a project enters the list besides Create.
  const handleOpen = useCallback(async () => {
    if (isPicking) return;
    setIsPicking(true);
    const exit = await BrowserRuntime.runPromiseExit(pickFolder());
    setIsPicking(false);
    if (exit._tag === 'Success' && exit.value.folder) {
      onOpenProject(exit.value.folder);
    }
  }, [isPicking, onOpenProject]);

  // "Create" — name the folder here, pick where it goes in the native dialog,
  // and the server makes exactly that one directory. A button that only
  // reopened the picker would be Open wearing a different label.
  const handleCreate = useCallback(async () => {
    const name = createName.trim();
    if (isCreating || !name) return;
    setCreateError(null);
    setIsCreating(true);
    const picked = await BrowserRuntime.runPromiseExit(pickFolder());
    if (picked._tag !== 'Success' || !picked.value.folder) {
      setIsCreating(false);
      return; // cancelled — not an error
    }
    const created = await BrowserRuntime.runPromiseExit(createProject(picked.value.folder, name));
    setIsCreating(false);
    if (created._tag !== 'Success') {
      setCreateError(t('workspace.createProjectFailed'));
      return;
    }
    const result = created.value;
    if (!result.ok) {
      setCreateError(
        result.reason === 'exists'
          ? t('workspace.createProjectFailedExists')
          : result.reason === 'invalid-name'
            ? t('workspace.createProjectFailedName')
            : t('workspace.createProjectFailed'),
      );
      return;
    }
    setCreateOpen(false);
    setCreateName('');
    onOpenProject(result.path);
  }, [createName, isCreating, onOpenProject, t]);

  const formatDate = (isoString: string) => {
    const date = new Date(isoString);
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatOpened = (ms: number) =>
    ms > 0
      ? t('workspace.lastOpened', {
          when: new Date(ms).toLocaleString(undefined, {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          }),
        })
      : t('workspace.lastOpenedNever');

  // The two ways in. Rendered in the header when there are projects and inside
  // the empty-state hero when there are none — never both at once, so each
  // affordance has exactly one node on screen.
  const openButton = (large: boolean) => (
    <button
      data-testid="home-open-project"
      onClick={() => void handleOpen()}
      disabled={isPicking}
      className={`flex items-center gap-2 rounded-lg border border-border text-foreground hover:bg-accent transition-colors disabled:opacity-50 ${
        large ? 'px-4 py-2 text-sm' : 'px-3 py-1.5 text-xs'
      }`}
      title={t('workspace.openProject')}
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
      </svg>
      {t('workspace.openProject')}
    </button>
  );

  const createButton = (large: boolean) => (
    <button
      data-testid="home-create-project"
      onClick={() => {
        setCreateError(null);
        setCreateOpen((v) => !v);
      }}
      className={`flex items-center gap-2 rounded-lg border border-border text-foreground hover:bg-accent transition-colors ${
        large ? 'px-4 py-2 text-sm' : 'px-3 py-1.5 text-xs'
      }`}
      title={t('workspace.createProject')}
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m3-3H9m-4 7h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
      </svg>
      {t('workspace.createProject')}
    </button>
  );

  const createForm = (
    <div data-testid="home-create-form" className="flex flex-wrap items-center gap-2">
      <input
        autoFocus
        data-testid="home-create-name"
        type="text"
        value={createName}
        placeholder={t('workspace.createProjectName')}
        onChange={(e) => setCreateName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void handleCreate();
          if (e.key === 'Escape') setCreateOpen(false);
        }}
        className="px-3 py-1.5 text-sm border border-border rounded-lg bg-card text-foreground placeholder-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      />
      <button
        data-testid="home-create-confirm"
        onClick={() => void handleCreate()}
        disabled={isCreating || createName.trim().length === 0}
        className="px-3 py-1.5 text-sm rounded-lg bg-brand text-white hover:opacity-90 transition disabled:opacity-50"
      >
        {t('workspace.createProjectChooseLocation')}
      </button>
      <button
        onClick={() => {
          setCreateOpen(false);
          setCreateError(null);
        }}
        className="px-3 py-1.5 text-sm rounded-lg text-muted-foreground hover:text-foreground transition"
      >
        {t('workspace.createProjectCancel')}
      </button>
      {createError && (
        <span data-testid="home-create-error" className="text-xs text-red-500">
          {createError}
        </span>
      )}
    </div>
  );

  return (
    // `data-testid` marks THE HOME SCREEN. This component is both the
    // first-launch view and the destination of "close the last tab", and the UI
    // spike asserts against a stable hook rather than a translated heading —
    // which would make the assertion fail the moment someone switches locale.
    // `min-h-0` is load-bearing, not tidying. A flex item defaults to
    // `min-height: auto`, so without it this grows to fit the project list
    // instead of being clipped by the parent — and the `flex-1 overflow-y-auto`
    // content area below then has no bounded height to scroll within, so the
    // whole list overflows the viewport and nothing scrolls at all.
    <div className="flex-1 min-h-0 flex flex-col bg-card" data-testid="home-screen">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-border">
        <h2 className="text-lg font-medium text-foreground whitespace-nowrap">
          {t('workspace.selectProject')}
        </h2>
        {recents.length > 0 && (
          <div className="flex items-center gap-2">
            <input
              ref={searchInputRef}
              type="text"
              placeholder={t('workspace.searchProjectPath')}
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.target.value)}
              className="px-3 py-1.5 text-sm border border-border rounded-lg bg-card text-foreground placeholder-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
            />
            {openButton(false)}
            {createButton(false)}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {recents.length > 0 && createOpen && <div className="mb-4">{createForm}</div>}

        {/* Empty recents. NOT a blank panel: it says what this list is and
            offers both ways to put something in it. */}
        {recents.length === 0 && (
          <div
            data-testid="home-empty-recents"
            className="flex flex-col items-center justify-center text-center gap-4 py-16"
          >
            <svg className="w-12 h-12 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            <div className="text-base font-medium text-foreground">
              {t('workspace.noRecentProjects')}
            </div>
            <div className="max-w-md text-sm text-muted-foreground">
              {t('workspace.noRecentProjectsHint')}
            </div>
            <div className="flex items-center gap-3">
              {openButton(true)}
              {createButton(true)}
            </div>
            {createOpen && createForm}
          </div>
        )}

        {recents.length > 0 && (
          <div className="space-y-2">
            {rows.map((row) => {
              const state =
                projectStates[row.encodedPath] ||
                { isExpanded: false, isLoading: false, sessions: [], error: null };

              return (
                <div
                  key={row.cwd}
                  data-testid="recent-project"
                  data-cwd={row.cwd}
                  className="group border border-border rounded-lg overflow-hidden"
                >
                  {/* Row header: open (primary), expand sessions, remove. Three
                      separate controls — a nested button is invalid HTML and
                      the × must never be reachable by "click the project". */}
                  <div className="flex items-center gap-1 pr-2 hover:bg-accent transition-colors">
                    <button
                      data-testid="recent-expand"
                      data-cwd={row.cwd}
                      onClick={() => toggleProject(row.encodedPath)}
                      className="p-3 text-muted-foreground hover:text-foreground transition-colors"
                      title={t('workspace.sessions', { count: row.sessionCount })}
                      aria-expanded={state.isExpanded}
                    >
                      <svg
                        className={`w-4 h-4 transition-transform ${state.isExpanded ? 'rotate-90' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </button>

                    <button
                      data-testid="recent-open"
                      data-cwd={row.cwd}
                      onClick={() => onOpenProject(row.cwd)}
                      className="flex-1 min-w-0 flex items-center gap-3 py-3 text-left"
                    >
                      <svg className="w-5 h-5 text-brand flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                      </svg>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-foreground truncate">{row.name}</div>
                        <div className="text-xs text-muted-foreground truncate">{row.cwd}</div>
                      </div>
                    </button>

                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {formatOpened(row.lastOpenedAt)}
                    </span>
                    <span className="text-xs text-muted-foreground bg-secondary px-2 py-0.5 rounded whitespace-nowrap">
                      {t('workspace.sessions', { count: row.sessionCount })}
                    </span>

                    {/* × — removes the project FROM THIS LIST. The tooltip says
                        so in words, because "remove" next to a folder path is
                        exactly the kind of button people fear. */}
                    <button
                      data-testid="recent-remove"
                      data-cwd={row.cwd}
                      onClick={() => onRemoveRecent(row.cwd)}
                      title={t('workspace.removeFromList')}
                      aria-label={t('workspace.removeFromList')}
                      className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>

                  {/* Past sessions for this project — still read from the
                      session history on disk, which removal never touches. */}
                  {state.isExpanded && (
                    <div className="border-t border-border bg-secondary/30">
                      {state.isLoading && (
                        <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                          <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                          <span>{t('workspace.loadingSessions')}</span>
                        </div>
                      )}

                      {state.error && <div className="p-3 text-xs text-red-500">{state.error}</div>}

                      {!state.isLoading && !state.error && state.sessions.length === 0 && (
                        <div className="p-3 text-xs text-muted-foreground">{t('workspace.noSessions')}</div>
                      )}

                      {!state.isLoading &&
                        !state.error &&
                        state.sessions.map((session) => (
                          <button
                            key={session.path}
                            data-testid="recent-session"
                            onClick={() => handleSessionClick(row.cwd, session.path)}
                            className="w-full flex items-start gap-3 p-3 hover:bg-accent transition-colors text-left border-t border-border first:border-t-0"
                          >
                            <svg className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                            </svg>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm text-foreground truncate">{session.title}</div>
                              <div className="text-xs text-muted-foreground mt-0.5">
                                {formatDate(session.modifiedAt)}
                              </div>
                              {session.firstMessages.length > 0 && (
                                <div className="text-xs text-muted-foreground mt-1 truncate">
                                  {session.firstMessages[0]}
                                </div>
                              )}
                            </div>
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Said once, plainly, next to the list it applies to. */}
            <div data-testid="recents-removal-note" className="pt-2 text-xs text-muted-foreground">
              {t('workspace.recentsRemovalNote')}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
