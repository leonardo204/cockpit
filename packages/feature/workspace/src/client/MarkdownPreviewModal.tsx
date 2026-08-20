'use client';

/**
 * The markdown viewer as a MODAL — one of its two hosts.
 *
 * THE VIEWER ITSELF IS `MarkdownDocument`, and this file is only the window
 * around it: the dimmed backdrop, the card, Escape-to-close, the ✕, and the
 * button that promotes the document into a tab. Both hosts share the reading
 * pane rather than each owning a copy — see MarkdownDocument's header for why
 * that is not negotiable.
 *
 * WHY BOTH HOSTS EXIST. A modal is right for a document you glance at: it takes
 * the screen, you read the thing, you dismiss it. It is exactly wrong for one
 * you keep referring to, because while it is open it covers the conversation you
 * opened it to help with. The header's "open as a tab" is the promotion —
 * deliberately the same shape as the selection popup's "세션으로 변경", so the
 * two read as one idea: a throwaway thing you decided to keep.
 *
 * PORTALED, BECAUSE THE HOSTS CLIP. `FileBrowserPanel`'s root is
 * `overflow-hidden` and the three-panel shell wraps everything in a
 * `translateX` container, so an in-place overlay is cut off exactly the way
 * three sidebar panels once were (see shell/CLAUDE.md). `Portal` mounts into
 * the panel-portal target when there is one and `document.body` otherwise.
 */

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Portal, useEscToClose } from '@cockpit/shared-ui';
import { MarkdownDocument } from './MarkdownDocument';

export function MarkdownPreviewModal({
  cwd,
  rel,
  onClose,
  onOpenInTab,
}: {
  cwd: string;
  /** The document to open first. Callers key the element on this, so a second
   *  preview of a different file starts from a clean history. */
  rel: string;
  onClose: () => void;
  /**
   * Attach the document to the tab strip and leave it there.
   *
   * OPTIONAL, because the promotion needs a tab host to promote INTO. Where
   * there is none the control is simply absent — a button that silently does
   * nothing is worse than no button (the same rule the selection popup's
   * promote control follows).
   */
  onOpenInTab?: (rel: string) => void;
}) {
  const { t } = useTranslation();

  useEscToClose(onClose);

  /**
   * Promote and dismiss, in that order.
   *
   * `current` — the document ACTUALLY on screen, handed over by the viewer —
   * not the `rel` this modal was opened with. A reader who followed two relative
   * links and then asked to keep the document means the one they are reading;
   * pinning the file they started from would be the app answering a different
   * question.
   *
   * The modal closes because the tab now holds the document, and leaving the
   * overlay up would cover the very tab it just created.
   */
  const promote = useCallback(
    (current: string) => (
      <button
        type="button"
        data-testid="markdown-preview-open-in-tab"
        onClick={() => {
          onOpenInTab?.(current);
          onClose();
        }}
        title={t('markdownPreview.openInTabHint')}
        className="cursor-pointer rounded-md border border-brand px-2 py-0.5 text-xs font-medium text-brand transition-colors hover:bg-brand/10"
      >
        {t('markdownPreview.openInTab')}
      </button>
    ),
    [onOpenInTab, onClose, t],
  );

  const renderActions = useCallback(
    (current: string) => (
      <div className="flex items-center gap-1.5">
        {onOpenInTab && promote(current)}
        <button
          type="button"
          onClick={onClose}
          title={t('common.close')}
          className="p-1 rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    ),
    [onOpenInTab, promote, onClose, t],
  );

  return (
    <Portal>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-0 md:p-4"
        onClick={onClose}
      >
        <div
          data-testid="markdown-preview-modal"
          className="bg-card shadow-xl w-full max-w-[90%] h-full md:h-[90vh] rounded-none md:rounded-lg flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <MarkdownDocument cwd={cwd} rel={rel} renderActions={renderActions} />
        </div>
      </div>
    </Portal>
  );
}
