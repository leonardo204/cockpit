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
  type MemoryItem,
  type MemoryScope,
  type MemoryStatus,
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
const TRUST_TIERS: readonly TrustTier[] = ['user', 'artifact', 'external'];

function isScope(v: unknown): v is MemoryScope {
  return typeof v === 'string' && (MEMORY_SCOPES as readonly string[]).includes(v);
}

function isStatus(v: unknown): v is MemoryStatus {
  return typeof v === 'string' && (MEMORY_STATUSES as readonly string[]).includes(v);
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
}

export function listScopedMemory(
  params: {
    scope: string | null;
    scopeKey: string | null;
    status: string | null;
  },
  store: MemoryStore = getStore(),
): { ok: true; data: MemoryListResult } | { ok: false; error: string } {
  if (!isScope(params.scope)) {
    return { ok: false, error: `scope must be one of ${MEMORY_SCOPES.join(', ')}` };
  }
  if (params.status !== null && !isStatus(params.status)) {
    return { ok: false, error: `status must be one of ${MEMORY_STATUSES.join(', ')}` };
  }
  const scopeKey = resolveScopeKey(params.scope, params.scopeKey);
  if (scopeKey === null) {
    return { ok: false, error: `scopeKey is required for ${params.scope} scope` };
  }

  const items = store.getScopedMemory(
    params.scope,
    scopeKey,
    params.status ? { status: params.status } : undefined,
  );
  // ONE extra store call for the ids just listed — the store answers them in a
  // single grouped query, so this stays two statements however long the list is.
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
    },
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
  | { action: 'autoConfirm.set'; enabled: boolean };

export type MemoryActionResult =
  | { ok: true; autoConfirm?: boolean }
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
    const result = yield* Effect.sync(() =>
      listScopedMemory({
        scope: params.get('scope'),
        scopeKey: params.get('scopeKey'),
        status: params.get('status'),
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
