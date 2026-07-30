import { describe, it, expect } from 'vitest';
import { DEFAULT_USER_ID, type MemoryItem } from '../../../../../../../dist/naby-runtime.mjs';
import { listScopedMemory, runMemoryAction } from './memory';

// A fake store recording every scoped-memory call, so the list/action logic is
// exercised without opening a real sqlite file. Only the three methods the route
// touches are implemented.
function fakeStore(items: MemoryItem[] = [], corroboration: Record<string, number> = {}) {
  const calls = {
    getScopedMemory: [] as { scope: string; scopeKey: string; opts?: { status?: string } }[],
    confirmMemory: [] as string[],
    deleteMemory: [] as unknown[],
    getMemoryCorroboration: [] as string[][],
  };
  const settings = new Map<string, string>();
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
    // P3-M8b: distinct-session counts, and the auto-confirm opt-in.
    getMemoryCorroboration(ids: readonly string[]) {
      calls.getMemoryCorroboration.push([...ids]);
      const out: Record<string, number> = {};
      for (const id of ids) if (corroboration[id]) out[id] = corroboration[id]!;
      return out;
    },
    getSetting(key: string) {
      return settings.get(key);
    },
    setSetting(key: string, value: string) {
      settings.set(key, value);
    },
  };
  return { store, calls, settings };
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

// ---------------------------------------------------------------------------
// P3-M8b — corroboration on the list, and the auto-confirm opt-in
// ---------------------------------------------------------------------------

describe('listScopedMemory — corroboration (P3-M8b §5.4)', () => {
  it('asks for the ids it just listed and returns their counts', () => {
    const { store, calls } = fakeStore(
      [makeItem({ id: 'a' }), makeItem({ id: 'b' })],
      { a: 3 },
    );
    const res = listScopedMemory({ scope: 'user', scopeKey: null, status: null }, store);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(calls.getMemoryCorroboration).toEqual([['a', 'b']]);
    // 'b' has never been observed, so it is ABSENT rather than 0 — the client
    // reads `?? 0` and cannot mistake one for the other.
    expect(res.data.corroboration).toEqual({ a: 3 });
  });

  it('reports the auto-confirm state and the threshold with the list', () => {
    const { store } = fakeStore([makeItem()]);
    const before = listScopedMemory({ scope: 'user', scopeKey: null, status: null }, store);
    expect(before.ok).toBe(true);
    if (before.ok) {
      // Absent setting = OFF. Nothing is promoted without an explicit opt-in.
      expect(before.data.autoConfirm).toBe(false);
      expect(before.data.corroborationThreshold).toBeGreaterThan(1);
    }

    runMemoryAction({ action: 'autoConfirm.set', enabled: true }, store);
    const after = listScopedMemory({ scope: 'user', scopeKey: null, status: null }, store);
    if (after.ok) expect(after.data.autoConfirm).toBe(true);
  });
});

describe('runMemoryAction — the auto-confirm opt-in', () => {
  it('reads false before anything has been written', () => {
    const { store } = fakeStore();
    expect(runMemoryAction({ action: 'autoConfirm.get' }, store)).toEqual({
      ok: true,
      autoConfirm: false,
    });
  });

  it('round-trips on and back off', () => {
    const { store } = fakeStore();
    expect(runMemoryAction({ action: 'autoConfirm.set', enabled: true }, store)).toEqual({
      ok: true,
      autoConfirm: true,
    });
    expect(runMemoryAction({ action: 'autoConfirm.get' }, store)).toEqual({
      ok: true,
      autoConfirm: true,
    });
    runMemoryAction({ action: 'autoConfirm.set', enabled: false }, store);
    expect(runMemoryAction({ action: 'autoConfirm.get' }, store)).toEqual({
      ok: true,
      autoConfirm: false,
    });
  });

  it('refuses a non-boolean enabled rather than reading it as on', () => {
    const { store, settings } = fakeStore();
    // @ts-expect-error — the whole point is what arrives off the wire.
    const res = runMemoryAction({ action: 'autoConfirm.set', enabled: 'true' }, store);
    expect(res.ok).toBe(false);
    expect(settings.size).toBe(0);
  });
});
