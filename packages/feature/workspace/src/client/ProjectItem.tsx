'use client';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { GroupNameInput } from './ProjectGroupHeader';
import { PROJECT_TITLE_MAX } from './projectTitle';

interface ProjectItemProps {
  /** Position in the global `projects` array (select / remove / drag). */
  index: number;
  /** The number the row shows — restarts at 1 in each sidebar section
   *  (specs/project-groups.md §9 R30, R34). Absent: `index + 1`. */
  number?: number;
  /** The display name: the user's rename, else the folder name. */
  name: string;
  cwd: string;
  isActive: boolean;
  collapsed: boolean;
  hasUnread?: boolean;
  isLoading?: boolean;
  onClick: () => void;
  onRemove: () => void;
  onOpenNote?: () => void;
  /** The project carries a rename — offers "Use folder name" in the menu. */
  renamed?: boolean;
  /** The name is swapped for an input (specs/project-groups.md §8, R8.2). */
  editing?: boolean;
  /** Without it the row offers no rename at all (no double-click, no menu). */
  onStartRename?: () => void;
  /** The trimmed name; '' means "back to the folder name". */
  onCommitRename?: (title: string) => void;
  onCancelRename?: () => void;
  onResetName?: () => void;
}

// ─────────────────────────────────────────────────────────
// Right-click menu
// ─────────────────────────────────────────────────────────

/** The markup alone — rendered by tests without a DOM. */
export function ProjectItemMenuView({
  ref,
  style,
  renamed,
  onRename,
  onResetName,
  onOpenNote,
  onClose,
  onKeyDown,
}: {
  ref?: Ref<HTMLDivElement>;
  style?: CSSProperties;
  renamed: boolean;
  onRename: () => void;
  onResetName: () => void;
  onOpenNote?: () => void;
  onClose: () => void;
  onKeyDown?: (e: ReactKeyboardEvent) => void;
}) {
  const { t } = useTranslation();
  const item =
    'w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent focus:bg-accent focus:outline-none transition-colors';
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t('workspace.projectMenu')}
      data-testid="project-item-menu"
      className="fixed z-[80] min-w-40 py-1 bg-popover border border-border rounded-md shadow-lg"
      style={style}
      onKeyDown={onKeyDown}
      // Portaled, but React events still bubble up the COMPONENT tree — to the
      // row, whose onClick selects the project. "Close project" must not also
      // select it, and a right-click here must not reopen the menu.
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        data-testid="project-item-rename"
        className={`${item} text-foreground`}
        onClick={onRename}
      >
        {t('workspace.renameProject')}
      </button>
      {renamed && (
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          data-testid="project-item-reset-name"
          className={`${item} text-foreground`}
          onClick={onResetName}
        >
          {t('workspace.resetProjectName')}
        </button>
      )}
      {onOpenNote && (
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          data-testid="project-item-notes"
          className={`${item} text-foreground`}
          onClick={onOpenNote}
        >
          {t('workspace.projectNotes')}
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        data-testid="project-item-close"
        className={`${item} text-destructive`}
        onClick={onClose}
      >
        {t('workspace.closeProject')}
      </button>
    </div>
  );
}

/**
 * The live menu, opened at the pointer. PORTALED to <body> with fixed
 * coordinates for the same reason as the group menu: the project list scrolls
 * and would clip it, and the sidebar root must not clip at all.
 */
function ProjectItemMenu({
  at,
  onDismiss,
  ...items
}: {
  at: { x: number; y: number };
  onDismiss: () => void;
  renamed: boolean;
  onRename: () => void;
  onResetName: () => void;
  onOpenNote?: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    const left = Math.min(Math.max(8, at.x), window.innerWidth - w - 8);
    const top = at.y + h > window.innerHeight - 8 ? at.y - h : at.y;
    setPos({ left, top: Math.max(8, top) });
  }, [at]);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      onDismiss();
    };
    const onBlur = () => onDismiss();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('blur', onBlur);
    };
  }, [onDismiss]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      onDismiss();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const list = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const cur = list.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? (cur + 1) % list.length : (cur - 1 + list.length) % list.length;
    list[next]?.focus();
  };

  return createPortal(
    <ProjectItemMenuView
      ref={ref}
      style={pos ?? { left: -9999, top: -9999 }}
      onKeyDown={onKeyDown}
      {...items}
    />,
    document.body,
  );
}

