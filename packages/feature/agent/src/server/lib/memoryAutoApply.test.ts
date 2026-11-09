import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import {
  clearCredentialBridge,
  DEFAULT_USER_ID,
  installCredentialBridge,
  MemoryStore,
  retrieveForInjection,
  TIDY_BATCH_CAP,
  type MemoryItem,
  type MemoryWriteRequest,
  type ProviderProfile,
  type Store,
} from '../../../../../../../dist/naby-runtime.mjs';
import {
  answerMemoryQuestion,
  cancelLearnedMemory,
  memoryReviewStatus,
  migrateWaitingProposals,
  MEMORY_AUTO_APPLY_KEY,
  MEMORY_AUTO_APPLY_MIGRATED_KEY,
  noteQuestionCollapsed,
  openMemoryQuestions,
  runMemorySummaries,
  settleOpenMemoryQuestions,
  recentLearned,
  resolveSessionReviewBackend,
  runMemoryTidy,
  runTurnMemoryReview,
  type MemoryReviewer,
  type MemoryReviewStore,
} from './memoryReview';
import { runMemoryAction, summarizeMemory } from '../api/memory';

/**
 * MEMORY AUTO-APPLY — the shell half of specs/memory-auto-apply.md §10.
 *
 * Driven against the real in-memory store (the same `Store` contract SqliteStore
 * satisfies) with a DETERMINISTIC reviewer: it reads the prompt the runtime
 * built and answers in the agreed JSON, by handle. No model is called anywhere.
 */

const USER = DEFAULT_USER_ID;
const SESSION = 's-1';

function freshStore(): MemoryStore & MemoryReviewStore {
  return new MemoryStore() as unknown as MemoryStore & MemoryReviewStore;
}

function write(store: MemoryReviewStore, over: Partial<MemoryWriteRequest> & { key: string; value: string }): MemoryItem {
  return store.putMemory({
    scope: 'user',
    scopeKey: USER,
    type: 'semantic',
    provenance: { source: 'artifact', sessionId: SESSION },
    confidence: 0.5,
    requestedStatus: 'proposed',
    ...over,
  } as MemoryWriteRequest);
}

/** A pending write as `naby_remember` lands it for a stated, quoted fact. */
function pendingStated(store: MemoryReviewStore, key: string, value: string, quote: string): MemoryItem {
  return write(store, {
    key,
    value,
    provenance: { source: 'user', sessionId: SESSION, evidenceQuote: quote, basisKind: 'stated' },
    reviewState: 'pending',
  });
}

function confirmed(store: MemoryReviewStore, key: string, value: string, source: 'user' | 'artifact' = 'artifact'): MemoryItem {
  return write(store, { key, value, provenance: { source, sessionId: 'old' }, requestedStatus: 'confirmed' });
}

/** Find the handle the prompt gave a memory, by its value. */
function handleOf(prompt: string, value: string, kind: 'N' | 'E'): string {
  const lines = prompt.split('\n');
  if (kind === 'E') {
    const line = lines.find((l) => l.includes(value) && /^\[E\d+\]/.test(l));
    return line ? line.slice(1, line.indexOf(']')) : 'E?';
  }
  // NEW N<k> is the header; the value sits two lines below it.
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^NEW (N\d+) /.exec(lines[i]!);
    if (m && lines[i + 2]?.includes(value)) return m[1]!;
  }
  return 'N?';
}

type Rel = { newValue: string; existingValue?: string; relation?: 'equivalent' | 'refines' | 'contradicts'; supported?: 'yes' | 'no' };

/** A reviewer that answers per subject, by value, through the prompt's handles. */
function scriptedReviewer(rules: Rel[], calls: string[] = []): MemoryReviewer {
  return {
    label: 'test-model',
    async call(prompt) {
      calls.push(prompt.user);
      const reviews = rules
        .filter((r) => prompt.user.includes(r.newValue))
        .map((r) => ({
          memory: handleOf(prompt.user, r.newValue, 'N'),
          ...(r.supported ? { supported: r.supported } : {}),
          relations:
            r.existingValue && r.relation
              ? [{ existing: handleOf(prompt.user, r.existingValue, 'E'), relation: r.relation }]
              : [],
        }));
      return JSON.stringify({ reviews });
    },
  };
}

