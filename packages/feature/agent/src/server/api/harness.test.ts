import { describe, it, expect } from 'vitest';
import {
  DEFAULT_USER_ID,
  type HarnessImportRequest,
  type HarnessItem,
  type HarnessSet,
} from '../../../../../../../dist/naby-runtime.mjs';
import { listHarnessCommands, runHarnessAction } from './harness';

// A fake store recording every harness call, so the list/action logic is
// exercised without opening a real sqlite file. Only the five methods this route
// touches are implemented; putHarnessItem mirrors the runtime gate just enough
// (source:'user' honors requestedStatus) to assert the CRUD wiring.
function fakeStore(seed: HarnessItem[] = []) {
  const rows = new Map<string, HarnessItem>();
  for (const r of seed) rows.set(r.id, r);
  let n = 0;
  const calls = {
    listHarness: [] as { scope: string; scopeKey: string; opts?: unknown }[],
    put: [] as HarnessImportRequest[],
    setEnabled: [] as { id: string; enabled: boolean }[],
    remove: [] as unknown[],
    exportSet: [] as { scope: string; scopeKey: string; opts?: unknown }[],
    importSet: [] as { scope: string; scopeKey: string; opts?: unknown }[],
  };
  const findByIdentity = (scope: string, scopeKey: string, kind: string, name: string) =>
    [...rows.values()].find(
      (r) => r.scope === scope && r.scopeKey === scopeKey && r.kind === kind && r.name === name,
    );
  const store = {
    listHarness(scope: string, scopeKey: string, opts?: unknown) {
      calls.listHarness.push({ scope, scopeKey, ...(opts ? { opts } : {}) });
      return [...rows.values()].filter(
        (r) => r.scope === scope && r.scopeKey === scopeKey,
      );
    },
    getHarnessItem(id: string) {
      return rows.get(id);
    },
    putHarnessItem(req: HarnessImportRequest) {
      calls.put.push(req);
      // Mirror the gate outcome for source:'user' → requestedStatus honored.
      const status =
        req.item.provenance.source === 'user'
          ? req.requestedStatus ?? 'disabled'
          : 'disabled';
      const id = `gen-${++n}`;
      const item: HarnessItem = {
        ...req.item,
        id,
        status,
        createdAt: 1,
        updatedAt: 1,
      } as HarnessItem;
      rows.set(id, item);
      return item;
    },
    setHarnessEnabled(id: string, enabled: boolean) {
      calls.setEnabled.push({ id, enabled });
      const r = rows.get(id);
      if (r) rows.set(id, { ...r, status: enabled ? 'enabled' : 'disabled' });
    },
    removeHarness(sel: unknown) {
      calls.remove.push(sel);
      if (sel && typeof sel === 'object' && 'id' in sel) rows.delete((sel as { id: string }).id);
    },
    // Serialize a scope's ENABLED rows (a subset by id when given) into a set —
    // enough of the runtime's exportHarnessSet to assert the route wiring.
    exportHarnessSet(
      scope: string,
      scopeKey: string,
      opts?: { name: string; version: string; ids?: string[] },
    ): HarnessSet {
      calls.exportSet.push({ scope, scopeKey, ...(opts ? { opts } : {}) });
      const idFilter = opts?.ids ? new Set(opts.ids) : undefined;
      const picked = [...rows.values()].filter(
        (r) =>
          r.scope === scope &&
          r.scopeKey === scopeKey &&
          r.status === 'enabled' &&
          (!idFilter || idFilter.has(r.id)),
      );
      const counts = { command: 0, skill: 0, subagent: 0 };
      for (const r of picked) counts[r.kind] += 1;
      return {
        name: opts?.name ?? 'set',
        version: opts?.version ?? '0.0.0',
        items: picked.map((r) => ({ ...r })),
        manifest: { createdAt: 1, counts },
      };
    },
    // Merge a set: everything lands DISABLED/external; a conflict with a local
    // ENABLED row lands under a distinct name (mirrors resolveLandingName).
    importHarnessSet(
      set: HarnessSet,
      into: { scope: string; scopeKey: string },
      opts?: { ids?: string[] },
    ): HarnessItem[] {
      calls.importSet.push({ scope: into.scope, scopeKey: into.scopeKey, ...(opts ? { opts } : {}) });
      const origin = `set:${set.name}@${set.version}`;
      const idFilter = opts?.ids ? new Set(opts.ids) : undefined;
      const landed: HarnessItem[] = [];
      for (const src of set.items) {
        if (idFilter && !idFilter.has(src.id)) continue;
        let name = src.name;
        const clash = findByIdentity(into.scope, into.scopeKey, src.kind, name);
        if (clash && clash.status === 'enabled') name = `${src.name} (from ${origin})`;
        const id = `gen-${++n}`;
        const item = {
          ...src,
          id,
          scope: into.scope,
          scopeKey: into.scopeKey,
          name,
          status: 'disabled',
          provenance: { source: 'external', origin, importedAt: 1 },
          createdAt: 1,
          updatedAt: 1,
        } as HarnessItem;
        rows.set(id, item);
        landed.push(item);
      }
      return landed;
    },
  };
  return { store, calls, rows };
}

