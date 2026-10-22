'use client';

import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ProjectItem } from './ProjectItem';
import {
  GROUP_DRAG_TYPE,
  GroupNameInput,
  PROJECT_DRAG_TYPE,
  ProjectGroupHeader,
  type GroupHeaderDropHint,
} from './ProjectGroupHeader';
import {
  buildSidebarModel,
  createGroup,
  deleteGroup,
  moveProject,
  normalizeGroups,
  renameGroup,
  reorderGroups,
  toggleGroupCollapsed,
  type ProjectDropTarget,
  type ProjectGroup,
} from './projectGroups';
import { ProjectSessionRow } from './ProjectSessionRow';
import { GlobalSessionMonitor, GlobalSession } from '@cockpit/feature-agent';
import { PinnedSessionsPanel } from '@cockpit/feature-agent';
import { ScheduledTasksPanel } from '@cockpit/feature-agent';
import { usePinnedSessions } from '@cockpit/feature-agent';
import { useScheduledTasks } from '@cockpit/feature-agent';
import { withoutRecentSession } from '@cockpit/feature-agent';
import { useWebSocket } from '@cockpit/shared-ui';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import {
  deleteSession,
  loadProjectSessions,
  projectStateAt,
  projectStateChangedCwd,
  sessionIdOf,
  shouldRefetch,
  withExpanded,
  withLoadError,
  withLoading,
  withSessions,
  withoutSession,
  type ProjectSessionTree,
} from './projectSessionTree';
import { projectNameFromCwd } from '@cockpit/shared-utils';

export interface ProjectInfo {
  cwd: string;
  sessionId?: string;
  /** Epoch ms of the last open in this app. Persisted via /api/projects; the
   *  home screen orders its recents list by it. See server/effect/project.ts. */
  lastOpenedAt?: number;
}

/** Width bounds for the resizable sidebar, in px. The minimum is the point below
 *  which project names stop being readable — narrower than this the user wants
 *  the collapsed rail, which is a separate mode. */
export const SIDEBAR_MIN_WIDTH = 160;
export const SIDEBAR_MAX_WIDTH = 480;
/** The width before it was resizable (Tailwind `w-56`), so an install that has
 *  never dragged the divider looks exactly as it did. */
export const SIDEBAR_DEFAULT_WIDTH = 224;
/** The collapsed rail (Tailwind `w-12`). Not resizable — it is an icon strip. */
export const SIDEBAR_COLLAPSED_WIDTH = 48;

interface ProjectSidebarProps {
  projects: ProjectInfo[];
  activeIndex: number;
  collapsed: boolean;
  /** Expanded width in px. Ignored while collapsed. */
  width: number;
  /** True mid-drag: suppresses the width transition so the panel tracks the
   *  pointer instead of easing toward it a beat late. */
  resizing?: boolean;
  currentCwd?: string;
  onSelectProject: (index: number) => void;
  onRemoveProject: (index: number) => void;
  onReorderProjects: (projects: ProjectInfo[]) => void;
  /** User-defined groups (specs/project-groups.md). Absent or empty → the
   *  sidebar renders exactly the flat list it always did. */
  groups?: ReadonlyArray<ProjectGroup>;
  /** Persist a changed group set. Called only when something actually changed. */
  onChangeGroups?: (groups: ReadonlyArray<ProjectGroup>) => void;
  onToggleCollapse: () => void;
  /** "Open Project". Given the click so the quick folder menu can open under
   *  the button and hand focus back to it. */
  onOpenSessionBrowser: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  onBrowseAllSessions: () => void;
  onOpenSettings: () => void;
  onOpenNote: (cwd?: string) => void;
  onSwitchProject: (cwd: string, sessionId: string) => void;
  onAddProject: (cwd: string) => void;
}

const EMPTY_GROUPS: ReadonlyArray<ProjectGroup> = [];
/** `editingGroupId` value while the "new group" field is open. */
const NEW_GROUP = '__new__';

