'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The session tab's right-click menu.
 *
 * WHY IT EXISTS. Pinning used to be a small icon that appeared on hover in the
 * corner of the tab. Nobody found it — it was read as a bell, not a pin, so the
 * feature was effectively invisible. The actions now live where a user looks
 * for per-item actions.
 *
 * Rendered in a FIXED-position layer at the pointer, because the tab bar sits
 * inside the project iframe with its own scroll container: an absolutely
 * positioned menu would be clipped or misplaced the moment the strip scrolls.
 * (This is the same class of mistake that made three sidebar panels invisible —
 * see shell/CLAUDE.md on escaping popovers.)
 */

export interface TabContextMenuState {
  tabId: string;
  x: number;
  y: number;
  isPinned: boolean;
  /**
   * P3-M10 (memory-hygiene §3): whether this session is a TEMPORARY one — one
   * nothing is learned from. Read at open time like `isPinned`, so the label
   * says what the click will do rather than what the state is.
   */
  isNoLearn: boolean;
  /**
   * Whether the tab HAS a session yet. A blank tab has nothing to mark: the flag
   * is per session, and a tab becomes one only on its first turn. The item is
   * disabled rather than hidden, so the menu does not change shape between two
   * tabs that look identical to the user.
   */
  hasSession: boolean;
}

interface TabContextMenuProps {
  state: TabContextMenuState;
  onClose: () => void;
  onTogglePin: (tabId: string) => void;
  /** Opens the rename flow; the menu closes first so the input takes focus. */
  onRename: (tabId: string) => void;
  /** P3-M10: mark/unmark this session as one nothing is learned from. */
  onToggleNoLearn: (tabId: string) => void;
}

/** Keeps the menu on screen when the click lands near an edge. */
function clamp(value: number, size: number, viewport: number): number {
  return Math.max(8, Math.min(value, viewport - size - 8));
}

export function TabContextMenu({
  state,
  onClose,
  onTogglePin,
  onRename,
  onToggleNoLearn,
}: TabContextMenuProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: state.x, top: state.y });

  // Measure once mounted, then place. Guessing the height would misplace it on
  // a translated label.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: clamp(state.x, width, window.innerWidth),
      top: clamp(state.y, height, window.innerHeight),
    });
  }, [state.x, state.y]);

  // Dismiss on anything that means "I'm done here". `mousedown` rather than
  // `click` so the menu is gone before the underlying tab reacts.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const item =
    'w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent transition-colors';

  return (
    <div
      ref={ref}
      role="menu"
      data-testid="tab-context-menu"
      className="fixed z-[80] min-w-44 py-1 bg-popover border border-border rounded-md shadow-lg"
      style={{ left: pos.left, top: pos.top }}
    >
      <button
        role="menuitem"
        className={item}
        onClick={() => {
          onTogglePin(state.tabId);
          onClose();
        }}
      >
        <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M15 4.5l-4 4L7 10l-2 2 7 7 2-2 1.5-4 4-4z" />
          <path d="M9 15l-4.5 4.5" />
        </svg>
        {t(state.isPinned ? 'tabBar.unpin' : 'tabBar.pin')}
      </button>
      <button
        role="menuitem"
        className={item}
        onClick={() => {
          onClose();
          onRename(state.tabId);
        }}
      >
        <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z" />
        </svg>
        {t('tabBar.rename')}
      </button>
      {/* P3-M10 §3 — THE TEMPORARY SESSION. It lives here, beside pin and rename,
          because it is the same KIND of thing: a per-session property the user
          sets on the tab that holds it. A Settings switch would have been a
          worse home — by the time you have decided this particular conversation
          should not be learned from, you are looking at its tab. */}
      <button
        role="menuitem"
        disabled={!state.hasSession}
        className={`${item} disabled:opacity-40 disabled:cursor-not-allowed`}
        data-testid="tab-menu-no-learn"
        onClick={() => {
          onToggleNoLearn(state.tabId);
          onClose();
        }}
      >
        <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          {/* An eye with a stroke through it: "this is not being watched". */}
          <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
          <circle cx="12" cy="12" r="2.5" />
          <path d="M3 3l18 18" />
        </svg>
        {t(state.isNoLearn ? 'tabBar.noLearnOff' : 'tabBar.noLearn')}
      </button>
    </div>
  );
}