function makeCommand(over: Partial<HarnessItem> = {}): HarnessItem {
  return {
    id: 'cmd-1',
    scope: 'user',
    scopeKey: DEFAULT_USER_ID,
    kind: 'command',
    name: 'ship',
    status: 'enabled',
    provenance: { source: 'user' },
    command: { template: 'Ship it.' },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe('listHarnessCommands', () => {
  it('rejects an unknown scope', () => {
    const { store } = fakeStore();
    const res = listHarnessCommands({ scope: 'bogus', scopeKey: null, status: null }, store);
    expect(res.ok).toBe(false);
  });

  it('rejects an unknown status filter', () => {
    const { store } = fakeStore();
    const res = listHarnessCommands({ scope: 'user', scopeKey: null, status: 'maybe' }, store);
    expect(res.ok).toBe(false);
  });

  it('defaults the user scopeKey to the runtime constant when omitted', () => {
    const { store, calls } = fakeStore([makeCommand()]);
    const res = listHarnessCommands({ scope: 'user', scopeKey: null, status: null }, store);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.scopeKey).toBe(DEFAULT_USER_ID);
    expect(calls.listHarness[0]).toMatchObject({ scope: 'user', scopeKey: DEFAULT_USER_ID });
  });

  it('always filters to kind:command', () => {
    const { store, calls } = fakeStore([makeCommand()]);
    listHarnessCommands({ scope: 'user', scopeKey: null, status: null }, store);
    expect(calls.listHarness[0].opts).toMatchObject({ kind: 'command' });
  });

  it('requires a scopeKey for project scope', () => {
    const { store } = fakeStore();
    const res = listHarnessCommands({ scope: 'project', scopeKey: null, status: null }, store);
    expect(res.ok).toBe(false);
  });

  it('returns the command rows whole, template included', () => {
    const { store } = fakeStore([makeCommand({ command: { template: 'my body' } })]);
    const res = listHarnessCommands({ scope: 'user', scopeKey: null, status: null }, store);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.items[0].command?.template).toBe('my body');
  });
});

describe('runHarnessAction — create', () => {
  it('creates an enabled user command (source:user honored by the gate)', () => {
    const { store, calls } = fakeStore();
    const res = runHarnessAction(
      { action: 'create', scope: 'user', name: 'plan', template: 'Plan this.' },
      store,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.item?.status).toBe('enabled');
      expect(res.item?.name).toBe('plan');
    }
    expect(calls.put[0].requestedStatus).toBe('enabled');
    expect(calls.put[0].item.provenance.source).toBe('user');
    expect(calls.put[0].item.kind).toBe('command');
  });

  it('strips a leading slash from the verb', () => {
    const { store } = fakeStore();
    const res = runHarnessAction(
      { action: 'create', scope: 'user', name: '/deploy', template: 'x' },
      store,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.item?.name).toBe('deploy');
  });

  it('rejects an invalid verb', () => {
    const { store } = fakeStore();
    const res = runHarnessAction(
      { action: 'create', scope: 'user', name: '1bad name', template: 'x' },
      store,
    );
    expect(res.ok).toBe(false);
  });

  it('rejects an empty template', () => {
    const { store } = fakeStore();
    const res = runHarnessAction(
      { action: 'create', scope: 'user', name: 'ok', template: '   ' },
      store,
    );
    expect(res.ok).toBe(false);
  });

  it('requires a scopeKey for project scope', () => {
    const { store } = fakeStore();
    const res = runHarnessAction(
      { action: 'create', scope: 'project', name: 'ok', template: 'x' },
      store,
    );
    expect(res.ok).toBe(false);
  });

  it('carries an argumentHint through', () => {
    const { store } = fakeStore();
    const res = runHarnessAction(
      { action: 'create', scope: 'user', name: 'ok', template: 'x', argumentHint: '<spec>' },
      store,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.item?.command?.argumentHint).toBe('<spec>');
  });
});

