'use client';

/**
 * Phase 3 (P3-M5) — THE GROWTH PANEL: 알 → 애벌레 → 번데기 → 나비.
 *
 * Reads `POST /api/naby {growth.get}` and shows how far an agent can be trusted,
 * with the one thing a meter like this owes its user: an honest reason when it
 * goes DOWN. A number that only ever rises is decoration; a number that falls
 * without explanation is worse than no number.
 *
 * WHAT THIS PANEL IS CAREFUL ABOUT
 *
 *  1. It says what does NOT move the meter. Users assume a "learning rate" counts
 *     conversations or stored memories. This one counts only whether naby's own
 *     recommendation matched what the user then chose, so the panel says so
 *     outright — otherwise the number looks arbitrary and gets ignored.
 *  2. The regression sentence is built from a REASON CODE plus real counts, never
 *     from prose the server wrote. `diagnoseChange` is deterministic, so the
 *     explanation is reproducible and cannot invent a cause; this file turns the
 *     code into the user's language.
 *  3. It never prints two numbers that disagree. In the egg stage the gauge is
 *     suppressed in favour of "how many more answers are needed", and a
 *     tripwire-blocked agent shows why the gauge stops just short.
 *  4. `boundDeltaPoints` is deliberately NOT rendered as a percentage — it is on
 *     the raw-bound scale, not the gauge's. The sentence leads with the counts a
 *     user can check against their own conversation instead.
 *  5. P3-M8c: the LEARNING block sits below a divider, in its own box, with its
 *     own heading and a closing line that says outright that none of it enters
 *     the butterfly judgement. It is the one place on this screen where counts
 *     appear, and rule 3 above is exactly why it has to disown the gauge: a user
 *     who reads "47 facts learned" next to "Egg — not measured yet" will believe
 *     the bigger number unless told, in that spot, which question each answers.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** The wire shape of `growth.get`. Declared locally, like the other naby action
 *  responses in this package: the panel is an HTTP client, not a server import. */
type GrowthWire = {
  stage: 'egg' | 'larva' | 'pupa' | 'butterfly';
  percent: number;
  addressable: boolean;
  hits: number;
  trials: number;
  lifetimeHits: number;
  lifetimeTrials: number;
  needsMoreSamples: number;
  coverage: number;
  correctedAfter: number;
  tripwires: number;
  excluded: number;
  blockedByTripwire?: boolean;
  brier?: number;
  brierSamples: number;
  ask?: {
    precision: number;
    recall: number;
    warrantedAsks: number;
    unnecessaryAsks: number;
    missedAsks: number;
    correctSilences: number;
    samples: number;
  };
  ledgerRows: number;
  change: {
    direction: 'up' | 'down' | 'flat';
    code: 'not-measured' | 'new-pattern' | 'accuracy-drop' | 'accuracy-gain' | 'evidence-grew' | 'steady';
    boundDeltaPoints: number;
    taskType?: string;
    recentMisses?: number;
    recentTrials?: number;
  };
  byTaskType: Array<{
    taskType: string;
    stage: GrowthWire['stage'];
    percent: number;
    hits: number;
    trials: number;
  }>;
  recentDecisions: Array<{
    at: number;
    question: string;
    options: string[];
    recommended: number;
    chosen: number;
    hit: boolean;
    taskType?: string;
    correction?: string;
    excludedCode?: string;
  }>;
};

/** The wire shape of the P3-M8c learning block. A SIBLING of `growth`, not a
 *  field inside it — see note 5 in the header. */
type LearningWire = {
  confirmedByScope: { session?: number; project?: number; user: number; org?: number };
  confirmedTotal: number;
  proposedCount: number;
  corroborated2Plus: number;
  distinctTaskTypes: number;
  lastReflectionAt?: number;
};

const STAGES: Array<GrowthWire['stage']> = ['egg', 'larva', 'pupa', 'butterfly'];
const GLYPH: Record<GrowthWire['stage'], string> = {
  egg: '🥚',
  larva: '🐛',
  pupa: '🛡',
  butterfly: '🦋',
};

type GrowthResponse = { growth: GrowthWire; learning: LearningWire | null };

