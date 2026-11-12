// packages/feature/agent/src/server/lib/memoryReview.ts
//
// MEMORY AUTO-APPLY — the review, the tidy pass, the questions and the undo
// (specs/memory-auto-apply.md §2a, §3, §4, §5, §7).
//
// The runtime owns every RULE: the evidence rule (memory-gate.ts
// `decideMemoryActivation`), what a review is shown and how its answer is read
// (memory-consolidation.ts `selectReviewContext` / `buildMemoryReviewPrompt` /
// `parseMemoryReviewAnswer`), and what an answer DOES (`decideReviewOutcome`,
// `decideTidyOperation`). This file owns the four things only the shell can do:
// call a model, execute the operations against the store, remember what was done
// so it can be shown and undone, and keep the question queue.
//
// THE MODEL IS THE SESSION'S (R38). A review runs on the provider and model the
// turn that wrote the memory actually ran on — the subscription when the turn was
// a subscription turn, that key when it was a key. It never reaches for another
// provider's key: `resolveSessionReviewBackend` is pinned to one provider id, and
// with no way to reach it the review simply waits (R42) — a review that cannot be
// asked is not an answer, and a verdict is never invented.
//
// NOTHING HERE BLOCKS A TURN (R37). The review is queued after the turn's last
// event and runs in the memory process, one job at a time (memory-worker.ts,
// specs/memory-worker.md); this file is the work itself, not its scheduling.

import {
  AiSdkEngine,
  apiKeyCredential,
  CHATGPT_OAUTH_DEFAULT_MODEL,
  CHATGPT_OAUTH_LABEL,
  CHATGPT_OAUTH_PROVIDER_ID,
  getChatgptTokenSource,
  isChatgptOauthEnabled,
  buildMemoryReviewPrompt,
  buildMemorySummaryPrompt,
  MEMORY_SUMMARY_BATCH_CAP,
  MEMORY_SUMMARY_MIN_CHARS,
  MEMORY_SUMMARY_MIN_LINE_BREAKS,
  parseMemorySummaryAnswer,
  ClaudeAgentSdkEngine,
  decideReviewOutcome,
  decideTidyOperation,
  isClaudeAgentSdkAvailable,
  logActivity,
  makeModelResolver,
  parseMemoryReviewAnswer,
  resolveProviderCredential,
  selectReviewContext,
  requestMemoryPin,
  settlePinRequest,
  TIDY_BATCH_CAP,
  unanchorMemory,
  type Engine,
  type MemoryItem,
  type MemoryPairVerdict,
  type MemoryProvenance,
  type MemoryQuestion,
  type MemoryQuestionAnswer,
  type MemoryReviewSubject,
  type ModelSelection,
  type ProviderProfile,
  type ReviewRelation,
  type Store,
} from '../../../../../../../dist/naby-runtime.mjs';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** `memory.autoApply` (R8, R31) — use what naby learns without a click. Default ON. */
export const MEMORY_AUTO_APPLY_KEY = 'memory.autoApply';
/** When the one-time migration of waiting proposals ran (R34). */
export const MEMORY_AUTO_APPLY_MIGRATED_KEY = 'memory.autoApply.migratedAt';
/** The ids the migration queued, so "recent" can show them as one batch (R33). */
export const MEMORY_AUTO_APPLY_MIGRATED_IDS_KEY = 'memory.autoApply.migratedIds';
/** The review/tidy receipts — what was done, for the chat chip, "recent" and undo. */
export const MEMORY_REVIEW_RECEIPTS_KEY = 'memory.review.receipts';
/** When the question popup last raised itself (R27: once a day). */
export const MEMORY_QUESTION_LAST_AUTO_SHOWN_KEY = 'memory.questions.lastAutoShownAt';

/** A review waiting this long is shown in "needs checking" (R42). */
export const PENDING_REVIEW_STALE_MS = 24 * 60 * 60_000;
/** "Recently learned" reaches back this far (R29). */
export const RECENT_LEARNED_MS = 7 * 24 * 60 * 60_000;
/** The migration moves proposals younger than this (R33). */
export const MIGRATION_WINDOW_MS = 90 * 24 * 60 * 60_000;
/** "Later", or two unanswered collapses, snooze a question this long (R27). */
export const QUESTION_SNOOZE_MS = 7 * 24 * 60 * 60_000;
/** Pending rows one review call looks at. */
export const REVIEW_BATCH_CAP = 20;
/** How long one review call may take before it is abandoned (it stays pending). */
export const MEMORY_REVIEW_TIMEOUT_MS = 60_000;
/** Receipts older than this, or beyond the newest `RECEIPT_CAP`, are dropped. */
const RECEIPT_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const RECEIPT_CAP = 300;

type SettingsStore = Pick<Store, 'getSetting' | 'setSetting'>;

/** Read `memory.autoApply`. Absent or malformed reads as ON (R8 default); only the
 *  literal `'false'` turns it off. */
