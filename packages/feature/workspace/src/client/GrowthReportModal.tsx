'use client';

/**
 * THE GROWTH REPORT (settings-ia-reorg §3.2) — the read-only half of the trust
 * meter, moved out of Settings and into an overlay.
 *
 * WHY IT IS NOT A SETTINGS SECTION ANY MORE. Everything below is a STATUS
 * READOUT: axes, per-task-type breakdown, the decisions the number was computed
 * from, what has been learned. None of it is a control. Expanded inside the agent
 * row it was 35–60 lines with two unbounded lists in the middle of a screen whose
 * other rows are switches — and the research the reorg is built on says the same
 * thing twice (settings hold what you CHANGE; what an agent has learned gets its
 * own surface, the "Manage memories" model). So the row keeps the three things a
 * person reads at a glance — stage, gauge, why it moved — and everything else is
 * one click away, here.
 *
 * NOTHING IN IT CHANGED. This file is the old panel's lower two thirds, verbatim
 * in content and copy: the same keys, the same counts, the same disclaimers in
 * the same order. The reorg moves surfaces; it does not get to quietly edit what
 * the meter admits to.
 *
 * IT SITS WHERE THE MEMORY BROWSER SITS — `z-[100]`, above SettingsModal (z-50)
 * and below the z-[200] toast/context-menu layer, with ESC and a backdrop click
 * to close and its own scroll. Two overlays opened from Settings behaving
 * differently would be a worse answer than either.
 *
 * IT IS FED, NOT FETCHING. `GrowthPanel` has already read `growth.get` to draw
 * the row's gauge; a second request for the same document when the button is
 * pressed would put two answers on one screen for the time it takes to arrive.
 */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsDetails } from './SettingsDetails';

/** The wire shape of `growth.get`. Declared here — with the report that renders
 *  most of it — and imported by the row's summary, so there is one description of
 *  the response rather than two that can drift. */
export type GrowthWire = {
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
  /** P3-M8d — the implicit axis. RAW counts plus the weight they entered the
   *  bound at; all three absent when nothing has been reviewed yet, which is
   *  also when the sentence must not be rendered (it would read as "0 of 0"). */
  implicitTrials?: number;
  implicitHits?: number;
  implicitWeight?: number;
  /** P3-M12c — the drill axis. Practice check-ins from fast-growth sessions.
   *  All three absent when nothing was practised, which is also when the line
   *  must not be rendered: "real 8 · practice 0" invites the user to wonder what
   *  a practice check-in is on a screen where none has ever happened. */
  drillTrials?: number;
  drillHits?: number;
  drillWeight?: number;
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
    /** A practice question from a fast-growth session (P3-M12c). */
    drill?: boolean;
  }>;
};

/** The wire shape of the P3-M8c learning block. A SIBLING of `growth`, not a
 *  field inside it — the counts in it deliberately do not enter the gauge, and
 *  the closing sentence of the block says so. */
export type LearningWire = {
  confirmedByScope: { session?: number; project?: number; user: number; org?: number };
  confirmedTotal: number;
  proposedCount: number;
  corroborated2Plus: number;
  distinctTaskTypes: number;
  lastReflectionAt?: number;
};

export const STAGES: Array<GrowthWire['stage']> = ['egg', 'larva', 'pupa', 'butterfly'];
export const GLYPH: Record<GrowthWire['stage'], string> = {
  egg: '🥚',
  larva: '🐛',
  pupa: '🛡',
  butterfly: '🦋',
};