// Numbered SVG icon component
function NumberIcon({ number, isActive }: { number: number; isActive: boolean }) {
  return (
    <svg
      className={`w-6 h-6 flex-shrink-0 ${isActive ? 'text-brand' : 'text-muted-foreground'}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <rect x="3" y="3" width="18" height="18" rx="4" />
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

export function ProjectItem({
  index,
  number,
  name,
  cwd,
  isActive,
  collapsed,
  hasUnread,
  isLoading,
  onClick,
  onRemove,
  onOpenNote,
  renamed = false,
  editing = false,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onResetName,
}: ProjectItemProps) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  // The menu is an expanded-row affordance: on the 48px rail there is nowhere
  // to put the rename field it would open.
  const canRename = !!onStartRename && !collapsed;
  // Tooltip text: collapsed rows are icon-only, so show the project name;
  // expanded rows already show the name, so show the full cwd path.
  const tooltipText = collapsed ? name : cwd;

  return (
    <div
      className={`flex items-center gap-2 px-2 py-1 rounded-lg cursor-pointer transition-colors relative ${
        collapsed ? 'justify-center' : ''
      } ${
        isActive
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
      }`}
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onContextMenu={(e) => {
        if (!canRename || editing) return;
        e.preventDefault();
        e.stopPropagation();
        setMenuAt({ x: e.clientX, y: e.clientY });
      }}
      data-tooltip={tooltipText}
    >
      <div className="relative flex-shrink-0">
        <NumberIcon number={number ?? index + 1} isActive={isActive} />
        {/* Unread red dot - top-right of number icon (hidden while loading to avoid overlap) */}
        {hasUnread && !isActive && !isLoading && (
          <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-destructive" />
        )}
        {/* Running orange dot - top-right of number icon */}
        {isLoading && (
          <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-orange-9 animate-pulse" />
        )}
      </div>

      {!collapsed && (
        <>
          {editing ? (
            <GroupNameInput
              initial={name}
              placeholder={t('workspace.projectNamePlaceholder')}
              maxLength={PROJECT_TITLE_MAX}
              allowEmpty
              onCommit={(next) => onCommitRename?.(next)}
              onCancel={() => onCancelRename?.()}
              testId="sidebar-project-name-input"
            />
          ) : (
            <span
              data-testid="sidebar-project-name"
              className={`flex-1 truncate text-sm ${isActive ? 'text-brand' : ''}`}
              onDoubleClick={(e) => {
                if (!canRename) return;
                e.stopPropagation();
                onStartRename?.();
              }}
            >
              {name}
            </span>
          )}

          {/* Status indicator: active (brand color), loading dot moved to top-right of number */}
          {!isLoading && isActive ? (
            <span className="w-2 h-2 rounded-full bg-brand flex-shrink-0" />
          ) : null}
        </>
      )}

      {/* Action buttons - shown on hover in expanded state */}
      {isHovered && !collapsed && !editing && (
        <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
          {/* Note button */}
          {onOpenNote && (
            <button
              className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                onOpenNote();
              }}
              title={t('workspace.projectNotes')}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
          )}
          {/* Close button */}
          <button
            className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            title={t('workspace.closeProject')}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {menuAt && typeof document !== 'undefined' && (
        <ProjectItemMenu
          at={menuAt}
          onDismiss={() => setMenuAt(null)}
          renamed={renamed}
          onRename={() => {
            setMenuAt(null);
            onStartRename?.();
          }}
          onResetName={() => {
            setMenuAt(null);
            onResetName?.();
          }}
          onOpenNote={
            onOpenNote
              ? () => {
                  setMenuAt(null);
                  onOpenNote();
                }
              : undefined
          }
          onClose={() => {
            setMenuAt(null);
            onRemove();
          }}
        />
      )}
    </div>
  );
}
