'use client';

/**
 * "Open Settings AT this entry" (chat-connection-status §4): the chat status
 * bar's Skill Hub click lands on the Skill Hub key row under Connections.
 *
 * NO TIMER. The row a request points at may not exist yet — the Connections list
 * loads its presets asynchronously after the section opens — and polling the DOM
 * for it would be a timer in the Settings modal, which the modal deliberately has
 * none of (settingsLayout.test.ts). So it is a handoff instead:
 *
 *   - `requestSettingsFocus(anchor)` brings the entry into view at once if it is
 *     already rendered; otherwise it remembers the anchor;
 *   - the entry calls `claimSettingsFocus(anchor, el)` when it mounts, and takes
 *     the focus if it is the one waiting.
 *
 * `clearSettingsFocus()` drops a request nobody claimed (the modal closed).
 */

let pending: string | undefined;

function bringIntoView(el: HTMLElement): void {
  el.scrollIntoView({ block: 'center' });
  el.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true });
}

export function requestSettingsFocus(anchor: string): void {
  pending = anchor;
  if (typeof document === 'undefined') return;
  const el = document.querySelector<HTMLElement>(`[data-settings-anchor="${CSS.escape(anchor)}"]`);
  if (el) {
    pending = undefined;
    bringIntoView(el);
  }
}

/** Called by an anchored entry on mount. True when it took the focus. */
export function claimSettingsFocus(anchor: string, el: HTMLElement | null): boolean {
  if (!el || pending !== anchor) return false;
  pending = undefined;
  bringIntoView(el);
  return true;
}

export function clearSettingsFocus(): void {
  pending = undefined;
}

/** Test seam. */
export function __pendingSettingsFocusForTest(): string | undefined {
  return pending;
}