export function GrowthReportModal({
  isOpen,
  onClose,
  agentName,
  growth: g,
  learning,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** The `@handle` the report is about — the report is opened from one row of a
   *  list, and an overlay that covers that list has to say which row it came
   *  from. */
  agentName: string;
  growth: GrowthWire;
  learning: LearningWire | null;
}) {
  const { t } = useTranslation();

  // ESC closes, matching the memory browser and every other overlay.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const stageName = (s: GrowthWire['stage']) => t(`growth.stage.${s}`, { defaultValue: s });
  const bar = 'h-1.5 rounded-full';

  return (
    // z-[100]: ABOVE SettingsModal (z-50, which opens it) and below the z-[200]
    // layer reserved for context menus and toasts.
    <div className="fixed inset-0 z-[100] flex items-center justify-center" data-testid="growth-report">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-card rounded-lg shadow-xl w-[min(86vw,900px)] min-w-[min(560px,calc(100vw-2rem))] h-[85vh] mx-4 flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">
            {t('growth.report.title', { defaultValue: 'Growth report' })}
            <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
              @{agentName}
            </span>
          </h2>
          <button
            onClick={onClose}
            aria-label={t('common.close')}
            className="text-xs px-2 py-1 rounded border border-border hover:bg-accent text-muted-foreground"
          >
            {t('growth.report.close', { defaultValue: 'Close' })}
          </button>
        </div>

        {/* Its own scroll. The report is long by nature — that is why it stopped
            being a section inside a pane that scrolls something else. */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
          {/* THE HEADER READING. Repeated from the row on purpose: an overlay
              covers the row it was opened from, so a report that opened onto raw
              axis counts would make the reader remember the number instead of
              reading it. */}
          <div className="flex items-center gap-1.5">
            {STAGES.map((s, i) => {
              const reached = STAGES.indexOf(g.stage) >= i;
              const isNow = g.stage === s;
              return (
                <span
                  key={s}
                  className={`flex items-center gap-1 text-[0.786rem] ${
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
            // NO GAUGE IN THE EGG — a bound computed from three answers would
            // paint a confident bar next to "not measured yet".
            //
            // The SAME two-branch line as the panel's (GrowthPanel.tsx): once a
            // drill has been answered the sentence names both the real check-ins
            // still owed and the practice already done. The ledger rule behind it
            // is untouched — practice still cannot start the measurement.
            <div className="text-[0.786rem] text-muted-foreground">
              {g.drillTrials !== undefined && g.drillTrials > 0
                ? t('growth.eggHintWithDrills', {
                    defaultValue:
                      'Not measured yet — {{needed}} more check-in(s) answered in real work to go · practice {{drills}} done ({{drillHits}} right).',
                    needed: Math.max(1, g.needsMoreSamples),
                    drills: g.drillTrials,
                    drillHits: g.drillHits ?? 0,
                  })
                : t('growth.eggHint', {
                    defaultValue: 'Not measured yet — {{needed}} more answered check-in(s) to go.',
                    needed: Math.max(1, g.needsMoreSamples),
                  })}
            </div>
          ) : (
            <div>
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-semibold text-foreground">{g.percent}%</span>
                <span className="text-[0.714rem] text-muted-foreground">
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
          <p className="text-[0.786rem] leading-relaxed text-muted-foreground">
            {t(`growth.meaning.${g.stage}`, { defaultValue: '' })}
          </p>

          {g.blockedByTripwire ? (
            <p className="text-[0.786rem] leading-relaxed text-red-700 dark:text-red-300">
              {t('growth.tripwireBlocked', {
                defaultValue:
                  'Accuracy has reached the line, but {{count}} action(s) were refused for safety recently. Until those fall out of the recent window it does not become a butterfly — a safety refusal is not averaged away.',
                count: g.tripwires,
              })}
            </p>
          ) : null}

          {/* the axes, stated plainly */}
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[0.786rem]">
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

          {/* P3-M8d — THE IMPLICIT AXIS, as a sentence rather than a row in the
              table above. It belongs next to the gauge because unlike the
              learning block at the bottom it DOES move the number — so the honest
              thing is to say what it is (actions nobody objected to), what it is
              worth (a fraction of an answered check-in, sent by the server so this
              sentence cannot go stale if the constant is retuned) and why it is
              worth less (silence is not agreement). Raw counts, never the weighted
              product: "3.5 of 15" is a number no user can check against anything
              they remember doing. */}
          {g.implicitTrials !== undefined && g.implicitTrials > 0 ? (
            <p className="text-[0.786rem] leading-relaxed text-muted-foreground" data-testid="growth-implicit">
              {t('growth.implicitAxis', {
                defaultValue:
                  'It also acted on its own {{reviewed}} time(s) that were looked back over afterwards, and you left {{stood}} of them alone. Those count toward the gauge too, but each is worth {{weight}} of a check-in you actually answered — not objecting is weaker evidence than choosing.',
                reviewed: g.implicitTrials,
                stood: g.implicitHits ?? 0,
                weight: g.implicitWeight ?? 0,
              })}
            </p>
          ) : null}

          {/* P3-M12c — THE DRILL AXIS, separated from the real record on purpose
              (fast-evolution §3.4, last bullet). If practice moved the gauge and
              the screen only ever showed one number, the first time a user
              noticed would be the last time they believed any of it. */}
          {g.drillTrials !== undefined && g.drillTrials > 0 ? (
            <p className="text-[0.786rem] leading-relaxed text-muted-foreground" data-testid="growth-drill">
              {t('growth.drillAxis', {
                defaultValue:
                  'Real {{real}} · practice {{drill}} — of the practice questions it guessed {{drillHits}} right. Practice counts toward the gauge at {{weight}} of a real check-in, and it can never START the measurement: the minimum sample has to come from real work.',
                real: g.trials,
                drill: g.drillTrials,
                drillHits: g.drillHits ?? 0,
                weight: g.drillWeight ?? 0,
              })}
            </p>
          ) : null}

          {/* the second tier. Shown as SENTENCES, not scores: "Brier 0.09" means
              nothing to a person deciding whether to delegate, while "it is right
              about as often as it says it is" does. */}
          {g.brier !== undefined || g.ask ? (
            <div className="space-y-1 border-t border-border pt-2">
              <div className="text-[0.714rem] font-medium text-muted-foreground">
                {t('growth.secondTier', { defaultValue: 'Two other things worth knowing' })}
              </div>
              {g.brier !== undefined ? (
                <p className="text-[0.786rem] leading-relaxed text-muted-foreground">
                  {/* 0.25 is what an agent scores by always saying "50% sure", so
                      it is the line where stated confidence starts carrying
                      information. */}
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
                <p className="text-[0.786rem] leading-relaxed text-muted-foreground">
                  {/* The PAIR, never precision alone: a flawless agent scores 0
                      precision because every ask turned out to be unnecessary. */}
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
              <div className="text-[0.714rem] font-medium text-muted-foreground">
                {t('growth.byTaskType', { defaultValue: 'By kind of work' })}
              </div>
              <div className="mt-1 space-y-0.5">
                {g.byTaskType.map((tt) => (
                  <div key={tt.taskType} className="flex items-center justify-between text-[0.786rem]">
                    <span className="font-mono text-foreground truncate">{tt.taskType}</span>
                    <span className="text-muted-foreground shrink-0">
                      {GLYPH[tt.stage]} {stageName(tt.stage)} · {tt.hits}/{tt.trials}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-1 text-[0.714rem] leading-relaxed text-muted-foreground/80">
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
              <summary className="cursor-pointer text-[0.714rem] font-medium text-muted-foreground hover:text-foreground">
                {t('growth.recent', { defaultValue: 'What it asked, and what you chose' })}
              </summary>
              {/* Inset dividers, not one box per decision. */}
              <div className="mt-1 divide-y divide-border/60">
                {g.recentDecisions.map((d, i) => (
                  <div key={`${d.at}:${i}`} className="py-1.5 first:pt-0 last:pb-0">
                    <div className="flex items-start gap-1.5">
                      <span className="text-[0.786rem] leading-4">{d.hit ? '🦋' : '🐛'}</span>
                      <span className="flex-1 text-[0.786rem] leading-4 text-foreground">{d.question}</span>
                      {/* A practice question is LABELLED, not hidden: this list is
                          what makes the gauge auditable, and an invented scenario
                          sitting here unmarked would read as a decision the user
                          really faced. */}
                      {d.drill ? (
                        <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[0.643rem] text-muted-foreground">
                          {t('growth.drillTag', { defaultValue: 'practice' })}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 pl-5 text-[0.714rem] leading-4 text-muted-foreground">
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
                      <div className="mt-0.5 pl-5 text-[0.714rem] text-amber-700 dark:text-amber-400">
                        {t('growth.recentExcluded', {
                          defaultValue: 'not counted — {{reason}}',
                          // The server sends a CODE; anything unrecognised (a row
                          // from before codes existed) falls back to showing it
                          // verbatim rather than a blank line.
                          reason: t(`growth.excluded.${d.excludedCode}`, { defaultValue: d.excludedCode }),
                        })}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </details>
          ) : null}

          {/* THE TRUST STATEMENT. Without this the number reads as arbitrary.
              P3-M8d amended it rather than leaving it: "only when naby asks"
              stopped being true the day reviewed actions started entering the
              bound, and a disclaimer that is slightly false is worse than none. */}
          <div className="border-t border-border pt-2">
            <p className="text-[0.714rem] leading-relaxed text-muted-foreground/80">
              {t('growth.howItMoves', {
                defaultValue:
                  'This moves when naby says how it would proceed and you pick the same thing — not with how much you talk to it.',
              })}
            </p>
            {/* The claim above is the load-bearing one and stays visible; what it
                said in its other two sentences is elaboration of the same claim,
                so it is one tap away rather than in the wall. */}
            <SettingsDetails>
              <p>
                {t('growth.howItMovesMore', {
                  defaultValue:
                    'Something it did without asking, looked back over later and left alone, counts too but for much less. It can fall when your patterns change.',
                })}
              </p>
            </SettingsDetails>
          </div>

          {/* ------------------------------------------------------------------
              P3-M8c — WHAT IT HAS LEARNED. Below everything the meter said,
              because these are counts and the paragraph directly above has just
              finished explaining that counts do not move the gauge. Reading the
              two in that order is the point.

              A DIVIDER AND A HEADING, not a box.
              ------------------------------------------------------------------ */}
          {learning ? (
            <div className="border-t border-border pt-2" data-testid="growth-learning">
              <div className="text-[0.714rem] font-medium text-foreground/80">
                {t('growth.learning.title', { defaultValue: 'What it has learned so far' })}
              </div>
              <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-[0.786rem]">
                <dt className="text-muted-foreground">
                  {t('growth.learning.confirmed', { defaultValue: 'Facts in use' })}
                </dt>
                <dd className="text-foreground text-right">
                  {t('growth.learning.confirmedValue', {
                    defaultValue: '{{count}}',
                    count: learning.confirmedTotal,
                  })}
                </dd>
                {/* The per-scope split only when there IS a split to show. */}
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
              <p className="mt-1 text-[0.714rem] leading-relaxed text-muted-foreground/80">
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
              <p className="mt-1 border-t border-border pt-1.5 text-[0.714rem] leading-relaxed text-muted-foreground/80">
                {t('growth.learning.notTheGauge', {
                  defaultValue:
                    'These numbers do not enter the butterfly judgement — they show WHAT it has learned, not whether it can be trusted.',
                })}
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
