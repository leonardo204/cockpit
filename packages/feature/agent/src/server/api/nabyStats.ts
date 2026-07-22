/**
 * `/api/naby/stats` — the usage/cost statistics surface, sourced ENTIRELY from
 * the Naby store (`app.db`, the `usage` table this app writes per answered
 * turn), NOT from the provider's `~/.claude/projects/*.jsonl` transcripts.
 *
 * This is the stats counterpart to the session/project re-backing (see
 * `sessions/nabyBrowse.ts`): the old `/api/claude-stats` route scanned every
 * JSONL the underlying `claude` CLI ever wrote, i.e. UPSTREAM Claude Code's
 * numbers. Per the Naby-layer realignment, the statistics a Naby user sees must
 * be NABY'S OWN records — the turns run through this app — and are keyed and
 * priced by the same store + pricing table the per-session cost strip
 * (NabySessionCost / F1-07) already uses.
 *
 * IT TOUCHES NO FILESYSTEM TRANSCRIPT SOURCE — only `getStore()`. There is no
 * `CLAUDE_PROJECTS_DIR`, no `.jsonl` read, no stats cache file. The store reads
 * are fast (local SQLite), so no caching layer is needed (project convention:
 * local requests are cheap).
 *
 * SHAPE. It emits the SAME `StatsData` the modal already renders — model usage
 * map, daily activity, daily model tokens, hour counts, totals, longest session,
 * first use — so the client charts are unchanged. Two differences from upstream,
 * both intrinsic to the store's data model:
 *   - There is one row PER ANSWERED TURN (a `UsageRecord`), so "messages" means
 *     turns and there is no per-day tool-call timeline (tool calls live in the
 *     transcript, which carries no per-message timestamp) — `toolCallCount` is 0.
 *   - Cost is authoritative, not re-derived client-side: each row is priced with
 *     `reportedCostUsd` when the engine reported one, else `costOfUsage()` from
 *     the runtime price table, and subscription (dev-claude) turns are surfaced
 *     as an EQUIVALENT figure, never a charge — the `usageSummary` (a runtime
 *     `summarizeUsage` over every row) carries the metered-vs-subscription
 *     wording the UI shows.
 */

import { Effect } from 'effect';
import { handler, ok } from '@cockpit/effect-runtime/server';
import {
  costOfUsage,
  priceModel,
  summarizeUsage,
  type SessionUsageSummary,
  type UsageRecord,
} from '../../../../../../../dist/naby-runtime.mjs';
import { getStore } from '../engines/naby';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The per-model aggregate the modal's cost table renders. `cacheCreationInputTokens`
// and `webSearchRequests` have no analogue in a Naby usage row (the normalized
// `Usage` folds cache writes into inputTokens and we do not count web searches),
// so they are always 0 — kept in the shape only so the client renderer is
// untouched. `costUSD` is the AUTHORITATIVE per-model cost (see `rowCost`).
interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
}

interface DailyActivity {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

interface DailyModelTokens {
  date: string;
  tokensByModel: Record<string, number>;
}

export interface NabyStatsData {
  modelUsage: Record<string, ModelUsage>;
  dailyActivity: DailyActivity[];
  dailyModelTokens: DailyModelTokens[];
  hourCounts: Record<string, number>;
  totalSessions: number;
  /** Total answered turns across all sessions (one per usage row). */
  totalMessages: number;
  /** The session with the widest span between its first and last recorded turn. */
  longestSession?: { sessionId: string; duration: number };
  /** ISO timestamp of the earliest recorded turn. */
  firstSessionDate?: string;
  /** The runtime's own aggregate summary over every usage row — carries the
   *  metered `billedUsd`, the subscription `subscriptionEquivalentUsd`, and the
   *  ready-made `label`/`detail` strings (same wording as the per-session cost
   *  strip). The modal uses it to caption and explain the cost card. */
  usageSummary: SessionUsageSummary;
}

function emptyModelUsage(): ModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow: 0,
  };
}

/**
 * One turn's cost. `reportedCostUsd` wins when the engine gave us one (for a
 * metered turn that is the real charge; for a subscription turn it is the
 * metered-API EQUIVALENT of those tokens, which is what we want to show as
 * "equivalent cost"). Otherwise we price the tokens ourselves against the
 * runtime table — `providerId` is the profile id, which defaults to the
 * provider kind and so is the correct key into `priceModel` (same call the
 * per-session summary makes). An unpriced model contributes 0 rather than a
 * guessed number.
 */
