'use client';

/**
 * Phase 3 (P3-M5) — THE GROWTH SUMMARY: 알 → 애벌레 → 번데기 → 나비.
 *
 * Reads `POST /api/naby {growth.get}` and shows how far an agent can be trusted,
 * with the one thing a meter like this owes its user: an honest reason when it
 * goes DOWN. A number that only ever rises is decoration; a number that falls
 * without explanation is worse than no number.
 *
 * WHAT IS LEFT HERE, AND WHAT MOVED (settings-ia-reorg §3.2). This file used to
 * be the whole panel — gauge, axes, per-task-type breakdown, the decision list,
 * the learning counts, three disclaimers — expanded inside the agent row. All of
 * that is a READ-ONLY DASHBOARD sitting in the middle of a screen of switches, so
 * it moved to `GrowthReportModal`. Three things stayed, because they are what a
 * person reads at a glance and act on:
 *
 *   1. the stage ladder and the gauge (or, in the egg, how far off measurement is),
 *   2. ONE reason line — the sentence a falling meter owes its user,
 *   3. two buttons: open the full report, and start a fast-growth session.
 *
 * WHAT THIS SUMMARY IS STILL CAREFUL ABOUT
 *
 *  1. The regression sentence is built from a REASON CODE plus real counts, never
 *     from prose the server wrote. `diagnoseChange` is deterministic, so the
 *     explanation is reproducible and cannot invent a cause; this file turns the
 *     code into the user's language.
 *  2. It never prints two numbers that disagree. In the egg stage the gauge is
 *     suppressed in favour of "how many more answers are needed".
 *  3. It fetches ONCE and hands the document to the report, so the overlay and
 *     the row can never show two different readings of the same ledger.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { publishTopic } from '@cockpit/effect-react';
import { Topics } from '@cockpit/effect-services';
import {
  GrowthReportModal,
  GLYPH,
  STAGES,
  type GrowthWire,
  type LearningWire,
} from './GrowthReportModal';

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
    // report's own copy states to the user.
    return { growth: json.growth, learning: json.learning ?? null };
  } catch {
    return null;
  }
}

export function GrowthPanel({
  agentId,
  agentName,
  cwd,
  onLeaveSettings,
}: {
  agentId: string;
  /** The `@handle` this summary is about — passed through to the report, which
   *  covers the row it was opened from and has to name it. */
  agentName: string;
  cwd?: string;
  /** Close the Settings modal. Called ONLY after a fast-growth session has been
   *  opened behind it — a modal that shut without putting anything in its place
   *  would read as the button having dismissed Settings. Absent when this panel
   *  is rendered somewhere that has no modal to close, in which case the button
   *  falls back to telling the user where the session is. */
  onLeaveSettings?: () => void;
}) {
  const { t } = useTranslation();
  const [g, setG] = useState<GrowthWire | null>(null);
  const [learning, setLearning] = useState<LearningWire | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  // P3-M12b — the fast-growth session. Four states rather than a boolean: the
  // button has to say what happened, and "nothing visibly changed" is the one
  // outcome a click must never produce. Declared with the other hooks, above the
  // loading/failure early-returns, because hooks cannot live after a branch.
  //
  // `done` now means OPENED, not merely created — see `startFastGrowth`. It
  // survives on screen for the moment before the modal closes, and is what the
  // user reads in the fallback case where there is nothing to open into.
  const [drillSession, setDrillSession] = useState<
    'idle' | 'creating' | 'done' | 'created-not-opened' | 'failed'
  >('idle');

  const startFastGrowth = useCallback(async () => {
    setDrillSession('creating');
    try {
      const res = await fetch('/api/naby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'session.fastGrowth.create',
          ...(cwd ? { cwd } : {}),
          // THE NAME TRAVELS FROM HERE because the server has no locale. It is
          // the same string the button carries, so the row that appears in the
          // session list is recognisably the thing that was just pressed.
          title: t('growth.fastSession.sessionTitle', { defaultValue: 'Fast-growth session' }),
          // AND SO DO THE OPENING WORDS (fast-evolution §3.3b). The route fires
          // one turn into the new session so naby is already asking when the tab
          // opens; this is the sentence that turn is made of, and it is written
          // in the user's language for the same reason the title is. It is a
          // real message in a real transcript, so it says plainly what it is
          // rather than pretending to be something the user typed.
          kickoff: t('growth.fastSession.kickoff', {
            defaultValue: 'Starting the fast-growth session.',
          }),
        }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; sessionId?: string }
        | null;
      if (!res.ok || !json?.ok || !json.sessionId) {
        setDrillSession('failed');
        return;
      }
      // ---- GO THERE (the whole point of the button) -----------------------
      //
      // Two builds shipped with "it is at the top of your session list", and the
      // user did not find it either time. A control that creates a conversation
      // has to open the conversation; a sentence describing where it went is a
      // treasure map, not navigation.
      //
      // NO NEW INFRASTRUCTURE. `Topics.OpenProject` is the existing "open this
      // project at this session" message — the session-list rows in
      // SessionBrowser and ProjectSessionsModal publish exactly this, and
      // Workspace's window listener switches the project and posts SWITCH_SESSION
      // into its iframe. Settings renders in that same top window, where
      // `window.parent === window`, so `publishTopic` reaches the listener
      // directly and no downward broadcast is needed (that half of
      // `announceTopic` exists for subscribers INSIDE the iframes).
      //
      // IT NEEDS A PROJECT. `cwd` is the open project, and Workspace keys the
      // whole open path on it; with no project on screen there is nowhere to
      // navigate to, so the button degrades to the sentence it used to be —
      // stated as a fallback rather than as the design.
      if (cwd) {
        publishTopic(Topics.OpenProject, { cwd, sessionId: json.sessionId });
        setDrillSession('done');
        // Closes AFTER the request to open has gone out, so the settings pane is
        // never dismissed by a click that then failed to produce a session.
        onLeaveSettings?.();
      } else {
        setDrillSession('created-not-opened');
      }
    } catch {
      setDrillSession('failed');
    }
  }, [cwd, onLeaveSettings, t]);

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

  // Both transient states are one sentence of status text. A bordered, tinted box
  // around a single line inside a row that is already bordered is three
  // rectangles to say "loading".
  if (loading) {
    return (
      <p className="mt-2.5 border-t border-border pt-2.5 text-[11px] text-muted-foreground">
        {t('growth.loading', { defaultValue: 'Reading the record…' })}
      </p>
    );
  }
  if (failed || !g) {
    return (
      <p className="mt-2.5 border-t border-border pt-2.5 text-[11px] text-muted-foreground">
        {t('growth.unavailable', { defaultValue: 'The growth record could not be read.' })}
      </p>
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
    // Opens with a divider rather than a border: this summary sits INSIDE the
    // agent row, which is already the one card the list is allowed.
    <div className="mt-2.5 space-y-2 border-t border-border pt-2.5" data-testid="growth-panel">
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
        //
        // WHEN PRACTICE HAS HAPPENED, THE LINE SAYS SO — and still says the real
        // check-ins are what is owed. Drills never satisfy the minimum sample
        // (fast-evolution §3.4); that rule is not what changes here, the FEEDBACK
        // is. A user who answered three practice questions and then read the same
        // sentence as before their session has no way to tell the effort landed.
        // Both facts, one line, from numbers the reading already carries — and
        // deliberately NOT a second gauge: the egg gauge stays absent, so the
        // numbers and the words keep saying the same thing.
        <div className="text-[11px] text-muted-foreground">
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

      {/* the reason — the part the user reads when it went down.
          A LEFT ACCENT, not a box. This one line does need to stand apart from
          the prose around it (it is the sentence a falling meter owes its user),
          and a 2px rule down its edge carries that without adding a fourth
          rectangle to the row. The colour still switches on direction, so a drop
          reads as a drop. */}
      <div
        className={`border-l-2 pl-2.5 text-[11px] leading-relaxed ${
          c.direction === 'down'
            ? 'border-amber-500/60 text-amber-800 dark:text-amber-200'
            : 'border-border text-muted-foreground'
        }`}
        data-testid="growth-reason"
      >
        <span className="mr-1">{c.direction === 'down' ? '↓' : c.direction === 'up' ? '↑' : '→'}</span>
        {reason}
      </div>

      {/* THE TWO BUTTONS. Everything the meter can say about itself is behind the
          first; the one lever the user has over it is the second (P3-M12b) — it
          sits here rather than in the report because the report is a reading, and
          this is an action. Pressing it now OPENS the session (see
          `startFastGrowth`) rather than leaving the user to find it. */}
      <div className="flex flex-wrap items-center gap-1.5" data-testid="growth-fast-session">
        <button
          type="button"
          onClick={() => setReportOpen(true)}
          className="rounded border border-border px-2 py-1 text-[11px] text-foreground hover:bg-accent"
        >
          {t('growth.report.open', { defaultValue: 'Growth report' })}
        </button>
        <button
          type="button"
          onClick={() => void startFastGrowth()}
          disabled={drillSession === 'creating'}
          // The SECOND-ORDER fact — that practice answers are discounted — stays
          // on the control, because it is the kind of thing a person looks for
          // once they already know what the button does. What the button IS is
          // below, in the open, where hovering is not a prerequisite.
          title={t('growth.fastSession.weight', {
            defaultValue:
              'Practice answers count for less than real check-ins, and they can never start the measurement.',
          })}
          className="rounded border border-border px-2 py-1 text-[11px] text-foreground hover:bg-accent disabled:opacity-50"
        >
          {t('growth.fastSession.button', { defaultValue: 'Fast-growth session' })}
        </button>
      </div>

      {/* WHAT THE BUTTON ABOVE IS, ALWAYS VISIBLE, IN ONE SENTENCE.
          It used to live in a `title`, and a tooltip is not an explanation: the
          user pressed this control twice, across two builds, and still could not
          say what it was — which is what a hover-only affordance buys on a
          surface nobody hovers over. One sentence is the pane's standing rule
          (settingsLayout.test.ts), and one sentence is all this needs; the
          discount caveat stayed on the button, where a second-order fact
          belongs. */}
      <p
        className="text-[10px] leading-relaxed text-muted-foreground"
        data-testid="growth-fast-session-hint"
      >
        {t('growth.fastSession.hint', {
          defaultValue:
            'A fast-growth session is a conversation of its own, where naby asks about you and sets practice decisions so it learns faster than ordinary work allows.',
        })}
      </p>

      {/* The OUTCOME of that click, which is the one thing a button that opens
          something elsewhere owes the person who pressed it. Three outcomes, not
          two: opened, created-but-there-was-nowhere-to-open-it, and failed. The
          middle one is the honest report of the fallback path — saying "opened"
          when nothing moved is how the previous version misled. */}
      {drillSession !== 'idle' ? (
        <p className="text-[10px] leading-relaxed text-muted-foreground/80">
          {drillSession === 'creating'
            ? t('growth.fastSession.opening', { defaultValue: 'Opening…' })
            : drillSession === 'done'
            ? t('growth.fastSession.created', {
                defaultValue:
                  'The fast-growth session is open — say hello and naby will start asking.',
              })
            : drillSession === 'created-not-opened'
              ? t('growth.fastSession.createdNoOpen', {
                  defaultValue:
                    'Created. Open "Fast-growth session" from the top of your session list.',
                })
              : t('growth.fastSession.failed', {
                  defaultValue: 'The session could not be created.',
                })}
        </p>
      ) : null}

      <GrowthReportModal
        isOpen={reportOpen}
        onClose={() => setReportOpen(false)}
        agentName={agentName}
        growth={g}
        learning={learning}
      />
    </div>
  );
}
