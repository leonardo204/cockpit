/**
 * `/api/harness` — the Naby-owned harness CRUD surface (Phase 1.6 HP-02).
 *
 * WHY THIS EXISTS. Today the shell slash palette is HARDCODED (`/qa`, `/fx`, …)
 * with no way for the owner to add or remove a command — the first slice of the
 * dev/prod harness cliff (strategy §1). This route turns commands into
 * Naby-OWNED, scoped rows in `app.db`: a `user` can create/edit/delete a command
 * (verb + template + argumentHint) and it expands identically on all five
 * providers AND the dev engine, because expansion happens in the shell ABOVE the
 * engine seam (contract §3 injection). This is the harness twin of `/api/memory`
 * (P15-06): same `getStore()` seam, same scoped-ownership + cascade-exemption
 * model (contract §2), reusing the runtime's `putHarnessItem` import gate
 * (contract §4) so a `source:'user'` row is granted `enabled` while an external
 * import could never be.
 *
 * COMMAND KIND ONLY. Phase 1.6 HP-02 scopes this to `kind:'command'`. Skills and
 * subagents (HP-03a/HP-04/…) are separate surfaces; this route lists/creates
 * only commands so the palette CRUD lands without dragging in skill runtime.
 *
 * STORE-ONLY. The single input is `getStore()` (the same store the memory and
 * naby routes read); no filesystem transcript is touched. The store slice is an
 * injectable seam (default `getStore()`) so the list/action logic is unit-testable
 * against a fake store without opening a real sqlite file — exactly like memory.ts.
 */

import { Effect } from 'effect';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import {
  DEFAULT_USER_ID,
  type HarnessItem,
  type HarnessScope,
  type HarnessStatus,
  type Store,
} from '../../../../../../../dist/naby-runtime.mjs';
import { getStore } from '../engines/naby';

// The slice of the store this route touches. Named so the handlers depend on an
// injectable seam (default `getStore()`), keeping the list/action logic unit-
// testable against a fake store without opening a real sqlite file.
type HarnessStore = Pick<
  Store,
  'listHarness' | 'putHarnessItem' | 'getHarnessItem' | 'setHarnessEnabled' | 'removeHarness'
>;

// The store is opened on demand, so this must run on the node runtime and must
// never be statically rendered.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Validation helpers — the query/body come off the wire untyped.
// ---------------------------------------------------------------------------

// No `session` scope for harness — a command is a durable capability, not
// per-conversation state (contract §2). `org` is kept in the surface for the
// in-house rollout though single-user builds have no local org id.
const HARNESS_SCOPES: readonly HarnessScope[] = ['user', 'project', 'org'];
const HARNESS_STATUSES: readonly HarnessStatus[] = ['enabled', 'disabled'];

// A command verb: a letter then letters/digits/hyphens (/qa, /new-branch). Kept
// in sync with the server dispatcher (slashCommands' COMMAND_LINE_RE) and the
// client autocomplete (ChatInput's commandQuery) so a created verb is actually
// typable and expandable.
const VERB_RE = /^[a-zA-Z][a-zA-Z0-9-]*$/;

function isScope(v: unknown): v is HarnessScope {
  return typeof v === 'string' && (HARNESS_SCOPES as readonly string[]).includes(v);
}

function isStatus(v: unknown): v is HarnessStatus {
  return typeof v === 'string' && (HARNESS_STATUSES as readonly string[]).includes(v);
}

/**
 * Normalize a verb: strip a leading slash if the user typed one, trim, and
 * validate against VERB_RE. Returns null when the shape is invalid so the caller
 * can reject with a clear message instead of persisting an unusable verb.
 */
function normalizeVerb(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/^\//, '');
  return VERB_RE.test(name) ? name : null;
}