describe('runHarnessAction — update', () => {
  it('edits the template in place', () => {
    const { store } = fakeStore([makeCommand({ id: 'e1' })]);
    const res = runHarnessAction({ action: 'update', id: 'e1', template: 'new body' }, store);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.item?.command?.template).toBe('new body');
  });

  it('renames by removing the old id then re-putting (no duplicate row)', () => {
    const { store, calls, rows } = fakeStore([makeCommand({ id: 'e1', name: 'old' })]);
    const res = runHarnessAction({ action: 'update', id: 'e1', name: 'new' }, store);
    expect(res.ok).toBe(true);
    expect(calls.remove).toEqual([{ id: 'e1' }]);
    // exactly one command row remains, under the new name
    const names = [...rows.values()].map((r) => r.name);
    expect(names).toEqual(['new']);
  });

  it('preserves enabled status across an edit', () => {
    const { store } = fakeStore([makeCommand({ id: 'e1', status: 'enabled' })]);
    const res = runHarnessAction({ action: 'update', id: 'e1', template: 'x2' }, store);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.item?.status).toBe('enabled');
  });

  it('preserves disabled status across an edit', () => {
    const { store } = fakeStore([makeCommand({ id: 'e1', status: 'disabled' })]);
    const res = runHarnessAction({ action: 'update', id: 'e1', template: 'x2' }, store);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.item?.status).toBe('disabled');
  });

  it('rejects an unknown id', () => {
    const { store } = fakeStore();
    const res = runHarnessAction({ action: 'update', id: 'nope', template: 'x' }, store);
    expect(res.ok).toBe(false);
  });
});

describe('runHarnessAction — delete / setEnabled', () => {
  it('delete removes exactly the one id', () => {
    const { store, calls } = fakeStore([makeCommand({ id: 'd1' })]);
    const res = runHarnessAction({ action: 'delete', id: 'd1' }, store);
    expect(res.ok).toBe(true);
    expect(calls.remove).toEqual([{ id: 'd1' }]);
  });

  it('delete rejects an empty id', () => {
    const { store } = fakeStore();
    const res = runHarnessAction({ action: 'delete', id: '' }, store);
    expect(res.ok).toBe(false);
  });

  it('setEnabled toggles via the store', () => {
    const { store, calls } = fakeStore([makeCommand({ id: 's1' })]);
    const res = runHarnessAction({ action: 'setEnabled', id: 's1', enabled: false }, store);
    expect(res.ok).toBe(true);
    expect(calls.setEnabled).toEqual([{ id: 's1', enabled: false }]);
  });

  it('setEnabled rejects a non-boolean flag', () => {
    const { store } = fakeStore();
    // @ts-expect-error — exercising the runtime guard against a bad enabled value.
    const res = runHarnessAction({ action: 'setEnabled', id: 's1', enabled: 'yes' }, store);
    expect(res.ok).toBe(false);
  });

  it('an unknown action is rejected', () => {
    const { store } = fakeStore();
    // @ts-expect-error — exercising the default branch.
    const res = runHarnessAction({ action: 'frobnicate' }, store);
    expect(res.ok).toBe(false);
  });
});

describe('listHarnessCommands — kind filter (HP-06 list-all)', () => {
  it('defaults to kind:command when kind is omitted', () => {
    const { store, calls } = fakeStore([makeCommand()]);
    listHarnessCommands({ scope: 'user', scopeKey: null, status: null }, store);
    expect(calls.listHarness[0].opts).toMatchObject({ kind: 'command' });
  });

  it("kind:'all' clears the kind filter so every kind returns", () => {
    const { store, calls } = fakeStore([makeCommand()]);
    const res = listHarnessCommands({ scope: 'user', scopeKey: null, status: null, kind: 'all' }, store);
    expect(res.ok).toBe(true);
    const opts = calls.listHarness[0].opts as { kind?: string } | undefined;
    expect(opts?.kind).toBeUndefined();
  });

  it('an explicit kind filters to it', () => {
    const { store, calls } = fakeStore([makeCommand()]);
    listHarnessCommands({ scope: 'user', scopeKey: null, status: null, kind: 'skill' }, store);
    expect(calls.listHarness[0].opts).toMatchObject({ kind: 'skill' });
  });

  it('rejects an unknown kind', () => {
    const { store } = fakeStore();
    const res = listHarnessCommands({ scope: 'user', scopeKey: null, status: null, kind: 'bogus' }, store);
    expect(res.ok).toBe(false);
  });
});

