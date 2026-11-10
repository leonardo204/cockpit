import { describe, expect, it } from 'vitest';
import {
  ANCHORED_MAX_ROWS,
  anchorMemory,
  DEFAULT_USER_ID,
  MEMORY_TIERS_ARCHIVE_LOG_KEY,
  MEMORY_TIERS_MIGRATED_AT_KEY,
  MemoryStore,
  type MemoryItem,
  type MemoryWriteRequest,
} from '../../../../../../../dist/naby-runtime.mjs';
import {
  memoryReviewStatus,
  recentLearned,
  replaceAnchoredMemory,
  runMemoryTidy,
  runTurnMemoryReview,
  undoMemoryAnchor,
  type MemoryReviewer,
  type MemoryReviewStore,
} from './memoryReview';
import { MEMORY_JOB_EXECUTORS, type MemoryWorkStore } from './memoryJobs';
import { listScopedMemory, runMemoryAction, summarizeMemory } from '../api/memory';
import { memoryChipView, type MemoryWrite } from '../../client/pendingMemory';

/**
 * MEMORY TIERS — the shell half of specs/memory-tiers.md: what the review does
 * around an anchored memory (R18/R19), the explicit pin (R5), the chat chips
 * (R6/R19), the tier jobs, and the memory screen's actions and summary (§6).
 * Real in-memory store, scripted reviewer — no model anywhere.
 */

const USER = DEFAULT_USER_ID;
const SESSION = 's-1';

type TestStore = MemoryStore & MemoryReviewStore & MemoryWorkStore;
function freshStore(): TestStore {
  return new MemoryStore() as unknown as TestStore;
}

function write(store: TestStore, over: Partial<MemoryWriteRequest> & { key: string; value: string }): MemoryItem {
  return store.putMemory({
    scope: 'user',
    scopeKey: USER,
    type: 'semantic',
    provenance: { source: 'artifact', sessionId: SESSION },
    confidence: 0.5,
    requestedStatus: 'confirmed',
    ...over,
  } as MemoryWriteRequest);
}

const STATED = { source: 'user' as const, sessionId: SESSION, evidenceQuote: 'remember', basisKind: 'stated' as const };

function anchored(store: TestStore, key: string, value: string): MemoryItem {
  const row = write(store, { key, value, provenance: STATED });
  expect(anchorMemory(store, row.id, 'explicit')).toBe('anchored');
  return store.getMemoryById(row.id)!;
}

/** Answers one subject (N1) with one relation to the first existing row (E1). */
function oneRelation(relation: 'contradicts' | 'refines' | 'equivalent' | null): MemoryReviewer {
  return {
    label: 'scripted',
    call: async () =>
      JSON.stringify({
        reviews: [
          { memory: 'N1', supported: 'yes', relations: relation ? [{ existing: 'E1', relation }] : [] },
        ],
      }),
  };
}