/**
 * Resolve the `scopeKey` for a read/write. For `user` scope the key is the
 * stable local user id — a single-user-machine CONSTANT the runtime owns
 * (`DEFAULT_USER_ID`, the same value command expansion keys `user` harness on).
 * The client never needs to know it, so an omitted `scopeKey` on `user` scope
 * resolves here rather than erroring. `project`/`org` are addressed by their own
 * key (cwd / orgId), which the caller supplies. Returns null when a required key
 * is missing.
 */
function resolveScopeKey(scope: HarnessScope, scopeKey: string | null | undefined): string | null {
  if (scope === 'user') return scopeKey && scopeKey.length > 0 ? scopeKey : DEFAULT_USER_ID;
  return scopeKey && scopeKey.length > 0 ? scopeKey : null;
}

// ---------------------------------------------------------------------------
// GET — list one scope's owned commands, provenance included.
// ---------------------------------------------------------------------------

export interface HarnessListResult {
  scope: HarnessScope;
  /** The RESOLVED scopeKey the rows were read for (echoes the `user` default so
   *  the client can label the panel without knowing the constant). */
  scopeKey: string;
  /** The rows WHOLE — template included; this is the user's own authored content.
   *  Ordered by the store. */
  items: HarnessItem[];
}

export function listHarnessCommands(
  params: {
    scope: string | null;
    scopeKey: string | null;
    status: string | null;
  },
  store: HarnessStore = getStore(),
): { ok: true; data: HarnessListResult } | { ok: false; error: string } {
  if (!isScope(params.scope)) {
    return { ok: false, error: `scope must be one of ${HARNESS_SCOPES.join(', ')}` };
  }
  if (params.status !== null && !isStatus(params.status)) {
    return { ok: false, error: `status must be one of ${HARNESS_STATUSES.join(', ')}` };
  }
  const scopeKey = resolveScopeKey(params.scope, params.scopeKey);
  if (scopeKey === null) {
    return { ok: false, error: `scopeKey is required for ${params.scope} scope` };
  }

  const items = store.listHarness(params.scope, scopeKey, {
    kind: 'command',
    ...(params.status ? { status: params.status as HarnessStatus } : {}),
  });
  return { ok: true, data: { scope: params.scope, scopeKey, items } };
}

// ---------------------------------------------------------------------------
// POST — the mutations (create, update, delete, setEnabled).
// ---------------------------------------------------------------------------

export type HarnessAction =
  | {
      action: 'create';
      scope: HarnessScope;
      scopeKey?: string;
      name: string;
      description?: string;
      template: string;
      argumentHint?: string;
    }
  | {
      // Edit an existing owned command by id. Rename is supported: the store
      // upsert identity is (scope,scopeKey,kind,name), so a name change would
      // otherwise leave a stale row — we remove the old id then re-put.
      action: 'update';
      id: string;
      name?: string;
      description?: string;
      template?: string;
      argumentHint?: string;
    }
  | { action: 'delete'; id: string }
  | { action: 'setEnabled'; id: string; enabled: boolean };

export type HarnessActionResult =
  | { ok: true; item?: HarnessItem }
  | { ok: false; error: string };