async function fetchGrowth(agentId: string, cwd?: string): Promise<GrowthResponse | null> {
  try {
    const res = await fetch('/api/naby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'growth.get', agentId, ...(cwd ? { cwd } : {}) }),
    });
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; growth?: GrowthWire; learning?: LearningWire }
      | null;
    if (!res.ok || !json?.ok || !json.growth) return null;
    // The learning block is OPTIONAL on the wire: an older server (or a store
    // that could not be read) simply omits it, and the section is not rendered.
    // The meter must never depend on it — that is the same separation the
    // section's own copy states to the user.
    return { growth: json.growth, learning: json.learning ?? null };
  } catch {
    return null;
  }
}

export function GrowthPanel({ agentId, cwd }: { agentId: string; cwd?: string }) {
  const { t } = useTranslation();
  const [g, setG] = useState<GrowthWire | null>(null);
  const [learning, setLearning] = useState<LearningWire | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const next = await fetchGrowth(agentId, cwd);
    setG(next?.growth ?? null);
    setLearning(next?.learning ?? null);
    setFailed(next === null);
    setLoading(false);
  }, [agentId, cwd]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="mt-2 rounded-lg border border-border bg-muted/30 p-3 text-[11px] text-muted-foreground">
        {t('growth.loading', { defaultValue: 'Reading the record…' })}
      </div>
    );
  }
  if (failed || !g) {
    return (
      <div className="mt-2 rounded-lg border border-border bg-muted/30 p-3 text-[11px] text-muted-foreground">
        {t('growth.unavailable', { defaultValue: 'The growth record could not be read.' })}
      </div>
    );
  }

  const stageName = (s: GrowthWire['stage']) => t(`growth.stage.${s}`, { defaultValue: s });

  // -- the reason sentence -------------------------------------------------
  // Every branch carries the counts, so the user can check the claim against
  // their own conversation rather than taking the meter's word for it.
  const c = g.change;
  const reason =
    c.code === 'not-measured'
      ? t('growth.reason.notMeasured', {
          defaultValue:
            'There is not enough to judge yet. Answer {{needed}} more check-in(s) and the stage starts being calculated.',
          needed: Math.max(1, g.needsMoreSamples),
        })
      : c.code === 'new-pattern'
        ? t('growth.reason.newPattern', {
            defaultValue:
              'A kind of work it had not seen before came up. {{misses}} of the last {{trials}} went differently from what it expected, mostly on "{{taskType}}" — it is still learning that one, so the stage came down.',
            misses: c.recentMisses ?? 0,
            trials: c.recentTrials ?? 0,
            taskType: c.taskType ?? '',
          })
        : c.code === 'accuracy-drop'
          ? t('growth.reason.accuracyDrop', {
              defaultValue:
                'On familiar work, {{misses}} of the last {{trials}} went differently from what it expected. If how you decide has shifted, a few more answers bring it back in line.',
              misses: c.recentMisses ?? 0,
              trials: c.recentTrials ?? 0,
            })
          : c.code === 'accuracy-gain'
            ? t('growth.reason.accuracyGain', {
                defaultValue:
                  'Its recommendations landed more often lately — only {{misses}} of the last {{trials}} went differently.',
                misses: c.recentMisses ?? 0,
                trials: c.recentTrials ?? 0,
              })
            : c.code === 'evidence-grew'
              ? t('growth.reason.evidenceGrew', {
                  defaultValue:
                    'It is right about as often as before, but you have answered more, so the estimate is firmer. This rose because the evidence grew, not because it got better.',
                })
              : t('growth.reason.steady', {
                  defaultValue: 'Recent decisions look much like the earlier ones.',
                });

  const bar = 'h-1.5 rounded-full';

  return (
    <div className="mt-2 space-y-2.5 rounded-lg border border-border bg-muted/30 p-3" data-testid="growth-panel">
      {/* stage ladder + gauge */}
      <div className="flex items-center gap-1.5">
        {STAGES.map((s, i) => {
          const reached = STAGES.indexOf(g.stage) >= i;
          const isNow = g.stage === s;
          return (
            <span
              key={s}
              className={`flex items-center gap-1 text-[11px] ${
                isNow ? 'font-semibold text-foreground' : reached ? 'text-foreground/70' : 'text-muted-foreground/50'
              }`}
            >
              <span className={reached ? '' : 'grayscale opacity-50'}>{GLYPH[s]}</span>
              {stageName(s)}
              {i < STAGES.length - 1 ? <span className="text-muted-foreground/40">→</span> : null}
            </span>
          );
        })}
      </div>

      {g.stage === 'egg' ? (
        // NO GAUGE IN THE EGG. A bound computed from three answers would paint a
        // confident-looking bar next to "not measured yet", and the user would
        // believe the bar. What is useful here is how far off measurement is.
        <div className="text-[11px] text-muted-foreground">
          {t('growth.eggHint', {
            defaultValue: 'Not measured yet — {{needed}} more answered check-in(s) to go.',
            needed: Math.max(1, g.needsMoreSamples),
          })}
        </div>
      ) : (
        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-semibold text-foreground">{g.percent}%</span>
            <span className="text-[10px] text-muted-foreground">
              {t('growth.ofButterfly', { defaultValue: 'of the butterfly threshold' })}
            </span>
          </div>
          <div className={`mt-1 w-full bg-border ${bar}`}>
            <div
              className={`${bar} ${g.blockedByTripwire ? 'bg-amber-500' : 'bg-brand'}`}
              style={{ width: `${Math.min(100, Math.max(2, g.percent))}%` }}
            />
          </div>
        </div>
      )}

      {/* what it means, and what it does NOT count */}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t(`growth.meaning.${g.stage}`, { defaultValue: '' })}
      </p>

      {/* the reason — the part the user reads when it went down */}
      <div
        className={`rounded-md border px-2.5 py-2 text-[11px] leading-relaxed ${
          c.direction === 'down'
            ? 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200'
            : 'border-border bg-background/60 text-muted-foreground'
        }`}
        data-testid="growth-reason"
      >
        <span className="mr-1">{c.direction === 'down' ? '↓' : c.direction === 'up' ? '↑' : '→'}</span>
        {reason}
      </div>

      {g.blockedByTripwire ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-red-700 dark:text-red-300">
          {t('growth.tripwireBlocked', {
            defaultValue:
              'Accuracy has reached the line, but {{count}} action(s) were refused for safety recently. Until those fall out of the recent window it does not become a butterfly — a safety refusal is not averaged away.',
            count: g.tripwires,
          })}
        </div>
      ) : null}

      {/* the axes, stated plainly */}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <dt className="text-muted-foreground">{t('growth.axis.hitRate', { defaultValue: 'Guessed right' })}</dt>
        <dd className="text-foreground text-right">
          {t('growth.axis.hitRateValue', {
            defaultValue: '{{hits}} of {{trials}}',
            hits: g.hits,
            trials: g.trials,
          })}
        </dd>
        <dt className="text-muted-foreground">{t('growth.axis.coverage', { defaultValue: 'Handled without asking' })}</dt>
        <dd className="text-foreground text-right">{Math.round(g.coverage * 100)}%</dd>
        {g.excluded > 0 ? (
          <>
            <dt className="text-muted-foreground">{t('growth.axis.excluded', { defaultValue: 'Not counted' })}</dt>
            <dd className="text-foreground text-right">
              {t('growth.axis.excludedValue', { defaultValue: '{{count}} (padded or repeated)', count: g.excluded })}
            </dd>
          </>
        ) : null}
        {g.correctedAfter > 0 ? (
          <>
            <dt className="text-muted-foreground">{t('growth.axis.corrected', { defaultValue: 'Fixed afterwards' })}</dt>
            <dd className="text-foreground text-right">{g.correctedAfter}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">{t('growth.axis.lifetime', { defaultValue: 'All time' })}</dt>
        <dd className="text-foreground text-right">
          {t('growth.axis.hitRateValue', {
            defaultValue: '{{hits}} of {{trials}}',
            hits: g.lifetimeHits,
            trials: g.lifetimeTrials,
          })}
        </dd>
      </dl>

      {/* the second tier. Shown as SENTENCES, not scores: "Brier 0.09" means
          nothing to a person deciding whether to delegate, while "it is right
          about as often as it says it is" does. */}
      {g.brier !== undefined || g.ask ? (
        <div className="space-y-1 border-t border-border pt-2">
          <div className="text-[10px] font-medium text-muted-foreground">
            {t('growth.secondTier', { defaultValue: 'Two other things worth knowing' })}
          </div>
          {g.brier !== undefined ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {/* 0.25 is what an agent scores by always saying "50% sure", so it is
                  the line where stated confidence starts carrying information. */}
              {g.brier < 0.25
                ? t('growth.calibrationGood', {
                    defaultValue:
                      'When it says how sure it is, that number is worth reading — it has been about as right as it claimed, across {{count}} answer(s).',
                    count: g.brierSamples,
                  })
                : t('growth.calibrationPoor', {
                    defaultValue:
                      'How sure it says it is does not track how often it is right yet ({{count}} answer(s)). Read the recommendation, not its confidence.',
                    count: g.brierSamples,
                  })}
            </p>
          ) : null}
          {g.ask ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {/* The PAIR, never precision alone: a flawless agent scores 0
                  precision because every ask turned out to be unnecessary, and
                  showing that number by itself would read as a failing grade. */}
              {t('growth.askQuality', {
                defaultValue:
                  'Of the times it asked, {{warranted}} of {{asked}} turned out to be worth asking. It acted alone {{silent}} time(s) without needing a fix, and {{missed}} time(s) you had to correct it.',
                warranted: g.ask.warrantedAsks,
                asked: g.ask.warrantedAsks + g.ask.unnecessaryAsks,
                silent: g.ask.correctSilences,
                missed: g.ask.missedAsks,
              })}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* per-task-type: trust is graduated, not global */}
      {g.byTaskType.length > 0 ? (
        <div>
          <div className="text-[10px] font-medium text-muted-foreground">
            {t('growth.byTaskType', { defaultValue: 'By kind of work' })}
          </div>
          <div className="mt-1 space-y-0.5">
            {g.byTaskType.map((tt) => (
              <div key={tt.taskType} className="flex items-center justify-between text-[11px]">
                <span className="font-mono text-foreground truncate">{tt.taskType}</span>
                <span className="text-muted-foreground shrink-0">
                  {GLYPH[tt.stage]} {stageName(tt.stage)} · {tt.hits}/{tt.trials}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground/80">
            {t('growth.byTaskTypeHint', {
              defaultValue:
                'A new kind of work starts in its own egg instead of dragging the overall number down.',
            })}
          </p>
        </div>
      ) : null}

      {/* the decisions themselves, so the number is auditable */}
      {g.recentDecisions.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-[10px] font-medium text-muted-foreground hover:text-foreground">
            {t('growth.recent', { defaultValue: 'What it asked, and what you chose' })}
          </summary>
          <div className="mt-1 space-y-1.5">
            {g.recentDecisions.map((d, i) => (
              <div key={`${d.at}:${i}`} className="rounded border border-border bg-background/60 px-2 py-1.5">
                <div className="flex items-start gap-1.5">
                  <span className="text-[11px] leading-4">{d.hit ? '🦋' : '🐛'}</span>
                  <span className="flex-1 text-[11px] leading-4 text-foreground">{d.question}</span>
                </div>
                <div className="mt-0.5 pl-5 text-[10px] leading-4 text-muted-foreground">
                  {d.chosen >= 0
                    ? t('growth.recentChose', {
                        defaultValue: 'you chose: {{option}}',
                        option: d.options[d.chosen] ?? '',
                      })
                    : t('growth.recentCorrected', {
                        defaultValue: 'you answered in your own words: {{text}}',
                        text: d.correction ?? '',
                      })}
                  {!d.hit && d.options[d.recommended]
                    ? ` · ${t('growth.recentRecommended', {
                        defaultValue: 'it had recommended: {{option}}',
                        option: d.options[d.recommended] ?? '',
                      })}`
                    : ''}
                </div>
                {d.excludedCode ? (
                  <div className="mt-0.5 pl-5 text-[10px] text-amber-700 dark:text-amber-400">
                    {t('growth.recentExcluded', {
                      defaultValue: 'not counted — {{reason}}',
                      // The server sends a CODE; anything unrecognised (a row from
                      // before codes existed) falls back to showing it verbatim
                      // rather than a blank line.
                      reason: t(`growth.excluded.${d.excludedCode}`, { defaultValue: d.excludedCode }),
                    })}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {/* THE TRUST STATEMENT. Without this the number reads as arbitrary. */}
      <p className="border-t border-border pt-2 text-[10px] leading-relaxed text-muted-foreground/80">
        {t('growth.howItMoves', {
          defaultValue:
            'This does not rise with the number of conversations or stored memories. It moves only when naby asks how to proceed and its own recommendation turns out to match what you chose — and it can fall when your patterns change.',
        })}
      </p>

      {/* ------------------------------------------------------------------
          P3-M8c — WHAT IT HAS LEARNED. Its own bordered box, below everything
          the meter said, because these are counts and the paragraph directly
          above has just finished explaining that counts do not move the gauge.
          Reading the two in that order is the point: the disclaimer arrives
          before the numbers, and again after them.
          ------------------------------------------------------------------ */}
      {learning ? (
        <div
          className="rounded-md border border-border bg-background/60 px-2.5 py-2"
          data-testid="growth-learning"
        >
          <div className="text-[10px] font-medium text-foreground/80">
            {t('growth.learning.title', { defaultValue: 'What it has learned so far' })}
          </div>
          <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            <dt className="text-muted-foreground">
              {t('growth.learning.confirmed', { defaultValue: 'Facts in use' })}
            </dt>
            <dd className="text-foreground text-right">
              {t('growth.learning.confirmedValue', {
                defaultValue: '{{count}}',
                count: learning.confirmedTotal,
              })}
            </dd>
            {/* The per-scope split only when there IS a split to show. On a
                machine with no project open, "user 4 / project 0" would invent a
                distinction the user cannot act on. */}
            {learning.confirmedByScope.project !== undefined ? (
              <>
                <dt className="text-muted-foreground">
                  {t('growth.learning.byScope', { defaultValue: 'Of those, by where they apply' })}
                </dt>
                <dd className="text-foreground text-right">
                  {t('growth.learning.byScopeValue', {
                    defaultValue: '{{user}} everywhere · {{project}} in this project',
                    user: learning.confirmedByScope.user,
                    project: learning.confirmedByScope.project,
                  })}
                </dd>
              </>
            ) : null}
            {learning.proposedCount > 0 ? (
              <>
                <dt className="text-muted-foreground">
                  {t('growth.learning.proposed', { defaultValue: 'Waiting for your review' })}
                </dt>
                <dd className="text-foreground text-right">
                  {t('growth.learning.proposedValue', {
                    defaultValue: '{{count}}',
                    count: learning.proposedCount,
                  })}
                </dd>
              </>
            ) : null}
            {learning.corroborated2Plus > 0 ? (
              <>
                <dt className="text-muted-foreground">
                  {t('growth.learning.corroborated', { defaultValue: 'Said in more than one chat' })}
                </dt>
                <dd className="text-foreground text-right">
                  {t('growth.learning.corroboratedValue', {
                    defaultValue: '{{count}}',
                    count: learning.corroborated2Plus,
                  })}
                </dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">
              {t('growth.learning.taskTypes', { defaultValue: 'Kinds of work seen' })}
            </dt>
            <dd className="text-foreground text-right">
              {t('growth.learning.taskTypesValue', {
                defaultValue: '{{count}}',
                count: learning.distinctTaskTypes,
              })}
            </dd>
          </dl>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground/80">
            {learning.lastReflectionAt
              ? t('growth.learning.lastReflection', {
                  defaultValue: 'It last looked back over a finished conversation on {{when}}.',
                  when: new Date(learning.lastReflectionAt).toLocaleString(),
                })
              : t('growth.learning.neverReflected', {
                  defaultValue: 'It has not looked back over a finished conversation yet.',
                })}
          </p>
          {/* THE DISOWNING SENTENCE (spec §6.3, trust-meter §9.2 rule 2). Not
              optional and not a tooltip: it is the only thing standing between
              these counts and being read as the growth number. */}
          <p className="mt-1 border-t border-border pt-1.5 text-[10px] leading-relaxed text-muted-foreground/80">
            {t('growth.learning.notTheGauge', {
              defaultValue:
                'These numbers do not enter the butterfly judgement. They show WHAT it has learned; whether it can be trusted is answered by the record above.',
            })}
          </p>
        </div>
      ) : null}
    </div>
  );
}
