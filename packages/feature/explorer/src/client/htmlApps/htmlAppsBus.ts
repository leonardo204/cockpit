/**
 * Cross-frame notification bus for HTML-apps registry mutations (mirrors
 * skillsBus). The modal runs in the Workspace parent frame; the console `/name`
 * autocomplete runs inside a project iframe. BroadcastChannel keeps both in sync.
 */

const CHANNEL_NAME = 'cockpit-html-apps';

function getChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  return new BroadcastChannel(CHANNEL_NAME);
}

/** Notify all frames/tabs that the HTML-apps list changed (added or removed). */
export function notifyHtmlAppsChanged(): void {
  const ch = getChannel();
  if (!ch) return;
  try {
    ch.postMessage({ type: 'changed' });
  } finally {
    ch.close();
  }
}

/** Subscribe to HTML-apps-change events. Returns an unsubscribe function. */
export function onHtmlAppsChanged(cb: () => void): () => void {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return () => {};
  const ch = new BroadcastChannel(CHANNEL_NAME);
  const handler = (e: MessageEvent) => {
    if (e.data?.type === 'changed') cb();
  };
  ch.addEventListener('message', handler);
  return () => {
    ch.removeEventListener('message', handler);
    ch.close();
  };
}
