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
  type HarnessKind,
  type HarnessScope,
  type HarnessSet,
  type HarnessStatus,
  type Store,
} from '../../../../../../../dist/naby-runtime.mjs';
import { getStore } from '../engines/naby';
import {
  importClaudeHarness,
  type HarnessImportSummary,
} from '../lib/harnessImporter';

// The slice of the store this route touches. Named so the handlers depend on an
// injectable seam (default `getStore()`), keeping the list/action logic unit-
// testable against a fake store without opening a real sqlite file.
type HarnessStore = Pick<
  Store,
  | 'listHarness'
  | 'putHarnessItem'
  | 'getHarnessItem'
  | 'setHarnessEnabled'
  | 'removeHarness'
  // HP-05: set export/import — serialize a scope's enabled items into a portable
  // HarnessSet, and merge an incoming set through the same gate (contract §5/§6).
  | 'exportHarnessSet'
  | 'importHarnessSet'
>;

// Injectable deps for the actions that reach beyond the store (the filesystem
// importer). Default binds the real `~/.claude` importer; tests pass a fake so
// the action wiring is exercised without touching a disk.
export interface HarnessActionDeps {
  importClaude: (args: { scope: HarnessScope; scopeKey: string; cwd?: string }) => HarnessImportSummary;
}

function defaultDeps(store: HarnessStore): HarnessActionDeps {
  return {
    importClaude: (args) => importClaudeHarness({ ...args, store }),
  };
}

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
const HARNESS_KINDS: readonly HarnessKind[] = ['command', 'skill', 'subagent'];

// HP-08: the single-tenant in-house org key. The runtime does not (yet) export a
// DEFAULT_ORG_ID constant, so the shell owns one stable value — every `org`-scope
// read/write keys on it. This makes the "team-shared harness set" a real, keyable
// scope for a single in-house deployment; a true multi-org build would resolve
// this from the signed-in org instead of a constant (org-set signing is an open
// question, contract §7). Kept in sync with the org skill-injection key the
// runtime already reads (skill-inject opts.orgId).
const DEFAULT_ORG_ID = 'default';

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