export function readAutoApplySetting(store: Pick<Store, 'getSetting'>): boolean {
  try {
    return store.getSetting(MEMORY_AUTO_APPLY_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function writeAutoApplySetting(store: SettingsStore, enabled: boolean): void {
  store.setSetting(MEMORY_AUTO_APPLY_KEY, enabled ? 'true' : 'false');
}

// ---------------------------------------------------------------------------
// Receipts — what a review or a tidy pass did, kept so it can be shown and undone
// ---------------------------------------------------------------------------

/**
 * One thing a review or tidy pass did (R10, R29).
 *
 * WHY A RECEIPT AND NOT A COLUMN. Two of the outcomes leave no row to read:
 * `known` deletes the new row (the claim already existed, R41) and `refined`
 * overwrites the old value in place. The chat chip still has to say "이미 알고
 * 있어요" / "기억을 바꿨어요: A → B", and the undo has to put A back. So the
 * outcome is written down when it happens, keyed by the memory the chip knows —
 * the id `naby_remember` returned.
 */
export type MemoryReceiptKind =
  | 'applied' // confirmed as written
  | 'known' // the same claim already existed; folded into it (R41 equivalent)
  | 'refined' // the existing row took the new value (R41 refines)
  | 'changed' // the new row retired the old one (R17/R17a)
  | 'held' // the review said the quote does not back the value (R41 supported:no)
  | 'question' // R18/R21: the user will be asked
  | 'tidy-equivalent'
  | 'tidy-refines'
  | 'tidy-contradicts'
  /** memory-tiers R19: the new memory contradicted an anchored one — kept, but
   *  the anchored row wins until the user presses "replace". */
  | 'anchored-conflict';

export type MemoryReceipt = {
  /** The id the chip/row addresses: the reviewed row (review) or the retired row (tidy). */
  id: string;
  kind: MemoryReceiptKind;
  /** The row that now holds the claim. */
  memoryId: string;
  key: string;
  value: string;
  /** The other row involved (merged into, refined, retired). */
  otherId?: string;
  /** The other row's value before (refined / changed / tidy). */
  oldValue?: string;
  /** For `refined`: what to restore on undo. */
  previous?: { value: string; provenance: MemoryProvenance };
  at: number;
  /** The migration batch (R33). */
  migrated?: boolean;
  undone?: boolean;
  /** memory-tiers R19: the user replaced the anchored value with this one. */
  replaced?: boolean;
};

export function readReceipts(store: Pick<Store, 'getSetting'>): MemoryReceipt[] {
  try {
    const raw = store.getSetting(MEMORY_REVIEW_RECEIPTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed.filter((r) => r && typeof r === 'object') as MemoryReceipt[]) : [];
  } catch {
    return [];
  }
}

function writeReceipts(store: SettingsStore, receipts: readonly MemoryReceipt[], now: number): void {
  const kept = receipts
    .filter((r) => now - r.at <= RECEIPT_MAX_AGE_MS)
    .slice(-RECEIPT_CAP);
  store.setSetting(MEMORY_REVIEW_RECEIPTS_KEY, JSON.stringify(kept));
}

function addReceipts(store: SettingsStore, added: readonly MemoryReceipt[], now: number): void {
  if (added.length === 0) return;
  const migrated = readMigratedIds(store);
  const byId = new Map(readReceipts(store).map((r) => [r.id, r]));
  for (const r of added) byId.set(r.id, migrated.has(r.id) ? { ...r, migrated: true } : r);
  writeReceipts(store, [...byId.values()].sort((a, b) => a.at - b.at), now);
}

function readMigratedIds(store: Pick<Store, 'getSetting'>): Set<string> {
  try {
    const raw = store.getSetting(MEMORY_AUTO_APPLY_MIGRATED_IDS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// The reviewer — one model call, on the session's own provider (R38)
// ---------------------------------------------------------------------------

/** One review call: prompt in, raw text out. THROWS when it cannot be made. */
export type MemoryReviewer = {
  call(prompt: { system: string; user: string }): Promise<string>;
  /** Which backend/model answered, for the activity log (R23). */
  label: string;
};

/** What a review call runs on. `engine` is a FACTORY: a review can overlap the
 *  next turn, and an engine instance is not shared between concurrent runs. */
export type ReviewBackend = {
  engine: () => Engine;
  model: ModelSelection;
  label: string;
};

/** The turn a review is pinned to (R38). */
export type SessionTurnModel = {
  engineId: string;
  providerId: string;
  model?: string;
  /** dev-claude only: which subscription the turn ran on. */
  accountId?: string;
};

/**
 * The backend for a session's review (R38) — the turn's own provider and model.
 *
 * `makeEngine` is the turn's own engine factory when the caller has one (the
 * engine adapter always does): the review then runs on exactly what the turn ran
 * on, whichever of the five engine branches built it. Without one, the backend is
 * resolved from the turn's descriptor, PINNED:
 *
 *   * a subscription turn (`dev-claude`) reviews on the Claude Agent SDK, on the
 *     same account, or not at all;
 *   * a key turn reviews on THAT provider's key (`resolveProviderCredential` with
 *     the provider id filters both the vault and the env fallback to it), with
 *     the turn's model, or not at all.
 *
 * NEVER ANOTHER PROVIDER. `resolveJudgeBackend`'s rule is "the chosen provider,
 * else the subscription"; a review is narrower still — the subscription fallback
 * would be a different model than the one the user is talking to, and R38 asks
 * for that model. Undefined means the review waits (R42).
 */
export async function resolveSessionReviewBackend(
  turn: SessionTurnModel,
  opts: { makeEngine?: () => Engine } = {},
): Promise<ReviewBackend | undefined> {
  const model: ModelSelection = { providerId: turn.providerId, ...(turn.model ? { model: turn.model } : {}) };
  if (opts.makeEngine) {
    return { engine: opts.makeEngine, model, label: `${turn.engineId} (${turn.providerId}${turn.model ? ` ${turn.model}` : ''})` };
  }
  if (turn.engineId === 'dev-claude') {
    if (!isClaudeAgentSdkAvailable()) return undefined;
    return {
      // Toolless: the review is answered in one text reply (R38 keeps the model).
      engine: () =>
        new ClaudeAgentSdkEngine({ toolless: true, ...(turn.accountId ? { accountId: turn.accountId } : {}) }),
      model,
      label: `claude-agent-sdk (subscription${turn.model ? ` ${turn.model}` : ''})`,
    };
  }
  // THE CHATGPT SUBSCRIPTION, rebuilt from the descriptor the same way the
  // engine's own branch builds it (engines/naby.ts): the token SOURCE the Electron
  // main process installed, never a key. Needed since the review left the turn's
  // closure for the memory queue (memory-worker R6) — the descriptor is all that
  // travels, so every engine branch must be rebuildable from it.
  if (turn.providerId === CHATGPT_OAUTH_PROVIDER_ID) {
    const source = isChatgptOauthEnabled() ? getChatgptTokenSource() : undefined;
    if (!source) return undefined;
    const chatgptModel = turn.model ?? CHATGPT_OAUTH_DEFAULT_MODEL;
    const profile: ProviderProfile = {
      id: CHATGPT_OAUTH_PROVIDER_ID,
      label: CHATGPT_OAUTH_LABEL,
      kind: 'openai-chatgpt-oauth',
      config: { kind: 'openai-chatgpt-oauth' },
      model: chatgptModel,
      credentialRef: 'chatgpt-oauth',
    };
    const base = makeModelResolver([profile], () => ({ kind: 'chatgpt-oauth', source }));
    return {
      engine: () => new AiSdkEngine({ resolveModel: (s) => base(s.providerId, s.model) }),
      model: { providerId: CHATGPT_OAUTH_PROVIDER_ID, model: chatgptModel },
      label: `ai-sdk (chatgpt subscription ${chatgptModel})`,
    };
  }
  const resolution = await resolveProviderCredential({ providerId: turn.providerId });
  if (!resolution.ok || resolution.value.profile.id !== turn.providerId) return undefined;
  const { profile, apiKey } = resolution.value;
  const base = makeModelResolver([profile], () => apiKeyCredential(apiKey));
  return {
    engine: () => new AiSdkEngine({ resolveModel: (s) => base(s.providerId, s.model) }),
    model: { providerId: profile.id, model: turn.model ?? profile.model },
    label: `ai-sdk (${profile.id} ${turn.model ?? profile.model})`,
  };
}

/** Drive a backend for one strict-JSON answer: no tools, a deny-all gate, a
 *  timeout. The same shape as the reflection judge — the review leaves no trace
 *  in any transcript. */
export function engineReviewer(
  backend: ReviewBackend,
  opts: { timeoutMs?: number } = {},
): MemoryReviewer {
  const timeoutMs = opts.timeoutMs ?? MEMORY_REVIEW_TIMEOUT_MS;
  return {
    label: backend.label,
    async call(prompt) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let answer = '';
      try {
        for await (const event of backend.engine().run({
          model: backend.model,
          messages: [{ role: 'user', content: prompt.user }],
          system: prompt.system,
          toolSchemas: [],
          gate: async () => ({ behavior: 'deny' as const, reason: 'the memory review runs without tools' }),
          executors: {},
          signal: controller.signal,
        })) {
          if (event.kind === 'text' && event.role === 'assistant' && !event.partial) answer += event.text;
          if (event.kind === 'error') throw new Error(event.message);
        }
      } finally {
        clearTimeout(timer);
      }
      return answer;
    },
  };
}

// ---------------------------------------------------------------------------
// The store slice
// ---------------------------------------------------------------------------

export type MemoryReviewStore = Pick<
  Store,
  | 'getSetting'
  | 'setSetting'
  | 'getScopedMemory'
  | 'getMemoryById'
  | 'deleteMemory'
  | 'corroborateMemory'
  | 'confirmMemory'
  | 'updateMemoryValue'
  | 'supersedeMemory'
  | 'revertSupersession'
  | 'putMemory'
  | 'listPendingReviewMemory'
  | 'settleMemoryReview'
  | 'markMemoryReviewed'
  | 'listMemoryToSummarize'
  | 'setMemorySummary'
  | 'listUnreviewedMemory'
  | 'reviseMemoryValue'
  | 'patchMemoryProvenance'
  | 'absorbMemoryEvidence'
  | 'queueProposedForReview'
  | 'getMemoryPairVerdict'
  | 'putMemoryPairVerdict'
  | 'putMemoryQuestion'
  | 'getMemoryQuestion'
  | 'listMemoryQuestions'
  | 'updateMemoryQuestion'
  // memory-tiers: pins settle when a review confirms (R5), and the chips' undo
  // and "replace" act on the anchored row (R6, R19).
  | 'setMemoryTierState'
  | 'listTieredMemory'
>;

/** Has the user said "keep both" about this pair (R26)? Never re-asked. */
function keptBoth(store: MemoryReviewStore, a: MemoryItem, b: MemoryItem): boolean {
  try {
    return store.getMemoryPairVerdict(a.id, b.id)?.relation === 'both-valid';
  } catch {
    return false;
  }
}

/** A stored verdict still describes this pair: both sides unchanged since (R16). */
function settledPair(store: MemoryReviewStore, a: MemoryItem, b: MemoryItem): boolean {
  let v: MemoryPairVerdict | undefined;
  try {
    v = store.getMemoryPairVerdict(a.id, b.id);
  } catch {
    return false;
  }
  if (!v) return false;
  if (v.relation === 'both-valid') return true;
  return v.aUpdatedAt === a.updatedAt && v.bUpdatedAt === b.updatedAt;
}

/** The in-use rows of one scope key — what a subject is compared with. */
function scopePool(store: MemoryReviewStore, item: MemoryItem): MemoryItem[] {
  try {
    return store.getScopedMemory(item.scope, item.scopeKey, { status: 'confirmed', superseded: false });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The turn review (§2a)
// ---------------------------------------------------------------------------

export type MemoryReviewResult = {
  /** Pending rows put before the model. */
  reviewed: number;
  applied: number;
  merged: number;
  refined: number;
  superseded: number;
  held: number;
  questions: number;
  /** Rows left pending (no answer for them, or the call failed). */
  waiting: number;
  /** The call could not be made or its answer was unreadable (R42). */
  failed: boolean;
  skipped?: 'auto-apply-off' | 'nothing-pending';
};

const emptyReview = (): MemoryReviewResult => ({
  reviewed: 0,
  applied: 0,
  merged: 0,
  refined: 0,
  superseded: 0,
  held: 0,
  questions: 0,
  waiting: 0,
  failed: false,
});

/**
 * Review the rows waiting since the last turn (R36–R43). ONE model call.
 *
 * `sessionId` puts the session that just ended first; rows from elsewhere that an
 * earlier review could not finish ride along (R42), up to `REVIEW_BATCH_CAP`.
 *
 * NEVER THROWS. A reviewer that throws, or answers with something unreadable,
 * leaves every row pending and returns `failed: true`; a row the answer leaves
 * out stays pending too. Nothing is ever confirmed on a missing answer.
 */
export async function runTurnMemoryReview(
  store: MemoryReviewStore,
  reviewer: MemoryReviewer | undefined,
  opts: { sessionId?: string; now?: number } = {},
): Promise<MemoryReviewResult> {
  const result = emptyReview();
  const now = opts.now ?? Date.now();
  if (!readAutoApplySetting(store)) return { ...result, skipped: 'auto-apply-off' };

  let pending: MemoryItem[];
  try {
    pending = store.listPendingReviewMemory({
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      limit: REVIEW_BATCH_CAP,
    });
  } catch {
    return { ...result, failed: true };
  }
  if (pending.length === 0) return { ...result, skipped: 'nothing-pending' };
  if (!reviewer) return { ...result, waiting: pending.length, failed: true };

  const subjects: MemoryReviewSubject[] = pending.map((item) => ({
    item,
    context: selectReviewContext(item, scopePool(store, item), { skip: (other) => keptBoth(store, item, other) }),
    askSupported: Boolean(item.provenance.evidenceQuote),
  }));
  const prompt = buildMemoryReviewPrompt(subjects);

  let verdicts: ReturnType<typeof parseMemoryReviewAnswer>;
  try {
    verdicts = parseMemoryReviewAnswer(await reviewer.call(prompt), prompt);
  } catch (e) {
    console.warn(`[memory-review] review not made: ${e instanceof Error ? e.message : String(e)}`);
    verdicts = undefined;
  }
  if (!verdicts) {
    logActivity('memory_review', { kind: 'turn', failed: true, waiting: pending.length, model: reviewer.label });
    return { ...result, waiting: pending.length, failed: true };
  }

  const receipts: MemoryReceipt[] = [];
  for (const subject of subjects) {
    const verdict = verdicts.get(subject.item.id);
    if (!verdict) {
      result.waiting += 1;
      continue;
    }
    // Re-read: the user may have cancelled it while the model was thinking.
    const item = store.getMemoryById(subject.item.id);
    if (!item || item.reviewState !== 'pending') continue;
    result.reviewed += 1;
    try {
      const receipt = applyReviewOutcome(store, item, verdict, now, result);
      if (receipt) receipts.push(receipt);
    } catch (e) {
      console.warn(`[memory-review] "${item.key}" not settled: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  addReceipts(store, receipts, now);
  // R23: counts and the model — never a memory's text.
  logActivity('memory_review', {
    kind: 'turn',
    reviewed: result.reviewed,
    applied: result.applied,
    merged: result.merged,
    refined: result.refined,
    superseded: result.superseded,
    held: result.held,
    questions: result.questions,
    waiting: result.waiting,
    model: reviewer.label,
  });
  return result;
}

/** Execute one `decideReviewOutcome` answer (R41). Returns its receipt. */
function applyReviewOutcome(
  store: MemoryReviewStore,
  item: MemoryItem,
  verdict: Parameters<typeof decideReviewOutcome>[1],
  now: number,
  result: MemoryReviewResult,
): MemoryReceipt | undefined {
  // The target may have moved on since the prompt was built.
  const outcome = decideReviewOutcome(item, verdict);
  const base = { id: item.id, key: item.key, value: item.value, at: now };
  switch (outcome.op) {
    case 'hold':
      store.settleMemoryReview(item.id, { status: 'proposed', at: now });
      result.held += 1;
      return { ...base, kind: 'held', memoryId: item.id };

    case 'confirm':
      store.settleMemoryReview(item.id, { status: 'confirmed', at: now });
      // memory-tiers R5: an explicit pin waited for exactly this moment.
      settlePin(store, item.id, now);
      result.applied += 1;
      return { ...base, kind: 'applied', memoryId: item.id };

    case 'anchored-wins': {
      // memory-tiers R19: the new memory is KEPT (confirmed) but loses to the
      // anchored row — retired in its favour, so injection never carries both.
      // The chip offers "replace" (`replaceAnchoredMemory`); nothing is asked.
      store.settleMemoryReview(item.id, { status: 'confirmed', at: now });
      store.setMemoryTierState(item.id, { pinRequested: false });
      store.supersedeMemory(item.id, outcome.target.id, now, 'anchored-wins');
      result.applied += 1;
      return {
        ...base,
        kind: 'anchored-conflict',
        memoryId: item.id,
        otherId: outcome.target.id,
        oldValue: outcome.target.value,
      };
    }

    case 'merge': {
      const target = store.getMemoryById(outcome.target.id);
      if (!target || target.supersededAt !== undefined) {
        store.settleMemoryReview(item.id, { status: 'confirmed', at: now });
        result.applied += 1;
        return { ...base, kind: 'applied', memoryId: item.id };
      }
      if (item.provenance.sessionId) store.corroborateMemory(target.id, item.provenance.sessionId);
      if (outcome.upgrade) {
        store.patchMemoryProvenance(target.id, {
          source: item.provenance.source,
          ...(item.provenance.evidenceQuote ? { evidenceQuote: item.provenance.evidenceQuote } : {}),
          ...(item.provenance.basisKind ? { basisKind: item.provenance.basisKind } : {}),
        });
      }
      // memory-tiers R5: a pin asked for the same claim goes to the row holding it.
      const pinWanted = item.pinRequested === true;
      // No new row (R41): the claim already lives in `target`.
      store.deleteMemory({ id: item.id });
      if (pinWanted) requestMemoryPin(store, target.id, now);
      result.merged += 1;
      return { ...base, kind: 'known', memoryId: target.id, otherId: target.id, value: target.value };
    }

    case 'refine': {
      const target = store.getMemoryById(outcome.target.id);
      if (!target || target.supersededAt !== undefined) {
        store.settleMemoryReview(item.id, { status: 'confirmed', at: now });
        result.applied += 1;
        return { ...base, kind: 'applied', memoryId: item.id };
      }
      store.reviseMemoryValue(target.id, item.value, { ...item.provenance }, now);
      const pinWanted = item.pinRequested === true;
      store.deleteMemory({ id: item.id });
      if (pinWanted) requestMemoryPin(store, target.id, now);
      result.refined += 1;
      return {
        ...base,
        kind: 'refined',
        memoryId: target.id,
        otherId: target.id,
        oldValue: target.value,
        previous: { value: target.value, provenance: { ...target.provenance } },
      };
    }

    case 'supersede': {
      store.settleMemoryReview(item.id, { status: 'confirmed', at: now });
      settlePin(store, item.id, now);
      const stamped = store.supersedeMemory(outcome.target.id, item.id, now, 'review-contradicts');
      if (!stamped) {
        result.applied += 1;
        return { ...base, kind: 'applied', memoryId: item.id };
      }
      result.superseded += 1;
      return { ...base, kind: 'changed', memoryId: item.id, otherId: outcome.target.id, oldValue: outcome.target.value };
    }
  }
  return undefined;
}

/** Act on a pin request a just-confirmed row carried (memory-tiers R5). Never
 *  throws: a pin that cannot land leaves an ordinary memory. */
function settlePin(store: MemoryReviewStore, id: string, now: number): void {
  try {
    settlePinRequest(store, id, now);
  } catch (e) {
    console.warn(`[memory-review] pin not settled: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// The tidy pass (§4)
// ---------------------------------------------------------------------------

export type MemoryTidyResult = {
  /** Backlog rows compared and stamped `reviewed_at`. */
  reviewed: number;
  equivalent: number;
  refines: number;
  contradicts: number;
  questions: number;
  failed: boolean;
  skipped?: 'auto-apply-off' | 'nothing-to-tidy' | 'no-model';
};

/**
 * Compare up to `TIDY_BATCH_CAP` backlog rows with their scopes (R14–R23). ONE
 * call. A pair already judged with both sides unchanged is not shown again
 * (R16); every pair that WAS shown is recorded, related or not. Supersession
 * never deletes (R19) and no merged sentence is written (R20).
 *
 * NO MODEL, NO CHANGE (R22): an unavailable reviewer or an unreadable answer
 * leaves everything — including `reviewed_at` — exactly as it was.
 */
export async function runMemoryTidy(
  store: MemoryReviewStore,
  reviewer: MemoryReviewer | undefined,
  opts: { now?: number } = {},
): Promise<MemoryTidyResult> {
  const result: MemoryTidyResult = {
    reviewed: 0,
    equivalent: 0,
    refines: 0,
    contradicts: 0,
    questions: 0,
    failed: false,
  };
  const now = opts.now ?? Date.now();
  if (!readAutoApplySetting(store)) return { ...result, skipped: 'auto-apply-off' };
  let backlog: MemoryItem[];
  try {
    backlog = store.listUnreviewedMemory(TIDY_BATCH_CAP);
  } catch {
    return { ...result, failed: true };
  }
  if (backlog.length === 0) return { ...result, skipped: 'nothing-to-tidy' };
  if (!reviewer) return { ...result, skipped: 'no-model' };

  const batchIndex = new Map(backlog.map((m, i) => [m.id, i]));
  const subjects: MemoryReviewSubject[] = backlog.map((item, index) => ({
    item,
    context: selectReviewContext(item, scopePool(store, item), {
      skip: (other) => {
        // A pair inside this batch is asked once, from its earlier member.
        const j = batchIndex.get(other.id);
        if (j !== undefined && j < index) return true;
        return settledPair(store, item, other);
      },
    }),
    askSupported: false,
  }));
  // Nothing to compare at all (a lone row, or every pair already settled): the
  // rows have been looked at as far as there is anything to look at.
  const toAsk = subjects.filter((s) => s.context.length > 0);
  const nothingToAsk = subjects.filter((s) => s.context.length === 0);
  if (toAsk.length === 0) {
    store.markMemoryReviewed(nothingToAsk.map((s) => s.item.id), now);
    return { ...result, reviewed: nothingToAsk.length };
  }

  const prompt = buildMemoryReviewPrompt(toAsk);
  let verdicts: ReturnType<typeof parseMemoryReviewAnswer>;
  try {
    verdicts = parseMemoryReviewAnswer(await reviewer.call(prompt), prompt);
  } catch (e) {
    console.warn(`[memory-review] tidy not made: ${e instanceof Error ? e.message : String(e)}`);
    verdicts = undefined;
  }
  if (!verdicts) {
    logActivity('memory_review', { kind: 'tidy', failed: true, model: reviewer.label });
    return { ...result, failed: true };
  }

  const receipts: MemoryReceipt[] = [];
  const stamped: string[] = nothingToAsk.map((s) => s.item.id);
  for (const subject of toAsk) {
    // A subject a READABLE answer leaves out is read as "related to nothing".
    // Unlike the turn review — where an omitted subject waits, because a missing
    // answer must never confirm a new memory (R42) — nothing here is confirmed
    // by an omission: "unrelated" is the operation that changes nothing, and
    // waiting instead would re-send the same rows to a model that answers that
    // way on every sweep.
    const verdict = verdicts.get(subject.item.id) ?? { relations: [] };
    const related = new Map(verdict.relations.map((r) => [r.existing.id, r.relation]));
    for (const other of subject.context) {
      const relation: ReviewRelation | 'unrelated' = related.get(other.id) ?? 'unrelated';
      // Re-read both sides: an earlier pair in this pass may have retired one.
      const a = store.getMemoryById(subject.item.id);
      const b = store.getMemoryById(other.id);
      if (!a || !b) continue;
      store.putMemoryPairVerdict({
        aId: a.id,
        bId: b.id,
        aUpdatedAt: a.updatedAt,
        bUpdatedAt: b.updatedAt,
        relation,
        judgedAt: now,
      });
      if (a.supersededAt !== undefined || b.supersededAt !== undefined) continue;
      const op = decideTidyOperation(a, b, relation);
      if (op.op === 'supersede') {
        if (!store.supersedeMemory(op.retire.id, op.keep.id, now, op.reason)) continue;
        if (op.reason === 'tidy-equivalent') store.absorbMemoryEvidence(op.retire.id, op.keep.id);
        if (op.reason === 'tidy-equivalent') result.equivalent += 1;
        else if (op.reason === 'tidy-refines') result.refines += 1;
        else result.contradicts += 1;
        receipts.push({
          id: op.retire.id,
          kind: op.reason,
          memoryId: op.keep.id,
          key: op.keep.key,
          value: op.keep.value,
          otherId: op.retire.id,
          oldValue: op.retire.value,
          at: now,
        });
      }
    }
    stamped.push(subject.item.id);
  }
  store.markMemoryReviewed(stamped, now);
  result.reviewed = stamped.length;
  addReceipts(store, receipts, now);
  logActivity('memory_review', {
    kind: 'tidy',
    reviewed: result.reviewed,
    equivalent: result.equivalent,
    refines: result.refines,
    contradicts: result.contradicts,
    questions: result.questions,
    model: reviewer.label,
  });
  return result;
}

// ---------------------------------------------------------------------------
// Summaries for long memories (R45-R48)
// ---------------------------------------------------------------------------

/**
 * Write the short line for values taller than three lines. No call when nothing needs
 * one; without a model or a readable answer the row keeps showing its own text
 * and the next pass tries again. Returns how many were written. Never throws.
 */
export async function runMemorySummaries(
  store: MemoryReviewStore,
  reviewer: MemoryReviewer | undefined,
): Promise<number> {
  if (!reviewer) return 0;
  try {
    const items = store.listMemoryToSummarize(
      MEMORY_SUMMARY_BATCH_CAP,
      MEMORY_SUMMARY_MIN_CHARS,
      MEMORY_SUMMARY_MIN_LINE_BREAKS,
    );
    if (items.length === 0) return 0;
    const prompt = buildMemorySummaryPrompt(items);
    const answer = parseMemorySummaryAnswer(await reviewer.call(prompt), prompt);
    let written = 0;
    for (const item of items) {
      const summary = answer?.get(item.id);
      // Re-read: a summary of words the row no longer says must not land.
      if (summary && store.getMemoryById(item.id)?.value === item.value) {
        store.setMemorySummary(item.id, summary);
        written += 1;
      }
    }
    logActivity('memory_review', { kind: 'summary', asked: items.length, written, model: reviewer.label });
    return written;
  } catch (e) {
    console.warn(`[memory-review] summaries not made: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// What the chat chip shows (R10/R11), and the undo
// ---------------------------------------------------------------------------

export type MemoryReviewStatus =
  | { id: string; state: 'pending' }
  | { id: string; state: 'held'; reason?: string; summary?: string }
  | { id: string; state: 'applied'; value: string; summary?: string; undone?: boolean }
  | { id: string; state: 'known'; value: string }
  | { id: string; state: 'changed'; value: string; oldValue: string; summary?: string; oldSummary?: string; undone?: boolean }
  | { id: string; state: 'question' }
  | { id: string; state: 'gone' }
  /** memory-tiers R6: the memory this chip is about is now anchored — `explicit`
   *  ("고정했어요") or `auto` ("자주 말씀하신 걸 고정했어요"). `undone` = the
   *  user took the anchoring back from this chip. */
  | { id: string; state: 'anchored'; origin: 'explicit' | 'auto'; value: string; summary?: string; undone?: boolean }
  /** memory-tiers R19: the new memory disagreed with an anchored one, which
   *  wins. `replaced` = the user pressed "새 내용으로 바꾸기". */
  | {
      id: string;
      state: 'anchored-conflict';
      value: string;
      anchoredValue: string;
      anchoredSummary?: string;
      replaced?: boolean;
    };

/**
 * memory-tiers R6: the anchored overlay of a chip. The row that now holds the
 * chip's claim (`holderId`) was anchored by naby AFTER the chip's write (`since`)
 * — so the chip is where the user learns of it, with the undo beside it. An
 * anchoring the user undid from a chip reads as `undone` on the chips after it.
 */
function anchoredOverlay(
  store: MemoryReviewStore,
  id: string,
  holderId: string,
  since: number,
): MemoryReviewStatus | undefined {
  const holder = store.getMemoryById(holderId);
  if (!holder) return undefined;
  const at = holder.tierSince ?? 0;
  if (at < since) return undefined;
  if (holder.tier === 'anchored' && (holder.anchorOrigin === 'explicit' || holder.anchorOrigin === 'auto')) {
    return {
      id,
      state: 'anchored',
      origin: holder.anchorOrigin,
      value: holder.value,
      ...(holder.summary ? { summary: holder.summary } : {}),
    };
  }
  if (holder.tier === 'long' && holder.anchorBlocked) {
    return { id, state: 'anchored', origin: 'auto', value: holder.value, undone: true };
  }
  return undefined;
}

/** The state of each memory a `naby_remember` call wrote, for its chip. */
export function memoryReviewStatus(store: MemoryReviewStore, ids: readonly string[]): MemoryReviewStatus[] {
  const receipts = new Map(readReceipts(store).map((r) => [r.id, r]));
  const summaryOf = (key: 'summary' | 'oldSummary', memoryId: string | undefined) => {
    const summary = memoryId ? store.getMemoryById(memoryId)?.summary : undefined;
    return summary ? { [key]: summary } : {};
  };
  return ids.slice(0, 50).map((id): MemoryReviewStatus => {
    const receipt = receipts.get(id);
    // memory-tiers R6: an anchoring after this chip's write is what it shows.
    if (receipt && !receipt.undone && receipt.kind !== 'anchored-conflict' && receipt.kind !== 'held') {
      const overlay = anchoredOverlay(store, id, receipt.memoryId, receipt.at);
      if (overlay) return overlay;
    } else if (!receipt) {
      const row = store.getMemoryById(id);
      if (row && row.reviewState === undefined && row.status === 'confirmed') {
        const overlay = anchoredOverlay(store, id, id, row.createdAt);
        if (overlay) return overlay;
      }
    }
    if (receipt) {
      switch (receipt.kind) {
        case 'anchored-conflict': {
          const anchored = receipt.otherId ? store.getMemoryById(receipt.otherId) : undefined;
          return {
            id,
            state: 'anchored-conflict',
            value: receipt.value,
            anchoredValue: anchored && !receipt.replaced ? anchored.value : (receipt.oldValue ?? ''),
            ...(anchored?.summary && !receipt.replaced ? { anchoredSummary: anchored.summary } : {}),
            ...(receipt.replaced ? { replaced: true } : {}),
          };
        }
        case 'known':
          return { id, state: 'known', value: receipt.value };
        case 'refined':
        case 'changed':
          return {
            id,
            state: 'changed',
            value: receipt.value,
            oldValue: receipt.oldValue ?? '',
            ...summaryOf('summary', receipt.memoryId),
            // A refinement rewrote the old row in place, so its old words have no row.
            ...(receipt.kind === 'changed' ? summaryOf('oldSummary', receipt.otherId) : {}),
            ...(receipt.undone ? { undone: true } : {}),
          };
        case 'held': {
          const summary = store.getMemoryById(id)?.summary;
          return { id, state: 'held', reason: 'unsupported', ...(summary ? { summary } : {}) };
        }
        case 'question':
          return { id, state: 'question' };
        case 'applied':
          return {
            id,
            state: 'applied',
            value: receipt.value,
            ...summaryOf('summary', receipt.memoryId),
            ...(receipt.undone ? { undone: true } : {}),
          };
        default:
          break;
      }
    }
    const row = store.getMemoryById(id);
    if (!row) return { id, state: 'gone' };
    if (row.reviewState === 'pending') return { id, state: 'pending' };
    if (row.status === 'proposed') return { id, state: 'held', ...(row.summary ? { summary: row.summary } : {}) };
    return { id, state: 'applied', value: row.value, ...(row.summary ? { summary: row.summary } : {}) };
  });
}

/**
 * UNDO what learning did with one memory (R10, R29): a new memory is removed; a
 * memory that changed an existing value puts the old value back; a supersession
 * is reverted. Never deletes the user's OLD memory — undo restores, it does not
 * erase. Returns false when there is nothing to undo.
 */
export function cancelLearnedMemory(store: MemoryReviewStore, id: string, now: number = Date.now()): boolean {
  if (!id) return false;
  const receipts = readReceipts(store);
  const receipt = receipts.find((r) => r.id === id);
  let done = false;
  if (receipt && !receipt.undone) {
    switch (receipt.kind) {
      case 'applied':
      case 'held':
      case 'question':
        if (store.getMemoryById(receipt.memoryId)) {
          store.deleteMemory({ id: receipt.memoryId });
          done = true;
        }
        break;
      case 'changed':
        if (receipt.otherId) done = store.revertSupersession(receipt.otherId) || done;
        if (store.getMemoryById(receipt.memoryId)) {
          store.deleteMemory({ id: receipt.memoryId });
          done = true;
        }
        break;
      case 'refined':
        if (receipt.previous && receipt.otherId && store.getMemoryById(receipt.otherId)) {
          store.reviseMemoryValue(receipt.otherId, receipt.previous.value, receipt.previous.provenance, now);
          done = true;
        }
        break;
      case 'tidy-equivalent':
      case 'tidy-refines':
      case 'tidy-contradicts':
        if (receipt.otherId) done = store.revertSupersession(receipt.otherId);
        break;
      case 'known':
        // Nothing was added; the existing memory is the user's and stays.
        break;
    }
  } else if (!receipt) {
    // Not reviewed yet (or reviewed before receipts existed): cancelling a
    // memory that is still only naby's new note removes it.
    if (store.getMemoryById(id)) {
      store.deleteMemory({ id });
      receipts.push({ id, kind: 'applied', memoryId: id, key: '', value: '', at: now });
      done = true;
    }
  }
  if (done) {
    writeReceipts(
      store,
      receipts.map((r) => (r.id === id ? { ...r, undone: true } : r)),
      now,
    );
  }
  return done;
}

/**
 * memory-tiers R6: undo an anchoring from the chip — the row the chip's claim
 * now lives in goes back to long-term and is never anchored automatically
 * again. Returns false when it is not anchored (nothing to undo).
 */
export function undoMemoryAnchor(store: MemoryReviewStore, id: string, now: number = Date.now()): boolean {
  if (!id) return false;
  const receipt = readReceipts(store).find((r) => r.id === id);
  const holderId = receipt?.memoryId ?? id;
  return unanchorMemory(store, holderId, now);
}

/**
 * memory-tiers R19: "새 내용으로 바꾸기". The anchored row takes the new
 * memory's value (it stays anchored — the user just chose its new words), and
 * the new row, which was only ever kept beside it, goes. Returns false when the
 * conflict is gone or already settled.
 */
export function replaceAnchoredMemory(store: MemoryReviewStore, id: string, now: number = Date.now()): boolean {
  const receipts = readReceipts(store);
  const receipt = receipts.find((r) => r.id === id && r.kind === 'anchored-conflict');
  if (!receipt || receipt.replaced || !receipt.otherId) return false;
  const anchored = store.getMemoryById(receipt.otherId);
  const fresh = store.getMemoryById(receipt.memoryId);
  if (!anchored) return false;
  const value = fresh?.value ?? receipt.value;
  // A person's choice, so the anchored row is on the user tier now (the same
  // promotion an edit makes); the evidence of the new memory comes with it.
  store.reviseMemoryValue(
    anchored.id,
    value,
    { ...(fresh?.provenance ?? anchored.provenance), source: 'user' },
    now,
  );
  if (fresh) store.deleteMemory({ id: fresh.id });
  writeReceipts(
    store,
    receipts.map((r) => (r.id === id ? { ...r, replaced: true, oldValue: anchored.value } : r)),
    now,
  );
  return true;
}

/** "Recently learned" (R29): the last week's receipts, newest first, minus the
 *  undone ones and the holds/questions (those live in "needs checking"). */
export function recentLearned(store: MemoryReviewStore, now: number = Date.now()): MemoryReceipt[] {
  return readReceipts(store)
    .filter(
      (r) =>
        !r.undone &&
        now - r.at <= RECENT_LEARNED_MS &&
        r.kind !== 'held' &&
        r.kind !== 'question' &&
        r.kind !== 'known' &&
        // memory-tiers R19: the chip carries the choice; "recently learned" is
        // for what naby started using, and this memory is not in use.
        r.kind !== 'anchored-conflict',
    )
    .sort((a, b) => b.at - a.at);
}

// ---------------------------------------------------------------------------
// Questions (§5)
// ---------------------------------------------------------------------------

/** One question, ready to render: both sides' words and when each was learned. */
export type MemoryQuestionView = {
  id: string;
  kind: MemoryQuestion['kind'];
  a: { id: string; key: string; value: string; learnedAt: number };
  b: { id?: string; key: string; value: string; learnedAt: number };
  createdAt: number;
  shownCount: number;
  snoozedUntil?: number;
};

/** The open questions whose memories still exist — an orphan is closed (R25). */
export function openMemoryQuestions(store: MemoryReviewStore): MemoryQuestionView[] {
  const out: MemoryQuestionView[] = [];
  for (const q of store.listMemoryQuestions({ status: 'open' })) {
    const a = store.getMemoryById(q.aId);
    const b = q.bId ? store.getMemoryById(q.bId) : undefined;
    const live = (m: MemoryItem | undefined): m is MemoryItem => Boolean(m && m.supersededAt === undefined);
    if (!live(a) || (q.kind === 'conflict' && !live(b)) || (q.kind === 'overwrite' && !q.candidate)) {
      store.updateMemoryQuestion(q.id, { status: 'closed' });
      continue;
    }
    out.push({
      id: q.id,
      kind: q.kind,
      a: { id: a.id, key: a.key, value: a.value, learnedAt: a.createdAt },
      b:
        q.kind === 'conflict' && b
          ? { id: b.id, key: b.key, value: b.value, learnedAt: b.createdAt }
          : { key: q.candidate!.key, value: q.candidate!.value, learnedAt: q.createdAt },
      createdAt: q.createdAt,
      shownCount: q.shownCount,
      ...(q.snoozedUntil !== undefined ? { snoozedUntil: q.snoozedUntil } : {}),
    });
  }
  return out;
}

/**
 * Settle the questions older versions left open (R18): for a conflict the newer
 * memory stays, the same rule the review now applies, shown as a tidy receipt so
 * it can be undone. A refused overwrite never reached review, so its candidate
 * is dropped rather than applied. Returns how many were settled.
 */
export function settleOpenMemoryQuestions(store: MemoryReviewStore, now: number = Date.now()): number {
  const receipts: MemoryReceipt[] = [];
  let settled = 0;
  for (const q of store.listMemoryQuestions({ status: 'open' })) {
    const a = store.getMemoryById(q.aId);
    const b = q.bId ? store.getMemoryById(q.bId) : undefined;
    if (q.kind === 'conflict' && a && b && a.supersededAt === undefined && b.supersededAt === undefined) {
      const op = decideTidyOperation(a, b, 'contradicts');
      if (op.op === 'supersede') {
        if (op.keep.status === 'proposed') store.settleMemoryReview(op.keep.id, { status: 'confirmed', at: now });
        if (store.supersedeMemory(op.retire.id, op.keep.id, now, op.reason)) {
          receipts.push({
            id: op.retire.id,
            kind: op.reason,
            memoryId: op.keep.id,
            key: op.keep.key,
            value: op.keep.value,
            otherId: op.retire.id,
            oldValue: op.retire.value,
            at: now,
          });
        }
      }
    }
    store.updateMemoryQuestion(q.id, { status: 'closed' });
    settled += 1;
  }
  addReceipts(store, receipts, now);
  return settled;
}

/** Make a memory the user's own choice: confirmed, on the `user` tier (R26). */
function adoptAsUsers(store: MemoryReviewStore, id: string): void {
  const row = store.getMemoryById(id);
  if (!row) return;
  if (row.status === 'proposed') store.confirmMemory(id);
  else store.patchMemoryProvenance(id, { source: 'user' });
}

/**
 * Answer a question (R26). `later` snoozes it for a week (R27). The answer never
 * touches the trust ledger (R28) — this function has no ledger to touch.
 */
export function answerMemoryQuestion(
  store: MemoryReviewStore,
  id: string,
  answer: MemoryQuestionAnswer | 'later',
  now: number = Date.now(),
): { ok: true } | { ok: false; error: string } {
  const q = store.getMemoryQuestion(id);
  if (!q || q.status !== 'open') return { ok: false, error: 'no such open question' };
  if (answer === 'later') {
    store.updateMemoryQuestion(id, { snoozedUntil: now + QUESTION_SNOOZE_MS, shownCount: 0 });
    return { ok: true };
  }
  if (answer !== 'a' && answer !== 'b' && answer !== 'both') return { ok: false, error: 'answer must be a, b, both or later' };

  if (q.kind === 'conflict') {
    const a = store.getMemoryById(q.aId);
    const b = q.bId ? store.getMemoryById(q.bId) : undefined;
    if (!a || !b) {
      store.updateMemoryQuestion(id, { status: 'closed' });
      return { ok: false, error: 'one of the memories is gone' };
    }
    if (answer === 'both') {
      adoptAsUsers(store, a.id);
      adoptAsUsers(store, b.id);
      // Never asked again about this pair (R26).
      const fa = store.getMemoryById(a.id)!;
      const fb = store.getMemoryById(b.id)!;
      store.putMemoryPairVerdict({
        aId: fa.id,
        bId: fb.id,
        aUpdatedAt: fa.updatedAt,
        bUpdatedAt: fb.updatedAt,
        relation: 'both-valid',
        judgedAt: now,
      });
    } else {
      const keep = answer === 'a' ? a : b;
      const drop = answer === 'a' ? b : a;
      adoptAsUsers(store, keep.id);
      // Kept, not deleted (R19) — revertible from the memory browser.
      store.supersedeMemory(drop.id, keep.id, now, 'question');
    }
  } else {
    const a = store.getMemoryById(q.aId);
    const c = q.candidate;
    if (!a || !c) {
      store.updateMemoryQuestion(id, { status: 'closed' });
      return { ok: false, error: 'the memory is gone' };
    }
    if (answer === 'b') {
      store.updateMemoryValue(a.id, c.value, now); // the user's own choice: `user` tier
    } else if (answer === 'both') {
      let key = `${c.key}-2`;
      for (let n = 2; n <= 9; n += 1) {
        key = `${c.key}-${n}`.slice(0, 64);
        const taken = store.getScopedMemory(c.scope, c.scopeKey).some((m) => m.key === key);
        if (!taken) break;
      }
      store.putMemory({
        scope: c.scope,
        scopeKey: c.scopeKey,
        type: c.type,
        key,
        value: c.value,
        provenance: { source: 'user', ...(c.sessionId ? { sessionId: c.sessionId } : {}), basis: 'kept by the user' },
        confidence: 1,
        requestedStatus: 'confirmed',
      });
    }
  }
  store.updateMemoryQuestion(id, { status: 'answered', answer, answeredAt: now });
  return { ok: true };
}

/** The popup folded away unanswered (R27). Two in a row snooze the question. */
export function noteQuestionCollapsed(store: MemoryReviewStore, id: string, now: number = Date.now()): void {
  const q = store.getMemoryQuestion(id);
  if (!q || q.status !== 'open') return;
  const count = q.shownCount + 1;
  if (count >= 2) store.updateMemoryQuestion(id, { shownCount: 0, snoozedUntil: now + QUESTION_SNOOZE_MS });
  else store.updateMemoryQuestion(id, { shownCount: count });
}

export function readLastAutoShownAt(store: Pick<Store, 'getSetting'>): number | undefined {
  try {
    const n = Number(store.getSetting(MEMORY_QUESTION_LAST_AUTO_SHOWN_KEY));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

export function noteQuestionAutoShown(store: SettingsStore, now: number = Date.now()): void {
  store.setSetting(MEMORY_QUESTION_LAST_AUTO_SHOWN_KEY, String(Math.trunc(now)));
}

// ---------------------------------------------------------------------------
// The one-time migration (§7)
// ---------------------------------------------------------------------------

/**
 * Put the waiting proposals through review, ONCE (R33, R34): `artifact`-tier
 * `proposed` rows younger than 90 days go to review-pending. Older ones and
 * `external` ones stay where they are ("needs checking"). Does nothing while
 * `memory.autoApply` is off — and does not mark itself done then either, so
 * turning the switch on later still migrates. Never throws.
 */
export function migrateWaitingProposals(store: MemoryReviewStore, now: number = Date.now()): number {
  try {
    if (store.getSetting(MEMORY_AUTO_APPLY_MIGRATED_KEY)) return 0;
    if (!readAutoApplySetting(store)) return 0;
    const before = new Set(store.listPendingReviewMemory().map((m) => m.id));
    const moved = store.queueProposedForReview({ source: 'artifact', since: now - MIGRATION_WINDOW_MS });
    const ids = store
      .listPendingReviewMemory()
      .map((m) => m.id)
      .filter((mid) => !before.has(mid));
    store.setSetting(MEMORY_AUTO_APPLY_MIGRATED_IDS_KEY, JSON.stringify(ids));
    store.setSetting(MEMORY_AUTO_APPLY_MIGRATED_KEY, String(Math.trunc(now)));
    if (moved > 0) console.log(`[memory-review] migration: ${moved} waiting proposal(s) queued for review`);
    return moved;
  } catch (e) {
    console.warn(`[memory-review] migration skipped: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
}
