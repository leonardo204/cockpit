'use client';

import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { PROJECT_GROUP_NAME_MAX } from './projectGroups';

/**
 * The sidebar's group rows (specs/project-groups.md): the header line with its
 * chevron, count and `⋯` menu, the inline name editor shared by "new group" and
 * "rename", and the menu itself.
 *
 * Every callback takes the group id, so the sidebar can hand down ONE stable
 * function per action and the memo'd header re-renders only when its own
 * booleans change.
 */

/** dataTransfer types. The sidebar keeps its own drag state as the source of
 *  truth; these mark the payload so a group drag and a project drag can never
 *  be mistaken for each other by anything reading the event. */
export const GROUP_DRAG_TYPE = 'application/x-naby-project-group';
export const PROJECT_DRAG_TYPE = 'application/x-naby-project';

/** What a drag currently hovering a header would do. */
export type GroupHeaderDropHint =
  /** A project would join this group. */
  | 'into'
  /** A group would be inserted above / below this one. */
  | 'before'
  | 'after'
  | null;

// ─────────────────────────────────────────────────────────
// Name editor
// ─────────────────────────────────────────────────────────

interface GroupNameInputProps {
  initial: string;
  placeholder: string;
  /** Called once with the typed name. An empty name means "cancel". */
  onCommit: (name: string) => void;
  onCancel: () => void;
  testId?: string;
}

/**
 * Enter commits, Escape cancels, an empty name cancels. Leaving the field
 * commits what was typed — clicking away should not throw a name away. The
 * `done` ref keeps Enter-then-blur from committing twice.
 */
export const GroupNameInput = memo(function GroupNameInput({
  initial,
  placeholder,
  onCommit,
  onCancel,
  testId,
}: GroupNameInputProps) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const name = value.trim();
    if (commit && name) onCommit(name);
    else onCancel();
  };

  return (
    <input
      ref={inputRef}
      data-testid={testId}
      className="flex-1 min-w-0 px-1.5 py-0.5 text-sm bg-background text-foreground border border-brand rounded outline-none"
      value={value}
      maxLength={PROJECT_GROUP_NAME_MAX}
      placeholder={placeholder}
      aria-label={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
});

// ─────────────────────────────────────────────────────────
// Menu
// ─────────────────────────────────────────────────────────

/** The markup alone — rendered by tests without a DOM. */
export function ProjectGroupMenuView({
  ref,
  style,
  onRename,
  onDelete,
  onKeyDown,
}: {
  ref?: Ref<HTMLDivElement>;
  style?: CSSProperties;
  onRename: () => void;
  onDelete: () => void;
  onKeyDown?: (e: ReactKeyboardEvent) => void;
}) {
  const { t } = useTranslation();
  const item =
    'w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent focus:bg-accent focus:outline-none transition-colors';
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t('workspace.groupMenu')}
      data-testid="project-group-menu"
      className="fixed z-[80] min-w-40 py-1 bg-popover border border-border rounded-md shadow-lg"
      style={style}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        data-testid="project-group-rename"
        className={`${item} text-foreground`}
        onClick={onRename}
      >
        {t('workspace.renameGroup')}
      </button>
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        data-testid="project-group-delete"
        className={`${item} text-destructive`}
        onClick={onDelete}
      >
        {t('workspace.deleteGroup')}
      </button>
    </div>
  );
}

/**
 * The live menu. PORTALED to <body> with fixed coordinates: the project list
 * scrolls (overflow-y-auto) and so clips anything absolutely positioned inside
 * it, and the sidebar root must not clip at all (shell CLAUDE.md). A fixed
 * layer outside both cannot be cut off by either.
 */
function ProjectGroupMenu({
  anchor,
  onRename,
  onDelete,
  onClose,
}: {
  anchor: HTMLElement | null;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!anchor || !menu) return;
    const a = anchor.getBoundingClientRect();
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    let top = a.bottom + 4;
    if (top + h > window.innerHeight - 8) top = a.top - h - 4;
    const left = Math.min(Math.max(8, a.right - w), window.innerWidth - w - 8);
    setPos({ left, top: Math.max(8, top) });
  }, [anchor]);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    const onBlur = () => onClose();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('blur', onBlur);
    };
  }, [anchor, onClose]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const list = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const at = list.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? (at + 1) % list.length : (at - 1 + list.length) % list.length;
    list[next]?.focus();
  };

  return createPortal(
    <ProjectGroupMenuView
      ref={ref}
      style={pos ?? { left: -9999, top: -9999 }}
      onRename={onRename}
      onDelete={onDelete}
      onKeyDown={onKeyDown}
    />,
    document.body,
  );
}

