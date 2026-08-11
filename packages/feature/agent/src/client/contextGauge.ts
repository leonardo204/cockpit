// packages/feature/agent/src/client/contextGauge.ts
//
// HOW FULL IS THE WINDOW — the derivation, kept pure (specs/session-context-
// management.md §2.1).
//
// The number itself is a MEASUREMENT taken by the engine (the last step's reported
// input tokens, cache reads included) and the exact window comes from the runtime's
// model registry; both arrive on the turn's `result` event, along with the concrete
// model id the provider actually served. All that is left is the part that is easy
// to get quietly wrong — which denominator to divide by when the registry has no
// exact one, and which of the three tiers the result falls in — so it lives here,
// away from JSX, and is asserted directly.
//
// THE RULE THAT DECIDES EVERY BRANCH USED TO BE "never divide by a guess": no
// measurement → show nothing, measurement with no known window → show the count
// and NO ratio.
//
// THE SECOND HALF OF THAT RULE IS REVISED (spec §2.1, v0.3.0), because it failed
// in practice. `293k` on its own told the reader nothing at all — it is not an
// amount of anything they can act on — and it turned out to be the COMMON case,
// not the exotic one: the app's default Claude path names its model `default`,
// which no registry can size. So an estimate is now shown, and the honesty the old
// rule was protecting is carried by MARKING it:
//
//   * exact window, occupancy inside it   → `66%`  (approximate: false)
//   * measurement EXCEEDS the exact window → the next larger tier that family
//     ships, marked `~` — a 293k reading on a 200k Claude window means the run is
//     on the long-context tier, and the reading is better evidence of that than
//     our own configuration is
//   * no window at all                    → the family's default, marked `~`
//
// AND ONE THING THE ESTIMATE MAY NOT DO: it may not push the user to act. The
// "this conversation is long — continue in a new tab" banner keys on
// `atThreshold`, which stays FALSE for an approximate reading. Telling someone
// their conversation is nearly full is a claim; a guessed denominator is not
// enough to make it.

/** The tiers, in the order they escalate. `neutral` is the ordinary state and gets
 *  the muted colour every other stat in the bar already uses. */
export type ContextGaugeTier = 'neutral' | 'warn' | 'critical';

/** 70% — the first tier boundary (§2.1). */
export const GAUGE_WARN_RATIO = 0.7;
/** 85% — the second, and the point at which the input banner appears (§2.1). */
export const GAUGE_CRITICAL_RATIO = 0.85;

/**
 * The window sizes each family ships, ascending.
 *
 * They are the ESCALATION LADDER, not a catalog: when a measurement exceeds the
 * window we believed, the next rung up is the smallest size that could actually
 * have held it. The exact sizes still come from the runtime registry — these are
 * only consulted once a reading has already proved the exact answer wrong, or when
 * there was never one.
 *
 * Kept deliberately small. A rung that does not correspond to a real product would
 * make the escalation land on a denominator nothing runs in.
 */
const LADDERS: Record<ModelFamily, readonly number[]> = {
  // 200k standard, 1M on the long-context tier.
  claude: [200_000, 1_000_000],
  // 128k (4o), 200k (o-series), 272k input (GPT-5), 1,047,576 (GPT-4.1).
  openai: [128_000, 200_000, 272_000, 1_047_576],
  // One size across 1.5 and 2.x.
  gemini: [1_048_576],
  // Every rung any supported provider ships, since we cannot narrow it.
  unknown: [128_000, 200_000, 272_000, 1_048_576],
};

/**
 * The denominator to estimate with when there is no exact one.
 *
 * Claude gets 200k and OpenAI 128k because those are the sizes their ordinary
 * models ship; an unknown family gets 128k for the reason the runtime's
 * compaction fallback uses it — it is the smallest window any provider we support
 * ships, so the estimate errs toward "fuller than reality", which prompts the user
 * early rather than never. Gemini has only one size, so its default is exact in
 * everything but name.
 */
const FAMILY_DEFAULTS: Record<ModelFamily, number> = {
  claude: 200_000,
  openai: 128_000,
  gemini: 1_048_576,
  unknown: 128_000,
};

type ModelFamily = 'claude' | 'openai' | 'gemini' | 'unknown';

/**
 * Which family a concrete model id belongs to.
 *
 * The id here is what the PROVIDER reported it served (`context_model`), not what
 * we asked for — so the aliases are matched too, for the case where the run
 * reported nothing and the caller passed the requested label instead.
 */
