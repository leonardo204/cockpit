import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_USER_ID,
  // A VALUE import: the enable→list regression at the bottom of this file runs
  // the real store (hence the real import gate) instead of the fake below.
  MemoryStore,
  type HarnessImportRequest,
  type HarnessItem,
  type HarnessScope,
  type HarnessSet,
} from '../../../../../../../dist/naby-runtime.mjs';
import { importHarness } from '../lib/harnessImporter';
// The REAL containment-checked deleter — the naby-home cases below run it against
// a temp directory rather than stubbing the one thing worth not stubbing.
import { deleteHarnessSource } from '../lib/harnessSource';
import {
  listHarnessCommands,
  resetHarnessScanThrottle,
  runHarnessAction,
  type HarnessActionDeps,
} from './harness';

// An empty importer summary — the shape scan-on-list ignores anyway (it re-reads
// the store afterwards), needed only to satisfy the dep signature.
function emptySummary(scope: HarnessScope, scopeKey: string) {
  return {
    scope,
    scopeKey,
    baseDir: '',
    baseDirs: [],
    baseExists: false,
    imported: { command: 0, skill: 0, subagent: 0 },
    unchanged: 0,
    copied: 0,
    skippedHooks: 0,
    skipped: [],
    failed: [],
    items: [],
  };
}

/** The dep literals below are about scanning/importing, not about unlinking, so
 *  they take this: a source delete that reports success without touching a disk.
 *  It is required rather than defaulted on purpose — a test that forgot to pass
 *  one would otherwise fall through to the REAL deleter and a real `~/.naby`. */
const okDelete: HarnessActionDeps['deleteSource'] = (plan) => ({
  outcome: 'deleted',
  target: plan.target,
});

/** A deleteSource dep that RECORDS the unlink instead of performing one, so the
 *  two-tier delete is exercised without a real `~/.naby`. `outcome` chooses what
 *  the (real) containment-checked deleter would have answered. */
function fakeDeleteSource(outcome: 'deleted' | 'missing' | 'refused' = 'deleted') {
  const unlinked: string[] = [];
  const deleteSource: HarnessActionDeps['deleteSource'] = (plan) => {
    unlinked.push(plan.target);
    if (outcome === 'refused') {
      return { outcome: 'refused', target: plan.target, reason: 'escapes the harness home' };
    }
    return { outcome, target: plan.target };
  };
  return { deleteSource, unlinked };
}

/** Deps that record every scan the list triggers, so a test can assert WHICH
 *  scopes were scanned and how often. */
function scanSpy() {
  const scans: Array<{ scope: HarnessScope; scopeKey: string; cwd?: string; mode?: string }> = [];
  const deps: HarnessActionDeps = {
    importHarness: (args) => {
      scans.push(args);
      return emptySummary(args.scope, args.scopeKey);
    },
    deleteSource: (plan) => ({ outcome: 'deleted', target: plan.target }),
  };
  return { deps, scans };
}

// The default deps would walk the REAL `~/.naby`; every list test that is not
// about scanning passes this instead, so the assertions stay about the store.
const noScan: HarnessActionDeps = {
  importHarness: (args) => emptySummary(args.scope, args.scopeKey),
  deleteSource: (plan) => ({ outcome: 'deleted', target: plan.target }),
};

