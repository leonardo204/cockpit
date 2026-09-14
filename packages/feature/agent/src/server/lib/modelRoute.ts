// packages/feature/agent/src/server/lib/modelRoute.ts
//
// THE SIGNAL-GATHERING HALF OF `auto` (specs/model-auto-routing.md §4.4–§4.5).
//
// The DECISION is `routeModelTier` in the runtime, and it is a pure function on
// purpose: no store, no clock, no catalogue, no I/O. That purity has to be paid
// for somewhere, and this file is where. It reads the four things the rules key
// on out of the places they actually live — the session's messages, the session's
// usage rows, the model-catalogue settings row, the subscription-limits settings
// row — hands them over, and turns the tier that comes back into a string the
// Agent SDK will accept.
//
// ── THE ONE RULE OF THIS FILE: IT CANNOT FAIL THE TURN ──────────────────────
//
// Everything it touches is failure-prone in an ordinary way. A settings row is
// JSON a human can edit. `getMessages` opens SQLite. A session id can name a
// session that was deleted between the dispatch and this line. None of that is
// exotic — and all of it would, without the wrapper below, turn a routing
// PREFERENCE into a failed message. The user asked "which model should answer";
// they did not ask to gamble the turn on the answer being available. So §4.5 says
// it plainly: a router that throws is caught, the turn goes to sonnet, and a
// warning is logged. `resolveAutoModel` has exactly one `try` and it covers the
// whole body, including the fallback's own catalogue lookup.
//
// ── WHY THE STORE IS A STRUCTURAL TYPE ──────────────────────────────────────
//
// Not test scaffolding for its own sake: the three methods below are the ENTIRE
// surface this routing decision is allowed to have on the store, and writing them
// out is what makes that checkable. `Store` has well over a hundred methods, and
// a parameter typed as `Store` would let a later rule reach for `listHarness` or
// `appendMessage` with nothing to notice it. It also lets `modelRoute.test.ts`
// hand-roll fakes the way `growthRead.test.ts` does, so the decision table can be
// driven to a chosen percentage and a chosen history — neither of which a real
// database can be asked for on demand.

import {
  contextWindowFor,
  estimateContextTokens,
  pickCatalogValue,
  routeModelTier,
  tierOfModelId,
  windowsForTiers,
  type ContextTextSource,
  type GrowthStage,
  type ModelTier,
  type RouteReason,
  type RouteSignals,
} from '../../../../../../../dist/naby-runtime.mjs';
import { readClaudeModelRows, readUsageCache, usageCacheState } from './usageCache';

// ---------------------------------------------------------------------------
// `auto` is a chat-bar value, and it must never reach a provider
// ---------------------------------------------------------------------------

/** The chat bar's own row (§4.1). It names a POLICY, not a model, and the SDK
 *  rejects the turn if it ever arrives as one. */
export const AUTO_MODEL_VALUE = 'auto';

/**
 * An agent's or subagent's stored model, as a value that may be sent to an
 * engine — `undefined` for "inherit whatever this turn is running on".
 *
 * WHY THIS IS A FUNCTION AND NOT AN `if` AT ONE CALL SITE. `auto` is a value of
 * the chat bar, not of a model field (§4.1 ends on exactly that sentence), and
 * the agent editor does not offer it. But the editor's model field is FREE TEXT,
 * and an agent can also arrive by import from a file this app never wrote — so
 * "the picker does not offer it" is a statement about one surface, not about the
 * database. The server does not validate model values either (§3), so a stored
 * `auto` would travel agent → `ModelSelection.model` → the Agent SDK's `model`
 * option and come back as "there's an issue with the selected model", on every
 * turn that agent answers, with nothing in the message naming the cause.
 *
 * Treating it EXACTLY LIKE AN EMPTY MODEL is what makes that harmless: an agent
 * with no model of its own already means "use the turn's model", and an agent
 * whose model says `auto` is asking for the same thing in a different word. The
 * router's own choice is what the turn is running on by then, so inheritance
 * delivers precisely what `auto` asked for.
 *
 * Every site that lifts a model off a stored row goes through here — the routed
 * agent (`runTurn`'s model), the subagent roster (which feeds both the Agent
 * SDK's native `agents` map and `naby_delegate`'s nested turns), and the nested
 * turn's inherited model — so there is one answer to "is this string sendable"
 * rather than three that can drift apart.
 */
