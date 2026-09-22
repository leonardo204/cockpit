// packages/feature/agent/src/server/lib/contextWindow.ts
//
// THE DENOMINATOR OF THE STATUS-BAR GAUGE, resolved for one finished run
// (specs/session-context-management.md §2.1).
//
// THE PRECEDENCE, IN FULL. Four answers, best first:
//
//   1. THE WINDOW THE RUN REPORTED. The Agent SDK's result message carries
//      `modelUsage[model].contextWindow`, which the runtime forwards on its result
//      event as `contextWindow`. A measurement, so it wins.
//   2. THE TIER WE REQUESTED, when the served id names the SAME model. `opus[1m]`
//      served as `claude-opus-5` is a 1M run (`requestedOneMTier`).
//   3. THE SERVED ID'S REGISTRY ANSWER — `contextWindowFor` over the id the run
//      reported, plus whatever betas it negotiated.
//   4. THE REQUESTED LABEL'S REGISTRY ANSWER, for a turn that died before it could
//      report an id at all.
//
// (1) WINS, AND THAT ORDERING IS THE POINT OF THIS FILE. The registry inferred
// the 1M tier from two announcements — the `context-1m-2025-08-07` beta and a
// `[1m]` marker on the served id — and a live Agent SDK 0.3.215 run showed BOTH
// gone while `modelUsage` reported 1,000,000 tokens: the tier had gone GA, so
// nothing flagged it any more. The gauge read `64% (127k/200k)` on a window five
// times larger. An inference goes stale when the provider changes how it
// announces things; a number the run states about itself does not.
//
// (2) IS WHY THIS FILE CHANGED AGAIN. The measurement is not always there: a
// result that bills two models — ordinary now that subagents route to a cheap
// model — can name no entry attributable to the reading, and answers nothing. The
// tier we asked for was then thrown away too, because step (3) already answered
// 200k for the marker-stripped served id and step (4) was never reached. A 1M run
// read `97% (194k/200k)` with no `~` and offered to continue in a new tab. The
// requested label is now a LIVE signal, not just a last resort.
//
// (3) AND (4) ARE UNCHANGED AND STILL LOAD-BEARING. Every AI-SDK backend reports
// no window at all, and an Agent SDK turn that dies before its result reports none
// either — those all land on the registry exactly as before.
//
// It lives here rather than inside the engine adapter's turn closure so the
// precedence is assertable on its own (contextWindow.test.ts); the adapter binds
// it to the run's live values.

import { contextWindowFor } from '../../../../../../../dist/naby-runtime.mjs';

export type ResolveContextWindowInput = {
  /** Which backend answered (`dev-claude` / `ai-sdk` / …). */
  engineId: string;
  /**
   * THE WINDOW THE RUN REPORTED, straight off the engine's result event. Absent
   * for every backend that reports none — which is why this is an input and not
   * the answer.
   */
  reportedWindow?: number | undefined;
  /** The concrete model the run served, as it reported it. */
  contextModel?: string | undefined;
  /**
   * The model we ASKED for — often an alias, sometimes `default`.
   *
   * TWO JOBS NOW. It is the fallback id for a turn that reported none, and it is
   * the only place the 1M tier still appears: the catalog sends `opus[1m]` and the
   * SDK serves `claude-opus-5`, marker stripped. Read as a tier only when the
   * served id names the same model, so a mid-turn swap to haiku is not sized as
   * opus.
   */
  modelLabel?: string | undefined;
  /** The betas the run negotiated, if it named any. */
  betas?: readonly string[] | undefined;
};

/**
 * The window this run filled, or `undefined` when nothing here can say.
 *
 * `undefined` still means what it always meant: the client estimates a size from
 * the model's FAMILY and marks the percentage approximate (`contextGauge.ts`).
 * It never means 200k.
 */
export function resolveContextWindow(input: ResolveContextWindowInput): number | undefined {
  const reported = input.reportedWindow;
  // Guarded rather than trusted: a zero or a NaN forwarded from a backend would
  // divide the gauge by nothing, so it falls through to the inference instead.
  if (typeof reported === 'number' && Number.isFinite(reported) && reported > 0) {
    return reported;
  }
  // The served id is asked first because `modelLabel` is what we requested, and on
  // the app's most common path that is `default` — the Agent SDK's "let Claude
  // pick" row, which names no window.
  //
  // THE LABEL RIDES ALONG AS `requested`, which is steps (2) and (3) of the header
  // in one call: the registry sizes the served id, except that a requested 1M tier
  // on the SAME model outranks it. That is the only way a GA 1M run can be
  // recognised once the measurement is missing — the beta is gone and the served id
  // never carried the marker.
  //
  // The second call stays as it was: the label as a plain id, for a turn that
  // reported none at all.
  return (
    contextWindowFor(input.engineId, input.contextModel ?? input.modelLabel, {
      ...(input.betas ? { betas: input.betas } : {}),
      ...(input.modelLabel ? { requested: input.modelLabel } : {}),
    }) ?? contextWindowFor(input.engineId, input.modelLabel)
  );
}