// The scan throttle is module state — cleared between cases so one test's scan
// cannot suppress the next one's.
beforeEach(() => {
  resetHarnessScanThrottle();
});

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
    setStatus: [] as { id: string; status: string }[],
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
      // An explicit toggle LEAVES the 'removed' tombstone (the restore path) —
      // same semantics as both real drivers.
      if (r) rows.set(id, { ...r, status: enabled ? 'enabled' : 'disabled' });
    },
    setHarnessStatus(id: string, status: HarnessItem['status']) {
      calls.setStatus.push({ id, status });
      const r = rows.get(id);
      if (r) rows.set(id, { ...r, status });
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
    const res = listHarnessCommands({ scope: 'bogus', scopeKey: null, status: null }, store, noScan);
    expect(res.ok).toBe(false);
  });

  it('rejects an unknown status filter', () => {
    const { store } = fakeStore();
    const res = listHarnessCommands({ scope: 'user', scopeKey: null, status: 'maybe' }, store, noScan);
    expect(res.ok).toBe(false);
  });

  it('defaults the user scopeKey to the runtime constant when omitted', () => {
    const { store, calls } = fakeStore([makeCommand()]);
    const res = listHarnessCommands({ scope: 'user', scopeKey: null, status: null }, store, noScan);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.scopeKey).toBe(DEFAULT_USER_ID);
    expect(calls.listHarness[0]).toMatchObject({ scope: 'user', scopeKey: DEFAULT_USER_ID });
  });

  it('always filters to kind:command', () => {
    const { store, calls } = fakeStore([makeCommand()]);
    listHarnessCommands({ scope: 'user', scopeKey: null, status: null }, store, noScan);
    expect(calls.listHarness[0].opts).toMatchObject({ kind: 'command' });
  });

  it('requires a scopeKey for project scope', () => {
    const { store } = fakeStore();
    const res = listHarnessCommands({ scope: 'project', scopeKey: null, status: null }, store, noScan);
    expect(res.ok).toBe(false);
  });

  it('returns the command rows whole, template included', () => {
    const { store } = fakeStore([makeCommand({ command: { template: 'my body' } })]);
    const res = listHarnessCommands({ scope: 'user', scopeKey: null, status: null }, store, noScan);
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
  // A row with no path origin (a user-authored command) has no file to unlink, so
  // it takes the tombstone tier — which is also what keeps a `.claude` artifact of
  // the same (kind, name) from re-appearing as a fresh row after the delete.
  it('delete tombstones a row with no file origin (no hard remove)', () => {
    const { store, calls, rows } = fakeStore([makeCommand({ id: 'd1' })]);
    const res = runHarnessAction({ action: 'delete', id: 'd1' }, store, noScan);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.deleted).toEqual({ tier: 'tombstone', reason: 'no-origin' });
    expect(calls.remove).toEqual([]);
    expect(calls.setStatus).toEqual([{ id: 'd1', status: 'removed' }]);
    expect(rows.get('d1')?.status).toBe('removed');
  });

  it('delete of an id that is not stored stays idempotent (hard remove, no throw)', () => {
    const { store, calls } = fakeStore();
    const res = runHarnessAction({ action: 'delete', id: 'ghost' }, store, noScan);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.deleted).toEqual({ tier: 'row' });
    expect(calls.remove).toEqual([{ id: 'ghost' }]);
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
    listHarnessCommands({ scope: 'user', scopeKey: null, status: null }, store, noScan);
    expect(calls.listHarness[0].opts).toMatchObject({ kind: 'command' });
  });

  it("kind:'all' clears the kind filter so every kind returns", () => {
    const { store, calls } = fakeStore([makeCommand()]);
    const res = listHarnessCommands({ scope: 'user', scopeKey: null, status: null, kind: 'all' }, store, noScan);
    expect(res.ok).toBe(true);
    const opts = calls.listHarness[0].opts as { kind?: string } | undefined;
    expect(opts?.kind).toBeUndefined();
  });

  it('an explicit kind filters to it', () => {
    const { store, calls } = fakeStore([makeCommand()]);
    listHarnessCommands({ scope: 'user', scopeKey: null, status: null, kind: 'skill' }, store, noScan);
    expect(calls.listHarness[0].opts).toMatchObject({ kind: 'skill' });
  });

  it('rejects an unknown kind', () => {
    const { store } = fakeStore();
    const res = listHarnessCommands({ scope: 'user', scopeKey: null, status: null, kind: 'bogus' }, store, noScan);
    expect(res.ok).toBe(false);
  });
});

