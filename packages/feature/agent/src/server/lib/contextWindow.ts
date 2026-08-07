// packages/feature/agent/src/server/lib/contextWindow.ts
//
// THE DENOMINATOR OF THE STATUS-BAR GAUGE, resolved for one finished run
// (specs/session-context-management.md §2.1).
//
// There are two ways to know how big a window is, and they are not equal:
//
//   1. THE RUN SAYS SO. The Agent SDK's result message carries
//      `modelUsage[model].contextWindow`, which the runtime forwards on its
//      result event as `contextWindow`. This is a measurement.
//   2. THE REGISTRY INFERS IT. `contextWindowFor` maps a model id (plus the
//      betas the run negotiated) to a published size. This is an inference, and
//      it can only be as current as the signals it reads.
//
// (1) WINS, AND THAT ORDERING IS THE POINT OF THIS FILE. The registry inferred
// the 1M tier from two announcements — the `context-1m-2025-08-07` beta and a
// `[1m]` marker on the served id — and a live Agent SDK 0.3.215 run showed BOTH
// gone while `modelUsage` reported 1,000,000 tokens: the tier had gone GA, so
// nothing flagged it any more. The gauge read `64% (127k/200k)` on a window five
// times larger. An inference goes stale when the provider changes how it
// announces things; a number the run states about itself does not.
//
// (2) IS UNCHANGED AND STILL LOAD-BEARING. Every AI-SDK backend reports no
// window at all, and an Agent SDK turn that dies before its result reports none
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
  /** The model we ASKED for — often an alias, sometimes `default`. */
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
  // Unchanged from before this file existed. The served id is asked first
  // because `modelLabel` is what we requested, and on the app's most common path
  // that is `default` — the Agent SDK's "let Claude pick" row, which names no
  // window; the label is only the fallback for a turn that died before it could
  // report an id.
  return (
    contextWindowFor(input.engineId, input.contextModel ?? input.modelLabel, {
      ...(input.betas ? { betas: input.betas } : {}),
    }) ?? contextWindowFor(input.engineId, input.modelLabel)
  );
}