export function modelFamily(model: string | undefined): ModelFamily {
  const id = (model ?? '').trim().toLowerCase();
  if (!id) return 'unknown';
  if (id.includes('claude') || id === 'opus' || id === 'sonnet' || id === 'haiku' || id === 'fable') {
    return 'claude';
  }
  if (id.startsWith('gemini')) return 'gemini';
  if (id.startsWith('gpt') || id.includes('codex') || /^o[1-9](-|$)/.test(id)) return 'openai';
  return 'unknown';
}

export type ContextGauge =
  | { show: false }
  | {
      show: true;
      /** The measured occupancy, in tokens. Always present when `show`. */
      tokens: number;
      /** The denominator the percentage was taken against. Always present now —
       *  when the registry knew none, this is the family estimate. */
      window: number;
      /** 0..100, rounded. Always present when `show`. */
      percent: number;
      /** True when `window` is an ESTIMATE (a family default, or an escalation
       *  after the measurement exceeded the exact window) rather than the size
       *  the provider publishes for this model. Rendered as a `~` prefix. */
      approximate: boolean;
      tier: ContextGaugeTier;
      /** True at or above 85% ON AN EXACT WINDOW — what the "continue in a new
       *  tab" banner keys on. Deliberately false for an approximate reading: the
       *  percentage is worth showing, but not worth interrupting someone over. */
      atThreshold: boolean;
    };

/** Climb `ladder` (non-empty, ascending) to the smallest rung that could hold
 *  `tokens`. Returns the top rung when nothing does — a reading past every window
 *  any provider ships is beyond anything this can explain, and the honest
 *  rendering is then a percentage over 100 on the largest thing that exists. */
function escalate(ladder: readonly number[], tokens: number): number {
  for (const rung of ladder) {
    if (tokens <= rung) return rung;
  }
  return ladder[ladder.length - 1] as number;
}

/**
 * Derive what the status bar should show.
 *
 * `tokens` undefined (or non-positive) hides the gauge entirely: it means no step
 * of the last turn reported usage, and the honest rendering of "we did not measure
 * it" is silence, not a zero. That branch is unchanged — the revision above is
 * about the DENOMINATOR, not about inventing a numerator.
 *
 * `window` is the registry's exact answer, when it had one. `model` is the
 * concrete id the provider served, used only to pick a family when the exact
 * answer is missing or has been disproved by the measurement itself.
 */
export function contextGauge(
  tokens: number | undefined,
  window: number | undefined,
  model?: string,
): ContextGauge {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) {
    return { show: false };
  }

  const exact = typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : undefined;
  const family = modelFamily(model);

  let denominator: number;
  let approximate: boolean;
  if (exact !== undefined && tokens <= exact) {
    denominator = exact;
    approximate = false;
  } else if (exact !== undefined) {
    // The measurement disproves the window we were given. Trust the measurement:
    // it is a fact about this run, and the window was an inference from an id.
    // The climb starts strictly ABOVE the disproved rung so a ladder containing
    // it cannot answer with it again; with nothing above it, we have nothing
    // better to offer and keep it — the percentage then reads over 100, which is
    // exactly what "this run is bigger than every window we know of" looks like.
    const above = LADDERS[family].filter((rung) => rung > exact);
    denominator = above.length > 0 ? escalate(above, tokens) : exact;
    approximate = true;
  } else {
    const guess = FAMILY_DEFAULTS[family];
    denominator = tokens <= guess ? guess : escalate(LADDERS[family], tokens);
    approximate = true;
  }

  const ratio = tokens / denominator;
  const percent = Math.round(ratio * 100);
  const tier: ContextGaugeTier =
    ratio >= GAUGE_CRITICAL_RATIO ? 'critical' : ratio >= GAUGE_WARN_RATIO ? 'warn' : 'neutral';
  return {
    show: true,
    tokens,
    window: denominator,
    percent,
    approximate,
    tier,
    atThreshold: !approximate && ratio >= GAUGE_CRITICAL_RATIO,
  };
}

/** `132000` → `132k`. Compact because this sits in a one-line stats row beside
 *  three other numbers; exact token counts are in the usage modal. */
export function formatTokensShort(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const k = tokens / 1000;
  // One decimal below 10k (`8.4k` reads better than `8k` when it matters), whole
  // thousands above it (`132k`, not `132.4k`).
  return k < 10 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
}

