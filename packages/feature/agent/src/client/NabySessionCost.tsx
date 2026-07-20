'use client';

/**
 * F1-07 — per-session cost / usage, in the chat header.
 *
 * WHAT IT REFUSES TO DO IS THE DESIGN
 * -----------------------------------
 * The runtime hands us a summary that already distinguishes three cases, and
 * this component renders each of them differently on purpose:
 *
 *   1. metered + priced      "$0.0123 · 4.2k tokens"
 *   2. metered + unpriced    "4.2k tokens · cost unknown"  — never a number we
 *                            do not have. A wrong figure is worse than none,
 *                            because the user cannot tell that it is wrong.
 *   3. subscription          "No metered cost · 4.2k tokens" — the development
 *                            model runs on a local Claude sign-in. The Agent SDK
 *                            reports a dollar amount, but that is what the same
 *                            tokens WOULD have cost on the metered API. Showing
 *                            it as a charge would be inventing a bill.
 *
 * All of that logic lives in the runtime (`summarizeUsage`), not here — this
 * component renders `label`/`detail` and adds no arithmetic of its own, so the
 * rules are tested where they are decided rather than in a React tree.
 *
 * IT ALSO SAYS WHAT IS ANSWERING. "Which model am I talking to and is it costing
 * me money" is one question, not two, and the engine summary answers the half
 * that a cost figure alone leaves ambiguous — particularly now that the app can
 * answer with no API key at all.
 */

import { useCallback, useEffect, useState } from 'react';

type UsageSummary = {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  billedUsd?: number;
  billedComplete: boolean;
  subscriptionTurns: number;
  label: string;
  detail: string;
  pricesAsOf: string;
};

type NabyState = {
  engine: { ok: boolean; id?: string; costBasis?: string; summary: string };
  usage: UsageSummary | null;
};

/** How often the strip refreshes while a session is open. The value only
 *  changes when a turn completes, so this is deliberately unhurried — it is a
 *  status line, not a live meter, and polling harder would cost more than it
 *  reports. */
const POLL_MS = 15_000;

export function NabySessionCost({ sessionId }: { sessionId: string | null }) {
  const [state, setState] = useState<NabyState | null>(null);

  const load = useCallback(async () => {
    try {
      const url = sessionId
        ? `/api/naby?sessionId=${encodeURIComponent(sessionId)}`
        : '/api/naby';
      const res = await fetch(url);
      if (!res.ok) return;
      setState((await res.json()) as NabyState);
    } catch {
      // A failed poll is not worth a toast: the strip simply keeps its last
      // value. The chat itself surfaces any real engine failure.
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  if (!state) return null;

  const { engine, usage } = state;

  // Nothing spent yet: still worth showing WHAT will answer, because that is
  // the thing a user most wants confirmed before they type.
  const costLabel = usage && usage.turns > 0 ? usage.label : null;

  return (
    <div className="flex items-center gap-2 text-xs">
      <span
        className={engine.ok ? 'text-muted-foreground' : 'text-amber-500'}
        title={engine.summary}
      >
        {engine.ok
          ? engine.id === 'dev-claude'
            ? 'Development model'
            : 'API provider'
          : 'Not configured'}
      </span>
      {costLabel && (
        <>
          <span className="text-muted-foreground/40">·</span>
          <span
            className="text-muted-foreground cursor-help"
            title={`${usage?.detail ?? ''}`}
          >
            {costLabel}
          </span>
        </>
      )}
    </div>
  );
}
