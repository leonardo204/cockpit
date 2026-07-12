import { useEffect } from 'react';

/**
 * Blur the currently focused element.
 *
 * When an overlay is opened by clicking a trigger button and then closed with
 * the keyboard (ESC), the trigger keeps DOM focus after the overlay unmounts.
 * Because ESC is a keyboard action, the browser then paints a `:focus-visible`
 * ring on that still-focused trigger — the "stuck highlight" bug. Blurring the
 * active element before/while closing removes that lingering ring.
 */
export function blurActiveElement(): void {
  if (
    typeof document !== 'undefined' &&
    document.activeElement instanceof HTMLElement
  ) {
    document.activeElement.blur();
  }
}

/**
 * Attach a document-level ESC handler that blurs the focused trigger and then
 * closes the overlay, preventing the "stuck focus ring on the trigger button
 * after ESC" bug.
 *
 * For simple overlays whose only ESC behavior is "close". Overlays with inner
 * layers (nested preview / search bars) should keep their bespoke handler and
 * call {@link blurActiveElement} manually right before their final `onClose()`.
 *
 * @param onClose  Called after the active element is blurred.
 * @param enabled  When false, no listener is attached (e.g. modal not open).
 */
export function useEscToClose(onClose: () => void, enabled: boolean = true): void {
  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      blurActiveElement();
      onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, enabled]);
}