export function effectiveAgentModel(model?: string): string | undefined {
  const trimmed = (model ?? '').trim();
  if (trimmed === '' || trimmed === AUTO_MODEL_VALUE) return undefined;
  // THE TRIMMED VALUE, not the raw one. The decision was taken on the trimmed
  // string, so returning the raw one hands the SDK a model this function has not
  // actually judged — ` sonnet ` is accepted here and rejected there, on a row a
  // human typed into a free-text field with a stray space. Either the trim is
  // what we mean or it should not be in the comparison.
  return trimmed;
}

// ---------------------------------------------------------------------------
// What the router needs from the store
// ---------------------------------------------------------------------------

/** The whole surface `resolveAutoModel` has on the store — see the header. */
export type ModelRouteStore = {
  /** This session's transcript, for the occupancy estimate (§4.4). */
  getMessages(sessionId: string): readonly ContextTextSource[];
  /** This session's per-turn usage rows, oldest first, for `previousTier` (§4.4). */
  listUsage(sessionId: string): readonly { providerId: string; model: string }[];
  /** Settings rows: the model catalogue and the subscription limits caches. */
  getSetting(key: string): string | undefined;
};

export type ResolveAutoModelArgs = {
  store: ModelRouteStore;
  sessionId: string;
  /** This turn's user text, with any `@name` address already stripped. */
  turnText: string;
  /** `@naby` (or `@someAgent`) full mode — the persona is driving, not just
   *  answering. */
  fullMode: boolean;
  /** Growth stage of whoever answers, when there is one. */
  stage?: GrowthStage;
  /** Plan mode (read-only) — the per-tab checkbox. */
  planMode: boolean;
  /** Which Claude subscription is answering, for the per-account limits row.
   *  Undefined is the ordinary single-account case and reads the `default` key. */
  accountId?: string;
  /** Injectable clock. Only the cache-freshness comparison uses it. */
  now?: number;
};

/** What the shell puts on the wire: the value the engine runs, plus the two
 *  fields `model_route` carries to the chip (§4.6). */
export type AutoModelResolution = {
  value: string;
  tier: ModelTier;
  reason: RouteReason;
};

/** The provider whose usage rows count as "the previous tier of this session".
 *  A metered turn ran on somebody else's model ids entirely. */
const CLAUDE_PROVIDER_ID = 'dev-claude';

/**
 * The tier that answered the previous turn of this session, or `undefined`
 * (§4.4).
 *
 * THE LAST DEV-CLAUDE ROW, not the last row: a session can have been answered by
 * a metered provider before the user switched, and `gpt-5` names no tier we route
 * between. `listUsage` returns oldest-first (`ORDER BY seq ASC`), so the last
 * match is the most recent one, and `tierOfModelId` reads the RESOLVED id the run
 * recorded rather than the alias it was asked for.
 */
function previousTierOf(
  store: ModelRouteStore,
  sessionId: string,
): ModelTier | undefined {
  const rows = store.listUsage(sessionId) ?? [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row?.providerId !== CLAUDE_PROVIDER_ID) continue;
    const tier = tierOfModelId(row.model);
    if (tier) return tier;
    // A dev-claude row naming nothing we recognise (`default`, an unknown
    // family) is not evidence of a tier, and it is not evidence of ABSENCE
    // either — keep looking further back rather than concluding "no previous".
  }
  return undefined;
}

/**
 * The subscription percentages, ONLY when the cached reading is one we would
 * serve (§4.5).
 *
 * THREE WAYS THIS RETURNS `undefined`, and they all mean the same thing to the
 * router: skip the budget rule entirely. No cache, an unparseable row, and a
 * reading past the staleness ceiling are all "we do not know how full the window
 * is" — and §2 principle 7 is explicit that an absent limit is absent, never a
 * zero and never a reason to act. A frozen percentage would otherwise cap every
 * turn on this machine forever.
 *
 * IT NEVER PROBES. `usage.limits` spawns the Claude CLI when the cache is cold;
 * doing that here would put up to a minute in front of a turn to answer a
 * question the router is happy to skip.
 *
 * `refresh: false` because this is not a user action: an explicit refresh
 * demotes `fresh` to `stale-usable` so the route goes and looks, and the router
 * has nothing to look with.
 */
