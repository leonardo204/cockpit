// packages/feature/agent/src/server/lib/usageCache.ts
//
// THE TWO SETTINGS ROWS THE MODEL ROUTER HAS TO READ, and the defensive parsers
// that turn them back into values (specs/model-auto-routing.md §4.5).
//
// WHY THIS FILE EXISTS AT ALL. Both readers were born inside `api/naby.ts`, next
// to the actions that WRITE them, and that was the right home while the only
// reader was the writer. `auto` added a second reader on the other side of the
// server — `engines/naby.ts` has to know how full the subscription window is and
// which model values the sign-in actually offers, one statement before it emits
// the init event — and there is no import edge from an engine to an API route,
// nor should there be: a route module is a request handler, and importing one to
// borrow a parser would drag its whole action switch (and every runtime symbol it
// pulls in) into the turn path.
//
// So the PARSERS move here and the ACTIONS stay there. `api/naby.ts` imports
// them back and re-exports the two its own tests address by name, which is why
// nothing that already depended on `./naby` had to change.
//
// WHAT DID NOT MOVE, and why the split falls where it does: `writeModelCache`,
// `MODEL_CACHE_TTL_MS` and `claudeModelCacheIsFresh` are about DECIDING TO PROBE
// — a question only the route asks, because only the route can probe. This file
// answers the other question, "what does the row already say", which is the only
// one a turn is allowed to ask: a turn must never spawn a CLI to choose a model.

import {
  SUBSCRIPTION_USAGE_MAX_STALE_MS,
  SUBSCRIPTION_USAGE_TTL_MS,
  type CatalogRow,
  type ClaudeCliUsageReason,
  type ClaudeModelInfo,
  type SubscriptionUsage,
} from '../../../../../../../dist/naby-runtime.mjs';

// ---------------------------------------------------------------------------
// The model catalogue cache (`models.<catalogue>.cache`)
// ---------------------------------------------------------------------------

/**
 * WHICH CATALOGUES `models.list` CAN ANSWER FOR.
 *
 * Two providers ask the same question — "which models may I use" — of two very
 * different places: Claude asks the local sign-in through the Agent SDK, Google
 * asks its own HTTP catalogue with the stored key. Everything AROUND that probe
 * is identical (a settings-row cache, a day's TTL, an explicit refresh, and a
 * failure that falls back to the cache rather than emptying a picker), so it is
 * written once and parameterised by this name rather than copied.
 */
export type ModelCatalog = 'claude' | 'google';

/** Setting key holding the last successful probe, per catalogue. The names follow
 *  one rule — `models.<catalogue>.cache` — and `claude`'s is the pre-existing key,
 *  so nothing that was already cached is invalidated by the generalisation. */
export function modelCacheKey(catalog: ModelCatalog): string {
  return `models.${catalog}.cache`;
}

/**
 * Read the cache defensively — it is JSON in a settings row, so a hand-edited or
 * half-written value must read as "no cache" rather than throwing in a chat
 * header, a settings screen, or (now) the first second of a turn.
 *
 * The payload field is NAMED AFTER THE CATALOGUE (`{ fetchedAt, claude: [...] }`,
 * `{ fetchedAt, google: [...] }`), which is what lets one reader serve both
 * without touching the shape Claude's cache is already written in.
 *
 * `sdk` is the Agent SDK version that PRODUCED a Claude list — absent on Google's
 * cache and on any row written before this existed, which is why it is optional
 * rather than required. See `claudeModelCacheIsFresh` in api/naby.ts for what it
 * is for.
 */
export function readModelCache<T>(
  raw: string | undefined,
  catalog: ModelCatalog,
  keep: (row: unknown) => row is T,
): { fetchedAt: number; sdk: string | null; models: T[] } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const fetchedAt = typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0;
    const sdk = typeof parsed.sdk === 'string' ? parsed.sdk : null;
    const rows = parsed[catalog];
    return { fetchedAt, sdk, models: Array.isArray(rows) ? rows.filter(keep) : [] };
  } catch {
    return null;
  }
}

/** A cached row is a model only if it carries the one field everything downstream
 *  keys on. `displayName` is NOT required here: it is what a picker renders, and
 *  a row that lost its label still names a model the SDK accepts. */
export const isClaudeModel = (row: unknown): row is ClaudeModelInfo =>
  !!row && typeof row === 'object' && typeof (row as ClaudeModelInfo).value === 'string';

/**
 * The Claude catalogue as the ROUTER needs it: synchronous, throw-free, and
 * `undefined` when there is nothing cached (§4.3).
 *
 * SYNCHRONOUS AND CACHE-ONLY, DELIBERATELY. The live probe spawns the Agent SDK's
 * CLI and is budgeted at up to 8 seconds on a warm machine and 45 on a cold one.
 * Waiting for that before choosing a model would put the whole probe budget in
 * front of every `auto` turn to answer a question whose fallback (`pickCatalogValue`
 * with no catalogue) is a working alias. So this reads the row the picker already
 * filled and never probes.
 *
 * NO TTL IS APPLIED, and that is not an oversight. The route's TTL answers "might
 * a NEW model have shipped since?" — a reason to go look, not a reason to stop
 * believing what is written down. A day-old row still names `opus[1m]` and
 * `claude-fable-5-1[1m]` correctly, and treating it as absent would silently move
 * fable from its concrete id to the bare alias, which `contextWindowFor` measures
 * at 200k — i.e. an expired TTL would shrink a window. The rows are values, and a
 * value does not rot on a clock.
 *
 * `undefined` rather than `[]` for "no cache": `pickCatalogValue` distinguishes
 * them only by falling back either way, but the caller can log the difference, and
 * an empty array reads as "the sign-in offers no models", which is a different
 * (and wrong) claim.
 */
