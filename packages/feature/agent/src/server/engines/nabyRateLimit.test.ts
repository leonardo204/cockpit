import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { describeRateLimit } from '../../../../../../../dist/naby-runtime.mjs';
import { toRateLimitRunEvent } from './naby';
import { rateLimitResetsAtMs } from '../../client/contextGauge';

/**
 * THE SUBSCRIPTION LIMIT, FROM THE SDK MESSAGE TO THE CHIP (specs/claude-multi-
 * account.md §3.3, §3.4, §4.3).
 *
 * This is asserted against a CAPTURED FIXTURE and not against a live run, and
 * that is not a convenience — it is the only option there is. A subscription
 * cannot be driven into `allowed_warning` on demand, the packaged app does not
 * ship the Agent SDK at all, and the event fires when the backend decides its
 * limit information changed. So the two hops are pure functions and the message
 * below is a real one, copied verbatim off a live turn.
 *
 * THE FIXTURE IS THE DESIGN ARGUMENT, so read it before the tests: it has NO
 * `utilization`. That absence is why the feature does not promise a percentage
 * gauge (§3.4) and why every reading of that field is guarded. A test suite that
 * only exercised a fully-populated event would be testing a shape that has never
 * been seen.
 */

/** Verbatim from a live turn. `resetsAt` is UNIX SECONDS. */
const OBSERVED_EVENT = {
  type: 'rate_limit_event',
  uuid: '00000000-0000-0000-0000-000000000000',
  session_id: 'sess-observed',
  rate_limit_info: {
    status: 'allowed',
    resetsAt: 1_786_426_200,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    overageDisabledReason: 'org_level_disabled',
    isUsingOverage: false,
  },
};

describe('describeRateLimit — the SDK message becomes a runtime event', () => {
  it('carries every field of the observed event across', () => {
    const ev = describeRateLimit(OBSERVED_EVENT);
    expect(ev).toEqual({
      kind: 'rate_limit',
      status: 'allowed',
      resetsAt: 1_786_426_200,
      limitType: 'five_hour',
      overageStatus: 'rejected',
      overageDisabledReason: 'org_level_disabled',
    });
  });

  it('does not invent a utilization the backend never sent', () => {
    // The absence IS the observed behaviour (§3.4). If this key ever appears by
    // default — as a 0, as a null — the bar would draw a "0% used" chip on an
    // account whose usage is simply unknown.
    const ev = describeRateLimit(OBSERVED_EVENT);
    expect(ev).not.toHaveProperty('utilization');
    expect(Object.keys(ev as object)).not.toContain('utilization');
  });

  it('omits `isUsingOverage` rather than reporting a false as a fact', () => {
    // The observed event says `false`. Absent and false render identically, and
    // absent is the honest one: an account with no overage at all sends nothing.
    expect(describeRateLimit(OBSERVED_EVENT)).not.toHaveProperty('isUsingOverage');
  });

  it('carries a utilization THROUGH, unnormalized, when one does arrive', () => {
    // The other half of the coverage: the field has never been observed, but the
    // SDK declares it, so the path must exist and must not scale anything. The
    // one place a scale is applied is the client's normalization function.
    const ev = describeRateLimit({
      rate_limit_info: { status: 'allowed_warning', utilization: 0.83, rateLimitType: 'seven_day' },
    });
    expect(ev).toEqual({
      kind: 'rate_limit',
      status: 'allowed_warning',
      limitType: 'seven_day',
      utilization: 0.83,
    });
  });

  it('reports a rejection with its overage and threshold detail', () => {
    const ev = describeRateLimit({
      rate_limit_info: {
        status: 'rejected',
        resetsAt: 1_786_426_200,
        rateLimitType: 'seven_day_opus',
        overageStatus: 'allowed',
        overageResetsAt: 1_786_512_600,
        overageInUse: true,
        surpassedThreshold: 0.95,
      },
    });
    expect(ev).toMatchObject({
      status: 'rejected',
      overageStatus: 'allowed',
      overageResetsAt: 1_786_512_600,
      // `overageInUse` is the SDK's second spelling of the same fact; either one
      // means the account is spending overage, which is the field that changes
      // what the usage COSTS.
      isUsingOverage: true,
      surpassedThreshold: 0.95,
    });
  });

  it('says nothing at all rather than guessing a status', () => {
    // `status` is the field the display branches on (silence / amber / red).
    // Defaulting an unrecognised value to `allowed` would report an account as
    // healthy on the strength of a string we do not understand.
    expect(describeRateLimit({ rate_limit_info: { status: 'throttled_maybe' } })).toBeNull();
    expect(describeRateLimit({ rate_limit_info: { resetsAt: 1_786_426_200 } })).toBeNull();
    expect(describeRateLimit({ rate_limit_info: null })).toBeNull();
    expect(describeRateLimit({})).toBeNull();
    expect(describeRateLimit(undefined)).toBeNull();
    expect(describeRateLimit('rate_limit_event')).toBeNull();
  });

  it('drops a number that is not one, instead of rendering NaN', () => {
    const ev = describeRateLimit({
      rate_limit_info: { status: 'allowed', resetsAt: Number.NaN, utilization: Number.NaN },
    });
    expect(ev).toEqual({ kind: 'rate_limit', status: 'allowed' });
  });

  it('drops a window name that is not a short label', () => {
    // Same rule every other echoed string in that engine follows: these two are
    // RENDERED, and a backend field is not a licence to put arbitrary text on
    // screen.
    const ev = describeRateLimit({
      rate_limit_info: {
        status: 'allowed',
        rateLimitType: 'five hour <script>alert(1)</script>',
        overageDisabledReason: 'x'.repeat(200),
      },
    });
    expect(ev).toEqual({ kind: 'rate_limit', status: 'allowed' });
  });
});