describe('runHarnessAction — import (HP-04)', () => {
  it('delegates to the injected importer and returns its summary', () => {
    const { store } = fakeStore();
    const summary = {
      scope: 'user' as const,
      scopeKey: DEFAULT_USER_ID,
      baseDir: '/home/me/.claude',
      baseExists: true,
      imported: { command: 1, skill: 0, subagent: 0 },
      skippedHooks: 2,
      skipped: [],
      failed: [],
      items: [],
    };
    let seen: { scope: string; scopeKey: string; cwd?: string } | null = null;
    const res = runHarnessAction({ action: 'import', scope: 'user' }, store, {
      importClaude: (args) => {
        seen = args;
        return summary;
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.summary?.skippedHooks).toBe(2);
    expect(seen).toMatchObject({ scope: 'user', scopeKey: DEFAULT_USER_ID });
  });

  it('requires a scopeKey for project scope', () => {
    const { store } = fakeStore();
    const res = runHarnessAction({ action: 'import', scope: 'project' }, store, {
      importClaude: () => {
        throw new Error('should not be called');
      },
    });
    expect(res.ok).toBe(false);
  });

  it('passes the cwd through as scopeKey for project scope', () => {
    const { store } = fakeStore();
    let seen: { scopeKey: string; cwd?: string } | null = null;
    const res = runHarnessAction(
      { action: 'import', scope: 'project', cwd: '/proj' },
      store,
      {
        importClaude: (args) => {
          seen = args;
          return {
            scope: 'project',
            scopeKey: '/proj',
            baseDir: '/proj/.claude',
            baseExists: true,
            imported: { command: 0, skill: 0, subagent: 0 },
            skippedHooks: 0,
            skipped: [],
            failed: [],
            items: [],
          };
        },
      },
    );
    expect(res.ok).toBe(true);
    expect(seen).toMatchObject({ scopeKey: '/proj', cwd: '/proj' });
  });
});

describe('runHarnessAction — revertOrigin (HP-06 rollback)', () => {
  it('removes only external rows under the prefix, keeping user rows and other imports', () => {
    const seed: HarnessItem[] = [
      makeCommand({
        id: 'x1',
        name: 'imported-a',
        provenance: { source: 'external', origin: '/home/me/.claude/commands/a.md' },
      }),
      makeCommand({
        id: 'x2',
        name: 'imported-b',
        kind: 'skill',
        provenance: { source: 'external', origin: '/home/me/.claude/skills/b/SKILL.md' },
      }),
      makeCommand({
        id: 'u1',
        name: 'mine',
        provenance: { source: 'user' },
      }),
      makeCommand({
        id: 'p1',
        name: 'other-import',
        provenance: { source: 'external', origin: '/other/.claude/commands/c.md' },
      }),
    ];
    const { store, rows } = fakeStore(seed);
    const res = runHarnessAction(
      { action: 'revertOrigin', scope: 'user', originPrefix: '/home/me/.claude' },
      store,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.removed).toBe(2);
    const remaining = [...rows.keys()].sort();
    expect(remaining).toEqual(['p1', 'u1']);
  });

  it('rejects a missing originPrefix', () => {
    const { store } = fakeStore();
    const res = runHarnessAction(
      // @ts-expect-error — exercising the guard against a missing prefix.
      { action: 'revertOrigin', scope: 'user' },
      store,
    );
    expect(res.ok).toBe(false);
  });
});

function makeSet(over: Partial<HarnessSet> = {}): HarnessSet {
  return {
    name: 'team-onboarding',
    version: '1.2.0',
    items: [
      makeCommand({ id: 'src-1', name: 'ship', command: { template: 'Ship it.' } }),
      makeCommand({
        id: 'src-2',
        name: 'review',
        kind: 'skill',
        command: undefined,
        skill: { instructions: 'Review carefully.' },
      } as Partial<HarnessItem>),
    ],
    manifest: { createdAt: 1, counts: { command: 1, skill: 1, subagent: 0 } },
    ...over,
  };
}

describe('runHarnessAction — exportSet (HP-05)', () => {
  it('serializes a scope\'s enabled items into a named/versioned HarnessSet', () => {
    const { store, calls } = fakeStore([
      makeCommand({ id: 'e1', name: 'ship', status: 'enabled' }),
      makeCommand({ id: 'e2', name: 'draft', status: 'disabled' }),
    ]);
    const res = runHarnessAction(
      { action: 'exportSet', scope: 'user', name: 'my-set', version: '2.0.0' },
      store,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.set?.name).toBe('my-set');
      expect(res.set?.version).toBe('2.0.0');
      // only the ENABLED row is serialized
      expect(res.set?.items.map((i) => i.name)).toEqual(['ship']);
      expect(res.set?.manifest.counts.command).toBe(1);
    }
    expect(calls.exportSet[0]).toMatchObject({ scope: 'user', scopeKey: DEFAULT_USER_ID });
  });

  it('passes an id subset through to the store', () => {
    const { store, calls } = fakeStore([
      makeCommand({ id: 'e1', name: 'ship', status: 'enabled' }),
      makeCommand({ id: 'e2', name: 'plan', status: 'enabled' }),
    ]);
    const res = runHarnessAction(
      { action: 'exportSet', scope: 'user', name: 's', version: '1.0.0', ids: ['e2'] },
      store,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.set?.items.map((i) => i.name)).toEqual(['plan']);
    expect((calls.exportSet[0].opts as { ids?: string[] }).ids).toEqual(['e2']);
  });

  it('requires name and version', () => {
    const { store } = fakeStore();
    expect(runHarnessAction({ action: 'exportSet', scope: 'user', name: '', version: '1.0.0' }, store).ok).toBe(false);
    expect(runHarnessAction({ action: 'exportSet', scope: 'user', name: 's', version: '  ' }, store).ok).toBe(false);
  });

  it('exports from the org scope using the default org key (HP-08)', () => {
    const { store, calls } = fakeStore([
      makeCommand({ id: 'o1', scope: 'org', scopeKey: 'default', name: 'org-cmd', status: 'enabled' }),
    ]);
    const res = runHarnessAction(
      { action: 'exportSet', scope: 'org', name: 'team', version: '1.0.0' },
      store,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.set?.items.map((i) => i.name)).toEqual(['org-cmd']);
    expect(calls.exportSet[0]).toMatchObject({ scope: 'org', scopeKey: 'default' });
  });
});

describe('runHarnessAction — importSet (HP-05)', () => {
  it('merges a set into the target scope, everything landing disabled/external', () => {
    const { store, rows } = fakeStore();
    const res = runHarnessAction(
      { action: 'importSet', set: makeSet(), scope: 'user' },
      store,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.landed).toHaveLength(2);
      // every landed row is inert + external (contract §4 invariant 1)
      for (const it of res.landed ?? []) {
        expect(it.status).toBe('disabled');
        expect(it.provenance.source).toBe('external');
        expect(it.provenance.origin).toBe('set:team-onboarding@1.2.0');
      }
      expect(res.conflicts).toEqual([]);
    }
    expect([...rows.values()].every((r) => r.status === 'disabled')).toBe(true);
  });

  it('imports only the selected ids (item-level pick)', () => {
    const { store } = fakeStore();
    const res = runHarnessAction(
      { action: 'importSet', set: makeSet(), scope: 'user', ids: ['src-2'] },
      store,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.landed).toHaveLength(1);
      expect(res.landed?.[0].name).toBe('review');
      expect(res.landed?.[0].kind).toBe('skill');
    }
  });

  it('a conflict with a local ENABLED item never overwrites it — it lands as a separate disabled candidate', () => {
    // A local ENABLED /ship already owns (user, command, ship).
    const { store, rows } = fakeStore([
      makeCommand({ id: 'local', name: 'ship', status: 'enabled', command: { template: 'MINE' } }),
    ]);
    const res = runHarnessAction(
      { action: 'importSet', set: makeSet(), scope: 'user' },
      store,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      // the incoming ship landed under a DISTINCT name, flagged as a conflict
      const conflict = res.conflicts?.find((c) => c.requestedName === 'ship');
      expect(conflict).toBeDefined();
      expect(conflict?.landedName).not.toBe('ship');
    }
    // local ENABLED /ship is untouched (still enabled, still MINE)
    const local = rows.get('local');
    expect(local?.status).toBe('enabled');
    expect(local?.command?.template).toBe('MINE');
  });

  it('merges into the org scope using the default org key (HP-08)', () => {
    const { store, calls } = fakeStore();
    const res = runHarnessAction(
      { action: 'importSet', set: makeSet(), scope: 'org' },
      store,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.landed?.every((i) => i.scope === 'org' && i.scopeKey === 'default')).toBe(true);
    expect(calls.importSet[0]).toMatchObject({ scope: 'org', scopeKey: 'default' });
  });

  it('rejects a malformed set envelope', () => {
    const { store } = fakeStore();
    // @ts-expect-error — exercising the shape guard against a non-set body.
    const res = runHarnessAction({ action: 'importSet', set: { name: 'x' }, scope: 'user' }, store);
    expect(res.ok).toBe(false);
  });

  it('requires a scopeKey for project scope', () => {
    const { store } = fakeStore();
    const res = runHarnessAction({ action: 'importSet', set: makeSet(), scope: 'project' }, store);
    expect(res.ok).toBe(false);
  });
});