function isKind(v: unknown): v is HarnessKind {
  return typeof v === 'string' && (HARNESS_KINDS as readonly string[]).includes(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Shape-guard for an uploaded HarnessSet (HP-05). The set arrives off the wire
 * (a teammate's file) so it is UNTRUSTED structurally — we validate the envelope
 * before handing it to the store, whose gate then handles the *content* trust
 * (external ⇒ disabled). We check only the fields the merge reads: name/version
 * and an `items` array of objects carrying a `kind` and `name`; the store
 * re-derives provenance/status, so a malformed provenance in the file cannot
 * smuggle an item to `enabled`.
 */
function isHarnessSet(v: unknown): v is HarnessSet {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  if (typeof s.name !== 'string' || typeof s.version !== 'string') return false;
  if (!Array.isArray(s.items)) return false;
  return s.items.every((it) => {
    if (!it || typeof it !== 'object') return false;
    const row = it as Record<string, unknown>;
    return isKind(row.kind) && typeof row.name === 'string';
  });
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
  // `org` resolves to the single in-house org constant when the caller omits a
  // key (HP-08), exactly like `user` — a team-shared set is addressable without
  // the client knowing the org id. `project` still requires its own key (cwd).
  if (scope === 'org') return scopeKey && scopeKey.length > 0 ? scopeKey : DEFAULT_ORG_ID;
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
    /** Omitted => 'command' (backward compat with the HP-02 palette UI). An
     *  explicit kind filters to it; the sentinel 'all' returns EVERY kind, which
     *  the HP-06 review UI needs to inspect imported skills/subagents too. */
    kind?: string | null;
  },
  store: HarnessStore = getStore(),
): { ok: true; data: HarnessListResult } | { ok: false; error: string } {
  if (!isScope(params.scope)) {
    return { ok: false, error: `scope must be one of ${HARNESS_SCOPES.join(', ')}` };
  }
  if (params.status !== null && !isStatus(params.status)) {
    return { ok: false, error: `status must be one of ${HARNESS_STATUSES.join(', ')}` };
  }
  // Resolve the kind filter. Default (undefined/null) preserves the original
  // command-only behavior; 'all' clears the filter; anything else is validated.
  const rawKind = params.kind ?? undefined;
  let kindFilter: HarnessKind | undefined;
  if (rawKind === undefined || rawKind === null) {
    kindFilter = 'command';
  } else if (rawKind === 'all') {
    kindFilter = undefined;
  } else if (isKind(rawKind)) {
    kindFilter = rawKind;
  } else {
    return { ok: false, error: `kind must be one of ${HARNESS_KINDS.join(', ')}, or 'all'` };
  }
  const scopeKey = resolveScopeKey(params.scope, params.scopeKey);
  if (scopeKey === null) {
    return { ok: false, error: `scopeKey is required for ${params.scope} scope` };
  }

  const items = store.listHarness(params.scope, scopeKey, {
    ...(kindFilter ? { kind: kindFilter } : {}),
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
  | { action: 'setEnabled'; id: string; enabled: boolean }
  | {
      // HP-04: import a scope's on-disk `~/.claude` / `.claude` harness
      // (commands/skills/subagents) through the gate — everything lands disabled.
      action: 'import';
      scope: HarnessScope;
      scopeKey?: string;
      cwd?: string;
    }
  | {
      // HP-06: roll back a whole import by its origin prefix (the `.claude` base
      // the items were read from). Every EXTERNAL item whose provenance.origin
      // starts with the prefix is removed. Scoped so it can never reach across to
      // another project's rows.
      action: 'revertOrigin';
      scope: HarnessScope;
      scopeKey?: string;
      originPrefix: string;
    }
  | {
      // HP-05: serialize a scope's ENABLED items (optionally a subset by id) into
      // a portable, named/versioned HarnessSet the client downloads as JSON. The
      // set is the interchange document a teammate/another machine imports.
      action: 'exportSet';
      scope: HarnessScope;
      scopeKey?: string;
      name: string;
      version: string;
      ids?: string[];
    }
  | {
      // HP-05: merge an uploaded HarnessSet into a target scope through the gate.
      // Everything lands DISABLED (external), `ids` selects a subset (item-level
      // pick), and a conflict never overwrites an ENABLED local item — the store
      // lands it under a distinct name instead (contract §5). `into` may be `org`
      // for a team-shared set (HP-08).
      action: 'importSet';
      set: HarnessSet;
      scope: HarnessScope;
      scopeKey?: string;
      ids?: string[];
    };

// A conflict the merge resolved by landing an incoming item under a DISTINCT name
// because a local ENABLED item already owns the original (scope,scopeKey,kind,name)
// — surfaced so the review UI can tell the user "this arrived as a separate
// candidate, your local one was not overwritten" (contract §5 acceptance).
export interface HarnessImportSetConflict {
  kind: HarnessKind;
  requestedName: string;
  landedName: string;
}

export type HarnessActionResult =
  | {
      ok: true;
      item?: HarnessItem;
      summary?: HarnessImportSummary;
      removed?: number;
      set?: HarnessSet;
      landed?: HarnessItem[];
      conflicts?: HarnessImportSetConflict[];
    }
  | { ok: false; error: string };

export function runHarnessAction(
  body: HarnessAction,
  store: HarnessStore = getStore(),
  deps: HarnessActionDeps = defaultDeps(store),
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

    case 'import': {
      if (!isScope(body.scope)) {
        return { ok: false, error: `scope must be one of ${HARNESS_SCOPES.join(', ')}` };
      }
      const scopeKey = resolveScopeKey(body.scope, body.scopeKey ?? body.cwd ?? null);
      if (scopeKey === null) {
        return { ok: false, error: `scopeKey is required for ${body.scope} scope` };
      }
      try {
        // The importer walks the `.claude` base, drops hooks, and pushes every
        // command/skill/subagent through the gate — external, so all land
        // DISABLED (contract §4 invariant 1). The summary carries what landed +
        // the hooks-skipped count for the review UI.
        const summary = deps.importClaude({
          scope: body.scope,
          scopeKey,
          ...(body.cwd ? { cwd: body.cwd } : {}),
        });
        return { ok: true, summary };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    case 'revertOrigin': {
      if (!isScope(body.scope)) {
        return { ok: false, error: `scope must be one of ${HARNESS_SCOPES.join(', ')}` };
      }
      if (typeof body.originPrefix !== 'string' || body.originPrefix.length === 0) {
        return { ok: false, error: 'originPrefix is required' };
      }
      const scopeKey = resolveScopeKey(body.scope, body.scopeKey ?? null);
      if (scopeKey === null) {
        return { ok: false, error: `scopeKey is required for ${body.scope} scope` };
      }
      // Remove every EXTERNAL row in this scope whose origin sits under the given
      // base. Deleting by id (not the store's exact origin selector) lets one
      // click undo a whole `~/.claude` import whose files each have a distinct
      // origin path, while staying scoped so it can never cross into another
      // project's rows. Only external provenance is touched — a user-authored row
      // that happens to share a path is never swept up.
      const rows = store.listHarness(body.scope, scopeKey);
      let removed = 0;
      for (const row of rows) {
        const origin = row.provenance.origin;
        if (
          row.provenance.source === 'external' &&
          typeof origin === 'string' &&
          origin.startsWith(body.originPrefix)
        ) {
          store.removeHarness({ id: row.id });
          removed += 1;
        }
      }
      return { ok: true, removed };
    }

    case 'exportSet': {
      if (!isScope(body.scope)) {
        return { ok: false, error: `scope must be one of ${HARNESS_SCOPES.join(', ')}` };
      }
      const scopeKey = resolveScopeKey(body.scope, body.scopeKey ?? null);
      if (scopeKey === null) {
        return { ok: false, error: `scopeKey is required for ${body.scope} scope` };
      }
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name.length === 0) {
        return { ok: false, error: 'name is required' };
      }
      const version = typeof body.version === 'string' ? body.version.trim() : '';
      if (version.length === 0) {
        return { ok: false, error: 'version is required' };
      }
      if (body.ids !== undefined && !isStringArray(body.ids)) {
        return { ok: false, error: 'ids must be an array of strings' };
      }
      try {
        // The store serializes only ENABLED rows (contract §6) — a subset when
        // `ids` is given. The resulting HarnessSet is the JSON the client
        // downloads; the store stamps the manifest counts + createdAt.
        const set = store.exportHarnessSet(body.scope, scopeKey, {
          name,
          version,
          ...(body.ids ? { ids: body.ids } : {}),
        });
        return { ok: true, set };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    case 'importSet': {
      if (!isScope(body.scope)) {
        return { ok: false, error: `scope must be one of ${HARNESS_SCOPES.join(', ')}` };
      }
      const scopeKey = resolveScopeKey(body.scope, body.scopeKey ?? null);
      if (scopeKey === null) {
        return { ok: false, error: `scopeKey is required for ${body.scope} scope` };
      }
      if (!isHarnessSet(body.set)) {
        return { ok: false, error: 'set must be a HarnessSet with { name, version, items[] }' };
      }
      if (body.ids !== undefined && !isStringArray(body.ids)) {
        return { ok: false, error: 'ids must be an array of strings' };
      }
      // The subset the merge will consider, in the SAME order the store iterates
      // (set.items filtered by ids) — so we can zip landed rows back to their
      // source item to detect conflicts by a changed landing name.
      const idFilter = body.ids ? new Set(body.ids) : undefined;
      const selected = body.set.items.filter((it) => !idFilter || idFilter.has(it.id));
      try {
        // Every item passes the gate: external ⇒ DISABLED, provenance
        // origin:'set:<name>@<version>'. A conflict with a local ENABLED row lands
        // under a distinct name rather than overwriting (contract §5).
        const landed = store.importHarnessSet(
          body.set,
          { scope: body.scope, scopeKey },
          body.ids ? { ids: body.ids } : undefined,
        );
        const conflicts: HarnessImportSetConflict[] = [];
        for (let i = 0; i < landed.length; i += 1) {
          const src = selected[i];
          if (src && landed[i].name !== src.name) {
            conflicts.push({
              kind: landed[i].kind,
              requestedName: src.name,
              landedName: landed[i].name,
            });
          }
        }
        return { ok: true, landed, conflicts };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
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
        kind: params.get('kind'),
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