/** Top or bottom half of the hovered header — where a dragged GROUP lands. */
function halfOf(e: ReactDragEvent): 'before' | 'after' {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

// Extract project name from cwd (either separator: Windows cwds use `\`)
function getProjectName(cwd: string): string {
  return projectNameFromCwd(cwd) || cwd;
}

export function ProjectSidebar({
  projects,
  activeIndex,
  collapsed,
  width,
  resizing = false,
  currentCwd,
  onSelectProject,
  onRemoveProject,
  onReorderProjects,
  groups = EMPTY_GROUPS,
  onChangeGroups,
  onToggleCollapse,
  onOpenSessionBrowser,
  onBrowseAllSessions,
  onOpenSettings,
  onOpenNote,
  onSwitchProject,
  onAddProject: _onAddProject,
}: ProjectSidebarProps) {
  const { t } = useTranslation();
  const { pinnedSessions, unpinSession, updateTitle, reorder } = usePinnedSessions();
  const { tasks: scheduledTasks, unreadCount: scheduledUnread, reload: reloadScheduled, pauseTask, resumeTask, triggerTask, deleteTask: deleteScheduledTask, updateTask: updateScheduledTask, markRead: markScheduledRead, reorderTasks } = useScheduledTasks();
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [sessions, setSessions] = useState<GlobalSession[]>([]);
  const sessionsRef = useRef(sessions);
  useEffect(() => { sessionsRef.current = sessions; });

  const reloadScheduledRef = useRef(reloadScheduled);
  useEffect(() => { reloadScheduledRef.current = reloadScheduled; });

  // ── Project tree: each project's own sessions, nested under its row ──
  //
  // Keyed by cwd, so a `project-state-changed` push (which carries a cwd) is a
  // direct lookup. Only expanded branches are ever fetched.
  const [sessionTree, setSessionTree] = useState<ProjectSessionTree>({});
  const sessionTreeRef = useRef(sessionTree);
  useEffect(() => { sessionTreeRef.current = sessionTree; });

  const activeCwd = projects[activeIndex]?.cwd;

  const refreshProjectSessions = useCallback(async (cwd: string) => {
    setSessionTree((prev) => withLoading(prev, cwd));
    const exit = await BrowserRuntime.runPromiseExit(loadProjectSessions(cwd));
    setSessionTree((prev) =>
      exit._tag === 'Success'
        ? withSessions(prev, cwd, exit.value)
        : withLoadError(prev, cwd, 'load-failed'),
    );
  }, []);

  // Ref indirection: the WebSocket handler below must keep ONE identity for the
  // lifetime of the panel (useWebSocket shares a connection per URL and a
  // changing listener would churn it), yet still call the current fetcher.
  const refreshProjectSessionsRef = useRef(refreshProjectSessions);
  useEffect(() => { refreshProjectSessionsRef.current = refreshProjectSessions; });

  const handleToggleProject = useCallback((cwd: string) => {
    const state = projectStateAt(sessionTreeRef.current, cwd);
    if (state.isExpanded) {
      setSessionTree((prev) => withExpanded(prev, cwd, false));
      return;
    }
    // Expanding always refetches: sessions come and go while the branch is
    // shut, so a cached list is only ever a placeholder.
    void refreshProjectSessionsRef.current(cwd);
  }, []);

  // The ACTIVE project opens expanded — that is the project the user is looking
  // at, and its sessions are the ones worth a click. Tracked in a ref so a
  // deliberate collapse is not undone on the next render; a project only
  // auto-expands the first time it becomes active.
  const autoExpandedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!activeCwd || collapsed) return;
    if (autoExpandedRef.current.has(activeCwd)) return;
    autoExpandedRef.current.add(activeCwd);
    void refreshProjectSessionsRef.current(activeCwd);
  }, [activeCwd, collapsed]);

  const handleSwitchProjectRef = useRef(onSwitchProject);
  useEffect(() => { handleSwitchProjectRef.current = onSwitchProject; });

  const handleSelectSession = useCallback((cwd: string, sessionId: string) => {
    handleSwitchProjectRef.current(cwd, sessionId);
  }, []);

  const handleDeleteSession = useCallback((cwd: string, sessionId: string) => {
    void (async () => {
      const exit = await BrowserRuntime.runPromiseExit(deleteSession(cwd, sessionId));
      // Optimistic removal. The server's `project-state-changed` broadcast
      // lands right behind this and refetches the branch, which confirms it.
      if (exit._tag === 'Success') {
        setSessionTree((prev) => withoutSession(prev, cwd, sessionId));
      }
    })();
  }, []);

  /**
   * Delete a session picked straight out of the RECENT list (the bottom
   * popover and its expanded modal), through the same single channel as the
   * tree row above: `deleteSession` → saveProjectState({closedSessionIds}).
   *
   * Two lists show that session, so two lists drop it optimistically — the
   * recents array this component owns and feeds to GlobalSessionMonitor, and
   * the project branch if it happens to be unfolded. Neither is guesswork: the
   * recents snapshot is only re-pushed on the next global-state broadcast, and
   * the branch is refetched by the `project-state-changed` push this very save
   * triggers.
   *
   * A SESSION OPEN IN A TAB NEEDS NOTHING EXTRA HERE, and that is worth stating
   * because it looks like it should. The server broadcasts
   * `project-state-changed` with the closed ids after the delete, and every
   * project iframe's useTabState reconciles on it (`reconcileTabs`): the tab
   * carrying that session closes itself, falling back to the last remaining tab
   * or, if it was the only one, to a blank tab plus GoHome. Adding a second
   * close path from this side would race that one.
   *
   * Returns whether the server accepted it, so the modal — which owns its own
   * copy of the list — can remove the card only on success.
   */
  const handleDeleteRecentSession = useCallback(async (cwd: string, sessionId: string) => {
    const exit = await BrowserRuntime.runPromiseExit(deleteSession(cwd, sessionId));
    if (exit._tag !== 'Success') return false;
    setSessions((prev) => withoutRecentSession(prev, cwd, sessionId));
    setSessionTree((prev) => withoutSession(prev, cwd, sessionId));
    return true;
  }, []);

  const handleGlobalStateMessage = useCallback((msg: unknown) => {
    try {
      const parsed = msg as { type: string; data?: { sessions: GlobalSession[] } };

      // Scheduled task trigger notification
      if (parsed.type === 'task-fired') {
        reloadScheduledRef.current();
        return;
      }

      // A session was added or closed somewhere in the app — the server
      // broadcasts this after every project-state write. Refetch the affected
      // branch so the tree does not show sessions that no longer exist.
      const changedCwd = projectStateChangedCwd(msg);
      if (changedCwd) {
        if (shouldRefetch(sessionTreeRef.current, changedCwd)) {
          void refreshProjectSessionsRef.current(changedCwd);
        }
        return;
      }

      const { data } = parsed;
      if (!data) return;
      setSessions(data.sessions || []);
    } catch {
      // Ignore parse errors
    }
  }, []);

  useWebSocket({
    url: '/ws/global-state',
    onMessage: handleGlobalStateMessage,
  });

  // Derive dot state directly from session.status (single source of truth: state.json)
  const loadingCwds = new Set(
    sessions.filter(s => s.status === 'loading').map(s => s.cwd)
  );
  const unreadCwds = new Set(
    sessions.filter(s => s.status === 'unread').map(s => s.cwd)
  );

  // ── Drag and drop ──
  //
  // TWO KINDS OF DRAG, KEPT APART. A project drag (`dragIndex`) reorders
  // projects and moves them between groups; a group drag (`dragGroupId`)
  // reorders group headers. Each drop target accepts exactly one kind — a
  // project row ignores a group drag, and a header dropped on by a project
  // means "join", never "reorder" — so neither can do the other's job.
  const [dragGroupId, setDragGroupId] = useState<string | null>(null);
  const [groupDropHint, setGroupDropHint] = useState<{ id: string; hint: GroupHeaderDropHint } | null>(null);
  /** A project is hovering the ungrouped end area, or an empty group's slot. */
  const [dropZone, setDropZone] = useState<string | null>(null);
  const [menuGroupId, setMenuGroupId] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);

  const model = useMemo(() => buildSidebarModel(projects, groups), [projects, groups]);
  const hasGroups = groups.length > 0;

  // Ref indirection for the memo'd group headers: their callbacks keep one
  // identity for the life of the panel, yet read the current lists and drag.
  const liveRef = useRef({ projects, groups, dragIndex, dragGroupId, onReorderProjects, onChangeGroups });
  useEffect(() => {
    liveRef.current = { projects, groups, dragIndex, dragGroupId, onReorderProjects, onChangeGroups };
  });

  const applyGroups = useCallback((next: ReadonlyArray<ProjectGroup>) => {
    const live = liveRef.current;
    if (next === live.groups) return;
    // Prune members that are no longer projects before saving, so a stale
    // client copy never resurrects a removed project into its old group.
    live.onChangeGroups?.(normalizeGroups(next, live.projects.map((p) => p.cwd)));
  }, []);

  const clearDrag = useCallback(() => {
    setDragIndex(null);
    setDragOverIndex(null);
    setDragGroupId(null);
    setGroupDropHint(null);
    setDropZone(null);
  }, []);

  const applyProjectDrop = useCallback((target: ProjectDropTarget) => {
    const live = liveRef.current;
    if (live.dragIndex === null) return;
    const result = moveProject(live.projects, live.groups, live.dragIndex, target);
    if (result.projects !== live.projects) live.onReorderProjects([...result.projects]);
    if (result.groups !== live.groups) applyGroups(result.groups);
  }, [applyGroups]);

  // Drag start
  const handleDragStart = useCallback((index: number, e: ReactDragEvent) => {
    e.dataTransfer?.setData(PROJECT_DRAG_TYPE, String(index));
    setDragGroupId(null);
    setDragIndex(index);
  }, []);

  // Drag over a project row. A GROUP drag is not accepted here: no
  // preventDefault, so the browser shows "no drop" and onDrop never fires.
  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    if (dragGroupId !== null) {
      setGroupDropHint(null);
      return;
    }
    e.preventDefault();
    setGroupDropHint(null);
    setDropZone(null);
    if (dragIndex !== null && dragIndex !== index) {
      setDragOverIndex(index);
    }
  }, [dragIndex, dragGroupId]);

  // Drop on a project row
  const handleDrop = useCallback((targetIndex: number) => {
    if (dragIndex !== null && dragIndex !== targetIndex) {
      applyProjectDrop({ kind: 'project', index: targetIndex });
    }
    clearDrag();
  }, [dragIndex, applyProjectDrop, clearDrag]);

  // Drag end
  const handleDragEnd = clearDrag;

  // A project hovering a drop zone that is not a row (the ungrouped end area,
  // an empty group's placeholder). `zone` is the group id or 'ungrouped'.
  const handleZoneDragOver = useCallback((e: ReactDragEvent, zone: string) => {
    if (liveRef.current.dragIndex === null) return;
    e.preventDefault();
    setDragOverIndex(null);
    setGroupDropHint(null);
    setDropZone(zone);
  }, []);

  const handleZoneDrop = useCallback((e: ReactDragEvent, zone: string) => {
    e.preventDefault();
    applyProjectDrop(zone === 'ungrouped' ? { kind: 'ungrouped-end' } : { kind: 'group', groupId: zone });
    clearDrag();
  }, [applyProjectDrop, clearDrag]);

  // ── Group header callbacks (stable; see liveRef) ──
  const handleToggleGroup = useCallback((id: string) => {
    applyGroups(toggleGroupCollapsed(liveRef.current.groups, id));
  }, [applyGroups]);

  const handleStartRename = useCallback((id: string) => {
    setMenuGroupId(null);
    setEditingGroupId(id);
  }, []);

  const handleDeleteGroup = useCallback((id: string) => {
    applyGroups(deleteGroup(liveRef.current.groups, id));
  }, [applyGroups]);

  const handleCommitGroupName = useCallback((id: string, name: string) => {
    setEditingGroupId(null);
    const current = liveRef.current.groups;
    applyGroups(id === NEW_GROUP ? createGroup(current, name) : renameGroup(current, id, name));
  }, [applyGroups]);

  const handleCommitNewGroup = useCallback((name: string) => {
    handleCommitGroupName(NEW_GROUP, name);
  }, [handleCommitGroupName]);

  const handleCancelEdit = useCallback(() => setEditingGroupId(null), []);

  const handleGroupDragStart = useCallback((id: string, e: ReactDragEvent) => {
    e.dataTransfer?.setData(GROUP_DRAG_TYPE, id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    setDragIndex(null);
    setDragOverIndex(null);
    setMenuGroupId(null);
    setDragGroupId(id);
  }, []);

  const handleGroupDragOver = useCallback((id: string, e: ReactDragEvent) => {
    const live = liveRef.current;
    if (live.dragGroupId !== null) {
      // Group onto group: reorder. Hovering itself shows nothing.
      e.preventDefault();
      setGroupDropHint(live.dragGroupId === id ? null : { id, hint: halfOf(e) });
      return;
    }
    if (live.dragIndex !== null) {
      // Project onto group: join it.
      e.preventDefault();
      setDragOverIndex(null);
      setDropZone(null);
      setGroupDropHint({ id, hint: 'into' });
    }
  }, []);

  const handleGroupDrop = useCallback((id: string, e: ReactDragEvent) => {
    e.preventDefault();
    const live = liveRef.current;
    if (live.dragGroupId !== null) {
      applyGroups(reorderGroups(live.groups, live.dragGroupId, id, halfOf(e)));
    } else if (live.dragIndex !== null) {
      applyProjectDrop({ kind: 'group', groupId: id });
    }
    clearDrag();
  }, [applyGroups, applyProjectDrop, clearDrag]);

  const renderProjectRow = (project: ProjectInfo, index: number, inGroup: boolean) => {
    const branch = projectStateAt(sessionTree, project.cwd);
    // The collapsed rail is an icon strip 48px wide — a session title has
    // nowhere to go there, so the whole tree folds away with it.
    const showBranch = !collapsed && branch.isExpanded;
    return (
      <div
        key={project.cwd}
        draggable
        onDragStart={(e) => handleDragStart(index, e)}
        onDragOver={(e) => handleDragOver(e, index)}
        onDrop={() => handleDrop(index)}
        onDragEnd={handleDragEnd}
        className={`${inGroup && !collapsed ? 'ml-3 ' : ''}${
          dragOverIndex === index ? 'border-t-2 border-brand' : ''
        } ${dragIndex === index ? 'opacity-50' : ''}`}
      >
        <div className="flex items-center">
          {/* Expand/collapse. A separate control from the project row —
              unfolding the sessions must never also switch project. */}
          {!collapsed && (
            <button
              data-testid="sidebar-project-expand"
              data-cwd={project.cwd}
              aria-expanded={branch.isExpanded}
              aria-label={t('sessions.projectSessions')}
              title={t('sessions.projectSessions')}
              onClick={(e) => {
                e.stopPropagation();
                handleToggleProject(project.cwd);
              }}
              className="flex-shrink-0 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            >
              <svg
                className={`w-3.5 h-3.5 transition-transform ${branch.isExpanded ? 'rotate-90' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}
          <div className="flex-1 min-w-0">
            <ProjectItem
              index={index}
              name={getProjectName(project.cwd)}
              cwd={project.cwd}
              isActive={index === activeIndex}
              collapsed={collapsed}
              hasUnread={unreadCwds.has(project.cwd)}
              isLoading={loadingCwds.has(project.cwd)}
              onClick={() => onSelectProject(index)}
              onRemove={() => onRemoveProject(index)}
              onOpenNote={() => onOpenNote(project.cwd)}
            />
          </div>
        </div>

        {showBranch && (
          <div className="mt-0.5 space-y-0.5" data-testid="sidebar-session-branch" data-cwd={project.cwd}>
            {branch.isLoading && branch.sessions.length === 0 && (
              <div className="pl-8 pr-1 py-1 text-xs text-muted-foreground">
                {t('sessions.loadingSessions')}
              </div>
            )}
            {!branch.isLoading && branch.error && (
              <div className="pl-8 pr-1 py-1 text-xs text-muted-foreground">
                {t('sessions.loadSessionsFailed')}
              </div>
            )}
            {!branch.isLoading && !branch.error && branch.sessions.length === 0 && (
              <div className="pl-8 pr-1 py-1 text-xs text-muted-foreground">
                {t('sessions.noSessionsYet')}
              </div>
            )}
            {branch.sessions.map((session) => {
              const sessionId = sessionIdOf(session);
              return (
                <ProjectSessionRow
                  key={sessionId}
                  cwd={project.cwd}
                  sessionId={sessionId}
                  title={session.title}
                  isActive={index === activeIndex && project.sessionId === sessionId}
                  onSelect={handleSelectSession}
                  onDelete={handleDeleteSession}
                />
              );
            })}
          </div>
        )}
      </div>
    );
  };

  /** The list body: flat when there are no groups (exactly the old markup),
   *  grouped sections + the ungrouped rest otherwise. */
  const renderProjectList = () => {
    if (!hasGroups) return projects.map((project, index) => renderProjectRow(project, index, false));

    if (collapsed) {
      // The rail has no room for headers: icons in group order, with a thin
      // divider between non-empty runs.
      const runs = [...model.groups.map((g) => g.items), model.ungrouped].filter((r) => r.length > 0);
      return runs.map((run, i) => (
        <div key={`run-${i}`} className="space-y-1">
          {i > 0 && <div data-testid="sidebar-group-divider" className="mx-2 border-t border-border" />}
          {run.map(({ project, index }) => renderProjectRow(project, index, true))}
        </div>
      ));
    }

    return (
      <>
        {model.groups.map(({ group, items }) => {
          const hint = groupDropHint?.id === group.id ? groupDropHint.hint : null;
          return (
            <div key={group.id} data-testid="sidebar-group" data-group-id={group.id} className="space-y-1">
              <ProjectGroupHeader
                id={group.id}
                name={group.name}
                collapsed={group.collapsed}
                count={items.length}
                hasUnread={items.some(({ project }) => unreadCwds.has(project.cwd))}
                menuOpen={menuGroupId === group.id}
                editing={editingGroupId === group.id}
                dropHint={hint}
                isDragging={dragGroupId === group.id}
                onToggle={handleToggleGroup}
                onSetMenu={setMenuGroupId}
                onStartRename={handleStartRename}
                onDelete={handleDeleteGroup}
                onCommitName={handleCommitGroupName}
                onCancelEdit={handleCancelEdit}
                onDragStart={handleGroupDragStart}
                onDragOver={handleGroupDragOver}
                onDrop={handleGroupDrop}
                onDragEnd={handleDragEnd}
              />
              {!group.collapsed && items.length === 0 && (
                <div
                  data-testid="sidebar-group-empty"
                  onDragOver={(e) => handleZoneDragOver(e, group.id)}
                  onDrop={(e) => handleZoneDrop(e, group.id)}
                  className={`ml-3 px-2 py-1.5 rounded-lg text-xs text-muted-foreground border border-dashed ${
                    dropZone === group.id ? 'border-brand bg-brand/10' : 'border-border'
                  }`}
                >
                  {t('workspace.groupEmptyHint')}
                </div>
              )}
              {!group.collapsed && items.map(({ project, index }) => renderProjectRow(project, index, true))}
            </div>
          );
        })}
        {model.ungrouped.map(({ project, index }) => renderProjectRow(project, index, false))}
        {/* The ungrouped end area: drop a project here to take it out of its
            group. Only meaningful (and only shown) once groups exist. */}
        <div
          data-testid="sidebar-ungrouped-drop"
          onDragOver={(e) => handleZoneDragOver(e, 'ungrouped')}
          onDrop={(e) => handleZoneDrop(e, 'ungrouped')}
          className={`min-h-8 rounded-lg flex items-center justify-center text-xs text-muted-foreground transition-colors ${
            dropZone === 'ungrouped' ? 'bg-brand/10 ring-1 ring-brand' : ''
          }`}
        >
          {dragIndex !== null && t('workspace.ungroupDropHint')}
        </div>
      </>
    );
  };

  return (
    // NO `overflow-hidden` HERE. It was added with the drag-to-resize handle to
    // keep content from spilling mid-drag, and it silently broke all three of
    // the bottom panels: Recent sessions, Pinned sessions and Scheduled tasks
    // each open an `absolute left-full` popover — deliberately OUTSIDE this
    // element, to the right of the sidebar — and a clipping ancestor erased
    // them. Clicking did nothing at all, which reads as a dead button rather
    // than as a layout bug.
    //
    // Clipping belongs on the parts that scroll, not on the panel that hosts
    // escaping popovers: the project list below sets its own overflow-y-auto,
    // and the rows truncate their own text.
    <div
      className={`h-full bg-sidebar flex flex-col shrink-0 ${
        resizing ? '' : 'transition-[width] duration-200'
      }`}
      style={{ width: collapsed ? SIDEBAR_COLLAPSED_WIDTH : width }}
    >
      {/* Open project button + collapse button */}
      <div className="group p-2 border-b border-border relative">
        <button
          className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ${
            collapsed ? 'justify-center' : ''
          }`}
          onClick={onOpenSessionBrowser}
          title={t('workspace.openProject')}
        >
          <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
          {!collapsed && <span className="text-sm">{t('workspace.openProject')}</span>}
        </button>
        {/* Collapse button — hidden until hover on pointer devices, always shown on touch (hover: none) */}
        {collapsed ? (
          // Collapsed state: overlay the entire button area
          <button
            className="absolute inset-0 m-2 flex items-center justify-center px-2 py-2 rounded-lg bg-accent text-foreground transition z-10 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
            onClick={onToggleCollapse}
            title={t('workspace.expandSidebar')}
          >
            <svg
              className="w-5 h-5 flex-shrink-0 rotate-180"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        ) : (
          <button
            className="absolute top-1/2 -translate-y-1/2 right-2 p-2 rounded-lg bg-accent text-foreground transition z-10 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
            onClick={onToggleCollapse}
            title={t('workspace.collapseSidebar')}
          >
            <svg
              className="w-5 h-5 flex-shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        )}
      </div>

      {/* Project list — a TREE. Each project row owns a chevron that unfolds
          that project's sessions as an indented list directly beneath it. The
          scrolling happens HERE (see the root comment above): this is the
          element that may clip, and the nested rows live inside it. */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {/* Section label (shell-look-and-feel section 5). The collapsed rail is
            an icon strip with no room for words, so it drops the label. The
            `+` beside it opens the "new group" field (project-groups R1). */}
        {!collapsed && (projects.length > 0 || hasGroups) && (
          <div className="flex items-center px-2 pt-1 pb-0.5 text-xs font-semibold tracking-wide text-muted-foreground select-none">
            <span className="flex-1 min-w-0 truncate">{t('workspace.sidebarProjects')}</span>
            <button
              type="button"
              data-testid="sidebar-new-group"
              aria-label={t('workspace.newGroup')}
              title={t('workspace.newGroup')}
              onClick={() => {
                setMenuGroupId(null);
                setEditingGroupId(NEW_GROUP);
              }}
              className="flex-shrink-0 -mr-1 p-0.5 rounded hover:text-foreground hover:bg-secondary transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>
        )}
        {!collapsed && editingGroupId === NEW_GROUP && (
          <div className="flex items-center px-1">
            <GroupNameInput
              initial=""
              placeholder={t('workspace.groupNamePlaceholder')}
              onCommit={handleCommitNewGroup}
              onCancel={handleCancelEdit}
              testId="sidebar-new-group-input"
            />
          </div>
        )}
        {renderProjectList()}
      </div>

      {/* Bottom button area */}
      <div className="p-2 border-t border-border space-y-1">
        {/* Recent sessions */}
        <GlobalSessionMonitor
          currentCwd={currentCwd}
          onSwitchProject={onSwitchProject}
          collapsed={collapsed}
          sessions={sessions}
          onDeleteSession={handleDeleteRecentSession}
        />
        {/* Pinned sessions */}
        <PinnedSessionsPanel
          collapsed={collapsed}
          pinnedSessions={pinnedSessions}
          onSwitchProject={onSwitchProject}
          onUnpin={unpinSession}
          onUpdateTitle={updateTitle}
          onReorder={reorder}
        />
        {/* Scheduled tasks */}
        <ScheduledTasksPanel
          collapsed={collapsed}
          tasks={scheduledTasks}
          unreadCount={scheduledUnread}
          onSwitchProject={onSwitchProject}
          onPause={pauseTask}
          onResume={resumeTask}
          onTrigger={triggerTask}
          onDelete={deleteScheduledTask}
          onMarkRead={markScheduledRead}
          onUpdateTask={updateScheduledTask}
          onReorder={reorderTasks}
        />
        {/* Browse all sessions — opens the machine-wide SessionBrowser modal
            (scans every project on disk). Icon-only when collapsed, like its
            neighbours. Distinct from the top "Open Project" button, which is
            the folder picker. */}
        <button
          className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ${
            collapsed ? 'justify-center' : ''
          }`}
          onClick={onBrowseAllSessions}
          title={t('sessions.browseAllSessions')}
          aria-label={t('sessions.browseAllSessions')}
        >
          {/* Clock/history glyph — "past sessions across all projects". */}
          <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {!collapsed && <span className="text-sm">{t('sessions.browseAllSessions')}</span>}
        </button>
        {/* Notes */}
        <button
          className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ${
            collapsed ? 'justify-center' : ''
          }`}
          onClick={() => onOpenNote()}
          title={t('workspace.notes')}
        >
          <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          {!collapsed && <span className="text-sm">{t('workspace.notes')}</span>}
        </button>
        {/* Settings row — the whole row is one click target (opens the
            Settings modal). Help is a secondary action nested inside the
            same row, positioned absolutely on the right like ProjectItem's
            note/close buttons. Clicking the Help icon stops propagation so
            it doesn't also fire Settings.

            Layout choices match the project-list item pattern:
              - Whole row uses a single hover background (one item, not two)
              - Help icon is small (w-3.5 h-3.5) like other secondary actions
              - Help link is hidden when the sidebar is collapsed — folding is
                a space-saving mode, and the help entry-point is for new users
                who would be in the expanded view anyway. */}
        <div
          className={`relative flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ${
            collapsed ? 'justify-center' : ''
          }`}
          onClick={onOpenSettings}
          title={t('workspace.settings')}
        >
          <div className="relative flex-shrink-0">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </div>
          {!collapsed && <span className="flex-1 text-sm">{t('workspace.settings')}</span>}
          {/* Help — points at the Naby repository. Naby updates itself via
              electron-updater (GitHub releases), so there is no npm update
              pill / changelog action here any more. */}
          {!collapsed && (
            <a
              href="https://github.com/leonardo204/naby"
              target="_blank"
              rel="noopener"
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              onClick={(e) => e.stopPropagation()}
              title={t('workspace.help')}
              aria-label={t('workspace.help')}
            >
              {/* Lucide HelpCircle, inline SVG to stay consistent with the
                  rest of this footer (no Lucide React import). */}
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                <line x1="12" y1="17" x2="12.01" y2="17" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
              </svg>
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