describe('R18/R19 — the review never changes an anchored memory', () => {
  it('a contradiction keeps the new memory but the anchored one wins; the chip offers to replace', async () => {
    const store = freshStore();
    const pin = anchored(store, 'tone', 'Write formally.');
    const fresh = write(store, {
      key: 'tone-2',
      value: 'Write casually.',
      provenance: STATED,
      requestedStatus: 'proposed',
      reviewState: 'pending',
    });
    const r = await runTurnMemoryReview(store, oneRelation('contradicts'), { sessionId: SESSION });
    expect(r.applied).toBe(1);
    // The anchored row is untouched; the new one is kept but retired in its favour.
    expect(store.getMemoryById(pin.id)).toMatchObject({ value: 'Write formally.', tier: 'anchored' });
    expect(store.getMemoryById(pin.id)?.supersededAt).toBeUndefined();
    expect(store.getMemoryById(fresh.id)).toMatchObject({ status: 'confirmed', supersededBy: pin.id, supersededReason: 'anchored-wins' });
    const [status] = memoryReviewStatus(store, [fresh.id]);
    expect(status).toMatchObject({ state: 'anchored-conflict', value: 'Write casually.', anchoredValue: 'Write formally.' });
    // Not something naby "started using" this week.
    expect(recentLearned(store).some((x) => x.id === fresh.id)).toBe(false);

    // "새 내용으로 바꾸기": the anchored row takes the new words and stays anchored.
    expect(replaceAnchoredMemory(store, fresh.id)).toBe(true);
    expect(store.getMemoryById(pin.id)).toMatchObject({ value: 'Write casually.', tier: 'anchored' });
    expect(store.getMemoryById(fresh.id)).toBeUndefined();
    expect(memoryReviewStatus(store, [fresh.id])[0]).toMatchObject({ state: 'anchored-conflict', replaced: true });
    expect(replaceAnchoredMemory(store, fresh.id)).toBe(false);
  });

  it('a refinement lives beside it, an equivalent folds into it without touching its words', async () => {
    const store = freshStore();
    const pin = anchored(store, 'lang', 'Answer in Korean.');
    const refine = write(store, { key: 'lang-2', value: 'Answer in polite Korean.', provenance: STATED, requestedStatus: 'proposed', reviewState: 'pending' });
    await runTurnMemoryReview(store, oneRelation('refines'), { sessionId: SESSION });
    expect(store.getMemoryById(pin.id)?.value).toBe('Answer in Korean.');
    expect(store.getMemoryById(refine.id)).toMatchObject({ status: 'confirmed' });
    expect(store.getMemoryById(refine.id)?.supersededAt).toBeUndefined();
  });

  it('the tidy pass retires the other row, never the anchored one', async () => {
    const store = freshStore();
    const pin = anchored(store, 'editor', 'Uses vim.');
    store.markMemoryReviewed([pin.id]);
    const other = write(store, { key: 'editor-2', value: 'Uses emacs.' });
    const t = await runMemoryTidy(store, oneRelation('contradicts'));
    expect(t.contradicts).toBe(1);
    expect(store.getMemoryById(pin.id)?.supersededAt).toBeUndefined();
    expect(store.getMemoryById(other.id)?.supersededBy).toBe(pin.id);
  });
});

describe('R5/R6 — an explicit pin, its chip and its undo', () => {
  it('a pin waits for the review, anchors on confirm, and the chip says so', async () => {
    const store = freshStore();
    const row = write(store, { key: 'always', value: 'Always cite sources.', provenance: STATED, requestedStatus: 'proposed', reviewState: 'pending' });
    store.setMemoryTierState(row.id, { pinRequested: true });
    await runTurnMemoryReview(store, oneRelation(null), { sessionId: SESSION });
    expect(store.getMemoryById(row.id)).toMatchObject({ tier: 'anchored', anchorOrigin: 'explicit' });
    const [status] = memoryReviewStatus(store, [row.id]);
    expect(status).toMatchObject({ state: 'anchored', origin: 'explicit', value: 'Always cite sources.' });

    expect(undoMemoryAnchor(store, row.id)).toBe(true);
    expect(store.getMemoryById(row.id)).toMatchObject({ tier: 'long', anchorBlocked: true });
    expect(memoryReviewStatus(store, [row.id])[0]).toMatchObject({ state: 'anchored', undone: true });
    expect(undoMemoryAnchor(store, row.id)).toBe(false);
  });

  it('the chip views read the two anchored states', () => {
    const write: MemoryWrite = { id: 'm', key: 'k', review: 'pending' };
    expect(memoryChipView(write, { state: 'anchored', origin: 'auto', value: 'v', summary: 's' })).toEqual({
      kind: 'anchored',
      origin: 'auto',
      value: 's',
      canUnanchor: true,
    });
    expect(memoryChipView(write, { state: 'anchored', origin: 'explicit', value: 'v', undone: true })).toEqual({ kind: 'unanchored' });
    expect(memoryChipView(write, { state: 'anchored-conflict', value: 'new', anchoredValue: 'old' })).toEqual({
      kind: 'anchored-conflict',
      anchoredValue: 'old',
      value: 'new',
      canReplace: true,
    });
    expect(memoryChipView(write, { state: 'anchored-conflict', value: 'new', anchoredValue: 'old', replaced: true })).toEqual({
      kind: 'anchored-replaced',
      value: 'new',
    });
  });
});