/** The percentage as the bar prints it — `66%`, or `~29%` when the denominator is
 *  an estimate. The tilde is the whole honesty mechanism, so it is produced here
 *  rather than assembled in JSX where it could be dropped from one of two call
 *  sites. */
export function formatGaugePercent(gauge: { percent: number; approximate: boolean }): string {
  return `${gauge.approximate ? '~' : ''}${gauge.percent}%`;
}

/**
 * THE ONE PLACE THE SUBSCRIPTION'S `utilization` BECOMES A PERCENTAGE
 * (specs/claude-multi-account.md §4.4).
 *
 * It lives beside the context gauge because it is the same KIND of thing and
 * carries the same hazard: a number arrives from a backend, and the honest
 * rendering of it depends on knowing something about it that is not written down.
 * The gauge's version of that is which denominator it may divide by; this one's
 * is what scale the numerator is already on.
 *
 * ⚠️ THE SCALE IS UNVERIFIED, AND THAT IS THE REASON THIS FUNCTION EXISTS.
 * The SDK's `SDKRateLimitInfo` documents `utilization` as a bare `number` and
 * says nothing about its range, and in the readings actually observed from a live
 * subscription THE FIELD DID NOT APPEAR AT ALL — the event carried `status`,
 * `resetsAt` and `rateLimitType` and nothing else. So there has never been a
 * value to check the assumption against.
 *
 * The bar was doing `utilization * 100` inline in FOUR places, which meant the
 * unverified assumption (that this is a 0..1 fraction) was written down four
 * times and could be corrected in three. It is written once now. When a real
 * value is finally observed — if it turns out to be 0..100 already, this becomes
 * an identity — this is the only line that changes, and the four call sites are
 * correct by construction.
 *
 * RETURNS null WHEN THERE IS NO VALUE, and every caller must render nothing for
 * null. That is the spec's rule (§2-3, §4.1): a limit reading is something the
 * backend either gives us or does not, and a missing one is not zero. `0` is a
 * legitimate reading (a freshly reset window) and is deliberately NOT folded in
 * with absence — hence null rather than a falsy number.
 */
export function rateLimitUtilizationPercent(utilization: number | null | undefined): number | null {
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return null;
  // The assumption, stated once: a 0..1 fraction.
  return Math.round(utilization * 100);
}

/** The percentage as the limit chip prints it — `83%` — or null when there is no
 *  reading, so a caller cannot accidentally render the string "null%". Formatting
 *  lives next to the arithmetic for the same reason `formatGaugePercent` does:
 *  the two call sites must not be able to drift apart. */
export function formatRateLimitPercent(utilization: number | null | undefined): string | null {
  const percent = rateLimitUtilizationPercent(utilization);
  return percent === null ? null : `${percent}%`;
}

/**
 * `resetsAt` AS A JAVASCRIPT TIMESTAMP — the seconds/milliseconds boundary, in
 * one place and under test.
 *
 * THE CONTRACT SAYS SECONDS. The runtime declares `resetsAt` in UNIX SECONDS
 * (runtime/engine.ts) and the shell adapter passes it across unconverted, because
 * the backend sends seconds — an observed reading is `1786426200`, which is
 * 2026-08-11T05:30Z as seconds. Everything from here on is `Date.now()`'s scale,
 * so the conversion happens exactly once, here.
 *
 * THE HEURISTIC IS KEPT ANYWAY, and deliberately. A unit is the one thing about
 * this value that goes wrong SILENTLY in both directions — read seconds as
 * milliseconds and the reset lands in 1970, so the countdown renders nothing at
 * all; read milliseconds as seconds and it lands roughly fifty thousand years
 * out, and the chip confidently says `438000000h`. Neither throws and neither
 * looks like a bug. So the contract is asserted in tests and this guard makes a
 * violation of it degrade to the right answer rather than to a wrong one: any
 * value below 1e12 (i.e. before 2001 when read as ms — no reset is ever in the
 * past) is seconds.
 */
export function rateLimitResetsAtMs(resetsAt: number | null | undefined): number | null {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) || resetsAt <= 0) return null;
  return resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
}

/** The Tailwind text colour for a tier, reusing the classes the bar already uses
 *  for its other states (muted / amber / red) so nothing new enters the palette. */
export function gaugeToneClass(tier: ContextGaugeTier): string {
  return tier === 'critical'
    ? 'text-red-500'
    : tier === 'warn'
      ? 'text-yellow-500'
      : 'text-muted-foreground';
}
