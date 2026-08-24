import { describe, it, expect } from 'vitest';
import {
  isoToUnixSeconds,
  leastRemainingWindow,
  mergeSubscriptionUsage,
  parseHudUsage,
  parseSdkUsage,
  usagePercent,
  SUBSCRIPTION_USAGE_MAX_STALE_MS,
  SUBSCRIPTION_USAGE_TTL_MS,
} from '../../../../../../../dist/naby-runtime.mjs';

/**
 * THE SUBSCRIPTION'S 5-HOUR AND 7-DAY WINDOWS — both sources, the merge, and
 * every way the whole thing is allowed to say nothing.
 *
 * WHY FIXTURES AND NOT A LIVE CALL, stated once. The primary source is an SDK
 * method literally named `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_
 * YET`; the packaged app may not ship the SDK at all; and a real subscription
 * cannot be driven to a chosen percentage on demand — you get whatever this
 * week's usage happens to be. So the parse, the merge and the refusal rules are
 * pure functions over captured shapes, which is the same argument
 * `describeRateLimit` makes about itself in nabyRateLimit.test.ts.
 *
 * THE FIXTURES ARE REAL. `HUD_FIXTURE` is a verbatim copy of a live
 * `~/.claude/.hud_cache` (utilizations 5 and 84, ISO resets with a `+00:00`
 * offset and six fractional digits). `SDK_FIXTURE` follows the vendor's own
 * declared shape in sdk.d.ts, including the `| null` on every leaf that it
 * declares nullable — because a suite that only exercised fully-populated
 * objects would be testing a shape neither source promises.
 */

/** Verbatim from a live `~/.claude/.hud_cache`. `_ts` is epoch MILLISECONDS. */
const HUD_FIXTURE = {
  _ts: 1787531824602,
  _ok: true,
  _rateLimited: false,
  _rlCount: 0,
  five_hour: {
    utilization: 5,
    resets_at: '2026-08-24T05:19:59.552361+00:00',
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
  },
  seven_day: {
    utilization: 84,
    resets_at: '2026-08-24T10:59:59.552386+00:00',
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
  },
};

/** The moment the fixture above was captured, so "fresh" is deterministic. */
const HUD_NOW = 1787531824602;

/** Shaped exactly as `SDKControlGetUsageResponse` declares it. */
const SDK_FIXTURE = {
  session: {
    total_cost_usd: 1.23,
    total_api_duration_ms: 1000,
    total_duration_ms: 2000,
    total_lines_added: 10,
    total_lines_removed: 2,
    model_usage: {},
  },
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 39, resets_at: '2026-08-24T08:00:00.000Z' },
    seven_day: { utilization: 15, resets_at: '2026-08-28T00:00:00.000Z' },
    seven_day_opus: { utilization: 62, resets_at: '2026-08-28T00:00:00.000Z' },
    seven_day_sonnet: { utilization: null, resets_at: null },
    seven_day_oauth_apps: null,
  },
};

