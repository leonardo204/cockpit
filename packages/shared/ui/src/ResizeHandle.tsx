'use client';

import { useCallback, useRef } from 'react';

interface ResizeHandleProps {
  /** Current width in px of the panel on the handle's side. */
  width: number;
  min: number;
  max: number;
  /** Fires continuously while dragging — drive the live layout from this. */
  onResize: (width: number) => void;
  /** Fires once when the gesture ends. Persist here, not on every move. */
  onResizeEnd?: (width: number) => void;
  /**
   * Which side of the handle the resized panel is on. 'left' (the default) means
   * dragging right makes it wider; 'right' inverts that.
   */
  side?: 'left' | 'right';
  /** Keyboard step in px. */
  step?: number;
  /** Tooltip + accessible name. */
  label?: string;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/**
 * A draggable divider between two panels.
 *
 * POINTER EVENTS, not mouse events, and with capture: `setPointerCapture` keeps
 * the drag attached to this element once it starts, so moving faster than React
 * re-renders — or crossing an iframe, which swallows mouse events entirely and
 * would otherwise strand the drag in a stuck state — does not drop the gesture.
 *
 * The hit area is deliberately wider than the line it draws. A 1px divider is
 * the right visual weight and the wrong target size, so the element spans a few
 * px and centres a hairline inside itself.
 *
 * Keyboard-operable because a pointer-only resize is unusable without a mouse:
 * it is a real `separator` with arrow-key stepping and Home/End for the bounds.
 */
export function ResizeHandle({
  width,
  min,
  max,
  onResize,
  onResizeEnd,
  side = 'left',
  step = 16,
  label,
}: ResizeHandleProps) {
  // Refs, not state: these are read inside pointermove, which must not depend on
  // a re-render having happened first.
  const startX = useRef(0);
  const startWidth = useRef(0);
  const dragging = useRef(false);

  const widthAt = useCallback(
    (clientX: number) => {
      const delta = clientX - startX.current;
      const signed = side === 'left' ? delta : -delta;
      return clamp(Math.round(startWidth.current + signed), min, max);
    },
    [side, min, max],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault(); // no text selection, no native drag
      startX.current = e.clientX;
      startWidth.current = width;
      dragging.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [width],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      onResize(widthAt(e.clientX));
    },
    [onResize, widthAt],
  );

  const endDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      dragging.current = false;
      const final = widthAt(e.clientX);
      onResize(final);
      onResizeEnd?.(final);
    },
    [onResize, onResizeEnd, widthAt],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
      const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
      let next: number | undefined;
      if (e.key === grow) next = clamp(width + step, min, max);
      else if (e.key === shrink) next = clamp(width - step, min, max);
      else if (e.key === 'Home') next = min;
      else if (e.key === 'End') next = max;
      if (next === undefined) return;
      e.preventDefault();
      onResize(next);
      onResizeEnd?.(next);
    },
    [side, width, step, min, max, onResize, onResizeEnd],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-label={label}
      title={label}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
      className="group relative w-1.5 shrink-0 cursor-col-resize select-none touch-none focus:outline-none"
    >
      {/* The hairline. Sits at the centre of the wider hit area, and brightens on
          hover / keyboard focus so the handle is discoverable at all. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-primary group-focus:bg-primary"
      />
    </div>
  );
}