const failingReviewer: MemoryReviewer = {
  label: 'down',
  async call() {
    throw new Error('provider unreachable');
  },
};

function injected(store: Store, sessionId = SESSION): string[] {
  return retrieveForInjection(store, { sessionId, tokenBudget: 2_000 }, { userId: USER }).items.map((m) => m.value);
}

// ---------------------------------------------------------------------------
// §2a — the turn review
// ---------------------------------------------------------------------------

describe('the turn review (memory-auto-apply §2a)', () => {
  it('a remembered fact is not injected before its review, is after, and is gone once cancelled', async () => {
    const store = freshStore();
    const row = pendingStated(store, 'commit-language', 'Write commit messages in English.', '영어로 써 줘');
    expect(injected(store)).not.toContain(row.value);

    const out = await runTurnMemoryReview(store, scriptedReviewer([{ newValue: row.value, supported: 'yes' }]), {
      sessionId: SESSION,
    });
    expect(out.applied).toBe(1);
    expect(store.getMemoryById(row.id)?.status).toBe('confirmed');
    expect(injected(store)).toContain(row.value);
    // The chip's answer.
    expect(memoryReviewStatus(store, [row.id])[0]).toMatchObject({ state: 'applied' });

    expect(cancelLearnedMemory(store, row.id)).toBe(true);
    expect(store.getMemoryById(row.id)).toBeUndefined();
    expect(injected(store)).not.toContain(row.value);
    expect(memoryReviewStatus(store, [row.id])[0]).toMatchObject({ state: 'applied', undone: true });
  });

  it('the same meaning in other words adds no row (equivalent)', async () => {
    const store = freshStore();
    const old = confirmed(store, 'commit-lang', 'Commit messages are written in English.');
    const row = pendingStated(store, 'commit-language', 'Write commit messages in English.', '영어로 써 줘');
    await runTurnMemoryReview(
      store,
      scriptedReviewer([{ newValue: row.value, existingValue: old.value, relation: 'equivalent', supported: 'yes' }]),
    );
    const live = store.getScopedMemory('user', USER, { superseded: false });
    expect(live.map((m) => m.id)).toEqual([old.id]);
    // The better-sourced restatement raised the kept row (R41).
    expect(store.getMemoryById(old.id)?.provenance.source).toBe('user');
    expect(memoryReviewStatus(store, [row.id])[0]).toMatchObject({ state: 'known' });
  });

  it('supported: no keeps it proposed, in "needs checking"', async () => {
    const store = freshStore();
    const row = pendingStated(store, 'lang', 'Prefers English answers.', '한국어로 답해 줘');
    const out = await runTurnMemoryReview(store, scriptedReviewer([{ newValue: row.value, supported: 'no' }]));
    expect(out.held).toBe(1);
    const after = store.getMemoryById(row.id)!;
    expect(after.status).toBe('proposed');
    expect(after.reviewState).toBeUndefined();
    const summary = summarizeMemory({}, store as unknown as Parameters<typeof summarizeMemory>[1], Date.now());
    expect(summary.needsCheck.proposed.map((r) => [r.item.id, r.reason])).toEqual([[row.id, 'unsupported']]);
  });

  it('without a model the row stays pending, and the next turn retries it (R42)', async () => {
    const store = freshStore();
    const row = pendingStated(store, 'k', 'A fact.', '어떤 사실');
    const down = await runTurnMemoryReview(store, failingReviewer, { sessionId: SESSION });
    expect(down.failed).toBe(true);
    expect(store.getMemoryById(row.id)?.reviewState).toBe('pending');
    const none = await runTurnMemoryReview(store, undefined);
    expect(none.failed).toBe(true);
    expect(store.getMemoryById(row.id)?.reviewState).toBe('pending');
    // An unreadable answer is not an answer either.
    await runTurnMemoryReview(store, { label: 'x', call: async () => 'looks good to me' });
    expect(store.getMemoryById(row.id)?.reviewState).toBe('pending');
    // The next turn, with a model, settles it.
    await runTurnMemoryReview(store, scriptedReviewer([{ newValue: row.value, supported: 'yes' }]), { sessionId: 'other' });
    expect(store.getMemoryById(row.id)?.status).toBe('confirmed');
  });

  it('cancelling a refinement puts the previous value back', async () => {
    const store = freshStore();
    const old = confirmed(store, 'editor', 'Uses an editor.');
    const row = write(store, {
      key: 'editor-2',
      value: 'Uses Neovim with LazyVim.',
      provenance: { source: 'artifact', sessionId: SESSION, evidenceQuote: 'neovim 써', basisKind: 'inferred' },
      reviewState: 'pending',
    });
    await runTurnMemoryReview(
      store,
      scriptedReviewer([{ newValue: row.value, existingValue: old.value, relation: 'refines', supported: 'yes' }]),
    );
    expect(store.getMemoryById(old.id)?.value).toBe('Uses Neovim with LazyVim.');
    expect(store.getMemoryById(row.id)).toBeUndefined();
    expect(memoryReviewStatus(store, [row.id])[0]).toMatchObject({
      state: 'changed',
      oldValue: 'Uses an editor.',
      value: 'Uses Neovim with LazyVim.',
    });
    expect(cancelLearnedMemory(store, row.id)).toBe(true);
    expect(store.getMemoryById(old.id)?.value).toBe('Uses an editor.');
  });

  it('R17a: the user just changed their mind — the new one wins, no question, and it shows as a swap', async () => {
    const store = freshStore();
    const old = confirmed(store, 'commit-language', 'Write commit messages in English.', 'user');
    const row = pendingStated(store, 'commit-language-2', 'Write commit messages in Korean.', '한국어로 써 줘');
    await runTurnMemoryReview(
      store,
      scriptedReviewer([{ newValue: row.value, existingValue: old.value, relation: 'contradicts', supported: 'yes' }]),
    );
    expect(store.getMemoryById(row.id)?.status).toBe('confirmed');
    expect(store.getMemoryById(old.id)?.supersededBy).toBe(row.id);
    expect(store.getMemoryById(old.id)?.supersededReason).toBe('review-contradicts');
    expect(store.listMemoryQuestions({ status: 'open' })).toEqual([]);
    expect(memoryReviewStatus(store, [row.id])[0]).toMatchObject({ state: 'changed', oldValue: old.value });
    // Undo restores the old one and removes the new one.
    cancelLearnedMemory(store, row.id);
    expect(store.getMemoryById(old.id)?.supersededAt).toBeUndefined();
    expect(store.getMemoryById(row.id)).toBeUndefined();
  });

  it('R18/R21: an inference contradicting a user-tier memory replaces it without asking', async () => {
    const store = freshStore();
    const old = confirmed(store, 'tone', 'Answer politely.', 'user');
    const row = write(store, {
      key: 'tone-2',
      value: 'Answer bluntly.',
      provenance: { source: 'artifact', sessionId: SESSION, evidenceQuote: '짧게 말해', basisKind: 'inferred' },
      reviewState: 'pending',
    });
    await runTurnMemoryReview(
      store,
      scriptedReviewer([{ newValue: row.value, existingValue: old.value, relation: 'contradicts', supported: 'yes' }]),
    );
    expect(store.getMemoryById(row.id)?.status).toBe('confirmed');
    expect(store.getMemoryById(old.id)?.supersededAt).toBeDefined();
    expect(openMemoryQuestions(store)).toEqual([]);
    expect(injected(store)).toContain(row.value);
    expect(injected(store)).not.toContain(old.value);
  });

  it('memory.autoApply off: nothing is reviewed', async () => {
    const store = freshStore();
    store.setSetting(MEMORY_AUTO_APPLY_KEY, 'false');
    const row = pendingStated(store, 'k', 'A fact.', '어떤 사실');
    const calls: string[] = [];
    const out = await runTurnMemoryReview(store, scriptedReviewer([{ newValue: row.value }], calls));
    expect(out.skipped).toBe('auto-apply-off');
    expect(calls).toEqual([]);
  });

  it('R43: the review cannot relate a memory to a row it was not shown', async () => {
    const store = freshStore();
    const otherScope = write(store, {
      scope: 'project',
      scopeKey: '/p',
      key: 'p',
      value: 'Project convention.',
      requestedStatus: 'confirmed',
    });
    const row = pendingStated(store, 'k', 'A user fact.', '사용자 사실');
    await runTurnMemoryReview(store, {
      label: 'liar',
      // Names E1 — which was never issued, because the only other memory is in a
      // different scope and so is never listed for this one.
      call: async () => JSON.stringify({ reviews: [{ memory: 'N1', supported: 'yes', relations: [{ existing: 'E1', relation: 'contradicts' }] }] }),
    });
    expect(store.getMemoryById(row.id)?.status).toBe('confirmed');
    expect(store.getMemoryById(otherScope.id)?.supersededAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// R38 — the review runs on the session's own provider
// ---------------------------------------------------------------------------

describe('the review backend is the session’s own (R38)', () => {
  const AZURE: ProviderProfile = {
    id: 'azure-openai',
    label: 'Azure OpenAI',
    kind: 'azure-openai',
    config: { kind: 'azure-openai', deployment: 'gpt-4o', baseURL: 'https://example.services.ai.azure.com/openai/v1' },
    model: 'gpt-4o',
    credentialRef: 'vault:azure-openai',
  };
  const GOOGLE: ProviderProfile = {
    id: 'google',
    label: 'Google Gemini',
    kind: 'google',
    config: { kind: 'google' },
    model: 'gemini-2.5-pro',
    credentialRef: 'vault:google',
  };
  const ENV = ['NABY_PROVIDER', 'NABY_MODEL', 'NABY_ANTHROPIC_API_KEY', 'NABY_GOOGLE_API_KEY', 'NABY_AZURE_OPENAI_API_KEY', 'NABY_OPENAI_API_KEY', 'NABY_BEDROCK_API_KEY'];
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterAll(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  afterEach(() => clearCredentialBridge());

  function bridge(keyed: string[]) {
    installCredentialBridge({
      listProfiles: () => [AZURE, GOOGLE],
      getKey: (id: string) => (keyed.includes(id) ? `key-${id}` : null),
      security: () => ({ backend: 'test', secure: true, warning: null }),
    });
  }

  it('reviews on the turn’s provider AND model, not the profile default', async () => {
    bridge(['azure-openai', 'google']);
    const backend = await resolveSessionReviewBackend({ engineId: 'ai-sdk', providerId: 'google', model: 'gemini-2.5-flash' });
    expect(backend?.model).toEqual({ providerId: 'google', model: 'gemini-2.5-flash' });
  });

  it('never falls over to another provider’s key — no backend, so the review waits', async () => {
    bridge(['azure-openai']);
    const backend = await resolveSessionReviewBackend({ engineId: 'ai-sdk', providerId: 'google', model: 'gemini-2.5-pro' });
    expect(backend).toBeUndefined();
  });

  it('with the turn’s own engine factory, uses exactly that', async () => {
    let built = 0;
    const backend = await resolveSessionReviewBackend(
      { engineId: 'dev-claude', providerId: 'dev-claude', model: 'opus' },
      { makeEngine: () => { built += 1; return {} as never; } },
    );
    expect(backend?.model).toEqual({ providerId: 'dev-claude', model: 'opus' });
    backend?.engine();
    expect(built).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// §4 — the tidy pass
// ---------------------------------------------------------------------------

describe('the tidy pass (memory-auto-apply §4)', () => {
  it('works through the backlog 30 at a time', async () => {
    const store = freshStore();
    for (let i = 0; i < TIDY_BATCH_CAP + 5; i += 1) confirmed(store, `fact-${i}`, `Distinct fact number ${i}.`);
    const reviewer = scriptedReviewer([]); // no relations at all
    const first = await runMemoryTidy(store, reviewer);
    expect(first.reviewed).toBe(TIDY_BATCH_CAP);
    expect(store.listUnreviewedMemory(100)).toHaveLength(5);
    await runMemoryTidy(store, reviewer);
    expect(store.listUnreviewedMemory(100)).toHaveLength(0);
  });

  it('two memories with the same meaning become one — kept, not deleted, and revertible', async () => {
    const store = freshStore();
    const a = confirmed(store, 'units', 'Prefers metric units.');
    const b = confirmed(store, 'measurements', 'Wants measurements in metric.');
    await runMemoryTidy(store, scriptedReviewer([{ newValue: a.value, existingValue: b.value, relation: 'equivalent' }]));
    const live = store.getScopedMemory('user', USER, { superseded: false });
    expect(live).toHaveLength(1);
    const retired = [a, b].find((m) => store.getMemoryById(m.id)?.supersededAt !== undefined)!;
    expect(store.getMemoryById(retired.id)?.supersededReason).toBe('tidy-equivalent');
    // R20: no merged sentence was written.
    expect(live[0]!.value === a.value || live[0]!.value === b.value).toBe(true);
    // R29: it shows under "recently learned", and undoing it brings the row back.
    expect(recentLearned(store).map((r) => r.kind)).toContain('tidy-equivalent');
    expect(cancelLearnedMemory(store, retired.id)).toBe(true);
    expect(store.getScopedMemory('user', USER, { superseded: false })).toHaveLength(2);
  });

  it('a judged pair is not sent again; editing one side sends it again (R16)', async () => {
    const store = freshStore();
    const a = confirmed(store, 'a', 'Likes tea.');
    const b = confirmed(store, 'b', 'Works from Seoul.');
    const calls: string[] = [];
    await runMemoryTidy(store, scriptedReviewer([], calls));
    expect(calls).toHaveLength(1);
    // Both rows are now reviewed; edit one — it is backlog again, and its pair
    // with the other is stale, so it is shown again.
    store.updateMemoryValue(b.id, 'Works from Busan.', Date.now() + 1_000);
    await runMemoryTidy(store, scriptedReviewer([], calls));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('Likes tea.');
    // Untouched since: nothing left to compare, so no call at all.
    store.markMemoryReviewed([a.id]);
    await runMemoryTidy(store, scriptedReviewer([], calls));
    expect(calls).toHaveLength(2);
  });

  it('without a model nothing changes — not even reviewed_at (R22)', async () => {
    const store = freshStore();
    confirmed(store, 'a', 'Likes tea.');
    confirmed(store, 'b', 'Likes coffee.');
    const out = await runMemoryTidy(store, failingReviewer);
    expect(out.failed).toBe(true);
    expect(store.listUnreviewedMemory(10)).toHaveLength(2);
    const none = await runMemoryTidy(store, undefined);
    expect(none.skipped).toBe('no-model');
    expect(store.listUnreviewedMemory(10)).toHaveLength(2);
  });

  it('two user-tier memories that contradict: the newer stays, no question (R18)', async () => {
    const store = freshStore();
    const a = confirmed(store, 'home', 'Lives in Lisbon.', 'user');
    const b = confirmed(store, 'home-2', 'Lives in Porto.', 'user');
    await runMemoryTidy(store, scriptedReviewer([{ newValue: a.value, existingValue: b.value, relation: 'contradicts' }]));
    const retired = [a, b].filter((m) => store.getMemoryById(m.id)?.supersededAt !== undefined);
    expect(retired).toHaveLength(1);
    expect(openMemoryQuestions(store)).toEqual([]);
  });

  it('settles questions left open by earlier versions: the newer stays and it can be undone (R18)', () => {
    const store = freshStore();
    const a = confirmed(store, 'home', 'Lives in Lisbon.', 'user');
    const b = write(store, {
      key: 'home-2',
      value: 'Lives in Porto.',
      provenance: { source: 'artifact', sessionId: SESSION, basisKind: 'inferred' },
    });
    const conflict = store.putMemoryQuestion({ kind: 'conflict', aId: a.id, bId: b.id });
    expect(settleOpenMemoryQuestions(store)).toBe(1);
    expect(store.getMemoryQuestion(conflict.id)?.status).toBe('closed');
    expect([a, b].filter((m) => store.getMemoryById(m.id)?.supersededAt !== undefined)).toHaveLength(1);
    expect(openMemoryQuestions(store)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §5 — questions
// ---------------------------------------------------------------------------

describe('questions (memory-auto-apply §5)', () => {
  it('an answer keeps the chosen side on the user tier and retires the other; no ledger row', () => {
    const store = freshStore();
    const a = confirmed(store, 'tone', 'Answer politely.', 'user');
    const b = write(store, { key: 'tone-2', value: 'Answer bluntly.' }); // a held candidate
    const q = store.putMemoryQuestion({ kind: 'conflict', aId: a.id, bId: b.id });
    expect(answerMemoryQuestion(store, q.id, 'b')).toEqual({ ok: true });
    expect(store.getMemoryById(b.id)).toMatchObject({ status: 'confirmed', provenance: { source: 'user' } });
    expect(store.getMemoryById(a.id)?.supersededReason).toBe('question');
    expect(store.getMemoryQuestion(q.id)).toMatchObject({ status: 'answered', answer: 'b' });
    // R28: the trust ledger is untouched.
    expect(store.listEvalEvents('naby')).toEqual([]);
  });

  it('"keep both" is never asked again', async () => {
    const store = freshStore();
    const a = confirmed(store, 'home', 'Lives in Lisbon.', 'user');
    const b = confirmed(store, 'home-2', 'Lives in Porto.', 'user');
    const q = store.putMemoryQuestion({ kind: 'conflict', aId: a.id, bId: b.id });
    answerMemoryQuestion(store, q.id, 'both');
    expect(store.getMemoryPairVerdict(a.id, b.id)?.relation).toBe('both-valid');
    // Both rows are backlog; the tidy pass must not show this pair again.
    const calls: string[] = [];
    await runMemoryTidy(store, scriptedReviewer([{ newValue: a.value, existingValue: b.value, relation: 'contradicts' }], calls));
    expect(calls).toHaveLength(0);
    expect(openMemoryQuestions(store)).toEqual([]);
  });

  it('a refused overwrite of a user-tier memory is kept as a question (R24 case 3)', () => {
    const store = freshStore();
    const a = confirmed(store, 'editor', 'Uses Vim.', 'user');
    store.putMemoryQuestion({
      kind: 'overwrite',
      aId: a.id,
      candidate: { scope: 'user', scopeKey: USER, key: 'editor', value: 'Uses Emacs.', type: 'semantic' },
    });
    const [q] = openMemoryQuestions(store);
    expect(q).toMatchObject({ kind: 'overwrite', a: { value: 'Uses Vim.' }, b: { value: 'Uses Emacs.' } });
    answerMemoryQuestion(store, q!.id, 'b');
    expect(store.getMemoryById(a.id)?.value).toBe('Uses Emacs.');
  });

  it('"later" and two unanswered collapses snooze for a week', () => {
    const store = freshStore();
    const a = confirmed(store, 'x', 'X.', 'user');
    const b = confirmed(store, 'y', 'Y.', 'user');
    const q = store.putMemoryQuestion({ kind: 'conflict', aId: a.id, bId: b.id });
    const now = 1_000_000;
    noteQuestionCollapsed(store, q.id, now);
    expect(store.getMemoryQuestion(q.id)?.snoozedUntil).toBeUndefined();
    noteQuestionCollapsed(store, q.id, now);
    expect(store.getMemoryQuestion(q.id)?.snoozedUntil).toBe(now + 7 * 86_400_000);
    answerMemoryQuestion(store, q.id, 'later', now + 1);
    expect(store.getMemoryQuestion(q.id)?.snoozedUntil).toBe(now + 1 + 7 * 86_400_000);
    expect(store.getMemoryQuestion(q.id)?.status).toBe('open');
  });

  it('the API answers through the same function and returns the remaining queue', () => {
    const store = freshStore();
    const a = confirmed(store, 'x', 'X.', 'user');
    const b = confirmed(store, 'y', 'Y.', 'user');
    const c = confirmed(store, 'z', 'Z.', 'user');
    const q1 = store.putMemoryQuestion({ kind: 'conflict', aId: a.id, bId: b.id });
    store.putMemoryQuestion({ kind: 'conflict', aId: a.id, bId: c.id });
    const res = runMemoryAction(
      { action: 'questions.answer', id: q1.id, answer: 'a' },
      store as unknown as Parameters<typeof runMemoryAction>[1],
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.questions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// §7 — the migration
// ---------------------------------------------------------------------------

describe('the one-time migration (memory-auto-apply §7)', () => {
  it('queues young artifact proposals once; old ones and external ones stay', () => {
    const store = freshStore();
    const young = write(store, { key: 'young', value: 'Young proposal.' });
    const ext = write(store, {
      scope: 'project',
      scopeKey: '/p',
      key: 'ext',
      value: 'External proposal.',
      provenance: { source: 'external' },
    });
    // "Now" is 100 days after these were written → they are OLD.
    const later = Date.now() + 100 * 86_400_000;
    const oldStore = freshStore();
    const oldRow = write(oldStore, { key: 'old', value: 'Old proposal.' });
    expect(migrateWaitingProposals(oldStore, later)).toBe(0);
    expect(oldStore.getMemoryById(oldRow.id)?.reviewState).toBeUndefined();

    expect(migrateWaitingProposals(store)).toBe(1);
    expect(store.getMemoryById(young.id)?.reviewState).toBe('pending');
    expect(store.getMemoryById(ext.id)?.reviewState).toBeUndefined();
    expect(store.getSetting(MEMORY_AUTO_APPLY_MIGRATED_KEY)).toBeTruthy();
    // Never twice.
    write(store, { key: 'young-2', value: 'Another.' });
    expect(migrateWaitingProposals(store)).toBe(0);
  });

  it('does nothing — and is not marked done — while the switch is off', () => {
    const store = freshStore();
    store.setSetting(MEMORY_AUTO_APPLY_KEY, 'false');
    write(store, { key: 'young', value: 'Young proposal.' });
    expect(migrateWaitingProposals(store)).toBe(0);
    expect(store.getSetting(MEMORY_AUTO_APPLY_MIGRATED_KEY)).toBeUndefined();
  });

  it('the migrated batch shows as one group under "recently learned"', async () => {
    const store = freshStore();
    const young = write(store, { key: 'young', value: 'Young proposal.' });
    migrateWaitingProposals(store);
    await runTurnMemoryReview(store, scriptedReviewer([{ newValue: young.value }]));
    const rows = summarizeMemory({}, store as unknown as Parameters<typeof summarizeMemory>[1], Date.now()).recentLearned;
    expect(rows).toEqual([expect.objectContaining({ id: young.id, kind: 'applied', migrated: true })]);
  });
});

// ---------------------------------------------------------------------------
// R21/R37 — reflection proposals go through the same review, in the same sweep
// ---------------------------------------------------------------------------

import { runReflectionSweep } from './reflection';
import { REFLECTION_IDLE_MS } from '../../../../../../../dist/naby-runtime.mjs';

describe('reflection proposals are reviewed in the sweep that made them (R21, R37)', () => {
  it('a quoted proposal lands pending, the review confirms it, and the backlog is tidied', async () => {
    const store = freshStore();
    const now = Date.now();
    const session = store.createSession('test', 'reflect');
    store.appendMessage(session.sessionId, { role: 'user', content: '나는 항상 결론부터 듣고 싶어' });
    store.appendMessage(session.sessionId, { role: 'assistant', content: '알겠습니다.' });
    store.appendMessage(session.sessionId, { role: 'user', content: '그리고 표는 마크다운으로 줘' });
    const judge = async () => ({
      corrections: [],
      memories: [
        {
          scope: 'user' as const,
          type: 'procedural' as const,
          key: 'conclusion-first',
          value: 'Wants the conclusion first.',
          evidenceQuote: '항상 결론부터 듣고 싶어',
        },
      ],
    });
    const out = await runReflectionSweep(store as unknown as Parameters<typeof runReflectionSweep>[0], judge, {
      now: now + REFLECTION_IDLE_MS + 1,
      reviewer: scriptedReviewer([{ newValue: 'Wants the conclusion first.', supported: 'yes' }]),
    });
    expect(out.proposedMemories).toBe(1);
    expect(out.review?.applied).toBe(1);
    const row = store.getScopedMemory('user', USER).find((m) => m.key === 'conclusion-first');
    expect(row).toMatchObject({
      status: 'confirmed',
      provenance: { source: 'artifact', basisKind: 'inferred', evidenceQuote: '항상 결론부터 듣고 싶어' },
    });
    expect(out.tidy).toBeDefined();
  });

  it('without a reviewer the proposal simply waits for the next turn (R42)', async () => {
    const store = freshStore();
    const now = Date.now();
    const session = store.createSession('test', 'reflect');
    store.appendMessage(session.sessionId, { role: 'user', content: '나는 항상 결론부터 듣고 싶어' });
    store.appendMessage(session.sessionId, { role: 'user', content: '고마워' });
    const judge = async () => ({
      corrections: [],
      memories: [
        { scope: 'user' as const, type: 'procedural' as const, key: 'c', value: 'Conclusion first.', evidenceQuote: '결론부터 듣고 싶어' },
      ],
    });
    await runReflectionSweep(store as unknown as Parameters<typeof runReflectionSweep>[0], judge, {
      now: now + REFLECTION_IDLE_MS + 1,
    });
    expect(store.listPendingReviewMemory().map((m) => m.key)).toEqual(['c']);
  });
});

// ---------------------------------------------------------------------------
// §5a — summaries for what is asked of the user
// ---------------------------------------------------------------------------

describe('summaries (memory-auto-apply R45-R48)', () => {
  const LONG = 'The user prefers that every weekly report starts with the three open risks, then the decisions that were made, then the owners, then whatever is still waiting on someone else.';
  const held = (store: ReturnType<typeof freshStore>, key: string, value: string, source: 'artifact' | 'external') =>
    write(store, { key, value, scope: 'project', provenance: { source, sessionId: SESSION } } as Parameters<typeof write>[1]);
  const summarizer = (text: string, calls: string[] = []): MemoryReviewer => ({
    label: 'test-model',
    async call(prompt) {
      calls.push(prompt.user);
      return JSON.stringify({ summaries: [{ memory: 'M1', summary: text }] });
    },
  });

  it('writes a line for a long held memory and shows it on the chip status', async () => {
    const store = freshStore();
    const row = held(store, 'report', LONG, 'artifact');
    expect(await runMemorySummaries(store, summarizer('주간 보고는 위험 3개부터'))).toBe(1);
    expect(store.getMemoryById(row.id)?.summary).toBe('주간 보고는 위험 3개부터');
    expect(memoryReviewStatus(store, [row.id])[0]).toMatchObject({ state: 'held', summary: '주간 보고는 위험 3개부터' });
  });

  it('a value over three lines by line breaks counts; a confirmed memory counts too (R46)', async () => {
    const store = freshStore();
    const row = confirmed(store, 'steps', 'one\ntwo\nthree\nfour', 'user');
    expect(await runMemorySummaries(store, summarizer('네 단계'))).toBe(1);
    expect(store.getMemoryById(row.id)?.summary).toBe('네 단계');
  });

  it('makes no call for short values or outside content (R46)', async () => {
    const store = freshStore();
    held(store, 'short', 'Short note.', 'artifact');
    held(store, 'web', LONG, 'external');
    const calls: string[] = [];
    expect(await runMemorySummaries(store, summarizer('x', calls))).toBe(0);
    expect(calls).toEqual([]);
  });

  it('a changed value drops its summary; a failed call leaves the row alone (R48)', async () => {
    const store = freshStore();
    const row = held(store, 'report', LONG, 'artifact');
    expect(await runMemorySummaries(store, failingReviewer)).toBe(0);
    expect(store.getMemoryById(row.id)?.summary).toBeUndefined();
    await runMemorySummaries(store, summarizer('요약'));
    store.updateMemoryValue(row.id, `${LONG} Then the budget section comes last, always.`);
    expect(store.getMemoryById(row.id)?.summary).toBeUndefined();
  });
});