describe('parseSdkUsage — the experimental usage query', () => {
  it('reads both windows, keeping the percentage on its own 0-100 scale', () => {
    const u = parseSdkUsage(SDK_FIXTURE);
    expect(u?.fiveHour).toEqual({
      utilizationPercent: 39,
      resetsAt: isoToUnixSeconds('2026-08-24T08:00:00.000Z'),
      source: 'sdk',
    });
    expect(u?.sevenDay?.utilizationPercent).toBe(15);
    // THE SCALE, PINNED. 39 must stay 39. The `rate_limit_event` path multiplies
    // its own `utilization` by 100 on the assumption it is a 0..1 fraction; if
    // this value ever went through that code it would render as `3900%`.
    expect(u?.fiveHour?.utilizationPercent).toBe(39);
  });

  it('carries the model sub-windows as `extra` rather than promoting them', () => {
    const u = parseSdkUsage(SDK_FIXTURE);
    // `seven_day_opus` has readings, so it is carried.
    expect(u?.extra?.seven_day_opus?.utilizationPercent).toBe(62);
    // `seven_day_sonnet` is all-null and `seven_day_oauth_apps` is null: both are
    // absent rather than present-and-empty, so nothing downstream can render a
    // bucket that reported nothing.
    expect(u?.extra).not.toHaveProperty('seven_day_sonnet');
    expect(u?.extra).not.toHaveProperty('seven_day_oauth_apps');
    // And they never become top-level windows — the bar shows two, by design.
    expect(Object.keys(u ?? {}).sort()).toEqual(['extra', 'fiveHour', 'sevenDay']);
  });

  it('carries a bucket the vendor has not shipped yet', () => {
    // The catalogue grows with the plan list. An unknown key must reach the
    // tooltip rather than fail to compile or be silently dropped.
    const u = parseSdkUsage({
      rate_limits_available: true,
      rate_limits: { thirty_day_futureplan: { utilization: 7, resets_at: '2026-09-01T00:00:00Z' } },
    });
    expect(u?.extra?.thirty_day_futureplan?.utilizationPercent).toBe(7);
  });

  it('returns null when the account has no plan windows at all', () => {
    // `rate_limits_available: false` is the vendor's documented answer for API
    // key / Bedrock / Vertex sessions. It is a real answer meaning "no windows
    // here", and the honest rendering is no chip — NOT a chip reading 0%.
    expect(
      parseSdkUsage({ rate_limits_available: false, rate_limits: null, subscription_type: null }),
    ).toBeNull();
  });

  it('refuses a truthy-but-not-true availability flag', () => {
    // Only `=== true` is the vendor saying plan limits apply. Anything else —
    // a string, a stray object — must not be read as consent to show numbers.
    expect(parseSdkUsage({ rate_limits_available: 'yes', rate_limits: SDK_FIXTURE.rate_limits })).toBeNull();
  });

  it('returns null for a missing `rate_limits`, and for garbage', () => {
    expect(parseSdkUsage({ rate_limits_available: true })).toBeNull();
    expect(parseSdkUsage({ rate_limits_available: true, rate_limits: 'nope' })).toBeNull();
    // Everything the method could return on a bad day.
    expect(parseSdkUsage(null)).toBeNull();
    expect(parseSdkUsage(undefined)).toBeNull();
    expect(parseSdkUsage('rate_limit_error')).toBeNull();
    expect(parseSdkUsage(42)).toBeNull();
    expect(parseSdkUsage([])).toBeNull();
  });

  it('drops a window whose readings are both null, rather than defaulting them', () => {
    // THE CENTRAL RULE. A defaulted 0 would turn "the backend told us nothing"
    // into "this window just reset", and a defaulted reset into a countdown of 0.
    const u = parseSdkUsage({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: null, resets_at: null },
        seven_day: { utilization: 20, resets_at: null },
      },
    });
    expect(u?.fiveHour).toBeUndefined();
    // A window with only a percentage still counts — the halves are independent.
    expect(u?.sevenDay).toEqual({ utilizationPercent: 20, source: 'sdk' });
    expect(u?.sevenDay).not.toHaveProperty('resetsAt');
  });

  it('returns null when every window was unreadable', () => {
    expect(
      parseSdkUsage({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: null, resets_at: null }, seven_day: null },
      }),
    ).toBeNull();
  });

  it('keeps 0 as a reading and keeps over-100 unclamped', () => {
    const u = parseSdkUsage({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 0, resets_at: null },
        seven_day: { utilization: 137, resets_at: null },
      },
    });
    // 0% is a real state (a window that just reset) and must survive the trip.
    expect(u?.fiveHour?.utilizationPercent).toBe(0);
    // Over 100 is real too — an account in overage — and clamping would erase
    // exactly the state most worth showing.
    expect(u?.sevenDay?.utilizationPercent).toBe(137);
  });
});

