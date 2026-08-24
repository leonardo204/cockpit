'use client';

// packages/feature/agent/src/client/subscriptionUsage.ts
//
// ONE READING OF THE PLAN LIMITS, SHARED BY EVERY TAB THAT DRAWS IT.
//
// WHY A MODULE SINGLETON AND NOT PLAIN `useState` IN THE BAR. This app keeps all
// three panels AND every open chat tab mounted at once (shell/CLAUDE.md), so a
// hook that fetched per component would fire once per tab on mount, once per tab
// on every turn end, and would run one timer per tab forever. The reading is a
// property of the ACCOUNT, not of a tab — there is exactly one correct answer on
// screen at any moment — so it is fetched once, cached here, and broadcast.
// `useSyncExternalStore` is the React-sanctioned way to read a store like this
// without tearing during a concurrent render.
//
// WHEN IT REFRESHES, IN PRIORITY ORDER:
//   1. First mount of the first subscriber — this is what makes the numbers
//      VISIBLE WITHOUT RUNNING A TURN, which is the whole point of the feature.
//   2. A turn finishing. This is the natural event: a turn is the only thing that
//      moves the number, so the moment it ends is the moment a refetch is worth
//      making, and it is preferred over the timer below.
//   3. A slow timer, as the backstop for an app left open and idle. It exists so
//      a window that rolls over while nobody is typing eventually comes back —
//      an expired window renders as nothing (usageWindowView), and without this
//      the bar would stay quiet until the next turn.
//
// THE POLL FLOOR IS NOT ENFORCED HERE, AND MUST NOT BE. Both readings ultimately
// resolve to server-side accounting that is rate-limited in practice, and the
// authority on how often it may actually be touched is the API action, which
// holds a per-account cache with a fifteen-minute TTL. This module's job is to
// keep the number of HTTP calls sane; the interval below is therefore a comfort
// value, NOT the floor, and shortening it cannot cause a source to be hit more
// often. Keeping the floor in one place — server-side, where the cache is — is
// what stops the two from drifting apart.

import { useEffect, useSyncExternalStore } from 'react';
import type { UsageLimitsSnapshot } from './types';

/**
 * The backstop timer, matched to the server's TTL so an idle app converges on
 * roughly one look per window-refresh rather than on a schedule of its own.
 * See the header: this is not the floor.
 */
export const USAGE_POLL_INTERVAL_MS = 15 * 60 * 1000;

/**
 * The shortest gap between two HTTP calls from this module.
 *
 * Coalesces bursts — ten tabs mounting at once, or a rapid sequence of short
 * turns — into one request. Deliberately far below the server's TTL: a request
 * inside the TTL is a settings-row read and costs nothing, so this only needs to
 * stop silliness, not to protect the source.
 */
export const USAGE_MIN_REQUEST_GAP_MS = 30 * 1000;

// -- the store ---------------------------------------------------------------

let snapshot: UsageLimitsSnapshot = null;
let lastRequestAt = 0;
let inFlight: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/**
 * Ask the server. Never throws, never rejects.
 *
 * A FAILED LOOK LEAVES THE PREVIOUS SNAPSHOT ALONE rather than blanking it: an
 * offline moment or a dropped request is not evidence about the account's usage,
 * and clearing the chip on one would make the bar flicker on every hiccup. The
 * protection against showing a number forever is not here — it is the server's
 * staleness ceiling, which stops SENDING a reading once it is too old, at which
 * point `limits: null` arrives and the chip goes away for a reason.
 */
async function fetchUsage(force: boolean): Promise<void> {
  if (inFlight) return inFlight;
  const now = Date.now();
  if (!force && now - lastRequestAt < USAGE_MIN_REQUEST_GAP_MS) return;
  lastRequestAt = now;
  inFlight = (async () => {
    try {
      const res = await fetch('/api/naby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'usage.limits', ...(force ? { refresh: true } : {}) }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; usage?: UsageLimitsSnapshot }
        | null;
      if (!json?.ok || json.usage === undefined) return;
      snapshot = json.usage;
      emit();
    } catch {
      /* see the doc comment: a failed look changes nothing */
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** An explicit, user-initiated refresh: bypasses both this module's gap and the
 *  server's TTL. Wired to nothing automatic — a timer must never call this. */
export function refreshSubscriptionUsage(): void {
  void fetchUsage(true);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // The first subscriber starts the backstop and takes the first reading. Doing
  // it here rather than in an effect means N tabs mounting together produce one
  // timer and (via the gap above) one request.
  if (listeners.size === 1) {
    void fetchUsage(false);
    if (timer === null) timer = setInterval(() => void fetchUsage(false), USAGE_POLL_INTERVAL_MS);
  }
  return () => {
    listeners.delete(listener);
    // Nothing is drawing it any more, so nothing needs to keep asking. The
    // snapshot itself is kept: a tab reopening should show the last known reading
    // immediately rather than an empty bar that fills in a moment later.
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): UsageLimitsSnapshot {
  return snapshot;
}

/** The server has no notion of this store, so an SSR pass has nothing to report.
 *  Returning the same `null` every time (not a fresh object) is what keeps
 *  `useSyncExternalStore` from looping on a changed identity. */
function getServerSnapshot(): UsageLimitsSnapshot {
  return null;
}

/**
 * The plan-usage reading for the bar, or null when there is nothing to show.
 *
 * `turnActive` is the ONE input: pass the tab's `isLoading`. The refetch happens
 * on the true → false edge — a turn just finished, which is the only event that
 * moves the number — and this is the "natural event over a timer" the design
 * asks for. Passing it from several tabs is safe; the request gap coalesces them.
 */
export function useSubscriptionUsage(turnActive: boolean): UsageLimitsSnapshot {
  const usage = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // THE FALLING EDGE, not the level. An effect keyed on `turnActive` runs on both
  // transitions; the early return makes only `true → false` — a turn that just
  // ended — do anything.
  //
  // NOT FORCED. A turn ending inside the server's TTL is answered from its cache,
  // which is exactly right; forcing here would make every turn hit a source and
  // would defeat the floor the action exists to hold.
  useEffect(() => {
    if (turnActive) return;
    void fetchUsage(false);
  }, [turnActive]);

  return usage;
}

/** Test seam — resets the module singleton between cases. Not exported from the
 *  package index: nothing in the app has any business clearing this. */
export function __resetSubscriptionUsageForTest(): void {
  snapshot = null;
  lastRequestAt = 0;
  inFlight = null;
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  listeners.clear();
}

/** Test seam — read the shared snapshot without mounting a component. */
export function __subscriptionUsageSnapshotForTest(): UsageLimitsSnapshot {
  return snapshot;
}
