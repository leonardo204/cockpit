'use client';

/**
 * "The org harness was updated to vX" — the one popup per version
 * (org-harness-sync §3.1). The update itself already happened silently; this
 * only says so, and — when the new version ships hooks naby does not run yet —
 * that they are installed and wait for a naby update (§3.5).
 *
 * Modeled on SessionCompleteToast: a portal card outside the React tree's
 * layout, so the three-panel layout cannot clip it. It does NOT auto-dismiss:
 * it shows once per version, and a notice that vanished while the user was away
 * would be a notice nobody saw. Both buttons acknowledge it (the server marks
 * the version seen for every window); "Details" also opens Settings → Harness.
 */

import { useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { orgUpdateLines, type OrgUpdateNoticeView } from './connectionStatusView';

export function OrgUpdateToast({
  notice,
  onDismiss,
  onDetails,
}: {
  notice: OrgUpdateNoticeView | null;
  onDismiss: (version: string) => void;
  onDetails: (version: string) => void;
}) {
  const { t } = useTranslation();
  const dismiss = useCallback(() => notice && onDismiss(notice.version), [notice, onDismiss]);
  const details = useCallback(() => notice && onDetails(notice.version), [notice, onDetails]);
  if (!notice || typeof document === 'undefined') return null;
  const lines = orgUpdateLines(notice);

  return createPortal(
    <div className="fixed top-4 right-4 z-[100] pointer-events-none">
      <div
        role="status"
        data-testid="org-update-toast"
        className="pointer-events-auto bg-card border border-border rounded-lg shadow-lg px-3 py-2.5 w-[340px] max-w-[calc(100vw-2rem)]"
        style={{ animation: 'slideInLeft 0.3s ease-out' }}
      >
        <div className="flex items-start gap-2">
          <svg className="w-4 h-4 mt-0.5 text-brand flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm font-medium text-foreground">
              {t('orgUpdate.title', { defaultValue: 'The org harness was updated' })}
            </p>
            {lines.map((l) => (
              <p key={l.key} className="text-xs text-muted-foreground break-words">
                {t(l.key, l.values)}
              </p>
            ))}
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={details}
                className="text-xs px-2 py-1 rounded border border-border text-foreground hover:bg-muted"
              >
                {t('orgUpdate.details', { defaultValue: 'Details' })}
              </button>
              <button
                type="button"
                onClick={dismiss}
                className="text-xs px-2 py-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted"
              >
                {t('orgUpdate.dismiss', { defaultValue: 'Dismiss' })}
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label={t('orgUpdate.dismiss', { defaultValue: 'Dismiss' })}
            className="p-0.5 text-muted-foreground hover:text-foreground rounded transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