describe('parseHudUsage — Claude Code’s own cache', () => {
  it('reads the live fixture', () => {
    const u = parseHudUsage(HUD_FIXTURE, { now: HUD_NOW, maxAgeMs: SUBSCRIPTION_USAGE_MAX_STALE_MS });
    expect(u?.fiveHour?.utilizationPercent).toBe(5);
    expect(u?.sevenDay?.utilizationPercent).toBe(84);
    expect(u?.fiveHour?.source).toBe('cli');
    // The ISO string with a `+00:00` offset and six fractional digits becomes
    // UNIX SECONDS — the same unit the `rate_limit` event contract declares, so
    // the client's single existing conversion serves both paths.
    expect(u?.sevenDay?.resetsAt).toBe(Math.floor(Date.parse('2026-08-24T10:59:59.552386+00:00') / 1000));
  });

  it('refuses a cache older than the ceiling — the frozen-daemon defect', () => {
    // This is the reason the ceiling exists. The poller can stop while leaving a
    // file that still parses perfectly, and because the merge takes the WORSE of
    // two readings, a frozen 84% would win every comparison from then on.
    const justInside = parseHudUsage(HUD_FIXTURE, {
      now: HUD_NOW + SUBSCRIPTION_USAGE_MAX_STALE_MS - 1,
      maxAgeMs: SUBSCRIPTION_USAGE_MAX_STALE_MS,
    });
    expect(justInside?.sevenDay?.utilizationPercent).toBe(84);
    const justOutside = parseHudUsage(HUD_FIXTURE, {
      now: HUD_NOW + SUBSCRIPTION_USAGE_MAX_STALE_MS + 1,
      maxAgeMs: SUBSCRIPTION_USAGE_MAX_STALE_MS,
    });
    expect(justOutside).toBeNull();
  });

  it('refuses a cache with no timestamp at all', () => {
    // Without `_ts` there is no way to tell "current" from "last week", and the
    // two must not be indistinguishable when one of them wins the merge.
    const { _ts, ...noTs } = HUD_FIXTURE;
    expect(parseHudUsage(noTs, { now: HUD_NOW, maxAgeMs: SUBSCRIPTION_USAGE_MAX_STALE_MS })).toBeNull();
  });

  it('refuses a cache whose own poller reported failure', () => {
    expect(
      parseHudUsage({ ...HUD_FIXTURE, _ok: false }, { now: HUD_NOW, maxAgeMs: SUBSCRIPTION_USAGE_MAX_STALE_MS }),
    ).toBeNull();
  });

  it('refuses a timestamp from the future by more than the ceiling', () => {
    // A clock that far out of step cannot establish freshness in either
    // direction, so it is refused rather than trusted forward.
    expect(
      parseHudUsage(HUD_FIXTURE, {
        now: HUD_NOW - SUBSCRIPTION_USAGE_MAX_STALE_MS - 1,
        maxAgeMs: SUBSCRIPTION_USAGE_MAX_STALE_MS,
      }),
    ).toBeNull();
  });

  it('returns null for garbage, and never invents `extra`', () => {
    expect(parseHudUsage(null, { now: HUD_NOW, maxAgeMs: 1000 })).toBeNull();
    expect(parseHudUsage('{}', { now: HUD_NOW, maxAgeMs: 1000 })).toBeNull();
    const u = parseHudUsage(HUD_FIXTURE, { now: HUD_NOW, maxAgeMs: SUBSCRIPTION_USAGE_MAX_STALE_MS });
    // The endpoint behind this cache carries the two plan windows only.
    // Fabricating empty model sub-windows would make the merge compare a real
    // bucket against an invented one.
    expect(u).not.toHaveProperty('extra');
  });
});

