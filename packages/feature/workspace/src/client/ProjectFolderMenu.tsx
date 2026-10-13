'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Portal, toast } from '@cockpit/shared-ui';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { tildePath } from '@cockpit/shared-utils';
import {
  loadProjectFolderChoices,
  pickFolder,
  updateProjectFolderFavorite,
  type ProjectFolderChoices,
} from './effect/workspaceClient';
import {
  buildFolderMenu,
  nextMenuIndex,
  requestProjectFolder,
  type FolderMenuChoice,
} from './projectFolderFlow';

/**
 * THE QUICK FOLDER MENU — favorites and the last folder, before the chooser.
 *
 * ONE HOOK FOR EVERY ENTRY POINT. The sidebar's "Open Project", the home
 * screen's Open and Create, and the session browser's "Open folder" all call
 * `requestFolder(trigger)` and render `menu`; none of them builds its own list.
 * Four copies of a menu drift (one forgets to hide a stale folder, another
 * forgets the keyboard), and the flow itself lives in `projectFolderFlow.ts`.
 *
 * Styled and dismissed like the tab context menu (`TabContextMenu.tsx`): a
 * fixed layer, `bg-popover`, closed by Escape, an outside mousedown or the
 * window losing focus. It is portaled because two of its triggers sit inside
 * containers that clip (the session browser modal, the sidebar header).
 *
 * KEYBOARD. Focus enters on the first item; ArrowUp/ArrowDown move (wrapping),
 * Home/End jump, Enter/Space activate (they are real buttons), Escape and Tab
 * close. However it closes, focus goes back to the trigger — a menu that
 * strands focus on <body> makes the next keystroke land nowhere.
 */

interface MenuState {
  choices: ProjectFolderChoices;
  trigger: HTMLElement | null;
  resolve: (choice: FolderMenuChoice | null) => void;
}

export interface FolderRequestOptions {
  /** Prompt shown above the native panel (macOS). */
  message?: string;
  /** See `pickFolder` — false for a pick that is not itself a project. */
  remember?: boolean;
}

export interface ProjectFolderMenuHandle {
  /**
   * Run the flow from `trigger` (the menu opens under it and focus returns to
   * it). Resolves with the picked folder, or null — cancelled, dismissed, or
   * refused because a request is already in flight. Calling it while the menu
   * is up CLOSES the menu (a second click on the trigger toggles it shut).
   */
  requestFolder: (trigger: HTMLElement | null, options?: FolderRequestOptions) => Promise<string | null>;
  /** Render this somewhere in the caller's tree (it is portaled). */
  menu: ReactNode;
  /** True from the click until the folder (or nothing) comes back. */
  busy: boolean;
  /** True while the menu itself is on screen — the trigger must stay clickable
   *  then, so a caller disables it only for `busy && !menuOpen`. */
  menuOpen: boolean;
}

export function useProjectFolderMenu(): ProjectFolderMenuHandle {
  const [state, setState] = useState<MenuState | null>(null);
  const [busy, setBusy] = useState(false);
  // The refs are the source of truth for `requestFolder`, which is handed to
  // click handlers and must not change identity on every open; the state copies
  // exist to re-render. They are always written together.
  const stateRef = useRef<MenuState | null>(null);
  const busyRef = useRef(false);

  const close = useCallback((choice: FolderMenuChoice | null) => {
    const current = stateRef.current;
    if (!current) return;
    stateRef.current = null;
    setState(null);
    current.trigger?.focus();
    current.resolve(choice);
  }, []);

  const requestFolder = useCallback(
    async (trigger: HTMLElement | null, options: FolderRequestOptions = {}) => {
      // A second click on the trigger while the menu is up closes it — the
      // outside-mousedown handler leaves the trigger alone so this can.
      if (stateRef.current) {
        close(null);
        return null;
      }
      // A native chooser is already up (or about to be): one at a time.
      if (busyRef.current) return null;
      busyRef.current = true;
      setBusy(true);
      try {
        return await requestProjectFolder({
          loadChoices: async () => {
            const exit = await BrowserRuntime.runPromiseExit(loadProjectFolderChoices());
            return exit._tag === 'Success' ? exit.value : { favorites: [], last: null };
          },
          showMenu: (choices) =>
            new Promise<FolderMenuChoice | null>((resolve) => {
              const next = { choices, trigger, resolve };
              stateRef.current = next;
              setState(next);
            }),
          pick: async (startAt) => {
            const exit = await BrowserRuntime.runPromiseExit(
              pickFolder(options.message, { remember: options.remember, startAt }),
            );
            return exit._tag === 'Success' ? exit.value.folder ?? null : null;
          },
        });
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [close],
  );

  // The star on the last-folder row. The row then becomes a favorite in place
  // (the menu stays open), so the user sees the star took.
  const addFavorite = useCallback(async (path: string) => {
    const exit = await BrowserRuntime.runPromiseExit(updateProjectFolderFavorite('add', path));
    if (exit._tag !== 'Success' || !exit.value.ok) return false;
    const current = stateRef.current;
    if (current && !current.choices.favorites.includes(path)) {
      const next = {
        ...current,
        choices: { ...current.choices, favorites: [...current.choices.favorites, path] },
      };
      stateRef.current = next;
      setState(next);
    }
    return exit.value.favorites.includes(path);
  }, []);

  const menu = state ? (
    <Portal>
      <ProjectFolderMenu
        choices={state.choices}
        trigger={state.trigger}
        onChoose={close}
        onAddFavorite={addFavorite}
      />
    </Portal>
  ) : null;

  return { requestFolder, menu, busy, menuOpen: state !== null };
}

/** Keeps the menu on screen near an edge (same rule as the tab menu). */
function clamp(value: number, size: number, viewport: number): number {
  return Math.max(8, Math.min(value, viewport - size - 8));
}

function ProjectFolderMenu({
  choices,
  trigger,
  onChoose,
  onAddFavorite,
}: {
  choices: ProjectFolderChoices;
  trigger: HTMLElement | null;
  onChoose: (choice: FolderMenuChoice | null) => void;
  onAddFavorite: (path: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // After a star, the row it was on is re-rendered as a favorite; focus follows
  // the folder rather than falling to <body> with the star button.
  const [focusPath, setFocusPath] = useState<string | null>(null);

  // Under the trigger, flipped above it when there is no room, measured first
  // so a long translated label cannot push it off screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const anchor = trigger?.getBoundingClientRect();
    const left = anchor ? anchor.left : (window.innerWidth - width) / 2;
    let top = anchor ? anchor.bottom + 4 : (window.innerHeight - height) / 2;
    if (anchor && top + height > window.innerHeight - 8) top = anchor.top - height - 4;
    setPos({
      left: clamp(left, width, window.innerWidth),
      top: clamp(top, height, window.innerHeight),
    });
  }, [trigger]);

  const items = () =>
    Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  // Focus enters on the first item once, when the menu opens.
  useEffect(() => {
    items()[0]?.focus();
  }, []);

  useEffect(() => {
    if (!focusPath) return;
    ref.current?.querySelector<HTMLElement>(`[data-folder-path="${CSS.escape(focusPath)}"]`)?.focus();
    setFocusPath(null);
  }, [focusPath, choices]);

  // Dismiss on anything that means "I'm done here", as the tab menu does. The
  // trigger is exempt: its own click toggles the menu shut (useProjectFolderMenu).
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || trigger?.contains(target)) return;
      onChoose(null);
    };
    const onBlur = () => onChoose(null);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('blur', onBlur);
    };
  }, [onChoose, trigger]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation(); // the session browser modal also closes on Escape
      onChoose(null);
      return;
    }
    const list = items();
    const next = nextMenuIndex(e.key, list.indexOf(document.activeElement as HTMLElement), list.length);
    if (next === null) return;
    e.preventDefault();
    list[next]?.focus();
  };

  const handleStar = async (path: string) => {
    if (await onAddFavorite(path)) setFocusPath(path);
    else toast(t('projectFolderMenu.addFavoriteFailed'), 'error');
  };

  return (
    <ProjectFolderMenuView
      ref={ref}
      choices={choices}
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
      onKeyDown={onKeyDown}
      onChoose={onChoose}
      onStar={(path) => void handleStar(path)}
    />
  );
}

