'use client';

// packages/feature/agent/src/client/connectionStatus.ts
//
// ONE READING OF "IS ATLASSIAN / SKILL HUB OK", SHARED BY EVERY CHAT TAB IN THIS
// FRAME (org-harness-sync §3.9). Same pattern as `subscriptionUsage.ts`: every
// open chat tab stays mounted, so a per-component fetch would multiply by the
// number of tabs. The answer is a property of the app, not of a tab, so it is
// fetched once here and broadcast to subscribers.
//
// REFCOUNTED. The first subscriber starts the timer, the focus listener and the
// cross-frame listener and takes the first reading; the last one to leave stops
// them all. The snapshot is kept, so a tab reopening draws the last reading at
// once.
//
// WHEN IT REFRESHES:
//   1. first subscribe (mount),
//   2. window focus — the user is back, possibly from the browser sign-in,
//   3. every 60 s while anything is subscribed,
//   4. right after a sign-in / sync / toggle anywhere — `refreshConnectionStatus`
//      in this frame, the `ConnectionsChanged` topic from other frames (the
//      Settings modal lives in the top window, the bars in project iframes),
//   5. every 2 s while an Atlassian sign-in is waiting on the browser or a
//      package check is running, so an amber dot settles as soon as it can.
//
// DEDUPED. A request already in flight is joined, never doubled — ten tabs
// mounting at once, a focus during a tick, a broadcast during a fetch all become
// one request.
//
// A FAILED LOOK CHANGES NOTHING: an offline moment is not evidence that the
// connections changed, and blanking the row on every hiccup would flicker.

import { useSyncExternalStore } from 'react';
import { Topics } from '@cockpit/effect-services';
import type { ConnectionsStatusView } from './connectionStatusView';

export const CONNECTION_POLL_MS = 60 * 1000;
export const CONNECTION_LOGIN_POLL_MS = 2 * 1000;

export type ConnectionStatusFetcher = () => Promise<ConnectionsStatusView | null>;

/** The real fetcher: the light `status.connections` action. */
async function defaultFetcher(): Promise<ConnectionsStatusView | null> {
  const res = await fetch('/api/naby', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'status.connections' }),
  });
  const json = (await res.json().catch(() => null)) as { ok?: boolean; connections?: ConnectionsStatusView } | null;
  return json?.ok && json.connections ? json.connections : null;
}

type Env = {
  addEventListener?: (type: string, fn: (e: unknown) => void) => void;
  removeEventListener?: (type: string, fn: (e: unknown) => void) => void;
};

let fetcher: ConnectionStatusFetcher = defaultFetcher;
let snapshot: ConnectionsStatusView | null = null;
let inFlight: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let fastTimer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();
let requests = 0;

function env(): Env | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as Env);
}

function emit(): void {
  for (const l of listeners) l();
}

/** Every 2 s while something settles on its own (a sign-in waiting on the
 *  browser, a package check running); off otherwise. */
function syncFastPoll(): void {
  const want =
    listeners.size > 0 && (snapshot?.atlassian.loginPending === true || snapshot?.skillHub.syncing === true);
  if (want && fastTimer === null) {
    fastTimer = setInterval(() => void fetchStatus(), CONNECTION_LOGIN_POLL_MS);
  } else if (!want && fastTimer !== null) {
    clearInterval(fastTimer);
    fastTimer = null;
  }
}

/** Ask the server, joining a request already in flight. Never rejects. */
export function fetchStatus(): Promise<void> {
  if (inFlight) return inFlight;
  requests += 1;
  inFlight = (async () => {
    try {
      const next = await fetcher();
      if (next) {
        snapshot = next;
        emit();
      }
    } catch {
      /* see the header: a failed look changes nothing */
    } finally {
      inFlight = null;
      syncFastPoll();
    }
  })();
  return inFlight;
}

/** "Something changed — look now." For login/sync/toggle call sites. */
export function refreshConnectionStatus(): Promise<void> {
  return fetchStatus();
}

/** Put a reading the caller already has (an action's reply) into the store. */
export function setConnectionStatus(next: ConnectionsStatusView): void {
  snapshot = next;
  emit();
  syncFastPoll();
}

/** A cross-frame "connections changed" message, in either bus envelope. */
export function isConnectionsChangedMessage(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return d.type === Topics.ConnectionsChanged.legacyType || d.topic === Topics.ConnectionsChanged.id;
}

const onFocus = (): void => {
  void fetchStatus();
};
const onMessage = (e: unknown): void => {
  if (isConnectionsChangedMessage((e as { data?: unknown })?.data)) void fetchStatus();
};

export function subscribeConnectionStatus(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void fetchStatus();
    if (timer === null) timer = setInterval(() => void fetchStatus(), CONNECTION_POLL_MS);
    env()?.addEventListener?.('focus', onFocus);
    env()?.addEventListener?.('message', onMessage);
  }
  return () => {
    if (!listeners.delete(listener)) return;
    if (listeners.size === 0) {
      if (timer !== null) clearInterval(timer);
      timer = null;
      env()?.removeEventListener?.('focus', onFocus);
      env()?.removeEventListener?.('message', onMessage);
      syncFastPoll();
    }
  };
}

export function getConnectionStatusSnapshot(): ConnectionsStatusView | null {
  return snapshot;
}

function getServerSnapshot(): ConnectionsStatusView | null {
  return null;
}

/** The current reading for the status bar (null until the first answer). */
export function useConnectionStatus(): ConnectionsStatusView | null {
  return useSyncExternalStore(subscribeConnectionStatus, getConnectionStatusSnapshot, getServerSnapshot);
}

// -- test seams (not exported from the package index) --------------------------

export function __setConnectionStatusFetcherForTest(fn: ConnectionStatusFetcher | undefined): void {
  fetcher = fn ?? defaultFetcher;
}

export function __resetConnectionStatusForTest(): void {
  snapshot = null;
  inFlight = null;
  if (timer !== null) clearInterval(timer);
  if (fastTimer !== null) clearInterval(fastTimer);
  timer = null;
  fastTimer = null;
  listeners.clear();
  requests = 0;
  fetcher = defaultFetcher;
}

export function __connectionStatusStatsForTest(): {
  subscribers: number;
  requests: number;
  polling: boolean;
  fastPolling: boolean;
} {
  return { subscribers: listeners.size, requests, polling: timer !== null, fastPolling: fastTimer !== null };
}
