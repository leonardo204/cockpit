'use client';

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { TokenUsage, RateLimitInfo, UsageLimitsSnapshot, UsageWindow } from './types';
import {
  contextGauge,
  formatGaugePercent,
  formatRateLimitPercent,
  formatTokensShort,
  gaugeToneClass,
  rateLimitResetsAtMs,
  usageWindowView,
  type UsageWindowView,
} from './contextGauge';
import { cacheBreakdown, type CacheBreakdownLine } from './cacheBreakdown';

// ============================================
// Token Usage Display
// ============================================
//
// Migrated from src/components/project/ChatHeader.tsx after agent types
// moved into this package (./types). See ChatHeader.tsx in this same
// directory for the original ChatHeader migration note.

interface TokenUsageBarProps {
  tokenUsage: TokenUsage;
  rateLimitInfo?: RateLimitInfo | null;
  /**
   * THE SUBSCRIPTION'S 5-HOUR AND 7-DAY WINDOWS, polled rather than pushed.
   *
   * Optional, and absent is the ordinary case for anything that is not a Claude
   * plan — the ai-sdk engine has no subscription at all. Modelled the way
   * `rateLimitInfo` is for exactly that reason: engine-supplied, absent
   * everywhere else, and never assumed.
   */
  usage?: UsageLimitsSnapshot;
}

