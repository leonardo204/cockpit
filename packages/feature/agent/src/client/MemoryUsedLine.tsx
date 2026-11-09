'use client';

/**
 * "기억 N개 반영" — the memories one answer was given (memory-auto-apply R13).
 *
 * The place the user SEES "the more I use it, the more it knows me": a small line
 * under an answer that had memory injected, which opens the list of what was
 * used. The ids come from the turn itself (the engine stamps them with the turn's
 * measurement), so a reloaded transcript says the same thing the live one did.
 *
 * The list is fetched only when opened — the line costs nothing per bubble — and
 * it expands in place rather than floating, so it can never escape its panel
 * (shell/CLAUDE.md: three-panel layout).
 */

import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

type UsedMemory = { id: string; key: string; value: string };

export const MemoryUsedLine = memo(function MemoryUsedLine({ ids }: { ids: readonly string[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<UsedMemory[] | null>(null);

  const toggle = useCallback(async () => {
    const next = !open;
    setOpen(next);
    if (!next || items) return;
    try {
      const res = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'byIds', ids }),
      });
      const json = (await res.json().catch(() => null)) as { items?: UsedMemory[] } | null;
      setItems(Array.isArray(json?.items) ? json!.items! : []);
    } catch {
      setItems([]);
    }
  }, [open, items, ids]);

  if (ids.length === 0) return null;
  return (
    <div className="px-1 mt-0.5 text-[0.786rem] text-muted-foreground" data-testid="memory-used">
      <button
        type="button"
        onClick={() => void toggle()}
        aria-expanded={open}
        className="hover:text-foreground transition-colors"
        title={t('chat.memoryUsedTitle', { defaultValue: 'What naby remembered for this answer' })}
      >
        {t('chat.memoryUsed', { defaultValue: '{{count}} memories used', count: ids.length })}
      </button>
      {open && (
        <ul className="mt-1 ml-2 space-y-0.5 border-l border-border pl-2" data-testid="memory-used-list">
          {items === null ? (
            <li>{t('chat.memoryUsedLoading', { defaultValue: 'Loading…' })}</li>
          ) : items.length === 0 ? (
            <li>{t('chat.memoryUsedGone', { defaultValue: 'These memories have since been removed.' })}</li>
          ) : (
            items.map((m) => (
              <li key={m.id} className="break-words">
                {m.value}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
});