describe('the tier jobs (memory-worker R2: promote, archive)', () => {
  it('promote anchors three stated sessions; archive archives a stale short row and logs the day', async () => {
    const store = freshStore();
    const fact = write(store, { key: 'f', value: 'Prefers tabs.', provenance: STATED });
    for (const s of ['a', 'b', 'c']) store.corroborateMemory(fact.id, s, { stated: true });
    const now = Date.now();
    const p = await MEMORY_JOB_EXECUTORS.promote!({ store, job: { kind: 'promote', reason: 'turn', enqueuedAt: now, attempts: 0, notBefore: 0 }, reviewer: undefined, port: { call: async () => ({ text: '', label: '' }) }, now });
    expect(p.counts).toMatchObject({ anchored: 1 });
    const stale = write(store, { key: 's', value: 'Was in Berlin.' });
    const later = now + 15 * 86_400_000;
    const a = await MEMORY_JOB_EXECUTORS.archive!({ store, job: { kind: 'archive', reason: 'turn', enqueuedAt: later, attempts: 0, notBefore: 0 }, reviewer: undefined, port: { call: async () => ({ text: '', label: '' }) }, now: later });
    expect(a.counts).toMatchObject({ archived: 1 });
    expect(store.getMemoryById(stale.id)?.archivedAt).toBe(later);
    expect(store.getMemoryById(fact.id)?.archivedAt).toBeUndefined();
    expect(JSON.parse(store.getSetting(MEMORY_TIERS_ARCHIVE_LOG_KEY) ?? '[]')).toHaveLength(1);
  });
});

describe('§6 — the memory screen', () => {
  it('summary: tier counts, the anchored group, "full" candidates, the archive line, the one-time notice', () => {
    const store = freshStore();
    const pin = anchored(store, 'a', 'Pinned fact.');
    write(store, { key: 'l', value: 'Long fact.', provenance: STATED });
    write(store, { key: 's', value: 'Short fact.' });
    const cand = write(store, { key: 'c', value: 'Candidate.', provenance: STATED });
    store.setMemoryTierState(cand.id, { anchorCandidate: true });
    store.setSetting(MEMORY_TIERS_ARCHIVE_LOG_KEY, JSON.stringify([{ day: '2026-11-10', at: Date.now(), count: 4 }]));
    store.setSetting(MEMORY_TIERS_MIGRATED_AT_KEY, String(Date.now()));
    const out = summarizeMemory({}, store);
    expect(out.scopes[0]).toMatchObject({ anchored: 1, long: 2, short: 1 });
    expect(out.anchored.map((m) => m.id)).toEqual([pin.id]);
    expect(out.needsCheck.anchorFull.map((m) => m.id)).toEqual([cand.id]);
    expect(out.recentLearned.find((r) => r.kind === 'archived')).toMatchObject({ count: 4, undo: 'none' });
    expect(out.tierGraceNotice?.until).toBeGreaterThan(Date.now());
    expect(runMemoryAction({ action: 'tiers.noticeShown' }, store)).toEqual({ ok: true });
    expect(summarizeMemory({}, store).tierGraceNotice).toBeUndefined();
  });

  it('pin / unpin / restore, the archived filter and its days left', () => {
    const store = freshStore();
    const long = write(store, { key: 'l', value: 'Long fact.', provenance: STATED });
    expect(runMemoryAction({ action: 'pin', id: long.id }, store)).toMatchObject({ ok: true, item: { tier: 'anchored', anchorOrigin: 'user' } });
    expect(runMemoryAction({ action: 'unpin', id: long.id }, store)).toMatchObject({ ok: true, item: { tier: 'long' } });
    expect(runMemoryAction({ action: 'unpin', id: long.id }, store)).toMatchObject({ ok: false });

    const gone = write(store, { key: 'g', value: 'Archived fact.' });
    const at = Date.now() - 10 * 86_400_000;
    store.archiveMemory([gone.id], at);
    const listed = listScopedMemory({ scope: 'user', scopeKey: null, status: null, archived: '1' }, store);
    expect(listed.ok && listed.data.items.map((m) => m.id)).toEqual([gone.id]);
    expect(listed.ok && listed.data.daysLeft[gone.id]).toBe(20);
    const live = listScopedMemory({ scope: 'user', scopeKey: null, status: null, tier: 'long' }, store);
    expect(live.ok && live.data.items.map((m) => m.id)).toEqual([long.id]);
    expect(runMemoryAction({ action: 'restore', id: gone.id }, store)).toMatchObject({ ok: true, item: { tier: 'long' } });
    expect(runMemoryAction({ action: 'restore', id: gone.id }, store)).toMatchObject({ ok: false });
  });

  it('a pin with the anchored memory full is refused as "anchored-full"', () => {
    const store = freshStore();
    for (let i = 0; i < ANCHORED_MAX_ROWS; i += 1) anchored(store, `p${i}`, `pinned ${i}`);
    const extra = write(store, { key: 'x', value: 'One more.', provenance: STATED });
    expect(runMemoryAction({ action: 'pin', id: extra.id }, store)).toEqual({ ok: false, error: 'anchored-full' });
  });
});
