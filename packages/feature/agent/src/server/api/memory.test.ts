import { describe, it, expect } from 'vitest';
import { DEFAULT_USER_ID, type MemoryItem } from '../../../../../../../dist/naby-runtime.mjs';
import { listScopedMemory, runMemoryAction } from './memory';

// A fake store recording every scoped-memory call, so the list/action logic is
// exercised without opening a real sqlite file. Only the three methods the route
// touches are implemented.
function fakeStore(items: MemoryItem[] = []) {
  const calls = {
    getScopedMemory: [] as { scope: string; scopeKey: string; opts?: { status?: string } }[],
    confirmMemory: [] as string[],
    deleteMemory: [] as unknown[],
  };
  const store = {
    getScopedMemory(scope: string, scopeKey: string, opts?: { status?: string }) {
      calls.getScopedMemory.push({ scope, scopeKey, ...(opts ? { opts } : {}) });
      return items;
    },
    confirmMemory(id: string) {
      calls.confirmMemory.push(id);
    },
    deleteMemory(sel: unknown) {
      calls.deleteMemory.push(sel);
    },
  };
  return { store, calls };
}

function makeItem(over: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'id-1',
    scope: 'user',
    scopeKey: DEFAULT_USER_ID,
    type: 'semantic',
    key: 'tone',
    value: 'concise',
    provenance: { source: 'user' },
    confidence: 1,
    status: 'confirmed',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe('listScopedMemory', () => {
  it('rejects an unknown scope', () => {
    const { store } = fakeStore();
    const res = listScopedMemory({ scope: 'bogus', scopeKey: null, status: null }, store);
    expect(res.ok).toBe(false);
  });

  it('rejects an unknown status filter', () => {
    const { store } = fakeStore();
    const res = listScopedMemory({ scope: 'user', scopeKey: null, status: 'maybe' }, store);
    expect(res.ok).toBe(false);
  });

  it('defaults the user scopeKey to the runtime constant when omitted', () => {
    const { store, calls } = fakeStore([makeItem()]);
    const res = listScopedMemory({ scope: 'user', scopeKey: null, status: null }, store);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.scopeKey).toBe(DEFAULT_USER_ID);
    expect(calls.getScopedMemory[0]).toMatchObject({ scope: 'user', scopeKey: DEFAULT_USER_ID });
  });

  it('requires a scopeKey for session scope', () => {
    const { store } = fakeStore();
    const res = listScopedMemory({ scope: 'session', scopeKey: null, status: null }, store);
    expect(res.ok).toBe(false);
  });

  it('passes the status filter through to the store', () => {
    const { store, calls } = fakeStore([makeItem({ status: 'proposed' })]);
    const res = listScopedMemory({ scope: 'session', scopeKey: 's1', status: 'proposed' }, store);
    expect(res.ok).toBe(true);
    expect(calls.getScopedMemory[0]).toMatchObject({
      scope: 'session',
      scopeKey: 's1',
      opts: { status: 'proposed' },
    });
  });

  it('returns items whole, value included (no redaction)', () => {
    const { store } = fakeStore([makeItem({ value: 'secret-ish preference' })]);
    const res = listScopedMemory({ scope: 'user', scopeKey: null, status: null }, store);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.items[0].value).toBe('secret-ish preference');
  });
});

describe('runMemoryAction', () => {
  it('confirm calls confirmMemory with the id', () => {
    const { store, calls } = fakeStore();
    const res = runMemoryAction({ action: 'confirm', id: 'x1' }, store);
    expect(res.ok).toBe(true);
    expect(calls.confirmMemory).toEqual(['x1']);
  });

  it('confirm rejects an empty id', () => {
    const { store } = fakeStore();
    const res = runMemoryAction({ action: 'confirm', id: '' }, store);
    expect(res.ok).toBe(false);
  });

  it('delete removes exactly the one id', () => {
    const { store, calls } = fakeStore();
    const res = runMemoryAction({ action: 'delete', id: 'x2' }, store);
    expect(res.ok).toBe(true);
    expect(calls.deleteMemory).toEqual([{ id: 'x2' }]);
  });

  it('deleteBySource with source only selects that tier across scopes', () => {
    const { store, calls } = fakeStore();
    const res = runMemoryAction({ action: 'deleteBySource', source: 'external' }, store);
    expect(res.ok).toBe(true);
    expect(calls.deleteMemory).toEqual([{ source: 'external' }]);
  });

  it('deleteBySource with source AND session narrows to that session', () => {
    const { store, calls } = fakeStore();
    const res = runMemoryAction(
      { action: 'deleteBySource', source: 'external', sessionId: 's9' },
      store,
    );
    expect(res.ok).toBe(true);
    expect(calls.deleteMemory).toEqual([{ source: 'external', sessionId: 's9' }]);
  });

  it('deleteBySource with sessionId only fans across every trust tier', () => {
    const { store, calls } = fakeStore();
    const res = runMemoryAction({ action: 'deleteBySource', sessionId: 's9' }, store);
    expect(res.ok).toBe(true);
    expect(calls.deleteMemory).toEqual([
      { source: 'user', sessionId: 's9' },
      { source: 'artifact', sessionId: 's9' },
      { source: 'external', sessionId: 's9' },
    ]);
  });

  it('deleteBySource with an invalid source is rejected', () => {
    const { store } = fakeStore();
    // @ts-expect-error — exercising the runtime guard against a bad source value.
    const res = runMemoryAction({ action: 'deleteBySource', source: 'nope' }, store);
    expect(res.ok).toBe(false);
  });

  it('deleteBySource with neither selector is rejected', () => {
    const { store } = fakeStore();
    const res = runMemoryAction({ action: 'deleteBySource' }, store);
    expect(res.ok).toBe(false);
  });

  it('an unknown action is rejected', () => {
    const { store } = fakeStore();
    // @ts-expect-error — exercising the default branch.
    const res = runMemoryAction({ action: 'frobnicate' }, store);
    expect(res.ok).toBe(false);
  });
});
