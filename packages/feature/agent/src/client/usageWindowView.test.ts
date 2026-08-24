import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatUsageCountdown,
  rateLimitUtilizationPercent,
  usageTier,
  usageWindowView,
} from './contextGauge';

/**
 * WHAT THE PLAN CHIP DRAWS — and, mostly, WHAT IT REFUSES TO DRAW.
 *
 * The rendering rules live in a pure function with the clock injected, because
 * the branch that matters most is the one nobody can reproduce on demand: what
 * happens in the minutes after a usage window rolls over. jsdom cannot show it, a
 * live subscription will not do it when asked, and getting it wrong produces a
 * confident number rather than a visible fault.
 */

const NOW = 1_787_531_824_602;
/** UNIX SECONDS, which is the unit both usage sources are normalised to. */
const sec = (ms: number) => Math.floor(ms / 1000);

describe('usageWindowView — the expiry rule', () => {
  it('shows a percentage and a countdown for a live window', () => {
    const view = usageWindowView(
      { utilizationPercent: 39, resetsAt: sec(NOW + 2 * 3600_000 + 37 * 60_000) },
      NOW,
    );
    expect(view).toMatchObject({ show: true, percent: '39%', countdown: '2h37m', tier: 'neutral' });
  });

  it('HIDES a window whose reset has already passed — not 0%, not the old number', () => {
    // THE JUDGEMENT CALL OF THE FEATURE, pinned here.
    //
    // A reading is a pair: "84% used, of the window ending at T". Once T has
    // passed, that window is over. Showing `84%` asserts something about the NEW
    // window that was never measured — and since the merge is pessimistic, that
    // stale number would sit there telling a user with a fresh window they are
    // nearly out. Showing `0%` invents the opposite. Silence is the only honest
    // one, and it lasts at most until the next refresh.
    expect(usageWindowView({ utilizationPercent: 84, resetsAt: sec(NOW - 1000) }, NOW)).toEqual({
      show: false,
    });
    // Exactly at the boundary counts as expired: a window resetting this instant
    // is no longer the window the percentage describes.
    expect(usageWindowView({ utilizationPercent: 84, resetsAt: sec(NOW) }, NOW).show).toBe(false);
  });

  it('still shows a window that reported no reset at all', () => {
    // ABSENT IS NOT ELAPSED. The backend genuinely sends a utilization with a
    // null `resets_at`, and the percentage is still the best thing known.
    const view = usageWindowView({ utilizationPercent: 12 }, NOW);
    expect(view).toMatchObject({ show: true, percent: '12%', countdown: null });
  });

  it('shows a countdown alone when there is no percentage', () => {
    const view = usageWindowView({ resetsAt: sec(NOW + 90 * 60_000) }, NOW);
    expect(view).toMatchObject({ show: true, percent: null, countdown: '1h30m', tier: 'neutral' });
  });

  it('shows nothing at all when the window carried neither reading', () => {
    expect(usageWindowView({}, NOW)).toEqual({ show: false });
    expect(usageWindowView(null, NOW)).toEqual({ show: false });
    expect(usageWindowView(undefined, NOW)).toEqual({ show: false });
  });

  it('renders 0% as a reading, because a window that just reset really is 0%', () => {
    // The one place a zero is legitimate — and it is distinguishable from absence
    // precisely because absence is `undefined`, never a falsy number.
    const view = usageWindowView({ utilizationPercent: 0, resetsAt: sec(NOW + 3600_000) }, NOW);
    expect(view).toMatchObject({ show: true, percent: '0%' });
  });

  it('renders over-100 rather than clamping it', () => {
    const view = usageWindowView({ utilizationPercent: 137, resetsAt: sec(NOW + 3600_000) }, NOW);
    expect(view).toMatchObject({ show: true, percent: '137%', tier: 'critical' });
  });

  it('refuses a nonsense percentage instead of printing NaN%', () => {
    expect(usageWindowView({ utilizationPercent: NaN }, NOW)).toEqual({ show: false });
    expect(usageWindowView({ utilizationPercent: -5 }, NOW)).toEqual({ show: false });
  });
});

describe('usageTier — the same two boundaries the context gauge uses', () => {
  it('escalates at 70 and 85', () => {
    expect(usageTier(69)).toBe('neutral');
    expect(usageTier(70)).toBe('warn');
    expect(usageTier(84)).toBe('warn');
    expect(usageTier(85)).toBe('critical');
  });
});

describe('formatUsageCountdown — two units, never three', () => {
  it('reads minutes, hours, and DAYS', () => {
    expect(formatUsageCountdown(39 * 60_000)).toBe('39m');
    expect(formatUsageCountdown(2 * 3600_000 + 37 * 60_000)).toBe('2h37m');
    expect(formatUsageCountdown(3 * 3600_000)).toBe('3h');
    // DAYS ARE WHY THIS FUNCTION EXISTS. The bar's older `formatResetTime` tops
    // out at hours, which turns the 7-day window into `163h` — a figure nobody
    // reads as "most of a week".
    expect(formatUsageCountdown((4 * 24 + 7) * 3600_000)).toBe('4d7h');
    expect(formatUsageCountdown(4 * 24 * 3600_000)).toBe('4d');
  });

  it('returns nothing for an elapsed or nonsense span, never `0m`', () => {
    expect(formatUsageCountdown(0)).toBeNull();
    expect(formatUsageCountdown(-1)).toBeNull();
    expect(formatUsageCountdown(NaN)).toBeNull();
  });
});

describe('the two utilization scales must not be confused', () => {
  it('the PUSH helper scales by 100 and the POLL view does not', () => {
    // `rate_limit_event.utilization` is assumed to be a 0..1 fraction (it has
    // never actually been observed). The polled `utilizationPercent` is
    // documented and observed as 0-100. Feeding one to the other's formatter
    // renders 84 as `8400%`, which is why the field names differ.
    expect(rateLimitUtilizationPercent(0.84)).toBe(84);
    expect(usageWindowView({ utilizationPercent: 84 }, NOW)).toMatchObject({ percent: '84%' });
  });
});

describe('source assertion — the bar shows two windows and tooltips the rest', () => {
  const BAR = readFileSync(join(__dirname, 'TokenUsageBar.tsx'), 'utf8');

  it('renders chips for exactly the 5-hour and 7-day windows', () => {
    // Five chips is not a status bar (this row already carries turn input,
    // output, cache hit and the context gauge). jsdom computes every width as 0,
    // so a mounted test cannot see crowding — the guard is the source.
    expect(BAR).toContain('usageWindowView(usage?.limits?.fiveHour, now)');
    expect(BAR).toContain('usageWindowView(usage?.limits?.sevenDay, now)');
    expect(BAR).not.toContain("limits?.seven_day_opus");
  });

  it('lists the remaining buckets in the tooltip rather than dropping them', () => {
    expect(BAR).toContain("usage?.limits?.extra ?? {}");
  });

  it('draws one chip, not two row items', () => {
    // Two spans would take two `gap-4` slots and split one fact across the row.
    expect(BAR.match(/data-testid="plan-usage-chip"/g)).toHaveLength(1);
  });
});
