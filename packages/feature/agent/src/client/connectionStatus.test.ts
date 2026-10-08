import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONNECTION_LOGIN_POLL_MS,
  CONNECTION_POLL_MS,
  fetchStatus,
  getConnectionStatusSnapshot,
  isConnectionsChangedMessage,
  refreshConnectionStatus,
  subscribeConnectionStatus,
  __connectionStatusStatsForTest as stats,
  __resetConnectionStatusForTest,
  __setConnectionStatusFetcherForTest,
} from './connectionStatus';
import type { ConnectionsStatusView } from './connectionStatusView';

/**
 * THE STATUS BAR'S SHARED POLLER (org-harness-sync §3.9): one reading per frame
 * however many chat tabs draw it, refcounted, deduped, refreshed on focus, on a
 * 60 s timer, on a cross-frame "connections changed", and every 2 s while a
 * sign-in waits on the browser.
 *
 * No DOM: a minimal `window` stand-in records the listeners the store installs,
 * and the fetcher is injected, so no request leaves the test.
 */

type Listener = (e: unknown) => void;
const handlers = new Map<string, Set<Listener>>();
const fakeWindow = {
  addEventListener: (type: string, fn: Listener) => {
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type)!.add(fn);
  },
  removeEventListener: (type: string, fn: Listener) => handlers.get(type)?.delete(fn),
};
const fire = (type: string, e: unknown = {}) => {
  for (const fn of handlers.get(type) ?? []) fn(e);
};

function view(patch: Partial<ConnectionsStatusView['atlassian']> = {}): ConnectionsStatusView {
  return {
    atlassian: { status: 'none', row: 'none', loginPending: false, required: false, blocking: false, ...patch },
    skillHub: { configured: true, on: true, auth: 'ok', version: '0.8.1' },
  };
}

let calls = 0;
let next: () => Promise<ConnectionsStatusView | null>;

beforeEach(() => {
  vi.useFakeTimers();
  handlers.clear();
  (globalThis as { window?: unknown }).window = fakeWindow;
  __resetConnectionStatusForTest();
  calls = 0;
  next = async () => view();
  __setConnectionStatusFetcherForTest(() => {
    calls += 1;
    return next();
  });
});

afterEach(() => {
  __resetConnectionStatusForTest();
  delete (globalThis as { window?: unknown }).window;
  vi.useRealTimers();
});

const settle = () => vi.advanceTimersByTimeAsync(0);

