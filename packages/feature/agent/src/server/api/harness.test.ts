import { describe, it, expect } from 'vitest';
import {
  DEFAULT_USER_ID,
  type HarnessImportRequest,
  type HarnessItem,
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
  };
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