function usageSignals(
  store: ModelRouteStore,
  accountId: string | undefined,
  now: number,
): RouteSignals['usage'] {
  const cached = readUsageCache(store.getSetting(`usage.limits.cache.${accountId ?? 'default'}`));
  const state = usageCacheState(cached, now, false);
  if (!cached || (state !== 'fresh' && state !== 'stale-usable')) return undefined;
  const limits = cached.limits;
  if (!limits) return undefined;
  // The 5-hour plan window, and the 7-day OPUS sub-window specifically — the two
  // §4.2 rule 4 names. `seven_day` (the all-model window) is deliberately NOT
  // read: capping opus because the shared weekly window is full would move work
  // onto sonnet, which spends the SAME window, and change nothing but the answer.
  const fiveHourPct = limits.fiveHour?.utilizationPercent;
  const opusPct = limits.extra?.seven_day_opus?.utilizationPercent;
  // Each field is omitted rather than defaulted, one level down, for the same
  // reason the whole object is: `utilizationPercent` is optional on a window, so
  // a cache can be fresh and still not say how full the opus window is.
  return {
    ...(typeof fiveHourPct === 'number' ? { fiveHourPct } : {}),
    ...(typeof opusPct === 'number' ? { opusPct } : {}),
  };
}

/**
 * WHICH MODEL ANSWERS THIS `auto` TURN (§4.5).
 *
 * SYNCHRONOUS, and that is a contract rather than an accident: every source it
 * reads is a local row, and the call site is one statement before the init event
 * goes out. An `await` here would put the first token of every `auto` turn behind
 * whatever the event loop happened to be doing, for a decision that has all its
 * inputs on hand.
 *
 * THE FALLBACK IS SONNET, ALWAYS. Not the last tier used, not opus: an ambiguous
 * turn is sonnet by the router's own instruction, and a turn whose signals could
 * not be READ is the most ambiguous turn there is. `reason: 'default'` is the
 * honest code for it — the chip will say "일반 요청", which is exactly what the
 * shell knows.
 */
export function resolveAutoModel(args: ResolveAutoModelArgs): AutoModelResolution {
  const { store, sessionId, turnText, fullMode, stage, planMode, accountId } = args;
  try {
    const now = args.now ?? Date.now();

    // §4.4 — occupancy. A LOWER BOUND over the stored transcript; the window rule
    // knows that and carries a 1.5x margin.
    //
    // IT COSTS A WHOLE SECOND READ OF THE TRANSCRIPT. `runTurn` reads the same
    // DATA when it builds the prompt, but this is not the same READ: a separate
    // SQLite query and a separate JSON parse of every row, once per turn. On a
    // 250k-token session that is not free — it is simply small next to the model
    // call it is choosing, which is the whole justification (§4.4). Anyone
    // tempted to add a second pass over `getMessages` here should note that the
    // first one is already the expensive part of this function.
    const estimatedContextTokens = estimateContextTokens(store.getMessages(sessionId) ?? []);

    // §4.3 — the live catalogue, cache-only. `undefined` is ordinary (a machine
    // whose picker has never been opened) and lands on the aliases.
    const rows = readClaudeModelRows(store);

    // §4.3 — sizes per tier, asked of the same values that will be sent. The two
    // callbacks are what keep the router from knowing either table.
    const windows = windowsForTiers(
      (tier) => pickCatalogValue(tier, rows),
      (value) => contextWindowFor(CLAUDE_PROVIDER_ID, value),
    );

    const previousTier = previousTierOf(store, sessionId);
    const usage = usageSignals(store, accountId, now);

    const decision = routeModelTier({
      text: turnText,
      fullMode,
      ...(stage ? { stage } : {}),
      planMode,
      estimatedContextTokens,
      ...(previousTier ? { previousTier } : {}),
      windows,
      ...(usage ? { usage } : {}),
    });

    return {
      value: pickCatalogValue(decision.tier, rows),
      tier: decision.tier,
      reason: decision.reason,
    };
  } catch (err) {
    // `pickCatalogValue` with no catalogue is a pure string lookup and cannot be
    // the thing that threw, so the fallback needs no guard of its own.
    console.warn(
      `[engine:naby] auto routing failed, falling back to sonnet: ${String(err)}`,
    );
    return { value: pickCatalogValue('sonnet', undefined), tier: 'sonnet', reason: 'default' };
  }
}
