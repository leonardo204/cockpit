/**
 * `/api/memory` — the scoped-memory review + delete surface (Phase 1.5 P15-06).
 *
 * WHY THIS EXISTS. Scoped memory (contract §3) is durable, cross-session
 * personalization: `user`-scope rows survive session AND project deletes
 * (contract §2). That durability is the point — and also the attack surface.
 * An `external`-origin memory that slips past the write gate (§4) as a
 * `proposed` row is the memory-poisoning vector the strategy calls out (ASI06).
 * This route is the LAST DEFENSIVE LAYER: it lets a user READ their own memory
 * WITH ITS PROVENANCE and DELETE it — one row, or every row from one source
 * (`deleteMemory({source, sessionId?})`, the poisoning rollback of §6). It is
 * also the ONLY path an `external`-origin `proposed` row becomes `confirmed`
 * (`confirmMemory`, §4 invariant 1) — a threshold can never do it, only a user.
 *
 * NO SECRET CROSSES THIS FILE — AND VALUES ARE INTENTIONALLY SHOWN. Unlike
 * `/api/naby` (which REDACTS MCP `env`/`headers` because a user may have put a
 * provider token there), a memory `value` is the user's OWN remembered content
 * about themselves. Hiding it would defeat the entire purpose of a review UI —
 * you cannot decide to delete a poisoned memory you are not allowed to see. So
 * the row is handed to the renderer WHOLE (id, key, value, type, status,
 * provenance). The one discipline kept from `/api/naby`: this is ordinary
 * application data owned by the RUNTIME, so it rides an HTTP route reached via
 * `getStore()`, never the credential IPC bridge.
 *
 * STORE-ONLY. The single input is `getStore()` (the same store the stats and
 * session-browse routes read); no filesystem transcript is touched.
 */

import { Effect } from 'effect';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import {
  CORROBORATION_THRESHOLD,
  DEFAULT_USER_ID,
  MEMORY_DECAY_REVIEW_MS,
  staleReviewCutoff,
  type MemoryItem,
  type MemoryScope,
  type MemoryStatus,
  type MemoryType,
  type ScopedMemoryQuery,
  type Store,
  type TrustTier,
} from '../../../../../../../dist/naby-runtime.mjs';
import { getStore } from '../engines/naby';
// The auto-confirm opt-in belongs to the consolidation step (which is the only
// thing that acts on it), so the key and its spelling live there and this route
// reads/writes it through the same two functions rather than re-deriving them.
import { readAutoConfirmSetting, writeAutoConfirmSetting } from '../lib/reflection';

// The slice of the store this route touches. Named so the handlers depend on an
// injectable seam (default `getStore()`), which keeps the list/action logic unit-
// testable against a fake store without opening a real sqlite file.
type MemoryStore = Pick<
  Store,
  | 'getScopedMemory'
  | 'confirmMemory'
  | 'deleteMemory'
  // P3-M8b: how many distinct sessions agree with each listed row, and the
  // opt-in that lets consolidation confirm the best-corroborated ones.
  | 'getMemoryCorroboration'
  | 'getSetting'
  | 'setSetting'
  // P3-M10 (memory-hygiene §3/§4): the browser's page total, the EDIT that
  // promotes a row to `user` tier, and the "keep this" action — which is
  // `markMemoriesInjected` for one id, because a person saying "still relevant"
  // is the same claim the injection step makes when it selects a row (§2.1).
  | 'countScopedMemory'
  | 'updateMemoryValue'
  | 'markMemoriesInjected'
>;

// The store is opened on demand, so this must run on the node runtime and must
// never be statically rendered.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Validation helpers — the query/body come off the wire untyped.
// ---------------------------------------------------------------------------

const MEMORY_SCOPES: readonly MemoryScope[] = ['session', 'project', 'user', 'org'];
const MEMORY_STATUSES: readonly MemoryStatus[] = ['proposed', 'confirmed'];
const MEMORY_TYPES: readonly MemoryType[] = ['working', 'episodic', 'semantic', 'procedural'];
const TRUST_TIERS: readonly TrustTier[] = ['user', 'artifact', 'external'];

/** The browser's page size (P3-M10 §4). Also the CEILING a request may ask for:
 *  the parameter comes off the wire, and `?limit=100000` on a large memory is a
 *  way to make the app render itself to a halt from a URL. */