export function readClaudeModelRows(store: {
  getSetting(key: string): string | undefined;
}): CatalogRow[] | undefined {
  try {
    const cached = readModelCache(
      store.getSetting(modelCacheKey('claude')),
      'claude',
      isClaudeModel,
    );
    if (!cached || cached.models.length === 0) return undefined;
    // Narrowed to the two fields the router reads. Passing `ClaudeModelInfo`
    // straight through would type-check too, but `CatalogRow` is the contract the
    // runtime declares, and keeping the boundary at the declared shape is what
    // stops a picker-only field (`supportsEffort`, `displayName`) from quietly
    // becoming something a routing rule depends on.
    return cached.models.map((m) => ({
      value: m.value,
      ...(m.resolvedModel ? { resolvedModel: m.resolvedModel } : {}),
    }));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The subscription usage cache (`usage.limits.cache.<accountId>`)
// ---------------------------------------------------------------------------

/** What `usage.limits` keeps between calls. Shaped as the response minus the
 *  `cached` flag, which is a fact about the read rather than about the reading. */
export type UsageCacheEntry = {
  limits: SubscriptionUsage | null;
  fetchedAt: number;
  sources: ('sdk' | 'cli')[];
  cliReason: ClaudeCliUsageReason;
};

/**
 * Read the usage cache defensively, and REJECT ANYTHING THAT IS NOT A COMPLETE,
 * TIMESTAMPED READING.
 *
 * The strictness is the point. A settings row can be hand-edited or half-written,
 * and every caller of this decides "is it too old" by subtracting `fetchedAt` —
 * so an entry that parses but has `fetchedAt: 0` would read as infinitely stale
 * (harmless), while one with a missing `limits` key would read as a successful
 * lookup that found no windows (not harmless: it would suppress a fresh probe for
 * fifteen minutes). Both are refused as "no cache" instead.
 */
export function readUsageCache(raw: string | undefined): UsageCacheEntry | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const fetchedAt = typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0;
    if (fetchedAt <= 0) return null;
    // `null` is a legitimate stored value ("we asked and this account has no plan
    // windows"), so it is distinguished from the key being absent entirely.
    if (!('limits' in parsed)) return null;
    const limits = (parsed.limits ?? null) as SubscriptionUsage | null;
    if (limits !== null && typeof limits !== 'object') return null;
    const sources = Array.isArray(parsed.sources)
      ? parsed.sources.filter((s): s is 'sdk' | 'cli' => s === 'sdk' || s === 'cli')
      : [];
    const cliReason = (
      parsed.cliReason === 'same-account' ||
      parsed.cliReason === 'different-account' ||
      parsed.cliReason === 'stale-cache'
        ? parsed.cliReason
        : 'no-cache'
    ) as ClaudeCliUsageReason;
    return { limits, fetchedAt, sources, cliReason };
  } catch {
    return null;
  }
}

/**
 * WHAT A CACHED READING IS STILL GOOD FOR, as a pure function of the clock.
 *
 * Extracted from the case body because it is the whole freshness policy of the
 * feature and it CANNOT BE REACHED FROM AN END-TO-END TEST: the branches that are
 * not `fresh` all continue into `probeClaudeUsage`, which spawns the Claude CLI
 * and takes up to a minute to fail on a machine that has no sign-in. So the two
 * thresholds are asserted directly, at a fixed clock, and the case body reads as
 * the three sentences they are.
 *
 *   fresh          inside the TTL — serve it and touch no source at all. This is
 *                  what makes it safe for the client to ask on every turn end.
 *   stale-usable   past the TTL but inside the ceiling — worth a fresh look, and
 *                  still good enough to answer with IF that look fails.
 *   expired        past the ceiling — no longer a reading. A failed look now
 *                  answers with nothing, because serving a frozen percentage
 *                  forever is the exact defect that disqualified reading another
 *                  program's cache as a lone source.
 *
 * `refresh` (an explicit user action) skips straight past `fresh`; it can still
 * be `stale-usable`, so an explicit refresh that FAILS falls back rather than
 * blanking a number the user was already looking at.
 *
 * THE ROUTER USES THE SAME THREE WORDS for a different decision (§4.5): it acts
 * on `fresh` and `stale-usable` and ignores the rest, which is why it calls this
 * with `refresh: false` — it is never an explicit user action, and it must never
 * turn a servable reading into a reason to go look.
 */
export function usageCacheState(
  cached: { fetchedAt: number } | null,
  now: number,
  refresh: boolean,
): 'none' | 'fresh' | 'stale-usable' | 'expired' {
  if (!cached) return 'none';
  const age = now - cached.fetchedAt;
  if (age >= SUBSCRIPTION_USAGE_MAX_STALE_MS) return 'expired';
  if (!refresh && age < SUBSCRIPTION_USAGE_TTL_MS) return 'fresh';
  return 'stale-usable';
}

/** Persist a reading. An unwritable cache costs one extra probe next time and
 *  nothing else, which is why this swallows rather than failing the request —
 *  the same rule `writeModelCache` follows. */
export function writeUsageCache(
  store: { setSetting(k: string, v: string): void },
  key: string,
  entry: UsageCacheEntry,
): void {
  try {
    store.setSetting(key, JSON.stringify(entry));
  } catch {
    /* see above */
  }
}