export function TokenUsageBar({ tokenUsage, rateLimitInfo, usage }: TokenUsageBarProps) {
  const { t } = useTranslation();

  // Pure derivation, unit-tested in contextGauge.ts — the branch rules ("hide when
  // unmeasured", which denominator to estimate with and when to mark it, the two
  // tier boundaries) are the part that goes quietly wrong, so they do not live in
  // JSX.
  const gauge = contextGauge(
    tokenUsage.contextTokens,
    tokenUsage.contextWindow,
    tokenUsage.contextModel,
  );

  // WHAT THE CACHE PERCENTAGE IS MADE OF, derived once (cacheBreakdown.ts) and
  // read by BOTH the printed percentage and the tooltip's counts — they are the
  // same measurement and must not be able to disagree. It also owns the
  // show-or-not rule the row used to state inline.
  const cache = cacheBreakdown(tokenUsage);

  // "Now" updates every 30s so the countdown stays fresh without calling Date.now()
  // during render (which would violate react-hooks/purity).
  //
  // IT NOW TICKS FOR THE PLAN WINDOWS TOO. The condition used to be
  // `rateLimitInfo?.resetsAt` alone; the plan chip has its own countdowns, and
  // more importantly its expiry rule (an elapsed window renders as nothing) is
  // evaluated against this clock — with a frozen `now` a window that rolled over
  // would keep drawing a stale percentage until something else re-rendered the
  // bar. Still gated: with neither source present there is no countdown on
  // screen, and an interval that updates nothing is an interval that should not
  // be running.
  const [now, setNow] = useState(() => Date.now());
  const hasCountdown = !!rateLimitInfo?.resetsAt || !!usage?.limits;
  useEffect(() => {
    if (!hasCountdown) return;
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, [hasCountdown]);

  // Rate limit status styling
  // ONLY `rejected` IS DRAWN HERE ANY MORE, and the two states that were
  // dropped were dropped because the plan chip now says the same thing better.
  //
  // `allowed_warning` rendered "Approaching Limit 89% · 9h12m" beside a chip
  // already reading "7일 89% (9h12m)" — the same number, the same clock, twice
  // in one row. `allowed` rendered a bare countdown, which is the chip's job
  // too. Neither told the reader anything the chip had not.
  //
  // `rejected` is NOT redundant and stays: it is the only signal that a request
  // was actually REFUSED. A chip at 100% says the window is spent; it cannot
  // say the backend just turned a turn away, and that is the one moment the
  // user needs the row to interrupt them.
  const rateLimitRejected = rateLimitInfo?.status === 'rejected';

  // Format reset time as countdown. The seconds→milliseconds step is NOT done
  // here: the unit is a contract (runtime/engine.ts declares UNIX seconds) and
  // contextGauge.ts owns the single conversion, under test — see
  // `rateLimitResetsAtMs` for why a unit error here would be invisible.
  const formatResetTime = (resetsAt?: number) => {
    const resetsAtMs = rateLimitResetsAtMs(resetsAt);
    if (resetsAtMs === null) return '';
    const diffMs = resetsAtMs - now;
    if (diffMs <= 0) return '';
    const diffMin = Math.ceil(diffMs / 60000);
    if (diffMin < 60) return `${diffMin}m`;
    const diffHr = Math.floor(diffMin / 60);
    const remainMin = diffMin % 60;
    return remainMin > 0 ? `${diffHr}h${remainMin}m` : `${diffHr}h`;
  };

  // Format rateLimitType for display
  const formatLimitType = (type?: string) => {
    if (!type) return '';
    return type.replace(/_/g, ' ');
  };

  // THE ONLY READING OF `utilization` IN THIS FILE. The percentage arithmetic was
  // inlined at four separate points here, each repeating an assumption about a
  // scale the SDK does not document and that has never actually been observed
  // (specs/claude-multi-account.md §4.4, §8) — so a correction would have had to
  // land in four places and would have landed in three. It is derived once, and
  // `null` (no reading) is what the guards below key on, so "no number, no chip"
  // stays structural rather than being re-remembered at each site.
  const utilizationPercent = formatRateLimitPercent(rateLimitInfo?.utilization);

  // -- THE PLAN WINDOWS ------------------------------------------------------
  //
  // WHICH BUCKETS GET A CHIP, AND WHY ONLY THESE TWO. The response can carry five
  // (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`,
  // `seven_day_oauth_apps`). Two are shown:
  //
  //   * They are the two that describe THE PLAN, and every account on a plan has
  //     both. The other three are sub-windows of the same seven-day period that
  //     only bind while a particular model is in use, so a chip for one of them
  //     is blank or irrelevant most of the time — and `seven_day_oauth_apps`
  //     meters third-party OAuth apps, which is a different consumer entirely.
  //   * Five figures do not fit. This row already carries turn input, output,
  //     cache hit, the context gauge and sometimes cost; appending five more
  //     would not be a status bar. That is a layout fact, not a preference.
  //
  // NOTHING IS DISCARDED, THOUGH. Every bucket the response actually contained is
  // listed in the tooltip below, which is the mechanism this row already uses for
  // every other hint (both rate-limit spans and the gauge) — a native `title`, so
  // it survives Electron's renderer with no portal and nothing to clip it against
  // the three-panel layout.
  //
  // `usageWindowView` decides SHOW-OR-NOT, and its rule is the one worth knowing:
  // a window whose reset has already passed renders as NOTHING, not as 0% and not
  // as its old percentage. It is pure and clock-injected so that branch is tested.
  const fiveHourView = usageWindowView(usage?.limits?.fiveHour, now);
  const sevenDayView = usageWindowView(usage?.limits?.sevenDay, now);
  const showUsage = fiveHourView.show || sevenDayView.show;

  /** One window as the chip prints it — `39% (2h37m)`, `39%`, or `2h37m`. Both
   *  halves are independently optional because the backend really does send one
   *  without the other, and a chip must render whichever it got. */
  const usageText = (view: UsageWindowView): string => {
    if (!view.show) return '';
    if (view.percent && view.countdown) return `${view.percent} (${view.countdown})`;
    return view.percent ?? view.countdown ?? '';
  };

  /** The tooltip. Multi-line, because these are several distinct facts rather
   *  than one sentence — and the last two exist so the number can be READ
   *  CORRECTLY: which sources stand behind it, and how old it is. A merged
   *  reading and a single-source reading are different claims. */
  const usageTitle = (): string => {
    const lines: string[] = [
      t('chat.planUsageHint', {
        defaultValue:
          'How much of your Claude subscription this account has used. The 5-hour and 7-day windows are shown; a window is hidden while its current period is unknown.',
      }),
    ];
    const named = (label: string, w: UsageWindow | undefined): void => {
      const view = usageWindowView(w, now);
      if (!view.show) return;
      lines.push(`${label}: ${usageText(view)}`);
    };
    named(t('chat.planWindowFiveHour', { defaultValue: '5h' }), usage?.limits?.fiveHour);
    named(t('chat.planWindowSevenDay', { defaultValue: '7d' }), usage?.limits?.sevenDay);
    // The buckets that did not earn a chip. Shown under their VENDOR NAMES,
    // spaced out — they are labels to display, never values to branch on.
    for (const [key, w] of Object.entries(usage?.limits?.extra ?? {})) {
      named(key.replace(/_/g, ' '), w);
    }
    if (usage && usage.sources.length > 0) {
      lines.push(
        t('chat.planUsageSources', {
          defaultValue: 'Sources: {{sources}}',
          sources: usage.sources.join(' + '),
        }),
      );
    }
    // THE MULTI-ACCOUNT REFUSAL, SAID OUT LOUD. When Claude Code on this machine
    // is signed into a different subscription its reading is dropped rather than
    // merged, and a user comparing naby's number with their terminal's needs to
    // be able to find out why they differ.
    if (usage?.cliReason === 'different-account') {
      lines.push(
        t('chat.planUsageOtherAccount', {
          defaultValue: "Claude Code's own reading was ignored — it is a different account.",
        }),
      );
    }
    return lines.join('\n');
  };

  // -- THE CACHE TOOLTIP -----------------------------------------------------
  //
  // The request this answers was "for the cache hit, tell me WHICH things were
  // hit", and the line between what that can and cannot mean is drawn in
  // cacheBreakdown.ts. In short: the API reports token counts over a cached
  // PREFIX and never says which blocks inside it were reused, so the honest
  // expansion of `75%` is the three measured categories that make up the turn's
  // input — read from cache, written to cache, sent uncached. Naming content
  // ("the system prompt was hit, the memories were hit") would be inventing an
  // attribution out of numbers that do not carry one; the prefix's composition is
  // therefore described in WORDS, in its own line, and kept away from the counts.

  /** One breakdown line, translated.
   *
   *  THE KEYS ARE LITERAL AT EACH BRANCH, not `chat.${line.kind}Tokens`. An
   *  assembled key is invisible to the both-locales test that greps this file, and
   *  the failure it would let through — a key present in en.json and missing in
   *  ko.json — reaches a Korean user as a raw key path in a tooltip.
   *
   *  The count goes through i18next's `number` formatter rather than
   *  `toLocaleString()` + concatenation, so grouping follows the language the
   *  sentence is written in and the whole line stays one translatable unit. */
  const cacheLineText = (line: CacheBreakdownLine): string => {
    switch (line.kind) {
      case 'read':
        return t('chat.cacheReadTokens', {
          defaultValue: 'Read from cache: {{tokens, number}}',
          tokens: line.tokens,
        });
      case 'write':
        return t('chat.cacheWriteTokens', {
          defaultValue: 'Written to cache this turn: {{tokens, number}}',
          tokens: line.tokens,
        });
      case 'uncached':
        return t('chat.cacheUncachedTokens', {
          defaultValue: 'Sent uncached: {{tokens, number}}',
          tokens: line.tokens,
        });
    }
  };

  /** Multi-line, for the same reason the plan chip's tooltip is: these are
   *  several distinct facts rather than one sentence — what the share is, the
   *  three counts behind it, what the numbers do NOT say, and why a low one is
   *  often nothing to fix. That last line is the question people actually have
   *  when they meet this stat on a session's first turn. */
  const cacheHitTitle = (): string => {
    if (!cache.show) return '';
    return [
      t('chat.cacheHitHint', {
        defaultValue:
          "The share of this turn's input that was reused from the prompt cache. The higher it is, the faster and cheaper the turn.",
      }),
      // WHAT CACHING IS, before what it measured. The counts below mean nothing
      // to a reader who does not know prompt caching exists, and the row gives
      // them no other way to find out — so the mechanism comes first and the
      // numbers follow it.
      //
      // "about a tenth" is not a guess: naby's own pricing table carries
      // `inputPerMTok: 1` against `cachedInputPerMTok: 0.1` for the Anthropic
      // models, cited to anthropic.com/pricing (src/runtime/pricing.ts). It is
      // hedged rather than exact because a tooltip must not read as a quote.
      t('chat.cacheWhatItDoes', {
        defaultValue:
          'Every turn resends everything said so far. The cache lets that repeated part be reused instead of reprocessed, and tokens read from it cost about a tenth as much. The longer the conversation, the more it saves.',
      }),
      ...cache.lines.map(cacheLineText),
      t('chat.cachePrefixNote', {
        defaultValue:
          "What gets cached is the prompt's prefix — the system prompt, the tool definitions and the conversation so far. Which parts inside it were reused is not reported, so only these totals are known.",
      }),
      t('chat.cacheFirstTurnNote', {
        defaultValue:
          "A low figure on a session's first turn is normal: the cache has to be written before it can be read.",
      }),
    ].join('\n');
  };

  /** The gauge's tooltip. The explanation comes FIRST and the raw pair second:
   *  `293,384 / 200,000 · claude-opus-5` was all this said, which is the number
   *  again rather than what it means. */
  const gaugeTitle = (): string => {
    if (!gauge.show) return '';
    return [
      t('chat.contextWindowHint', {
        defaultValue:
          "How much of the model's context window this conversation is holding. Past about 85% it is worth continuing in a new tab.",
      }),
      [
        `${gauge.tokens.toLocaleString()} / ${gauge.window.toLocaleString()}`,
        gauge.approximate
          ? t('chat.contextApproxHint', {
              defaultValue: "Estimated — this model's exact context window is unknown.",
            })
          : null,
        tokenUsage.contextModel || null,
      ]
        .filter(Boolean)
        .join(' · '),
    ].join('\n');
  };

  return (
    <div className="px-4 py-1.5 border-t border-border bg-secondary">
      <div className="flex items-center justify-end gap-4 text-xs text-muted-foreground">
        {/* THE PLAN WINDOWS — 5-hour and 7-day (see the derivation above).

            PLACED FIRST, i.e. leftmost in this right-aligned row, because the row
            now mixes two SCOPES and they should not interleave: this chip is
            about the ACCOUNT and everything to its right is about this
            conversation or this turn. Grouping by scope is also what keeps the
            addition from reading as "two more numbers on the pile".

            ONE CHIP, NOT TWO. Two spans would take two `gap-4` slots and split a
            single fact — "how much of the plan is left" — across the row. Inside
            it the two windows are separated by a thin divider and each carries
            its own tone, so a critical 7-day still goes red on its own without
            colouring a healthy 5-hour.

            Hidden entirely when neither window is showable, which covers every
            failure the feature has: no Agent SDK, no plan on this account, the
            experimental usage method gone, both sources silent, the cached
            reading past its staleness ceiling, or both windows expired. In none
            of those does a zero or an empty chip appear. */}
        {showUsage && (
          <span
            className="flex items-center gap-1.5"
            data-testid="plan-usage-chip"
            title={usageTitle()}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {fiveHourView.show && (
              <span className={gaugeToneClass(fiveHourView.tier)}>
                {t('chat.planWindowFiveHour', { defaultValue: '5h' })}{' '}
                <strong className={fiveHourView.tier === 'neutral' ? 'text-foreground' : undefined}>
                  {usageText(fiveHourView)}
                </strong>
              </span>
            )}
            {fiveHourView.show && sevenDayView.show && <span aria-hidden="true">·</span>}
            {sevenDayView.show && (
              <span className={gaugeToneClass(sevenDayView.tier)}>
                {t('chat.planWindowSevenDay', { defaultValue: '7d' })}{' '}
                <strong className={sevenDayView.tier === 'neutral' ? 'text-foreground' : undefined}>
                  {usageText(sevenDayView)}
                </strong>
              </span>
            )}
          </span>
        )}

        {/* Rate limit warning/rejected indicator */}
        {rateLimitInfo && rateLimitRejected && (
          <span className="flex items-center gap-1 text-red-500"
            title={[
              rateLimitInfo.rateLimitType && `Type: ${formatLimitType(rateLimitInfo.rateLimitType)}`,
              utilizationPercent && `Usage: ${utilizationPercent}`,
              rateLimitInfo.resetsAt && `Resets in: ${formatResetTime(rateLimitInfo.resetsAt)}`,
              rateLimitInfo.isUsingOverage && 'Using overage',
            ].filter(Boolean).join(' · ')}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span>
              <strong>{t('chat.rateLimitRejected', 'Rate Limited')}</strong>
              {/* The reset stays; the percentage does not. At `rejected` the
                  number is 100 and the chip is already showing it — what this
                  line adds is WHEN it lifts. */}
              {rateLimitInfo.resetsAt && ` · ${formatResetTime(rateLimitInfo.resetsAt)}`}
            </span>
          </span>
        )}

        {/* THE WINDOW GAUGE (session-context-management §2.1). It answers the
            question the row could not: how full is the conversation's window.
            Hidden entirely when the last turn reported no per-step usage — that
            is still an absence of measurement, and silence is its honest
            rendering. It is no longer hidden for an unknown WINDOW: a bare
            `293k` was found to say nothing to the reader, so a percentage is
            always shown and an estimated one is prefixed `~` (contextGauge.ts).

            The label is "컨텍스트" / "context". It was "창" / "window", which named
            the mechanism rather than the thing the user is watching fill up; the
            name freed up when the old "컨텍스트" stat became "턴 입력". */}
        {gauge.show && (
          <span
            className={`flex items-center gap-1 ${gaugeToneClass(gauge.tier)}`}
            data-testid="context-window-gauge"
            title={gaugeTitle()}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
            </svg>
            <span>
              {t('chat.contextWindow', { defaultValue: 'context' })}{' '}
              <strong className={gauge.tier === 'neutral' ? 'text-foreground' : undefined}>
                {`${formatGaugePercent(gauge)} (${formatTokensShort(gauge.tokens)}/${formatTokensShort(gauge.window)})`}
              </strong>
            </span>
          </span>
        )}

        {/* TURN INPUT. It had no tooltip at all, and it is the figure in this row
            most often misread — a multi-step turn's sum looks like an occupancy,
            which is the confusion the rename fixed only half of. The hint says
            what it counts and points at the gauge for the other question. */}
        <span
          className="flex items-center gap-1"
          data-testid="turn-input-stat"
          title={t('chat.turnInputHint', {
            defaultValue:
              'Everything this turn sent to the model, summed over its steps and including what was read from cache. It is not how full the context window is — the context figure is.',
          })}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
          </svg>
          {/* "turn input", not "context": this is what the LAST TURN consumed,
              summed over its steps. It was labelled "context" and read as window
              occupancy, which is how a 748k figure ended up on a 200k window. */}
          <span>{t('chat.turnInput')}: <strong className="text-foreground">{(tokenUsage.inputTokens + tokenUsage.cacheReadInputTokens + tokenUsage.cacheCreationInputTokens).toLocaleString()}</strong></span>
        </span>
        <span
          className="flex items-center gap-1"
          data-testid="output-stat"
          title={t('chat.outputHint', {
            defaultValue:
              'What the model produced this turn: its answer plus every tool call it made. Output is billed at a higher rate than input.',
          })}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
          </svg>
          <span>{t('chat.output')}: <strong className="text-foreground">{tokenUsage.outputTokens.toLocaleString()}</strong></span>
        </span>
        {/* CACHE HIT RATE. The label says "적중" / "hit" because "Cache: 7%" reads
            as "7% of something cached" without saying of what; the number is the
            share of THIS turn's input that came from the prompt cache.

            The explanation is a `title`, which is what every other hint in this
            row already uses (both rate-limit spans, the gauge). It is a native
            tooltip, so it survives Electron's renderer unchanged — no portal, no
            z-index, and nothing to clip it against the three-panel layout.

            IT NOW CARRIES THE BREAKDOWN as well as the sentence — see
            `cacheHitTitle` above, and cacheBreakdown.ts for what may and may not
            be claimed about a cache hit. The show-or-not condition moved into the
            same helper: the stat and its explanation now agree by construction
            about whether there is anything to say. */}
        {cache.show && (
          <span
            className="flex items-center gap-1 text-brand"
            data-testid="cache-hit-stat"
            title={cacheHitTitle()}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
            </svg>
            <span>
              {t('chat.cacheHit', { defaultValue: 'Cache hit' })}: {cache.percent}%
            </span>
          </span>
        )}
        {tokenUsage.totalCostUsd > 0 && (
          <span
            className="flex items-center gap-1 text-green-11"
            data-testid="turn-cost-stat"
            title={t('chat.turnCostHint', {
              defaultValue:
                "What this turn's tokens are worth at the provider's metered prices, as it reported them. On a Claude subscription run that is what the same tokens would have cost on the API, not a charge to you.",
            })}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>${tokenUsage.totalCostUsd.toFixed(4)}</span>
          </span>
        )}
      </div>
    </div>
  );
}
