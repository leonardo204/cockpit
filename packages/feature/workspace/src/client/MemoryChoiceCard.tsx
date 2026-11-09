'use client';

import { memo, useState } from 'react';

/** Past this length a value is clamped and offered a "show more". A length
 *  check rather than a measurement: jsdom has no layout, and the rule only has
 *  to be right about values long enough to need it. */
const CLAMP_CHARS = 140;

/**
 * One side of a memory question (memory-auto-apply R26): the value, when it was
 * learned, and the button that keeps it — all inside one bordered card, so which
 * button belongs to which memory cannot be misread when the values are long.
 */
export const MemoryChoiceCard = memo(function MemoryChoiceCard({
  value,
  meta,
  pickLabel,
  moreLabel,
  lessLabel,
  disabled,
  onPick,
}: {
  value: string;
  meta: string;
  pickLabel: string;
  moreLabel: string;
  lessLabel: string;
  disabled: boolean;
  onPick: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = value.length > CLAMP_CHARS;
  return (
    <div
      data-testid="memory-choice-card"
      className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-muted/30 p-2.5"
    >
      <div className="text-[0.714rem] text-muted-foreground">{meta}</div>
      <div className={`break-words text-sm text-foreground ${long && !expanded ? 'line-clamp-4' : ''}`}>{value}</div>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="self-start text-[0.714rem] text-muted-foreground underline hover:text-foreground"
        >
          {expanded ? lessLabel : moreLabel}
        </button>
      )}
      <button
        type="button"
        disabled={disabled}
        onClick={onPick}
        className="mt-auto w-full rounded-md border border-brand/50 px-2 py-1 text-xs text-brand hover:bg-brand/10 disabled:opacity-50"
      >
        {pickLabel}
      </button>
    </div>
  );
});
