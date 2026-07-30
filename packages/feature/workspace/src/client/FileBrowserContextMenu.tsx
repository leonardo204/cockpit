'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { MenuTarget } from './fileBrowserOps';

/**
 * The file browser's right-click menu — the Finder-basic operations on a row.
 *
 * FIXED POSITIONING *AND* A PORTAL, AND NEITHER IS A STYLE CHOICE.
 * `FileBrowserPanel`'s root is `overflow-hidden` and its tree scrolls inside a
 * second clipping box, so an `absolute` menu is cut off the moment it opens
 * near the bottom of the panel — or vanishes entirely. This is the same class
 * of mistake that erased three sidebar panels (see shell/CLAUDE.md on escaping
 * popovers), and the dead `FileContextMenu` in shared/ui makes exactly it.
 *
 * Fixed positioning alone is NOT sufficient here, which is why this goes
 * further than `TabContextMenu` (whose placement logic it otherwise copies).
 * `position: fixed` resolves against the nearest TRANSFORMED ancestor rather
 * than the viewport, and the three-panel shell wraps everything in a
 * `translateX` swipe container — so a fixed menu inside the panel would once
 * again be a descendant that `overflow-hidden` may clip. Rendering into
 * `document.body` removes the clipping ancestors from the picture entirely, and
 * the coordinates stay viewport coordinates either way (they come from
 * `clientX`/`clientY`).
 *
 * The placement itself is TabContextMenu's: put it at the pointer, measure once
 * mounted, then clamp inside the window.
 *
 * WHAT IS OFFERED DEPENDS ON WHERE THE CLICK LANDED, and on what the host can
 * actually do:
 *   • the panel BODY (`target.rel === ''`) is the project root — it can only be
 *     created into, never renamed, duplicated or deleted.
 *   • "Open" and "Reveal in Finder" are rendered ONLY when the Electron bridge
 *     is present. In a plain browser they are not disabled items, they are not
 *     items at all; an action the app cannot perform should not be advertised.
 *   • "Open" is further limited to FILES, and sits first — it is what a
 *     double-click on the row already does, and the menu should name the
 *     default action rather than leave it undiscoverable.
 */

export interface FileMenuState extends MenuTarget {
  x: number;
  y: number;
}

interface FileBrowserContextMenuProps {
  state: FileMenuState;
  onClose: () => void;
  onOpen: (target: MenuTarget) => void;
  onNewFile: (target: MenuTarget) => void;
  onNewFolder: (target: MenuTarget) => void;
  onRename: (target: MenuTarget) => void;
  onDuplicate: (target: MenuTarget) => void;
  onDelete: (target: MenuTarget) => void;
  onCopyPath: (target: MenuTarget, absolute: boolean) => void;
  onReveal: (target: MenuTarget) => void;
  /** True only in Electron (`window.naby.fsOps`); gates the two items that need
   *  the OS — Open and Reveal in Finder — entirely. */
  hasOsBridge: boolean;
}

/** Keeps the menu on screen when the click lands near an edge. */
function clamp(value: number, size: number, viewport: number): number {
  return Math.max(8, Math.min(value, viewport - size - 8));
}

export function FileBrowserContextMenu({
  state,
  onClose,
  onOpen,
  onNewFile,
  onNewFolder,
  onRename,
  onDuplicate,
  onDelete,
  onCopyPath,
  onReveal,
  hasOsBridge,
}: FileBrowserContextMenuProps) {
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
  // `click` so the menu is gone before the underlying row reacts.
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
  const danger =
    'w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm text-red-500 hover:bg-accent transition-colors';

  /** Every item closes first, then acts: the actions that follow open an inline
   *  input, and a menu still on screen would take the focus back. */
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };

  // The project root is a container, not an entry: it has no sibling to be
  // renamed among, nothing to be duplicated into, and deleting it would delete
  // the project.
  const isRoot = state.rel === '';
  const target: MenuTarget = {
    rel: state.rel,
    parentRel: state.parentRel,
    name: state.name,
    isDir: state.isDir,
  };

  // Never rendered on the server (it only exists after a contextmenu event),
  // but a missing `document` must not throw if that ever changes.
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-testid="file-context-menu"
      className="fixed z-[80] min-w-48 py-1 bg-popover border border-border rounded-md shadow-lg"
      style={{ left: pos.left, top: pos.top }}
    >
      {/* FIRST, and only for a file in Electron: it is what a double-click on
          the row does, and a menu should name the default action rather than
          hide it. A folder has no "open with" — it expands. */}
      {hasOsBridge && !isRoot && !state.isDir && (
        <>
          <button
            role="menuitem"
            data-testid="file-menu-open"
            className={item}
            onClick={run(() => onOpen(target))}
          >
            <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M14 3h7v7" />
              <path d="M10 14L21 3" />
              <path d="M21 14v5a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h5" />
            </svg>
            {t('fileBrowser.open')}
          </button>
          <div className="my-1 border-t border-border" />
        </>
      )}
      <button
        role="menuitem"
        data-testid="file-menu-new-file"
        className={item}
        onClick={run(() => onNewFile(target))}
      >
        <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
        {t('fileBrowser.createFile')}
      </button>
      <button
        role="menuitem"
        data-testid="file-menu-new-folder"
        className={item}
        onClick={run(() => onNewFolder(target))}
      >
        <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
        </svg>
        {t('fileBrowser.createFolder')}
      </button>

      {!isRoot && (
        <>
          <div className="my-1 border-t border-border" />
          <button
            role="menuitem"
            data-testid="file-menu-rename"
            className={item}
            onClick={run(() => onRename(target))}
          >
            <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z" />
            </svg>
            {t('fileBrowser.rename')}
          </button>
          <button
            role="menuitem"
            data-testid="file-menu-duplicate"
            className={item}
            onClick={run(() => onDuplicate(target))}
          >
            <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <rect x="9" y="9" width="12" height="12" rx="2" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
            {t('fileBrowser.duplicate')}
          </button>
        </>
      )}

      <div className="my-1 border-t border-border" />
      {/* The project root's relative path is the empty string, so the item is
          omitted there rather than offering to copy nothing. */}
      {!isRoot && (
        <button
          role="menuitem"
          data-testid="file-menu-copy-rel"
          className={item}
          onClick={run(() => onCopyPath(target, false))}
        >
          <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </svg>
          {t('fileContextMenu.copyRelativePath')}
        </button>
      )}
      <button
        role="menuitem"
        data-testid="file-menu-copy-abs"
        className={item}
        onClick={run(() => onCopyPath(target, true))}
      >
        <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
        {t('fileContextMenu.copyAbsolutePath')}
      </button>

      {/* Electron only. Absent — not disabled — in a browser: an item that can
          never work is worse than no item. */}
      {hasOsBridge && (
        <button
          role="menuitem"
          data-testid="file-menu-reveal"
          className={item}
          onClick={run(() => onReveal(target))}
        >
          <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
            <path d="M9 13l3 3 3-3" />
          </svg>
          {t('fileBrowser.revealInFinder')}
        </button>
      )}

      {!isRoot && (
        <>
          <div className="my-1 border-t border-border" />
          <button
            role="menuitem"
            data-testid="file-menu-delete"
            className={danger}
            onClick={run(() => onDelete(target))}
          >
            <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M3 6h18" />
              <path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
              <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
            </svg>
            {t(state.isDir ? 'fileContextMenu.deleteFolder' : 'fileContextMenu.deleteFile')}
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