export const MEMORY_PAGE_SIZE = 50;

function isScope(v: unknown): v is MemoryScope {
  return typeof v === 'string' && (MEMORY_SCOPES as readonly string[]).includes(v);
}

function isStatus(v: unknown): v is MemoryStatus {
  return typeof v === 'string' && (MEMORY_STATUSES as readonly string[]).includes(v);
}

function isType(v: unknown): v is MemoryType {
  return typeof v === 'string' && (MEMORY_TYPES as readonly string[]).includes(v);
}

/** Parse a non-negative integer query parameter; undefined when absent or
 *  unparseable, so a junk value falls back to the default rather than to NaN. */
function parseCount(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.trunc(n);
}

function isTrustTier(v: unknown): v is TrustTier {
  return typeof v === 'string' && (TRUST_TIERS as readonly string[]).includes(v);
}

/**
 * Resolve the `scopeKey` for a read. For `user` scope the key is the stable
 * local user id — a single-user-machine CONSTANT the runtime owns
 * (`DEFAULT_USER_ID`, the same value the injection step keys `user` memory on,
 * runtime `gatherCandidates`). The client never needs to know it, so an omitted
 * `scopeKey` on `user` scope resolves here rather than erroring. Session/project
 * scopes are addressed by their own key (sessionId / cwd), which the caller
 * supplies. Returns null when a required key is missing.
 */
function resolveScopeKey(scope: MemoryScope, scopeKey: string | null): string | null {
  if (scope === 'user') return scopeKey && scopeKey.length > 0 ? scopeKey : DEFAULT_USER_ID;
  return scopeKey && scopeKey.length > 0 ? scopeKey : null;
}

// ---------------------------------------------------------------------------
// GET — list one scope's memory, provenance included.
// ---------------------------------------------------------------------------

export interface MemoryListResult {
  scope: MemoryScope;
  /** The RESOLVED scopeKey the rows were read for (echoes the `user` default so
   *  the client can label the panel without knowing the constant). */
  scopeKey: string;
  /** The rows WHOLE — value included; this is the user's own content (see file
   *  header). Ordered createdAt asc by the store. */
  items: MemoryItem[];
  /**
   * P3-M8b: how many DISTINCT sessions agree with each row's current value,
   * keyed by item id. Ids with no observations are absent (read `?? 0`).
   *
   * WHY IT RIDES ALONG WITH THE LIST. A reviewer facing thirty proposals needs
   * to know which ones the conversation kept coming back to — that is the whole
   * ordering signal (§5.4), and fetching it separately would mean rendering the
   * queue once in the wrong order and then re-sorting it.
   */
  corroboration: Record<string, number>;
  /** Whether corroborated proposals are auto-confirmed (§5.4). Sent with the
   *  list so the toggle renders in its true state on first paint. */
  autoConfirm: boolean;
  /**
   * How many distinct sessions auto-confirmation requires
   * (`CORROBORATION_THRESHOLD`). Sent rather than duplicated client-side because
   * the review panel imports the runtime for TYPES ONLY — pulling a value across
   * that line would drag node code into the browser bundle — and a hand-copied 3
   * in a Korean sentence is a number that goes wrong silently the day §7 tunes it.
   */
  corroborationThreshold: number;
  /**
   * P3-M10 §4 — how many rows match this FILTER, ignoring the page window. What
   * the browser's "51–100 of 340" and its page buttons are computed from; the
   * store answers it with the same predicate as the list, so the two cannot
   * describe different sets.
   */
  total: number;
  /** The window actually applied (echoed so the client never has to assume the
   *  server honoured what it asked for). */
  limit: number;
  offset: number;
  /** The stale cutoff in force, epoch ms, or null when the "stale" filter is off
   *  — sent so the client can label the filter with the real window instead of
   *  hardcoding "90 days" beside a constant it cannot see (§2.2 lists that
   *  constant as a tunable). */
  staleBefore: number | null;
}