describe('refcount', () => {
  it('ten subscribers make one request, one timer, one focus listener', async () => {
    const offs = Array.from({ length: 10 }, () => subscribeConnectionStatus(() => {}));
    await settle();
    expect(calls).toBe(1);
    expect(stats()).toMatchObject({ subscribers: 10, polling: true });
    expect(handlers.get('focus')?.size).toBe(1);
    expect(handlers.get('message')?.size).toBe(1);
    for (const off of offs) off();
  });

  it('the last unsubscribe stops the timer and removes the listeners; the reading is kept', async () => {
    const a = subscribeConnectionStatus(() => {});
    const b = subscribeConnectionStatus(() => {});
    await settle();
    a();
    expect(stats().polling).toBe(true);
    b();
    expect(stats()).toMatchObject({ subscribers: 0, polling: false });
    expect(handlers.get('focus')?.size ?? 0).toBe(0);
    expect(handlers.get('message')?.size ?? 0).toBe(0);
    expect(getConnectionStatusSnapshot()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(CONNECTION_POLL_MS * 3);
    expect(calls).toBe(1);
  });

  it('an unsubscribe called twice does not drop someone else', async () => {
    const a = subscribeConnectionStatus(() => {});
    const b = subscribeConnectionStatus(() => {});
    a();
    a();
    expect(stats().subscribers).toBe(1);
    b();
  });
});

describe('dedupe', () => {
  it('concurrent asks join the request in flight', async () => {
    let release: (v: ConnectionsStatusView) => void = () => {};
    next = () => new Promise((r) => (release = r));
    const p1 = fetchStatus();
    const p2 = refreshConnectionStatus();
    const p3 = fetchStatus();
    expect(calls).toBe(1);
    release(view());
    await Promise.all([p1, p2, p3]);
    expect(calls).toBe(1);
    next = async () => view();
    await fetchStatus();
    expect(calls).toBe(2);
  });

  it('a focus during a request does not double it', async () => {
    let release: (v: ConnectionsStatusView) => void = () => {};
    next = () => new Promise((r) => (release = r));
    const off = subscribeConnectionStatus(() => {});
    fire('focus');
    fire('focus');
    expect(calls).toBe(1);
    release(view());
    await settle();
    off();
  });
});

describe('when it refreshes', () => {
  it('on mount, on focus, every 60 s, and on a cross-frame "connections changed"', async () => {
    let seen = 0;
    const off = subscribeConnectionStatus(() => {
      seen += 1;
    });
    await settle();
    expect(calls).toBe(1);
    fire('focus');
    await settle();
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(CONNECTION_POLL_MS);
    expect(calls).toBe(3);
    fire('message', { data: { type: 'CONNECTIONS_CHANGED' } });
    await settle();
    expect(calls).toBe(4);
    fire('message', { data: { topic: 'connections-changed', msg: {} } });
    await settle();
    expect(calls).toBe(5);
    fire('message', { data: { type: 'HARNESS_CHANGED' } });
    await settle();
    expect(calls).toBe(5);
    expect(seen).toBe(5);
    off();
  });

  it('every 2 s while a sign-in waits on the browser, back to 60 s when it lands', async () => {
    next = async () => view({ loginPending: true });
    const off = subscribeConnectionStatus(() => {});
    await settle();
    expect(stats().fastPolling).toBe(true);
    await vi.advanceTimersByTimeAsync(CONNECTION_LOGIN_POLL_MS * 2);
    expect(calls).toBe(3);
    next = async () => view({ status: 'connected', row: 'oauth' });
    await vi.advanceTimersByTimeAsync(CONNECTION_LOGIN_POLL_MS);
    expect(getConnectionStatusSnapshot()?.atlassian.status).toBe('connected');
    expect(stats().fastPolling).toBe(false);
    const before = calls;
    await vi.advanceTimersByTimeAsync(CONNECTION_LOGIN_POLL_MS * 5);
    expect(calls).toBe(before);
    off();
  });

  it('every 2 s while a package check runs, back to 60 s when it ends', async () => {
    next = async () => ({ ...view(), skillHub: { ...view().skillHub, version: undefined, syncing: true } });
    const off = subscribeConnectionStatus(() => {});
    await settle();
    expect(stats().fastPolling).toBe(true);
    next = async () => view();
    await vi.advanceTimersByTimeAsync(CONNECTION_LOGIN_POLL_MS);
    expect(stats().fastPolling).toBe(false);
    off();
  });

  it('a failed look keeps the last reading', async () => {
    const off = subscribeConnectionStatus(() => {});
    await settle();
    const first = getConnectionStatusSnapshot();
    next = async () => {
      throw new Error('offline');
    };
    await fetchStatus();
    expect(getConnectionStatusSnapshot()).toBe(first);
    next = async () => null;
    await fetchStatus();
    expect(getConnectionStatusSnapshot()).toBe(first);
    off();
  });
});

describe('the cross-frame message', () => {
  it('accepts both bus envelopes and nothing else', () => {
    expect(isConnectionsChangedMessage({ type: 'CONNECTIONS_CHANGED' })).toBe(true);
    expect(isConnectionsChangedMessage({ topic: 'connections-changed' })).toBe(true);
    expect(isConnectionsChangedMessage({ type: 'HARNESS_CHANGED' })).toBe(false);
    expect(isConnectionsChangedMessage(null)).toBe(false);
    expect(isConnectionsChangedMessage('CONNECTIONS_CHANGED')).toBe(false);
  });
});