// ─────────────────────────────────────────────────────────
// Header row
// ─────────────────────────────────────────────────────────

export interface ProjectGroupHeaderProps {
  id: string;
  name: string;
  collapsed: boolean;
  count: number;
  /** A member has an unread session. Shown only while the group is folded —
   *  open, the member rows carry their own dots. */
  hasUnread: boolean;
  menuOpen: boolean;
  editing: boolean;
  dropHint: GroupHeaderDropHint;
  isDragging: boolean;
  onToggle: (id: string) => void;
  onSetMenu: (id: string | null) => void;
  onStartRename: (id: string) => void;
  onDelete: (id: string) => void;
  onCommitName: (id: string, name: string) => void;
  onCancelEdit: () => void;
  onDragStart: (id: string, e: ReactDragEvent) => void;
  onDragOver: (id: string, e: ReactDragEvent) => void;
  onDrop: (id: string, e: ReactDragEvent) => void;
  onDragEnd: () => void;
}

export const ProjectGroupHeader = memo(function ProjectGroupHeader({
  id,
  name,
  collapsed,
  count,
  hasUnread,
  menuOpen,
  editing,
  dropHint,
  isDragging,
  onToggle,
  onSetMenu,
  onStartRename,
  onDelete,
  onCommitName,
  onCancelEdit,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: ProjectGroupHeaderProps) {
  const { t } = useTranslation();
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const hintClass =
    dropHint === 'into'
      ? 'bg-brand/10 ring-1 ring-brand'
      : dropHint === 'before'
        ? 'border-t-2 border-brand'
        : dropHint === 'after'
          ? 'border-b-2 border-brand'
          : '';

  return (
    <div
      data-testid="sidebar-group-header"
      data-group-id={id}
      draggable={!editing}
      onDragStart={(e) => onDragStart(id, e)}
      onDragOver={(e) => onDragOver(id, e)}
      onDrop={(e) => onDrop(id, e)}
      onDragEnd={onDragEnd}
      onDoubleClick={() => onStartRename(id)}
      className={`group/header flex items-center gap-1 pr-1 rounded-lg text-muted-foreground hover:text-foreground transition-colors select-none ${hintClass} ${
        isDragging ? 'opacity-50' : ''
      }`}
    >
      <button
        type="button"
        data-testid="sidebar-group-toggle"
        aria-expanded={!collapsed}
        aria-label={collapsed ? t('workspace.expandGroup') : t('workspace.collapseGroup')}
        title={collapsed ? t('workspace.expandGroup') : t('workspace.collapseGroup')}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(id);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        className="relative flex-shrink-0 p-1 rounded hover:bg-secondary transition-colors"
      >
        <svg
          className={`w-3.5 h-3.5 transition-transform ${collapsed ? '' : 'rotate-90'}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        {collapsed && hasUnread && (
          <span
            data-testid="sidebar-group-unread"
            className="absolute top-0 right-0 w-1.5 h-1.5 rounded-full bg-destructive"
          />
        )}
      </button>

      {editing ? (
        <GroupNameInput
          initial={name}
          placeholder={t('workspace.groupNamePlaceholder')}
          onCommit={(next) => onCommitName(id, next)}
          onCancel={onCancelEdit}
          testId="sidebar-group-name-input"
        />
      ) : (
        <span
          className="flex-1 min-w-0 truncate text-xs font-semibold tracking-wide py-1"
          title={name}
        >
          {name}
        </span>
      )}

      {!editing && (
        <span className="flex-shrink-0 text-xs text-muted-foreground tabular-nums" data-testid="sidebar-group-count">
          ({count})
        </span>
      )}
      {!editing && (
        <button
          ref={menuButtonRef}
          type="button"
          data-testid="sidebar-group-menu-button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={t('workspace.groupMenu')}
          title={t('workspace.groupMenu')}
          onClick={(e) => {
            e.stopPropagation();
            onSetMenu(menuOpen ? null : id);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          className={`flex-shrink-0 p-1 rounded hover:bg-secondary transition-opacity ${
            menuOpen ? 'opacity-100' : 'opacity-0 group-hover/header:opacity-100 [@media(hover:none)]:opacity-100'
          }`}
        >
          <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="5" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="19" cy="12" r="1.6" />
          </svg>
        </button>
      )}

      {menuOpen && typeof document !== 'undefined' && (
        <ProjectGroupMenu
          anchor={menuButtonRef.current}
          onRename={() => {
            onSetMenu(null);
            onStartRename(id);
          }}
          onDelete={() => {
            onSetMenu(null);
            onDelete(id);
          }}
          onClose={() => onSetMenu(null)}
        />
      )}
    </div>
  );
});