// The fix for "a skill installed to ~/.claude/skills is invisible forever": the
// list reconciles the on-disk tree into the store before reading it.
describe('listHarnessCommands — scan on list', () => {
  it('scans the user scope with the resolved scopeKey before listing', () => {
    const { store } = fakeStore([makeCommand()]);
    const { deps, scans } = scanSpy();
    const res = listHarnessCommands({ scope: 'user', scopeKey: null, status: null }, store, deps);
    expect(res.ok).toBe(true);
    // mode:'scan' — a list refresh may never open a vendor directory.
    expect(scans).toEqual([{ scope: 'user', scopeKey: DEFAULT_USER_ID, mode: 'scan' }]);
  });

  it('lists what the scan just imported (scan runs BEFORE the store read)', () => {
    const { store } = fakeStore();
    // A scan that lands one external skill, exactly as the real importer would.
    const deps: HarnessActionDeps = {
      importHarness: (args) => {
        store.putHarnessItem({
          item: {
            scope: args.scope,
            scopeKey: args.scopeKey,
            kind: 'skill',
            name: 'freshly-installed',
            provenance: { source: 'external', origin: '/home/me/.claude/skills/x/SKILL.md' },
            skill: { instructions: 'do the thing' },
          },
          requestedStatus: 'enabled',
        });
        return emptySummary(args.scope, args.scopeKey);
      },
      deleteSource: okDelete,
    };
    const res = listHarnessCommands(
      { scope: 'user', scopeKey: null, status: null, kind: 'all' },
      store,
      deps,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const found = res.data.items.find((i) => i.name === 'freshly-installed');
      expect(found).toBeDefined();
      // The trust gate is untouched: a scanned item is visible, never live.
      expect(found?.status).toBe('disabled');
    }
  });

  // THE STANDALONE PROPERTY, at the route surface (harness-standalone §2.2/§2.1).
  // Everything here is real except the disk: the real store, the real gate, the
  // real importer. A file sitting in `~/.claude` is invisible to any number of
  // lists, and the explicit Import action is what brings it in — as a COPY the
  // naby home owns.
  it('a `.claude` file never appears from a list, and DOES from an explicit import', () => {
    const files: Record<string, string> = {
      '/home/me/.claude/skills/planted/SKILL.md': skillDoc('planted', 'vendor body'),
    };
    const store = new MemoryStore();
    const deps: HarnessActionDeps = {
      importHarness: (args) =>
        importHarness({ ...args, homeDir: '/home/me', store, fs: fakeTreeFs(files) }),
      deleteSource: okDelete,
      homeDir: '/home/me',
    };

    for (let i = 0; i < 3; i += 1) {
      resetHarnessScanThrottle();
      expect(listPanel(store, deps).items).toEqual([]);
    }
    // And nothing was written into the naby home behind the user's back.
    expect(files['/home/me/.naby/skills/planted/SKILL.md']).toBeUndefined();

    const imported = runHarnessAction({ action: 'import', scope: 'user' }, store, deps);
    expect(imported.ok).toBe(true);
    if (imported.ok) expect(imported.summary?.copied).toBe(1);

    resetHarnessScanThrottle();
    const listed = listPanel(store, deps).items;
    expect(listed.map((i) => i.name)).toEqual(['planted']);
    expect(listed[0].provenance.origin).toBe('/home/me/.naby/skills/planted/SKILL.md');
    expect(listed[0].provenance.importedFrom).toBe('/home/me/.claude/skills/planted/SKILL.md');
    expect(listed[0].status).toBe('disabled');
    // The COPY exists, and the vendor original is untouched.
    expect(files['/home/me/.naby/skills/planted/SKILL.md']).toBe(skillDoc('planted', 'vendor body'));
    expect(files['/home/me/.claude/skills/planted/SKILL.md']).toBe(
      skillDoc('planted', 'vendor body'),
    );
  });

  it('throttles: a second list for the same scope+key does not re-walk the tree', () => {
    const { store } = fakeStore();
    const { deps, scans } = scanSpy();
    listHarnessCommands({ scope: 'user', scopeKey: null, status: null }, store, deps);
    listHarnessCommands({ scope: 'user', scopeKey: null, status: null }, store, deps);
    listHarnessCommands({ scope: 'user', scopeKey: null, status: null }, store, deps);
    expect(scans).toHaveLength(1);
  });

  it('throttles per scope+key, so a different scope still scans', () => {
    const { store } = fakeStore();
    const { deps, scans } = scanSpy();
    listHarnessCommands({ scope: 'user', scopeKey: null, status: null }, store, deps);
    listHarnessCommands({ scope: 'project', scopeKey: '/proj', status: null }, store, deps);
    listHarnessCommands({ scope: 'project', scopeKey: '/other', status: null }, store, deps);
    expect(scans.map((s) => s.scopeKey)).toEqual([DEFAULT_USER_ID, '/proj', '/other']);
  });

  it('passes the project scopeKey through as the cwd', () => {
    const { store } = fakeStore();
    const { deps, scans } = scanSpy();
    listHarnessCommands({ scope: 'project', scopeKey: '/proj', status: null }, store, deps);
    expect(scans).toEqual([{ scope: 'project', scopeKey: '/proj', cwd: '/proj', mode: 'scan' }]);
  });

  it('NEVER scans the org scope (no local harness home on disk)', () => {
    const { store } = fakeStore();
    const { deps, scans } = scanSpy();
    const res = listHarnessCommands({ scope: 'org', scopeKey: null, status: null }, store, deps);
    expect(res.ok).toBe(true);
    expect(scans).toEqual([]);
  });

  it('does not scan when the params are invalid (no scope, no key)', () => {
    const { store } = fakeStore();
    const { deps, scans } = scanSpy();
    listHarnessCommands({ scope: 'bogus', scopeKey: null, status: null }, store, deps);
    listHarnessCommands({ scope: 'project', scopeKey: null, status: null }, store, deps);
    expect(scans).toEqual([]);
  });

  it('a broken harness tree does not break the list', () => {
    const { store } = fakeStore([makeCommand()]);
    const deps: HarnessActionDeps = {
      importHarness: () => {
        throw new Error('EACCES: permission denied');
      },
      deleteSource: okDelete,
    };
    const res = listHarnessCommands({ scope: 'user', scopeKey: null, status: null }, store, deps);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.items).toHaveLength(1);
  });

  it('a throwing scan is still throttled (no re-walk storm)', () => {
    const { store } = fakeStore();
    let calls = 0;
    const deps: HarnessActionDeps = {
      importHarness: () => {
        calls += 1;
        throw new Error('boom');
      },
      deleteSource: okDelete,
    };
    listHarnessCommands({ scope: 'user', scopeKey: null, status: null }, store, deps);
    listHarnessCommands({ scope: 'user', scopeKey: null, status: null }, store, deps);
    expect(calls).toBe(1);
  });
});