export function listScopedMemory(
  params: {
    scope: string | null;
    scopeKey: string | null;
    status: string | null;
    // -- P3-M10 §4: the memory browser's filters. Every one of them is optional
    // and every omission is "no filter", so the pre-M10 three-parameter call is
    // byte-for-byte the request it always was.
    type?: string | null;
    search?: string | null;
    /** '1'/'true' turns on the derived stale filter (confirmed + unused). */
    stale?: string | null;
    limit?: number | undefined;
    offset?: number | undefined;
  },
  store: MemoryStore = getStore(),
  now: number = Date.now(),
): { ok: true; data: MemoryListResult } | { ok: false; error: string } {
  if (!isScope(params.scope)) {
    return { ok: false, error: `scope must be one of ${MEMORY_SCOPES.join(', ')}` };
  }
  if (params.status !== null && !isStatus(params.status)) {
    return { ok: false, error: `status must be one of ${MEMORY_STATUSES.join(', ')}` };
  }
  if (params.type != null && params.type !== '' && !isType(params.type)) {
    return { ok: false, error: `type must be one of ${MEMORY_TYPES.join(', ')}` };
  }
  const scopeKey = resolveScopeKey(params.scope, params.scopeKey);
  if (scopeKey === null) {
    return { ok: false, error: `scopeKey is required for ${params.scope} scope` };
  }

  // CLAMPED, not trusted. `limit` comes off the wire and a request for a million
  // rows is a way to hang the renderer from a URL; 0 is refused too, since a page
  // that can never contain anything is not a page.
  const limit = Math.min(
    MEMORY_PAGE_SIZE,
    Math.max(1, params.limit ?? MEMORY_PAGE_SIZE),
  );
  const offset = Math.max(0, params.offset ?? 0);
  const stale = params.stale === '1' || params.stale === 'true';
  // The SAME cutoff the reflection sweep derives its review queue from — one
  // expression in the runtime, two callers, so the filter and the log can never
  // mean different windows.
  const staleBefore = stale ? staleReviewCutoff(now, MEMORY_DECAY_REVIEW_MS) : null;

  const filter: ScopedMemoryQuery = {
    ...(params.status ? { status: params.status } : {}),
    ...(params.type ? { type: params.type as MemoryType } : {}),
    ...(params.search && params.search.trim() ? { search: params.search.trim() } : {}),
    ...(staleBefore !== null ? { staleBefore } : {}),
  };

  const items = store.getScopedMemory(params.scope, scopeKey, { ...filter, limit, offset });
  // The total for the SAME filter without the window. One extra COUNT(*) per
  // page — the alternative (reading every row to count them) is what pagination
  // exists to avoid.
  const total = store.countScopedMemory(params.scope, scopeKey, filter);
  // ONE extra store call for the ids just listed — the store answers them in a
  // single grouped query, so this stays three statements however long the list is.
  const corroboration = store.getMemoryCorroboration(items.map((item) => item.id));
  return {
    ok: true,
    data: {
      scope: params.scope,
      scopeKey,
      items,
      corroboration,
      autoConfirm: readAutoConfirmSetting(store),
      corroborationThreshold: CORROBORATION_THRESHOLD,
      total,
      limit,
      offset,
      staleBefore,
    },
  };
}

// ---------------------------------------------------------------------------
// The summary card's read (P3-M10 §4).
// ---------------------------------------------------------------------------

/** Per-scope counts, for the compact card that replaced the inline list. */
export interface MemoryScopeSummary {
  scope: MemoryScope;
  scopeKey: string;
  confirmed: number;
  proposed: number;
  /** Confirmed rows nobody has used inside the review window (§2.2). */
  stale: number;
}

export interface MemorySummaryResult {
  scopes: MemoryScopeSummary[];
  /** The newest few `proposed` rows across every reachable scope — the ones the
   *  card offers inline confirm/delete for. Newest first. */
  recentProposed: MemoryItem[];
  corroboration: Record<string, number>;
  autoConfirm: boolean;
  corroborationThreshold: number;
}

/** How many proposals the summary card shows inline (§4). Three, because the
 *  card's job is to say "there are decisions waiting" and offer the nearest ones
 *  — the rest belong in the browser, which is the whole point of splitting them. */
export const SUMMARY_PROPOSED_LIMIT = 3;

/**
 * Counts per scope plus the newest proposals — everything the settings summary
 * card renders, in ONE request.
 *
 * WHY COUNTS AND NOT ROWS. The card exists because the old panel listed every
 * memory inline and therefore grew without bound inside Settings (§1). Answering
 * it with the rows again would rebuild exactly that; a count is O(1) to render
 * however large the memory gets.
 *
 * A scope with no reachable key (no open session, no project, no org id) is
 * simply OMITTED rather than reported as zero — "you have no project memory" and
 * "there is no project open" are different statements, and only one of them is
 * true here.
 */