export function runHarnessAction(
  body: HarnessAction,
  store: HarnessStore = getStore(),
): HarnessActionResult {
  switch (body.action) {
    case 'create': {
      if (!isScope(body.scope)) {
        return { ok: false, error: `scope must be one of ${HARNESS_SCOPES.join(', ')}` };
      }
      const scopeKey = resolveScopeKey(body.scope, body.scopeKey ?? null);
      if (scopeKey === null) {
        return { ok: false, error: `scopeKey is required for ${body.scope} scope` };
      }
      const name = normalizeVerb(body.name);
      if (name === null) {
        return { ok: false, error: 'name must be a verb: a letter then letters/digits/hyphens' };
      }
      if (typeof body.template !== 'string' || body.template.trim().length === 0) {
        return { ok: false, error: 'template is required' };
      }
      try {
        // source:'user' — an authored-by-user row, so the import gate (§4) grants
        // the requested 'enabled'. An external import could never reach 'enabled'
        // without a review action; this is the difference that keeps CRUD usable
        // while imports stay inert.
        const item = store.putHarnessItem({
          item: {
            scope: body.scope,
            scopeKey,
            kind: 'command',
            name,
            ...(typeof body.description === 'string' && body.description.trim()
              ? { description: body.description.trim() }
              : {}),
            provenance: { source: 'user' },
            command: {
              template: body.template,
              ...(typeof body.argumentHint === 'string' && body.argumentHint.trim()
                ? { argumentHint: body.argumentHint.trim() }
                : {}),
            },
          },
          requestedStatus: 'enabled',
        });
        return { ok: true, item };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    case 'update': {
      if (typeof body.id !== 'string' || !body.id) {
        return { ok: false, error: 'id is required' };
      }
      const existing = store.getHarnessItem(body.id);
      if (!existing || existing.kind !== 'command') {
        return { ok: false, error: 'command not found' };
      }
      // Resolve the post-edit fields, falling back to the existing values.
      const nextName =
        body.name !== undefined ? normalizeVerb(body.name) : existing.name;
      if (nextName === null) {
        return { ok: false, error: 'name must be a verb: a letter then letters/digits/hyphens' };
      }
      const nextTemplate =
        body.template !== undefined ? body.template : existing.command?.template ?? '';
      if (typeof nextTemplate !== 'string' || nextTemplate.trim().length === 0) {
        return { ok: false, error: 'template is required' };
      }
      const nextDescription =
        body.description !== undefined ? body.description : existing.description;
      const nextArgHint =
        body.argumentHint !== undefined ? body.argumentHint : existing.command?.argumentHint;
      // Preserve whether this row was enabled across the edit — an edit must not
      // silently flip a user's enabled command off. source stays 'user'.
      const wasEnabled = existing.status === 'enabled';
      try {
        // Remove-then-put so a RENAME cannot leave a duplicate row: the store's
        // upsert identity is (scope,scopeKey,kind,name), so an in-place put under
        // a new name would create a second row while the old one lingered.
        store.removeHarness({ id: body.id });
        const item = store.putHarnessItem({
          item: {
            scope: existing.scope,
            scopeKey: existing.scopeKey,
            kind: 'command',
            name: nextName,
            ...(typeof nextDescription === 'string' && nextDescription.trim()
              ? { description: nextDescription.trim() }
              : {}),
            provenance: { source: 'user' },
            command: {
              template: nextTemplate,
              ...(typeof nextArgHint === 'string' && nextArgHint.trim()
                ? { argumentHint: nextArgHint.trim() }
                : {}),
            },
          },
          requestedStatus: wasEnabled ? 'enabled' : 'disabled',
        });
        return { ok: true, item };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    case 'delete': {
      if (typeof body.id !== 'string' || !body.id) {
        return { ok: false, error: 'id is required' };
      }
      store.removeHarness({ id: body.id });
      return { ok: true };
    }

    case 'setEnabled': {
      if (typeof body.id !== 'string' || !body.id) {
        return { ok: false, error: 'id is required' };
      }
      if (typeof body.enabled !== 'boolean') {
        return { ok: false, error: 'enabled must be a boolean' };
      }
      // The ONLY path an item toggles enablement (contract §4 invariant 1). For a
      // user-authored command this is a plain on/off; for an imported one it is
      // the explicit review action a threshold can never perform.
      store.setHarnessEnabled(body.id, body.enabled);
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
    const result = yield* Effect.sync(() =>
      listHarnessCommands({
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
    const body = (yield* parseJsonRaw(request)) as HarnessAction;
    const result = yield* Effect.sync(() => runHarnessAction(body));
    if (!result.ok) {
      return new Response(JSON.stringify({ error: result.error }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return ok(result);
  }),
);
