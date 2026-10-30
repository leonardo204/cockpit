'use client';

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * CLEAR CONTEXT — THE CHOICE (session-context-management §2.2c).
 *
 * "Clear context" used to clear on the click. Now it asks one question first:
 * keep a summary of this conversation, or start from nothing. Keeping a summary
 * is the same server work as "continue in a new tab" (§2.2) — a handoff is
 * written, planted in a fresh session, and the session-scoped environment moves
 * with it — except the fresh session lands in THIS tab's seat instead of a new
 * tab. Clearing everything is the old `/clear` (§2.2b).
 *
 * The summary is the DEFAULT and takes keyboard focus: losing the thread is the
 * expensive mistake, and a few seconds of waiting is the cheap one.
 *
 * A FIXED layer over the whole frame, like the other workspace modals
 * (GrowthReportModal, SessionBrowser). Esc and a backdrop click cancel.
 */

interface ClearContextDialogProps {
  onKeepSummary: () => void;
  onClearAll: () => void;
  onCancel: () => void;
}

export function ClearContextDialog({ onKeepSummary, onClearAll, onCancel }: ClearContextDialogProps) {
  const { t } = useTranslation();
  const primaryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    primaryRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const btn = 'text-sm px-3 py-1.5 rounded-md border transition-colors';

  return (
    // z-[100]: above the tab bar and chat, below the z-[200] layer reserved for
    // context menus and toasts — the failure toast must still show on top.
    <div className="fixed inset-0 z-[100] flex items-center justify-center" data-testid="clear-context-dialog">
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} data-testid="clear-context-backdrop" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="clear-context-title"
        className="relative bg-card rounded-lg shadow-xl w-[min(92vw,420px)] mx-4 p-4 flex flex-col gap-3"
      >
        <h2 id="clear-context-title" className="text-sm font-semibold text-foreground">
          {t('tabBar.clearDialogTitle', { defaultValue: 'Clear context?' })}
        </h2>
        <p className="text-[0.857rem] leading-relaxed text-muted-foreground">
          {t('tabBar.clearDialogBody', {
            defaultValue:
              'Keeping a summary carries the decisions, work in progress and open questions into a fresh conversation (takes a few seconds). Clearing everything starts a blank conversation. Either way, the previous conversation stays in the session history.',
          })}
        </p>
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button
            type="button"
            className={`${btn} border-border text-muted-foreground hover:bg-accent`}
            data-testid="clear-context-cancel"
            onClick={onCancel}
          >
            {t('tabBar.clearCancel', { defaultValue: 'Cancel' })}
          </button>
          <button
            type="button"
            className={`${btn} border-border text-foreground hover:bg-accent`}
            data-testid="clear-context-all"
            onClick={onClearAll}
          >
            {t('tabBar.clearAll', { defaultValue: 'Clear everything' })}
          </button>
          <button
            type="button"
            ref={primaryRef}
            className={`${btn} border-transparent bg-primary text-primary-foreground hover:bg-primary/90`}
            data-testid="clear-context-keep-summary"
            onClick={onKeepSummary}
          >
            {t('tabBar.clearKeepSummary', { defaultValue: 'Keep a summary and clear' })}
          </button>
        </div>
      </div>
    </div>
  );
}