export function summarizeMemory(
  params: { sessionId?: string | null; cwd?: string | null },
  store: MemoryStore = getStore(),
  now: number = Date.now(),
): MemorySummaryResult {
  const staleBefore = staleReviewCutoff(now, MEMORY_DECAY_REVIEW_MS);
  const targets: { scope: MemoryScope; scopeKey: string }[] = [
    { scope: 'user', scopeKey: DEFAULT_USER_ID },
  ];
  if (params.sessionId) targets.push({ scope: 'session', scopeKey: params.sessionId });
  if (params.cwd) targets.push({ scope: 'project', scopeKey: params.cwd });

  const scopes: MemoryScopeSummary[] = [];
  const proposals: MemoryItem[] = [];
  for (const target of targets) {
    scopes.push({
      ...target,
      confirmed: store.countScopedMemory(target.scope, target.scopeKey, {
        status: 'confirmed',
      }),
      proposed: store.countScopedMemory(target.scope, target.scopeKey, {
        status: 'proposed',
      }),
      stale: store.countScopedMemory(target.scope, target.scopeKey, { staleBefore }),
    });
    // The proposals themselves, capped per scope BEFORE the merge: the store
    // orders by createdAt asc, so the newest are at the END — hence the window is
    // taken from the tail rather than the head.
    const pending = store.getScopedMemory(target.scope, target.scopeKey, {
      status: 'proposed',
    });
    proposals.push(...pending.slice(-SUMMARY_PROPOSED_LIMIT));
  }

  const recentProposed = proposals
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, SUMMARY_PROPOSED_LIMIT);
  return {
    scopes,
    recentProposed,
    corroboration: store.getMemoryCorroboration(recentProposed.map((item) => item.id)),
    autoConfirm: readAutoConfirmSetting(store),
    corroborationThreshold: CORROBORATION_THRESHOLD,
  };
}

// ---------------------------------------------------------------------------
// POST — the mutations (confirm one, delete one, delete a whole source).
// ---------------------------------------------------------------------------

export type MemoryAction =
  | { action: 'confirm'; id: string }
  | { action: 'delete'; id: string }
  // Provenance-addressed bulk delete (§6 poisoning rollback). Supply `source`
  // ("all external-origin memory"), `sessionId` ("everything this session
  // taught", across every trust tier), or both ("this session's external
  // memory"). At least one selector is required.
  | { action: 'deleteBySource'; source?: TrustTier; sessionId?: string }
  // P3-M8b §5.4 — the opt-in that lets the consolidation step confirm a
  // `proposed` row that CORROBORATION_THRESHOLD distinct sessions agree with.
  // Off by default, and `external`-origin memory is untouched by it either way
  // (memory-contracts §4 invariant 1 is not a setting).
  | { action: 'autoConfirm.get' }
  | { action: 'autoConfirm.set'; enabled: boolean }
  // -- P3-M10 (memory-hygiene §3) — the sovereignty actions -----------------
  // EDIT one row's value. Promotes it to the `user` trust tier and resets its
  // corroboration when the claim actually changed; the store owns both rules.
  | { action: 'edit'; id: string; value: string }
  // "KEEP THIS" from the stale-review filter (§2.2). Stamps access, which is the
  // same thing the injection step does when it selects a row — a person saying
  // "still relevant" is at least as good a signal as a retrieval saying it.
  | { action: 'keepAlive'; id: string };

export type MemoryActionResult =
  | { ok: true; autoConfirm?: boolean; item?: MemoryItem }
  | { ok: false; error: string };