function rowCost(r: UsageRecord): number {
  if (r.reportedCostUsd !== undefined) return r.reportedCostUsd;
  const price = priceModel(r.providerId, r.model);
  return price ? costOfUsage(price, r) : 0;
}

/** Build the whole StatsData shape from the store's usage rows. Store-only: the
 *  single input is `getStore()`; no transcript file is read. */
export function buildNabyStats(): NabyStatsData {
  const store = getStore();
  const sessions = store.listSessions();

  const modelUsage: Record<string, ModelUsage> = {};
  // date → per-day activity accumulator (distinct sessions tracked as a Set).
  const dailyMap = new Map<string, { turns: number; sessions: Set<string> }>();
  // date → model → total tokens that day.
  const dailyTokenMap = new Map<string, Record<string, number>>();
  const hourCounts: Record<string, number> = {};
  const allRecords: UsageRecord[] = [];

  let totalTurns = 0;
  let totalSessions = 0;
  let firstAt = Infinity;
  let longest: { sessionId: string; duration: number } | undefined;

  for (const s of sessions) {
    const records = store.listUsage(s.sessionId);
    if (records.length === 0) continue; // "Total Sessions" = sessions that ran a turn
    totalSessions += 1;

    let minAt = Infinity;
    let maxAt = -Infinity;

    for (const r of records) {
      allRecords.push(r);
      totalTurns += 1;
      if (r.at < firstAt) firstAt = r.at;
      if (r.at < minAt) minAt = r.at;
      if (r.at > maxAt) maxAt = r.at;

      const when = new Date(r.at);
      const date = when.toISOString().slice(0, 10);
      const hour = when.getHours();
      hourCounts[String(hour)] = (hourCounts[String(hour)] ?? 0) + 1;

      let d = dailyMap.get(date);
      if (!d) {
        d = { turns: 0, sessions: new Set() };
        dailyMap.set(date, d);
      }
      d.turns += 1;
      d.sessions.add(s.sessionId);

      const mu = modelUsage[r.model] ?? (modelUsage[r.model] = emptyModelUsage());
      mu.inputTokens += r.inputTokens;
      mu.outputTokens += r.outputTokens;
      mu.cacheReadInputTokens += r.cachedInputTokens;
      mu.costUSD += rowCost(r);

      const tokens = r.inputTokens + r.outputTokens + r.cachedInputTokens;
      let dtm = dailyTokenMap.get(date);
      if (!dtm) {
        dtm = {};
        dailyTokenMap.set(date, dtm);
      }
      dtm[r.model] = (dtm[r.model] ?? 0) + tokens;
    }

    const span = maxAt - minAt;
    if (span > 0 && (!longest || span > longest.duration)) {
      longest = { sessionId: s.sessionId, duration: span };
    }
  }

  const dailyActivity: DailyActivity[] = Array.from(dailyMap.entries())
    .map(([date, d]) => ({
      date,
      messageCount: d.turns,
      sessionCount: d.sessions.size,
      // Tool calls are not on the usage row (they live in the transcript, which
      // has no per-message timestamp to bucket by), so there is no honest
      // per-day tool timeline to show. 0 rather than an invented number.
      toolCallCount: 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const dailyModelTokens: DailyModelTokens[] = Array.from(dailyTokenMap.entries())
    .map(([date, tokensByModel]) => ({ date, tokensByModel }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // One aggregate summary over EVERY row — the same runtime function the
  // per-session strip uses, so the metered/subscription/unpriced wording is
  // decided in one place. 'all' is a display-only pseudo session id.
  const usageSummary = summarizeUsage('all', allRecords);

  return {
    modelUsage,
    dailyActivity,
    dailyModelTokens,
    hourCounts,
    totalSessions,
    totalMessages: totalTurns,
    ...(longest ? { longestSession: longest } : {}),
    ...(firstAt !== Infinity ? { firstSessionDate: new Date(firstAt).toISOString() } : {}),
    usageSummary,
  };
}

export const GET = handler(() =>
  Effect.gen(function* () {
    const stats = yield* Effect.sync(() => buildNabyStats());
    return ok(stats);
  })
);
