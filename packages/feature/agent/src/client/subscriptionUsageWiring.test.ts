import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  refreshSubscriptionUsage,
  USAGE_MIN_REQUEST_GAP_MS,
  USAGE_POLL_INTERVAL_MS,
  __resetSubscriptionUsageForTest,
  __subscriptionUsageSnapshotForTest,
} from './subscriptionUsage';

/**
 * HOW OFTEN THE PLAN READING IS ASKED FOR, AND WHAT A FAILED ASK DOES.
 *
 * There is no React testing library in this project, so the parts that need a
 * mounted tree (the falling-edge refetch, the one-timer-for-N-tabs subscription)
 * are asserted against the SOURCE — which is the same guard shell/CLAUDE.md
 * prescribes for the things jsdom cannot see. The parts that are just an HTTP
 * call and a store are driven for real, with `fetch` stubbed.
 */

const SNAPSHOT = {
  limits: {
    fiveHour: { utilizationPercent: 39, resetsAt: 1_787_558_400, source: 'sdk' },
    sevenDay: { utilizationPercent: 84, resetsAt: 1_787_569_199, source: 'cli' },
  },
  fetchedAt: 1_787_531_824_602,
  cached: false,
  sources: ['sdk', 'cli'],
  cliReason: 'same-account',
};

describe('the shared reading', () => {
  beforeEach(() => {
    __resetSubscriptionUsageForTest();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetSubscriptionUsageForTest();
  });

  it('stores what the server sent, and nothing it did not', async () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true, usage: SNAPSHOT }) }));
    vi.stubGlobal('fetch', fetchMock);
    refreshSubscriptionUsage();
    await vi.waitFor(() => expect(__subscriptionUsageSnapshotForTest()).not.toBeNull());
    expect(__subscriptionUsageSnapshotForTest()).toEqual(SNAPSHOT);
    // Posts the action, and asks for a real refresh because this entry point is
    // the explicit user-initiated one.
    const body = JSON.parse((fetchMock.mock.calls[0] as never[])[1]['body']);
    expect(body).toEqual({ action: 'usage.limits', refresh: true });
  });

  it('a failed look leaves the previous reading alone rather than blanking it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ ok: true, usage: SNAPSHOT }) })));
    refreshSubscriptionUsage();
    await vi.waitFor(() => expect(__subscriptionUsageSnapshotForTest()).not.toBeNull());

    // Offline. This is not evidence about the account's usage, so clearing the
    // chip on it would make the bar flicker on every hiccup. The protection
    // against showing a number forever is the SERVER's staleness ceiling, which
    // stops sending a reading once it is too old.
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    refreshSubscriptionUsage();
    await new Promise((r) => setTimeout(r, 10));
    expect(__subscriptionUsageSnapshotForTest()).toEqual(SNAPSHOT);
  });

  it('ignores a response that is not ok, or that carries no usage key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ ok: false }) })));
    refreshSubscriptionUsage();
    await new Promise((r) => setTimeout(r, 10));
    expect(__subscriptionUsageSnapshotForTest()).toBeNull();

    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ ok: true }) })));
    refreshSubscriptionUsage();
    await new Promise((r) => setTimeout(r, 10));
    expect(__subscriptionUsageSnapshotForTest()).toBeNull();
  });

  it('accepts a `limits: null` answer — "we asked and there is nothing to show"', async () => {
    // Distinct from "we have not asked yet", and both render as no chip. It must
    // not be mistaken for a failure and discarded, or the client would keep
    // asking on every turn for an account that simply has no plan windows.
    const none = { limits: null, fetchedAt: 0, cached: false, sources: [], cliReason: 'no-cache' };
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ ok: true, usage: none }) })));
    refreshSubscriptionUsage();
    await vi.waitFor(() => expect(__subscriptionUsageSnapshotForTest()).not.toBeNull());
    expect(__subscriptionUsageSnapshotForTest()).toEqual(none);
  });
});

describe('source assertion — when it refetches', () => {
  const SRC = readFileSync(join(__dirname, 'subscriptionUsage.ts'), 'utf8');
  const CHAT = readFileSync(join(__dirname, 'Chat.tsx'), 'utf8');

  it('prefers the natural event: a turn ending', () => {
    // A finished turn is the only thing that moves the number, so it is the event
    // worth refetching on — and preferring it to a timer is what keeps naby off
    // the rate-limited accounting behind both sources.
    expect(CHAT).toContain('useSubscriptionUsage(isLoading)');
    expect(SRC).toContain('if (turnActive) return;');
  });

  it('does not force a refresh on the automatic paths', () => {
    // Forcing would bypass the server's TTL and turn every turn end into a source
    // hit. Only the explicit user-initiated entry point forces.
    expect(SRC).toContain('void fetchUsage(false)');
    expect(SRC.match(/fetchUsage\(true\)/g)).toHaveLength(1);
    expect(SRC).toContain('export function refreshSubscriptionUsage');
  });

  it('polls no faster than the 15-minute floor, and coalesces bursts', () => {
    expect(USAGE_POLL_INTERVAL_MS).toBe(15 * 60 * 1000);
    expect(USAGE_MIN_REQUEST_GAP_MS).toBeLessThan(USAGE_POLL_INTERVAL_MS);
    // One timer for the whole app, started by the FIRST subscriber and stopped by
    // the last: every chat tab stays mounted in this shell, so a per-component
    // timer would mean one interval per open tab, forever.
    expect(SRC).toContain('if (listeners.size === 1)');
    expect(SRC).toContain('if (listeners.size === 0 && timer !== null)');
    expect(SRC.match(/setInterval\(/g)).toHaveLength(1);
  });

  it('never lets two requests be in flight at once', () => {
    expect(SRC).toContain('if (inFlight) return inFlight;');
  });
});