export function runMemoryAction(
  body: MemoryAction,
  store: MemoryStore = getStore(),
): MemoryActionResult {
  switch (body.action) {
    case 'confirm': {
      // The ONLY path an external-origin proposed row becomes confirmed (§4
      // invariant 1). No-op in the store if already confirmed / absent.
      if (typeof body.id !== 'string' || !body.id) {
        return { ok: false, error: 'id is required' };
      }
      store.confirmMemory(body.id);
      return { ok: true };
    }

    case 'delete': {
      if (typeof body.id !== 'string' || !body.id) {
        return { ok: false, error: 'id is required' };
      }
      store.deleteMemory({ id: body.id });
      return { ok: true };
    }

    case 'deleteBySource': {
      // The POISONING ROLLBACK (§6). Every store selector is (source [+ session]),
      // so this maps the three UI intents onto it:
      //   source only            → "all external-origin memory"
      //   source + sessionId      → "this session's external-origin memory"
      //   sessionId only          → "everything this session taught", which spans
      //                             all three trust tiers, so we fan the delete
      //                             across each tier for that session.
      const hasSource = body.source !== undefined;
      const sessionId =
        typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : undefined;

      if (hasSource) {
        if (!isTrustTier(body.source)) {
          return { ok: false, error: `source must be one of ${TRUST_TIERS.join(', ')}` };
        }
        store.deleteMemory(sessionId ? { source: body.source, sessionId } : { source: body.source });
        return { ok: true };
      }

      if (sessionId) {
        for (const tier of TRUST_TIERS) store.deleteMemory({ source: tier, sessionId });
        return { ok: true };
      }

      return { ok: false, error: 'deleteBySource requires source and/or sessionId' };
    }

    case 'autoConfirm.get':
      return { ok: true, autoConfirm: readAutoConfirmSetting(store) };

    case 'autoConfirm.set': {
      // Strictly boolean: a missing or string-ish `enabled` would otherwise turn
      // auto-confirmation ON by accident, which is the one direction this switch
      // must never be flipped by a malformed request.
      if (typeof body.enabled !== 'boolean') {
        return { ok: false, error: 'enabled must be a boolean' };
      }
      writeAutoConfirmSetting(store, body.enabled);
      return { ok: true, autoConfirm: body.enabled };
    }

    case 'edit': {
      if (typeof body.id !== 'string' || !body.id) {
        return { ok: false, error: 'id is required' };
      }
      // A BLANK VALUE IS REFUSED, not stored. An empty memory is not an edit, it
      // is a delete performed by accident — and the row would still be injected,
      // spending budget on a line that says nothing. Delete is right there.
      if (typeof body.value !== 'string' || body.value.trim().length === 0) {
        return { ok: false, error: 'value must be a non-empty string' };
      }
      const item = store.updateMemoryValue(body.id, body.value.trim());
      if (!item) return { ok: false, error: 'no such memory' };
      return { ok: true, item };
    }

    case 'keepAlive': {
      if (typeof body.id !== 'string' || !body.id) {
        return { ok: false, error: 'id is required' };
      }
      // Deliberately NOT reported as missing when the id is unknown: the store
      // matches no row and the outcome the caller wanted ("this is not stale
      // any more") is true either way, since a row that no longer exists cannot
      // be in the queue.
      store.markMemoriesInjected([body.id]);
      return { ok: true };
    }

    default:
      return { ok: false, error: 'unknown action' };
  }
}

// ---------------------------------------------------------------------------
// Next.js mount points.
// ---------------------------------------------------------------------------

export const GET = handler((request) =>
  Effect.gen(function* () {
    const params = new URL(request.url).searchParams;
    // `?view=summary` answers the settings CARD (counts + the newest proposals)
    // rather than a page of rows. One route, because both reads are "memory, as
    // this client needs it" and a second endpoint would duplicate the scope-key
    // resolution that is the fiddly half of either.
    if (params.get('view') === 'summary') {
      const summary = yield* Effect.sync(() =>
        summarizeMemory({
          sessionId: params.get('sessionId'),
          cwd: params.get('cwd'),
        }),
      );
      return ok(summary);
    }
    const result = yield* Effect.sync(() =>
      listScopedMemory({
        scope: params.get('scope'),
        scopeKey: params.get('scopeKey'),
        status: params.get('status'),
        type: params.get('type'),
        search: params.get('search'),
        stale: params.get('stale'),
        limit: parseCount(params.get('limit')),
        offset: parseCount(params.get('offset')),
      }),
    );
    if (!result.ok) {
      return new Response(JSON.stringify({ error: result.error }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return ok(result.data);
  }),
);

export const POST = handler((request) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(request)) as MemoryAction;
    const result = yield* Effect.sync(() => runMemoryAction(body));
    if (!result.ok) {
      return new Response(JSON.stringify({ error: result.error }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return ok(result);
  }),
);
