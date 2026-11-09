'use client';

import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Over three lines at the width these cards have (memory-auto-apply R46). The
 *  same test as the runtime's `memoryNeedsSummary`; a client bundle cannot import
 *  the runtime. */
function overThreeLines(value: string): boolean {
  return value.length > 120 || value.split('\n').length > 3;
}

/**
 * A memory's text, never taller than three lines (R47): the summary when there is
 * one, otherwise the value clamped, with the stored words one tap away.
 */
export const MemoryText = memo(function MemoryText({
  value,
  summary,
  className,
}: {
  value: string;
  summary?: string;
  className: string;
}) {
  const { t } = useTranslation();
  const [showOriginal, setShowOriginal] = useState(false);
  const collapsible = Boolean(summary) || overThreeLines(value);
  return (
    <>
      <div
        className={`${className} break-words ${showOriginal ? 'whitespace-pre-wrap' : 'line-clamp-3'}`}
        data-testid="memory-text"
      >
        {showOriginal ? value : (summary ?? value)}
      </div>
      {collapsible ? (
        <button
          type="button"
          onClick={() => setShowOriginal((v) => !v)}
          className="text-[0.714rem] text-muted-foreground underline hover:text-foreground"
        >
          {t(showOriginal ? 'memoryReview.hideOriginal' : 'memoryReview.showOriginal')}
        </button>
      ) : null}
    </>
  );
});