describe('runHarnessAction — import (HP-04)', () => {
  it('delegates to the injected importer and returns its summary', () => {
    const { store } = fakeStore();
    const summary = {
      scope: 'user' as const,
      scopeKey: DEFAULT_USER_ID,
      baseDir: '/home/me/.naby',
      baseDirs: ['/home/me/.naby', '/home/me/.claude'],
      baseExists: true,
      imported: { command: 1, skill: 0, subagent: 0 },
      unchanged: 0,
      copied: 1,
      skippedHooks: 2,
      skipped: [],
      failed: [],
      items: [],
    };
    let seen: { scope: string; scopeKey: string; cwd?: string; mode?: string } | null = null;
    const res = runHarnessAction({ action: 'import', scope: 'user' }, store, {
      importHarness: (args) => {
        seen = args;
        return summary;
      },
      deleteSource: okDelete,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.summary?.skippedHooks).toBe(2);
    // mode:'import' is what licenses reading (and copying out of) a vendor tree.
    expect(seen).toMatchObject({ scope: 'user', scopeKey: DEFAULT_USER_ID, mode: 'import' });
  });

  it('requires a scopeKey for project scope', () => {
    const { store } = fakeStore();
    const res = runHarnessAction({ action: 'import', scope: 'project' }, store, {
      importHarness: () => {
        throw new Error('should not be called');
      },
      deleteSource: okDelete,
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
        importHarness: (args) => {
          seen = args;
          return {
            scope: 'project',
            scopeKey: '/proj',
            baseDir: '/proj/.naby',
            baseDirs: ['/proj/.naby', '/proj/.claude'],
            baseExists: true,
            imported: { command: 0, skill: 0, subagent: 0 },
            unchanged: 0,
            copied: 0,
            skippedHooks: 0,
            skipped: [],
            failed: [],
            items: [],
          };
        },
        deleteSource: okDelete,
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
      noScan,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.removed).toBe(2);
    // The two `.claude` rows are TOMBSTONED, not dropped: their files are the
    // vendor's and stay on disk, so dropping the rows would let the next
    // scan-on-list re-import both as fresh disabled rows — revert undoing itself
    // exactly like the per-item delete did.
    expect([...rows.keys()].sort()).toEqual(['p1', 'u1', 'x1', 'x2']);
    expect(rows.get('x1')?.status).toBe('removed');
    expect(rows.get('x2')?.status).toBe('removed');
    // Untouched: a user-authored row and another project's import.
    expect(rows.get('u1')?.status).toBe('enabled');
    expect(rows.get('p1')?.status).toBe('enabled');
  });

  it('a naby-home import reverts by deleting the files (nothing left to re-scan)', () => {
    const seed = [
      makeCommand({
        id: 'n1',
        name: 'mine-a',
        provenance: { source: 'external', origin: '/home/me/.naby/commands/a.md' },
      }),
      makeCommand({
        id: 'n2',
        name: 'mine-b',
        kind: 'skill',
        provenance: { source: 'external', origin: '/home/me/.naby/skills/b/SKILL.md' },
      }),
    ];
    const { store, rows } = fakeStore(seed);
    const { deleteSource, unlinked } = fakeDeleteSource('deleted');
    const res = runHarnessAction(
      { action: 'revertOrigin', scope: 'user', originPrefix: '/home/me/.naby' },
      store,
      { ...noScan, deleteSource, homeDir: '/home/me' },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.removed).toBe(2);
    // Files ours => unlinked (the SKILL.md takes its directory), rows gone.
    expect(unlinked).toEqual(['/home/me/.naby/commands/a.md', '/home/me/.naby/skills/b']);
    expect([...rows.keys()]).toEqual([]);
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

// ---------------------------------------------------------------------------
// The reported v1.8.1 bug, end to end at the route surface: enabling an imported
// skill in Settings > Harness "succeeded" and the item stayed 비활성, because the
// next list re-ran the scan and the scan re-imported the row as a fresh external
// item, which the gate pins to 'disabled'.
//
// This case runs the REAL store (MemoryStore ⇒ the real import gate) and the REAL
// importer over a fake harness tree, so nothing between the toggle and the list
// is stubbed — a fake would have re-encoded the very assumption that was wrong.
// The tree is the NABY HOME, because that is what a list scan reads
// (harness-standalone §2.2).
// ---------------------------------------------------------------------------

/** A one-file fake naby home: <home>/.naby/skills/review/SKILL.md. */
function fakeNabyTree(body: string) {
  const files: Record<string, string> = {
    '/home/me/.naby/skills/review/SKILL.md': `---\nname: review\n---\n${body}`,
  };
  const dirs = new Set(['/home/me/.naby', '/home/me/.naby/skills', '/home/me/.naby/skills/review']);
  return {
    existsSync: (p: string) => p in files || dirs.has(p),
    readFileSync: (p: string) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
    readdirSync: (p: string) => {
      const prefix = p.replace(/\/+$/, '') + '/';
      const names = new Set<string>();
      for (const key of [...Object.keys(files), ...dirs]) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split('/')[0]);
      }
      return [...names].map((name) => ({
        name,
        isDirectory: () => dirs.has(prefix + name),
        isFile: () => prefix + name in files,
      }));
    },
  };
}

describe('enable → list: the scan must not undo the review (v1.8.1 regression)', () => {
  function realWiring(body: string) {
    const store = new MemoryStore();
    const deps: HarnessActionDeps = {
      importHarness: (args) =>
        importHarness({
          ...args,
          homeDir: '/home/me',
          store,
          fs: fakeNabyTree(body),
        }),
      deleteSource: okDelete,
    };
    return { store, deps };
  }

  function listAll(store: MemoryStore, deps: HarnessActionDeps) {
    const res = listHarnessCommands(
      { scope: 'user', scopeKey: null, status: null, kind: 'all' },
      store,
      deps,
    );
    if (!res.ok) throw new Error(res.error);
    return res.data.items;
  }

  it('an imported skill enabled in Settings is STILL enabled on the next list', () => {
    const { store, deps } = realWiring('do the review');

    // 1) the panel opens: the scan discovers the skill, disabled and reviewable.
    const discovered = listAll(store, deps);
    expect(discovered.map((i) => i.name)).toEqual(['review']);
    expect(discovered[0].status).toBe('disabled');

    // 2) the user presses 활성화.
    const toggled = runHarnessAction(
      { action: 'setEnabled', id: discovered[0].id, enabled: true },
      store,
      deps,
    );
    expect(toggled.ok).toBe(true);

    // 3) the panel reloads. The throttle would have hidden the bug, so the scan
    //    is deliberately allowed to run again — as it does after 10s in the app.
    resetHarnessScanThrottle();
    expect(listAll(store, deps)[0].status).toBe('enabled');
  });

  it('the enabled skill is what "/" reads: it appears in the enabled-only list', () => {
    const { store, deps } = realWiring('do the review');
    const id = listAll(store, deps)[0].id;
    runHarnessAction({ action: 'setEnabled', id, enabled: true }, store, deps);
    resetHarnessScanThrottle();

    const res = listHarnessCommands(
      { scope: 'user', scopeKey: null, status: 'enabled', kind: 'all' },
      store,
      deps,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.items.map((i) => i.name)).toEqual(['review']);
  });

  it('a scan that finds EDITED content updates the body and keeps it enabled', () => {
    const { store, deps } = realWiring('do the review');
    const id = listAll(store, deps)[0].id;
    runHarnessAction({ action: 'setEnabled', id, enabled: true }, store, deps);

    // The file changed on disk since the last scan.
    const edited: HarnessActionDeps = {
      importHarness: (args) =>
        importHarness({
          ...args,
          homeDir: '/home/me',
          store,
          fs: fakeNabyTree('do the review, then summarize'),
        }),
      deleteSource: okDelete,
    };
    resetHarnessScanThrottle();
    const items = listAll(store, edited);
    expect(items[0].skill?.instructions).toBe('do the review, then summarize');
    expect(items[0].status).toBe('enabled');
  });

  it('a NEVER-reviewed skill still arrives disabled (the gate is not weakened)', () => {
    const { store, deps } = realWiring('do the review');
    listAll(store, deps);
    resetHarnessScanThrottle();
    expect(listAll(store, deps)[0].status).toBe('disabled');
  });
});

// ---------------------------------------------------------------------------
// THE REPORTED v1.8.2 BUG, at the route surface: DELETE DID NOT STICK.
//
// Deleting an imported item removed the row but not the file, and scan-on-list
// re-imported that file on the very next list as a brand-new disabled row. The
// user deleted A, B and C and watched all three come back at the bottom of the
// list, after D…Z. These cases run the REAL store (MemoryStore ⇒ the real gate)
// and the REAL importer, because a fake store would re-encode the assumption
// that was wrong.
// ---------------------------------------------------------------------------

/** A mutable in-memory tree. `files` can be edited between scans (that is the
 *  "changed content" case), and directories are derived from the paths. */
function fakeTreeFs(files: Record<string, string>) {
  const dirsNow = () => {
    const dirs = new Set<string>();
    for (const p of Object.keys(files)) {
      const parts = p.split('/');
      for (let i = 2; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'));
    }
    return dirs;
  };
  return {
    existsSync: (p: string) => p in files || dirsNow().has(p),
    readFileSync: (p: string) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
    readdirSync: (p: string) => {
      const prefix = p.replace(/\/+$/, '') + '/';
      const dirs = dirsNow();
      const names = new Set<string>();
      for (const key of [...Object.keys(files), ...dirs]) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split('/')[0]);
      }
      return [...names].map((name) => ({
        name,
        isDirectory: () => dirs.has(prefix + name),
        isFile: () => prefix + name in files,
      }));
    },
    // Writes, so a materializing import can be observed as FILES and not only as
    // rows (harness-standalone §2.1). Directories are implied by paths, so mkdir
    // has nothing to record.
    mkdirSync: () => undefined,
    copyFileSync: (src: string, dest: string) => {
      if (!(src in files)) throw new Error(`ENOENT: ${src}`);
      files[dest] = files[src];
    },
    cpSync: (src: string, dest: string) => {
      const prefix = src.replace(/\/+$/, '') + '/';
      const keys = Object.keys(files).filter((k) => k.startsWith(prefix));
      if (keys.length === 0) throw new Error(`ENOENT: ${src}`);
      for (const key of keys) files[dest + '/' + key.slice(prefix.length)] = files[key];
    },
  };
}

function skillDoc(name: string, body: string): string {
  return `---\nname: ${name}\n---\n${body}`;
}

/** The user-scope list the panel performs, tombstones included or not. */
function listPanel(
  store: MemoryStore,
  deps: HarnessActionDeps,
  opts?: { includeRemoved?: boolean; status?: string },
) {
  const res = listHarnessCommands(
    {
      scope: 'user',
      scopeKey: null,
      status: opts?.status ?? null,
      kind: 'all',
      ...(opts?.includeRemoved ? { includeRemoved: true } : {}),
    },
    store,
    deps,
  );
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

// TOMBSTONES, AFTER harness-standalone §2.1. A new import owns its file, so the
// ordinary delete now removes it (the real-disk block below). The tombstone is
// what happens when the file CANNOT be removed — a refused containment check, a
// row imported before the copy existed, a set import with no file at all — and
// the property it exists for is unchanged and still worth a full route test: the
// next list must not re-import the artifact as a brand-new disabled row.
//
// This wiring makes the refusal the constant: a real naby tree that the scan
// really reads, and a deleter that always refuses.
describe('delete must stick — a refused unlink tombstones (v1.8.2)', () => {
  function vendorWiring() {
    const files: Record<string, string> = {
      '/home/me/.naby/skills/alpha/SKILL.md': skillDoc('alpha', 'A body'),
      '/home/me/.naby/skills/beta/SKILL.md': skillDoc('beta', 'B body'),
      '/home/me/.naby/skills/gamma/SKILL.md': skillDoc('gamma', 'C body'),
    };
    const store = new MemoryStore();
    const deps: HarnessActionDeps = {
      importHarness: (args) =>
        importHarness({ ...args, homeDir: '/home/me', store, fs: fakeTreeFs(files) }),
      // Every unlink is refused, so every delete falls back to the tombstone —
      // and the file stays on disk for the next scan to find, which is the only
      // situation in which the tombstone has any work to do.
      deleteSource: (plan) => ({
        outcome: 'refused',
        target: plan.target,
        reason: 'the containment re-check refused this path',
      }),
      homeDir: '/home/me',
    };
    return { store, deps, files };
  }

  it('THE USER FLOW: import A,B,C → delete A → list again → A is gone and stays gone', () => {
    const { store, deps } = vendorWiring();

    const first = listPanel(store, deps).items;
    expect(first.map((i) => i.name)).toEqual(['alpha', 'beta', 'gamma']);

    const del = runHarnessAction({ action: 'delete', id: first[0].id }, store, deps);
    expect(del.ok).toBe(true);
    if (del.ok) expect(del.deleted).toMatchObject({ tier: 'tombstone' });

    // The list the user sees next — with the scan allowed to run again, which is
    // exactly where the bug lived.
    resetHarnessScanThrottle();
    const second = listPanel(store, deps).items;
    expect(second.map((i) => i.name)).toEqual(['beta', 'gamma']);

    // And again, twice more: no row accumulates, nothing reappears at the bottom.
    resetHarnessScanThrottle();
    listPanel(store, deps);
    resetHarnessScanThrottle();
    const third = listPanel(store, deps).items;
    expect(third.map((i) => i.name)).toEqual(['beta', 'gamma']);
    expect(store.listHarness('user', DEFAULT_USER_ID)).toHaveLength(3); // 2 live + 1 tombstone
  });

  it('an EDITED source file does not resurrect the deletion (refresh carries removed)', () => {
    const { store, deps, files } = vendorWiring();
    const alpha = listPanel(store, deps).items[0];
    runHarnessAction({ action: 'delete', id: alpha.id }, store, deps);

    // The file changes on disk: the scan now WRITES the row (it is no longer
    // "unchanged"), so the status has to survive the gate, not just the skip.
    files['/home/me/.naby/skills/alpha/SKILL.md'] = skillDoc('alpha', 'A body, revised');
    resetHarnessScanThrottle();
    const after = listPanel(store, deps);
    expect(after.items.map((i) => i.name)).toEqual(['beta', 'gamma']);

    const tombstone = listPanel(store, deps, { includeRemoved: true }).items.find(
      (i) => i.name === 'alpha',
    );
    expect(tombstone?.status).toBe('removed');
    expect(tombstone?.id).toBe(alpha.id); // the same row, not a second one
    expect(tombstone?.skill?.instructions).toBe('A body, revised');
  });

  it('deleting an ENABLED item takes it out of every enabled-only read', () => {
    const { store, deps } = vendorWiring();
    const alpha = listPanel(store, deps).items[0];
    runHarnessAction({ action: 'setEnabled', id: alpha.id, enabled: true }, store, deps);
    runHarnessAction({ action: 'delete', id: alpha.id }, store, deps);

    resetHarnessScanThrottle();
    // What "/" and the skill injection read.
    expect(store.listHarness('user', DEFAULT_USER_ID, { status: 'enabled' })).toEqual([]);
    expect(listPanel(store, deps, { status: 'enabled' }).items).toEqual([]);
  });

  it('export never serializes a tombstone', () => {
    const { store, deps } = vendorWiring();
    const items = listPanel(store, deps).items;
    for (const it of items) {
      runHarnessAction({ action: 'setEnabled', id: it.id, enabled: true }, store, deps);
    }
    runHarnessAction({ action: 'delete', id: items[0].id }, store, deps);

    const res = runHarnessAction(
      { action: 'exportSet', scope: 'user', name: 'team', version: '1.0.0' },
      store,
      deps,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.set?.items.map((i) => i.name)).toEqual(['beta', 'gamma']);
      expect(res.set?.manifest.counts.skill).toBe(2);
    }
  });

  it('RESTORE puts the row back as disabled, and the scan leaves it there', () => {
    const { store, deps } = vendorWiring();
    const alpha = listPanel(store, deps).items[0];
    runHarnessAction({ action: 'delete', id: alpha.id }, store, deps);

    // The panel's 복원 button: an explicit toggle, which leaves the removed state.
    const restored = runHarnessAction(
      { action: 'setEnabled', id: alpha.id, enabled: false },
      store,
      deps,
    );
    expect(restored.ok).toBe(true);

    resetHarnessScanThrottle();
    const after = listPanel(store, deps).items;
    expect(after.map((i) => i.name)).toEqual(['alpha', 'beta', 'gamma']);
    expect(after.find((i) => i.name === 'alpha')?.status).toBe('disabled');
    expect(after.find((i) => i.name === 'alpha')?.id).toBe(alpha.id);

    // Restoring straight to ENABLED works the same way.
    runHarnessAction({ action: 'delete', id: alpha.id }, store, deps);
    runHarnessAction({ action: 'setEnabled', id: alpha.id, enabled: true }, store, deps);
    resetHarnessScanThrottle();
    expect(listPanel(store, deps).items.find((i) => i.name === 'alpha')?.status).toBe('enabled');
  });

  it('tombstones are hidden by default and only visible when asked for', () => {
    const { store, deps } = vendorWiring();
    const alpha = listPanel(store, deps).items[0];
    runHarnessAction({ action: 'delete', id: alpha.id }, store, deps);
    resetHarnessScanThrottle();

    expect(listPanel(store, deps).items.map((i) => i.name)).toEqual(['beta', 'gamma']);
    expect(
      listPanel(store, deps, { includeRemoved: true }).items.map((i) => i.name).sort(),
    ).toEqual(['alpha', 'beta', 'gamma']);
    expect(listPanel(store, deps, { status: 'removed' }).items.map((i) => i.name)).toEqual([
      'alpha',
    ]);
  });

  it('the list tells the client which naby homes this scope owns', () => {
    const { store, deps } = vendorWiring();
    // Resolved from the REAL home dir, not the injected test one: the value is
    // display-only (it words the delete confirmation) and the action re-decides.
    expect(listPanel(store, deps).nabyBases).toHaveLength(1);
    expect(listPanel(store, deps).nabyBases[0].endsWith('/.naby')).toBe(true);
  });

  it('a refused unlink falls back to the tombstone (never a silent no-op)', () => {
    const { store } = vendorWiring();
    // A row that CLAIMS a naby-home origin, whose unlink the containment check
    // refuses (a symlink escape, an unreadable home). The delete must still be
    // honoured in the one place that is ours: the row.
    const item = store.putHarnessItem({
      item: {
        scope: 'user',
        scopeKey: DEFAULT_USER_ID,
        kind: 'skill',
        name: 'sneaky',
        provenance: { source: 'external', origin: '/home/me/.naby/skills/sneaky/SKILL.md' },
        skill: { instructions: 'body' },
      },
    });
    const { deleteSource, unlinked } = fakeDeleteSource('refused');
    const res = runHarnessAction({ action: 'delete', id: item.id }, store, {
      ...noScan,
      deleteSource,
      homeDir: '/home/me',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.deleted?.tier).toBe('tombstone');
    expect(unlinked).toEqual(['/home/me/.naby/skills/sneaky']); // attempted, refused
    expect(store.getHarnessItem(item.id)?.status).toBe('removed');
  });
});

describe('delete must stick — naby-home items lose their FILE (v1.8.2)', () => {
  // Real disk, real deleter: the containment re-check resolves realpaths, so a
  // fake fs would not exercise the thing most worth exercising.
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'naby-harness-del-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function realWiring() {
    const store = new MemoryStore();
    const deps: HarnessActionDeps = {
      importHarness: (args) => importHarness({ ...args, homeDir: home, store }),
      deleteSource: (plan) => deleteHarnessSource(plan),
      homeDir: home,
    };
    return { store, deps };
  }

  it('a skill in the naby home takes its whole directory with it, and never returns', () => {
    const dir = join(home, '.naby', 'skills', 'mine');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), skillDoc('mine', 'my own body'));
    // A resource file next to it: the skill is the DIRECTORY, so this goes too —
    // otherwise the leftovers sit there forever, invisible to the scanner.
    writeFileSync(join(dir, 'reference.md'), 'notes');

    const { store, deps } = realWiring();
    const found = listPanel(store, deps).items;
    expect(found.map((i) => i.name)).toEqual(['mine']);

    const res = runHarnessAction({ action: 'delete', id: found[0].id }, store, deps);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.deleted).toEqual({ tier: 'source', file: dir });
    expect(existsSync(dir)).toBe(false);
    // The row is GONE, not tombstoned: with no file left there is nothing for a
    // scan to re-import, so there is nothing to remember.
    expect(store.listHarness('user', DEFAULT_USER_ID)).toEqual([]);

    resetHarnessScanThrottle();
    expect(listPanel(store, deps, { includeRemoved: true }).items).toEqual([]);
  });

  it('a command in the naby home loses its file only (the folder stays)', () => {
    const dir = join(home, '.naby', 'commands');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ship.md'), 'Ship it.');
    writeFileSync(join(dir, 'keep.md'), 'Keep it.');

    const { store, deps } = realWiring();
    const found = listPanel(store, deps).items;
    expect(found.map((i) => i.name).sort()).toEqual(['keep', 'ship']);

    const ship = found.find((i) => i.name === 'ship')!;
    const res = runHarnessAction({ action: 'delete', id: ship.id }, store, deps);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.deleted).toEqual({ tier: 'source', file: join(dir, 'ship.md') });
    expect(existsSync(join(dir, 'ship.md'))).toBe(false);
    expect(existsSync(join(dir, 'keep.md'))).toBe(true);

    resetHarnessScanThrottle();
    expect(listPanel(store, deps).items.map((i) => i.name)).toEqual(['keep']);
  });

  it('a source file that is already gone still removes the row (no tombstone)', () => {
    const dir = join(home, '.naby', 'commands');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ship.md'), 'Ship it.');

    const { store, deps } = realWiring();
    const ship = listPanel(store, deps).items[0];
    rmSync(join(dir, 'ship.md')); // deleted outside naby, between list and click

    const res = runHarnessAction({ action: 'delete', id: ship.id }, store, deps);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.deleted?.tier).toBe('source');
    expect(store.listHarness('user', DEFAULT_USER_ID)).toEqual([]);
  });
});