describe('the merge — the pessimistic reading wins, per window', () => {
  it('takes the higher utilization for each window independently', () => {
    // The fixtures disagree in OPPOSITE directions, which is the case worth
    // pinning: SDK says 39/15, the CLI cache says 5/84. The answer must be
    // 39 (sdk) for the 5-hour and 84 (cli) for the 7-day — not one source's
    // whole object.
    const merged = mergeSubscriptionUsage(
      parseSdkUsage(SDK_FIXTURE),
      parseHudUsage(HUD_FIXTURE, { now: HUD_NOW, maxAgeMs: SUBSCRIPTION_USAGE_MAX_STALE_MS }),
    );
    expect(merged?.fiveHour?.utilizationPercent).toBe(39);
    expect(merged?.fiveHour?.source).toBe('sdk');
    expect(merged?.sevenDay?.utilizationPercent).toBe(84);
    expect(merged?.sevenDay?.source).toBe('cli');
  });

  it('takes the winning window WHOLE — never a percentage from one and a clock from the other', () => {
    // A chip assembled from two moments describes a state that never existed and
    // is indistinguishable from one that did.
    const merged = mergeSubscriptionUsage(
      parseSdkUsage(SDK_FIXTURE),
      parseHudUsage(HUD_FIXTURE, { now: HUD_NOW, maxAgeMs: SUBSCRIPTION_USAGE_MAX_STALE_MS }),
    );
    expect(merged?.sevenDay?.resetsAt).toBe(
      Math.floor(Date.parse('2026-08-24T10:59:59.552386+00:00') / 1000),
    );
    expect(merged?.fiveHour?.resetsAt).toBe(isoToUnixSeconds('2026-08-24T08:00:00.000Z'));
  });

  it('keeps whichever side has the window when only one does', () => {
    const sdkOnly = parseSdkUsage(SDK_FIXTURE);
    expect(mergeSubscriptionUsage(sdkOnly, null)).toEqual(sdkOnly);
    expect(mergeSubscriptionUsage(null, sdkOnly)).toEqual(sdkOnly);
    expect(mergeSubscriptionUsage(null, null)).toBeNull();
    // The `extra` buckets only one side has survive too.
    const merged = mergeSubscriptionUsage(
      sdkOnly,
      parseHudUsage(HUD_FIXTURE, { now: HUD_NOW, maxAgeMs: SUBSCRIPTION_USAGE_MAX_STALE_MS }),
    );
    expect(merged?.extra?.seven_day_opus?.utilizationPercent).toBe(62);
  });

  it('prefers the first argument on an exact tie, so the SDK wins a draw', () => {
    const a = { utilizationPercent: 50, source: 'sdk' as const };
    const b = { utilizationPercent: 50, source: 'cli' as const };
    expect(leastRemainingWindow(a, b)?.source).toBe('sdk');
  });

  it('prefers the side that has a percentage when the other has only a clock', () => {
    const withPercent = { utilizationPercent: 10, source: 'sdk' as const };
    const clockOnly = { resetsAt: 1_787_500_000, source: 'cli' as const };
    expect(leastRemainingWindow(clockOnly, withPercent)).toBe(withPercent);
    expect(leastRemainingWindow(withPercent, clockOnly)).toBe(withPercent);
  });

  it('falls back to the sooner reset when neither side reported a percentage', () => {
    const later = { resetsAt: 2000, source: 'sdk' as const };
    const sooner = { resetsAt: 1000, source: 'cli' as const };
    expect(leastRemainingWindow(later, sooner)).toBe(sooner);
  });

  it('does not turn 0 into "no reading" when comparing', () => {
    // A freshly reset window really is 0%, and it must be able to LOSE to a
    // higher number rather than be mistaken for absence and win by default.
    const zero = { utilizationPercent: 0, source: 'sdk' as const };
    const some = { utilizationPercent: 3, source: 'cli' as const };
    expect(leastRemainingWindow(zero, some)).toBe(some);
  });
});

describe('the field readers refuse rather than coerce', () => {
  it('usagePercent', () => {
    expect(usagePercent(0)).toBe(0);
    expect(usagePercent(84)).toBe(84);
    expect(usagePercent(137)).toBe(137);
    expect(usagePercent(null)).toBeUndefined();
    expect(usagePercent(undefined)).toBeUndefined();
    expect(usagePercent(NaN)).toBeUndefined();
    expect(usagePercent(Infinity)).toBeUndefined();
    expect(usagePercent(-1)).toBeUndefined();
    expect(usagePercent('84')).toBeUndefined();
  });

  it('isoToUnixSeconds returns SECONDS, and nothing for an unparseable string', () => {
    // The unit is the one thing here that can be wrong without looking wrong.
    expect(isoToUnixSeconds('2026-08-24T08:00:00.000Z')).toBe(1787558400);
    expect(String(isoToUnixSeconds('2026-08-24T08:00:00.000Z'))).toHaveLength(10);
    expect(isoToUnixSeconds('not a date')).toBeUndefined();
    expect(isoToUnixSeconds('')).toBeUndefined();
    expect(isoToUnixSeconds(1787558400)).toBeUndefined();
    expect(isoToUnixSeconds(null)).toBeUndefined();
  });
});

describe('the two clocks', () => {
  it('the poll floor is 15 minutes and the staleness ceiling is twice it', () => {
    // Pinned because both are policy, not implementation detail: the floor is
    // what keeps naby off a rate-limited endpoint, and the ceiling is what stops
    // a stale number being shown forever.
    expect(SUBSCRIPTION_USAGE_TTL_MS).toBe(15 * 60 * 1000);
    expect(SUBSCRIPTION_USAGE_MAX_STALE_MS).toBe(2 * SUBSCRIPTION_USAGE_TTL_MS);
  });
});