describe('toRateLimitRunEvent — the runtime event becomes what the client reads', () => {
  const runtimeEvent = describeRateLimit(OBSERVED_EVENT) as NonNullable<
    ReturnType<typeof describeRateLimit>
  >;

  it('emits the exact shape useChatStream destructures', () => {
    // The client half has been complete for a while and unreachable: it reads
    // `event.rate_limit_info` off an event whose type is `rate_limit_event`. If
    // either name drifts, the handler silently does nothing and the chip stays
    // dark — which is precisely the state this change is fixing.
    const emitted = toRateLimitRunEvent(runtimeEvent, 'sess-1');
    expect(emitted.type).toBe('rate_limit_event');
    expect(emitted.session_id).toBe('sess-1');
    expect(emitted.rate_limit_info).toEqual({
      status: 'allowed',
      resetsAt: 1_786_426_200,
      // RENAMED: the runtime says `limitType`, the client says `rateLimitType`.
      // The adapter is the one place the two vocabularies may meet.
      rateLimitType: 'five_hour',
      overageStatus: 'rejected',
      overageDisabledReason: 'org_level_disabled',
    });
  });

  it('leaves an unknown field absent rather than defaulting it', () => {
    // The client guards with `!= null` and truthiness. A defaulted `resetsAt: 0`
    // would become "resets now"; a defaulted `utilization: 0` would draw a chip
    // claiming an account is empty (§2-3: a wrong number is worse than none).
    const emitted = toRateLimitRunEvent({ kind: 'rate_limit', status: 'allowed' }, 'sess-1');
    expect(emitted.rate_limit_info).toEqual({ status: 'allowed' });
  });

  it('preserves the full round trip, SDK message → chip input', () => {
    const emitted = toRateLimitRunEvent(
      describeRateLimit(OBSERVED_EVENT) as never,
      'sess-1',
    ).rate_limit_info as Record<string, unknown>;
    expect(emitted.status).toBe(OBSERVED_EVENT.rate_limit_info.status);
    expect(emitted.rateLimitType).toBe(OBSERVED_EVENT.rate_limit_info.rateLimitType);
    expect(emitted.resetsAt).toBe(OBSERVED_EVENT.rate_limit_info.resetsAt);
  });
});

describe('resetsAt keeps ONE unit from the SDK message to the countdown', () => {
  /**
   * THE UNIT IS THE ONE THING HERE THAT CAN BE WRONG WITHOUT LOOKING WRONG.
   * Nothing on this path throws on a unit error: seconds read as milliseconds put
   * the reset in 1970 and the countdown renders empty, milliseconds read as
   * seconds put it fifty thousand years out and the chip renders a confident
   * enormous number. So the contract — UNIX SECONDS, unconverted at every hop —
   * is pinned end to end here rather than assumed at each seam.
   */
  it('is not scaled by either hop, and lands on the right instant at the client', () => {
    const runtime = describeRateLimit(OBSERVED_EVENT) as { resetsAt: number };
    expect(runtime.resetsAt).toBe(1_786_426_200);

    const emitted = toRateLimitRunEvent(runtime as never, 'sess-1').rate_limit_info as {
      resetsAt: number;
    };
    expect(emitted.resetsAt).toBe(1_786_426_200);

    // And the client's single conversion — the function TokenUsageBar's countdown
    // now calls — turns that into the moment it actually names.
    expect(new Date(rateLimitResetsAtMs(emitted.resetsAt) as number).toISOString()).toBe(
      '2026-08-11T05:30:00.000Z',
    );
  });
});

describe('the adapter actually emits it', () => {
  /**
   * A SOURCE ASSERTION, for the reason this codebase already uses them (see
   * shell/CLAUDE.md): the thing at risk is a WIRE, and no unit test can see it.
   * The runtime event is produced inside `runTurn` by the Agent SDK engine — a
   * package the packaged app deliberately does not ship and that this suite never
   * loads — so there is no way to make a real turn emit one. Both ENDS are unit
   * tested above; what is left to protect is that the switch still joins them,
   * because deleting the case would break nothing that any other test can notice
   * and would put the display back exactly where it was found: dark.
   */
  const source = readFileSync(join(__dirname, 'naby.ts'), 'utf8');

  it('handles the runtime kind in the event switch and emits the mapped event', () => {
    expect(source).toContain("case 'rate_limit':");
    expect(source).toContain('ctx.emit(toRateLimitRunEvent(ev, sessionId))');
  });

  it('does not dedupe or cap it the way harness events are capped', () => {
    // Deliberate: the harness case exists to survive a backend loop emitting the
    // same label thousands of times. A limit reading REPLACES the last one and
    // arrives a handful of times at most, so suppressing a repeat would hold back
    // the freshest reading and a cap would freeze the chip mid-turn.
    const caseBody = source.slice(
      source.indexOf("case 'rate_limit':"),
      source.indexOf("case 'error':", source.indexOf("case 'rate_limit':")),
    );
    expect(caseBody).not.toContain('harnessSeen');
    expect(caseBody).not.toContain('CAP');
  });
});
