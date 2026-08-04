import { describe, it, expect } from 'vitest';
import {
  DEFAULT_USER_ID,
  MEMORY_DECAY_REVIEW_MS,
  type MemoryItem,
  type ScopedMemoryQuery,
} from '../../../../../../../dist/naby-runtime.mjs';
import {
  listScopedMemory,
  MEMORY_PAGE_SIZE,
  runMemoryAction,
  summarizeMemory,
  SUMMARY_PROPOSED_LIMIT,
  SUMMARY_SUPERSESSION_LIMIT,
} from './memory';

// A fake store recording every scoped-memory call, so the list/action logic is
// exercised without opening a real sqlite file. Only the methods the route
// touches are implemented.
function fakeStore(
  items: MemoryItem[] = [],
  corroboration: Record<string, number> = {},
  reflectedAt?: number,
) {
  const calls = {
    getScopedMemory: [] as { scope: string; scopeKey: string; opts?: ScopedMemoryQuery }[],
    countScopedMemory: [] as { scope: string; scopeKey: string; opts?: ScopedMemoryQuery }[],
    confirmMemory: [] as string[],
    deleteMemory: [] as unknown[],
    getMemoryCorroboration: [] as string[][],
    // P3-M10 §3/§4.
    updateMemoryValue: [] as { id: string; value: string }[],
    markMemoriesInjected: [] as string[][],
    // P3-M13a §3.1: supersession — the chain read, its activation, and the undo.
    supersedeMemory: [] as { oldId: string; newId: string }[],
    revertSupersession: [] as string[],
  };
  const settings = new Map<string, string>();
  const store = {
    getScopedMemory(scope: string, scopeKey: string, opts?: ScopedMemoryQuery) {
      calls.getScopedMemory.push({ scope, scopeKey, ...(opts ? { opts } : {}) });
      // FILTERED, on the three predicates the summary now reads with
      // (settings-ia-reorg §3.3): it makes two calls per scope — the proposals
      // and the replaced rows — and a fake that answered both with every row
      // would let a bug that ignores the filter pass. The remaining filters stay
      // unapplied on purpose: the tests below assert that they are PASSED to the
      // store, which is where they are actually implemented.
      return items.filter((item) => {
        if (opts?.status && item.status !== opts.status) return false;
        if (typeof opts?.superseded === 'boolean') {
          if ((item.supersededAt !== undefined) !== opts.superseded) return false;
        }
        if (opts?.keyPrefix && !item.key.startsWith(opts.keyPrefix)) return false;
        return true;
      });
    },
    countScopedMemory(scope: string, scopeKey: string, opts?: ScopedMemoryQuery) {
      calls.countScopedMemory.push({ scope, scopeKey, ...(opts ? { opts } : {}) });
      return items.length;
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
    updateMemoryValue(id: string, value: string) {
      calls.updateMemoryValue.push({ id, value });
      const found = items.find((i) => i.id === id);
      // Mirrors the real store's shape: the promoted row, or undefined when the
      // id is unknown.
      return found ? { ...found, value, provenance: { source: 'user' as const } } : undefined;
    },
    markMemoriesInjected(ids: readonly string[]) {
      calls.markMemoriesInjected.push([...ids]);
    },
    getMemoryById(id: string) {
      return items.find((i) => i.id === id);
    },
    supersedeMemory(oldId: string, newId: string) {
      calls.supersedeMemory.push({ oldId, newId });
      return true;
    },
    revertSupersession(id: string) {
      calls.revertSupersession.push(id);
      const found = items.find((i) => i.id === id);
      if (!found || found.supersededAt === undefined) return false;
      delete found.supersededAt;
      delete found.supersededBy;
      return true;
    },
    getSetting(key: string) {
      return settings.get(key);
    },
    // settings-ia-reorg §3.3: the memory tab's "last looked back" line reads the
    // same cursor the growth report's learning block does.
    getLatestReflectionAt() {
      return reflectedAt;
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

// ---------------------------------------------------------------------------
// P3-M10 — the memory browser's read (specs/phase-3-memory-hygiene.md §4)
// ---------------------------------------------------------------------------

describe('listScopedMemory — pagination, search and the stale filter (P3-M10 §4)', () => {
  it('defaults to one page and reports the window it applied', () => {
    const { store, calls } = fakeStore([makeItem()]);
    const res = listScopedMemory({ scope: 'user', scopeKey: null, status: null }, store);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.limit).toBe(MEMORY_PAGE_SIZE);
    expect(res.data.offset).toBe(0);
    expect(calls.getScopedMemory[0]?.opts).toMatchObject({
      limit: MEMORY_PAGE_SIZE,
      offset: 0,
    });
  });

  it('CLAMPS an oversized limit — a page size is not something the URL gets to choose', () => {
    // The failure mode this guards is not a wrong number on screen: it is
    // `?limit=100000` rendering a hundred thousand rows into a modal.
    const { store, calls } = fakeStore([makeItem()]);
    const res = listScopedMemory(
      { scope: 'user', scopeKey: null, status: null, limit: 100_000 },
      store,
    );
    if (!res.ok) throw new Error(res.error);
    expect(res.data.limit).toBe(MEMORY_PAGE_SIZE);
    expect(calls.getScopedMemory[0]?.opts?.limit).toBe(MEMORY_PAGE_SIZE);
  });

  it('refuses a limit of zero rather than serving an empty page forever', () => {
    const { store } = fakeStore([makeItem()]);
    const res = listScopedMemory(
      { scope: 'user', scopeKey: null, status: null, limit: 0 },
      store,
    );
    if (!res.ok) throw new Error(res.error);
    expect(res.data.limit).toBe(1);
  });

  it('passes search and type straight through, trimmed', () => {
    const { store, calls } = fakeStore([makeItem()]);
    listScopedMemory(
      {
        scope: 'user',
        scopeKey: null,
        status: 'confirmed',
        type: 'semantic',
        search: '  postgres  ',
      },
      store,
    );
    expect(calls.getScopedMemory[0]?.opts).toMatchObject({
      status: 'confirmed',
      type: 'semantic',
      search: 'postgres',
    });
  });

  it('drops a blank search rather than filtering on an empty string', () => {
    const { store, calls } = fakeStore([makeItem()]);
    listScopedMemory({ scope: 'user', scopeKey: null, status: null, search: '   ' }, store);
    expect(calls.getScopedMemory[0]?.opts).not.toHaveProperty('search');
  });

  it('rejects an unknown type', () => {
    const { store } = fakeStore();
    const res = listScopedMemory(
      { scope: 'user', scopeKey: null, status: null, type: 'nonsense' },
      store,
    );
    expect(res.ok).toBe(false);
  });

  it('derives the stale cutoff on the server and echoes it', () => {
    // The client cannot compute this: staleness is measured against the store's
    // ACCESS history, and the window is a runtime constant (§2.2 calls it a
    // tunable). So the parameter is a flag and the cutoff comes back with the
    // page.
    const now = 1_800_000_000_000;
    const { store, calls } = fakeStore([makeItem()]);
    const res = listScopedMemory(
      { scope: 'user', scopeKey: null, status: null, stale: '1' },
      store,
      now,
    );
    if (!res.ok) throw new Error(res.error);
    expect(res.data.staleBefore).toBe(now - MEMORY_DECAY_REVIEW_MS);
    expect(calls.getScopedMemory[0]?.opts?.staleBefore).toBe(now - MEMORY_DECAY_REVIEW_MS);
  });

  it('leaves the stale filter off unless it was asked for', () => {
    const { store, calls } = fakeStore([makeItem()]);
    const res = listScopedMemory({ scope: 'user', scopeKey: null, status: null }, store);
    if (!res.ok) throw new Error(res.error);
    expect(res.data.staleBefore).toBeNull();
    expect(calls.getScopedMemory[0]?.opts).not.toHaveProperty('staleBefore');
  });

  it('counts with the SAME filter as the list, minus the window', () => {
    // A total computed from a different predicate than the rows is how a page
    // ends up saying "showing 12 of 40" while holding 12 of 12.
    const { store, calls } = fakeStore([makeItem()]);
    listScopedMemory(
      { scope: 'user', scopeKey: null, status: 'proposed', search: 'x', limit: 10, offset: 20 },
      store,
    );
    const listOpts = calls.getScopedMemory[0]?.opts;
    const countOpts = calls.countScopedMemory[0]?.opts;
    expect(countOpts).toEqual({ status: 'proposed', search: 'x' });
    expect(listOpts).toEqual({ status: 'proposed', search: 'x', limit: 10, offset: 20 });
  });
});

describe('summarizeMemory — the settings card (P3-M10 §4)', () => {
  it('omits a scope with no addressable key rather than reporting it as zero', () => {
    // "You have no project memory" and "there is no project open" are different
    // statements, and only one of them is true with no cwd.
    const { store } = fakeStore([]);
    const only = summarizeMemory({}, store);
    expect(only.scopes.map((s) => s.scope)).toEqual(['user']);

    const withBoth = summarizeMemory({ sessionId: 's1', cwd: '/tmp/p' }, store);
    expect(withBoth.scopes.map((s) => s.scope)).toEqual(['user', 'session', 'project']);
  });

  it('counts confirmed, proposed and stale separately per scope', () => {
    const { store, calls } = fakeStore([makeItem()]);
    const out = summarizeMemory({}, store, 1_800_000_000_000);
    expect(out.scopes[0]).toMatchObject({ scope: 'user', confirmed: 1, proposed: 1, stale: 1 });
    // FOUR counts, each with its own filter. The stale one carries the cutoff
    // AND (P3-M13b) the window it was derived from, so the store applies the
    // same strength-scaled rule `isStaleForReview` does. Every count of a
    // CURRENT belief excludes replaced rows (P3-M13a), and the fourth is those
    // replaced rows on their own.
    expect(calls.countScopedMemory.map((c) => c.opts)).toEqual([
      { status: 'confirmed', superseded: false },
      { status: 'proposed', superseded: false },
      {
        staleBefore: 1_800_000_000_000 - MEMORY_DECAY_REVIEW_MS,
        staleWindowMs: MEMORY_DECAY_REVIEW_MS,
        superseded: false,
      },
      { superseded: true },
    ]);
  });

  it('shows at most three proposals, newest first', () => {
    const many = [1, 2, 3, 4, 5].map((n) =>
      makeItem({ id: `p${n}`, status: 'proposed', updatedAt: n }),
    );
    const { store } = fakeStore(many);
    const out = summarizeMemory({}, store);
    expect(out.recentProposed).toHaveLength(SUMMARY_PROPOSED_LIMIT);
    expect(out.recentProposed.map((i) => i.id)).toEqual(['p5', 'p4', 'p3']);
  });

  it('asks for corroboration only for the rows it is about to show', () => {
    const many = [1, 2, 3, 4, 5].map((n) =>
      makeItem({ id: `p${n}`, status: 'proposed', updatedAt: n }),
    );
    const { store, calls } = fakeStore(many);
    summarizeMemory({}, store);
    const asked = calls.getMemoryCorroboration.at(-1) ?? [];
    expect(asked).toHaveLength(SUMMARY_PROPOSED_LIMIT);
  });
});

// ---------------------------------------------------------------------------
// settings-ia-reorg §3.3/§3.5 — the decisions inbox and the badge
// ---------------------------------------------------------------------------

describe('summarizeMemory — the decisions inbox', () => {
  const styleItem = (over: Partial<MemoryItem> = {}) =>
    makeItem({ status: 'proposed', type: 'procedural', ...over });

  it('splits style proposals out of the ordinary ones, keeping both', () => {
    // The split is PLACEMENT, not filtering: the two lists together are what the
    // one list used to be. A style proposal that fell off both would be a
    // decision the user is never offered.
    const { store } = fakeStore([
      makeItem({ id: 'm1', key: 'tone', status: 'proposed', updatedAt: 1 }),
      styleItem({ id: 's1', key: 'style/code-review/no-preamble', updatedAt: 2 }),
      styleItem({ id: 's2', key: 'style/global/conclusion-first', updatedAt: 3 }),
    ]);
    const out = summarizeMemory({}, store);
    expect(out.recentProposed.map((i) => i.id)).toEqual(['m1']);
    expect(out.pendingStyleProposals.map((p) => p.item.id)).toEqual(['s2', 's1']);
  });

  it('marks only the GLOBAL style rows as needing a person', () => {
    // `style/global/*` is the one class corroboration may never confirm (P3-M13c
    // §3.3). The flag is computed with the runtime's own predicate, so the badge
    // and the auto-confirm gate cannot disagree about which rows those are.
    const { store } = fakeStore([
      styleItem({ id: 's1', key: 'style/code-review/no-preamble' }),
      styleItem({ id: 's2', key: 'style/global/conclusion-first' }),
    ]);
    const out = summarizeMemory({}, store);
    expect(
      Object.fromEntries(out.pendingStyleProposals.map((p) => [p.item.id, p.isGlobal])),
    ).toEqual({ s1: false, s2: true });
  });

  it('reports the newest replacements with both claims and the undo handle', () => {
    const { store } = fakeStore([
      makeItem({
        id: 'old1',
        key: 'lunch',
        value: 'ramen',
        supersededAt: 10,
        supersededBy: 'new1',
      }),
      makeItem({ id: 'new1', key: 'lunch', value: 'salad' }),
    ]);
    const out = summarizeMemory({}, store);
    expect(out.recentSupersessions).toEqual([
      { oldId: 'old1', oldKey: 'lunch', oldValue: 'ramen', newKey: 'lunch', newValue: 'salad', at: 10 },
    ]);
  });

  it('still renders a notice when the replacement has since been deleted', () => {
    // The stamp points at nothing, but the belief really was retired — reporting
    // it as absent is honest; dropping the notice would hide the retirement.
    const { store } = fakeStore([
      makeItem({ id: 'old1', key: 'lunch', value: 'ramen', supersededAt: 9, supersededBy: 'gone' }),
    ]);
    const out = summarizeMemory({}, store);
    expect(out.recentSupersessions[0]).toMatchObject({ newKey: '', newValue: '' });
  });

  it('caps the notices at five, newest first', () => {
    const many = [1, 2, 3, 4, 5, 6, 7].map((n) =>
      makeItem({ id: `o${n}`, key: `k${n}`, supersededAt: n }),
    );
    const { store } = fakeStore(many);
    const out = summarizeMemory({}, store);
    expect(out.recentSupersessions).toHaveLength(SUMMARY_SUPERSESSION_LIMIT);
    expect(out.recentSupersessions.map((s) => s.oldId)).toEqual(['o7', 'o6', 'o5', 'o4', 'o3']);
  });

  it('counts the badge from the COUNTS, not from the capped lists', () => {
    // A badge that said "3" while thirty proposals waited would be worse than no
    // badge. The fake counts every row it holds per scope, so five proposals plus
    // one notice is six waiting decisions even though only three rows are shown.
    const many = [1, 2, 3, 4, 5].map((n) =>
      makeItem({ id: `p${n}`, status: 'proposed', updatedAt: n }),
    );
    const { store } = fakeStore(many);
    const out = summarizeMemory({}, store);
    expect(out.recentProposed).toHaveLength(SUMMARY_PROPOSED_LIMIT);
    // countScopedMemory in the fake answers `items.length` for every filter, so
    // the proposal count is 5 and there are no notices.
    expect(out.pendingCount).toBe(5);
  });

  it('adds the replacement notices to the badge', () => {
    const { store } = fakeStore([
      makeItem({ id: 'o1', supersededAt: 3, supersededBy: 'x' }),
    ]);
    const out = summarizeMemory({}, store);
    // One row in the fake → the proposed count is 1, plus the one notice.
    expect(out.pendingCount).toBe(2);
  });

  it('reports when reflection last ran, and says nothing when it never has', () => {
    const withRun = summarizeMemory({}, fakeStore([], {}, 4_242).store);
    expect(withRun.lastReflectionAt).toBe(4_242);
    expect(summarizeMemory({}, fakeStore().store).lastReflectionAt).toBeUndefined();
  });

  it('asks for corroboration for both proposal lists', () => {
    const { store, calls } = fakeStore([
      makeItem({ id: 'm1', key: 'tone', status: 'proposed' }),
      makeItem({ id: 's1', key: 'style/global/x', status: 'proposed' }),
    ]);
    summarizeMemory({}, store);
    expect(calls.getMemoryCorroboration.at(-1)).toEqual(['m1', 's1']);
  });
});

describe('listScopedMemory — the key-namespace filter (settings-ia-reorg §3.4)', () => {
  it('passes the prefix to the store, on the LIST and the COUNT alike', () => {
    // One builder, both queries: a page and its total that filtered differently
    // is the "showing 12 of 40" bug the store's shared filter exists to prevent.
    const { store, calls } = fakeStore([makeItem({ key: 'style/global/x' })]);
    const res = listScopedMemory(
      { scope: 'user', scopeKey: null, status: null, keyPrefix: 'style/' },
      store,
    );
    expect(res.ok).toBe(true);
    expect(calls.getScopedMemory[0]?.opts).toMatchObject({ keyPrefix: 'style/' });
    expect(calls.countScopedMemory[0]?.opts).toMatchObject({ keyPrefix: 'style/' });
  });

  it('treats a blank prefix as no filter', () => {
    const { store, calls } = fakeStore([makeItem()]);
    listScopedMemory({ scope: 'user', scopeKey: null, status: null, keyPrefix: '   ' }, store);
    expect(calls.getScopedMemory[0]?.opts).not.toHaveProperty('keyPrefix');
  });
});

describe('runMemoryAction — edit and keepAlive (P3-M10 §3)', () => {
  it('edits a value and hands back the promoted row', () => {
    const { store, calls } = fakeStore([makeItem({ id: 'm1', value: 'old' })]);
    const res = runMemoryAction({ action: 'edit', id: 'm1', value: '  new value  ' }, store);
    expect(res).toMatchObject({ ok: true });
    if (!res.ok) return;
    // Trimmed on the way in, and the store's own promotion is what comes back.
    expect(calls.updateMemoryValue).toEqual([{ id: 'm1', value: 'new value' }]);
    expect(res.item?.provenance.source).toBe('user');
  });

  it('refuses a blank value instead of storing an empty memory', () => {
    // An empty memory is a delete performed by accident — and it would still be
    // injected, spending budget on a line that says nothing.
    const { store, calls } = fakeStore([makeItem({ id: 'm1' })]);
    for (const value of ['', '   ', undefined]) {
      const res = runMemoryAction(
        { action: 'edit', id: 'm1', value } as { action: 'edit'; id: string; value: string },
        store,
      );
      expect(res.ok).toBe(false);
    }
    expect(calls.updateMemoryValue).toEqual([]);
  });

  it('reports an unknown id rather than silently doing nothing', () => {
    const { store } = fakeStore([]);
    const res = runMemoryAction({ action: 'edit', id: 'gone', value: 'x' }, store);
    expect(res).toEqual({ ok: false, error: 'no such memory' });
  });

  it('keepAlive stamps access through the same call the injection step makes', () => {
    // "Still relevant" from a person is at least as good a signal as a retrieval
    // selecting the row, so it is deliberately the same store write (§2.1).
    const { store, calls } = fakeStore([makeItem({ id: 'm1' })]);
    expect(runMemoryAction({ action: 'keepAlive', id: 'm1' }, store)).toEqual({ ok: true });
    expect(calls.markMemoriesInjected).toEqual([['m1']]);
  });

  it('requires an id for both actions', () => {
    const { store, calls } = fakeStore([]);
    expect(runMemoryAction({ action: 'keepAlive', id: '' }, store).ok).toBe(false);
    expect(runMemoryAction({ action: 'edit', id: '', value: 'x' }, store).ok).toBe(false);
    expect(calls.markMemoriesInjected).toEqual([]);
    expect(calls.updateMemoryValue).toEqual([]);
  });
});