/**
 * The markup alone — rendered by tests without a DOM. Every actionable element
 * is a `role="menuitem"` button with `tabIndex={-1}`: the menu manages focus
 * itself (roving), so Tab is free to mean "leave".
 */
export function ProjectFolderMenuView({
  ref,
  choices,
  style,
  onKeyDown,
  onChoose,
  onStar,
}: {
  ref?: Ref<HTMLDivElement>;
  choices: ProjectFolderChoices;
  style?: CSSProperties;
  onKeyDown?: (e: ReactKeyboardEvent) => void;
  onChoose: (choice: FolderMenuChoice | null) => void;
  onStar: (path: string) => void;
}) {
  const { t } = useTranslation();
  const entries = buildFolderMenu(choices);
  const item =
    'flex-1 min-w-0 flex items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent focus:bg-accent focus:outline-none transition-colors';

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t('projectFolderMenu.label')}
      data-testid="project-folder-menu"
      className="fixed z-[80] min-w-56 max-w-[28rem] py-1 bg-popover border border-border rounded-md shadow-lg"
      style={style}
      onKeyDown={onKeyDown}
    >
      {entries.map((entry) => (
        <div key={`${entry.kind}:${entry.path}`} className="flex items-center">
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-testid={`project-folder-menu-${entry.kind}`}
            data-folder-path={entry.path}
            title={entry.path}
            className={item}
            onClick={() => onChoose({ kind: 'folder', path: entry.path })}
          >
            {entry.kind === 'favorite' ? (
              <svg className="w-4 h-4 flex-shrink-0 text-amber-500" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 2.5l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.3l-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9z" />
              </svg>
            ) : (
              <svg className="w-4 h-4 flex-shrink-0 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
            )}
            <span className="truncate">{tildePath(entry.path, choices.home)}</span>
            {entry.kind === 'last' ? (
              <span className="ml-auto pl-2 flex-shrink-0 text-xs text-muted-foreground">
                {t('projectFolderMenu.last')}
              </span>
            ) : null}
          </button>
          {entry.kind === 'last' ? (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              data-testid="project-folder-menu-star"
              aria-label={t('projectFolderMenu.addFavorite')}
              title={t('projectFolderMenu.addFavorite')}
              className="px-2 py-1.5 text-muted-foreground hover:text-amber-500 focus:text-amber-500 hover:bg-accent focus:bg-accent focus:outline-none transition-colors"
              onClick={() => onStar(entry.path)}
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path d="M12 2.5l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.3l-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9z" />
              </svg>
            </button>
          ) : null}
        </div>
      ))}
      <div role="separator" className="my-1 border-t border-border" />
      <div className="flex">
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          data-testid="project-folder-menu-browse"
          className={item}
          onClick={() => onChoose({ kind: 'browse' })}
        >
          <svg className="w-4 h-4 flex-shrink-0 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
          </svg>
          {t('projectFolderMenu.browse')}
        </button>
      </div>
    </div>
  );
}
