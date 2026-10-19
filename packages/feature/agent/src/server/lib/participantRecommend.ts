// packages/feature/agent/src/server/lib/participantRecommend.ts
//
// NABY RECOMMENDS A PARTICIPANT (specs/multi-agent-chat.md §8.13, MAC-M6).
//
// After a user's turn, in the background, naby reads the session and — only
// when a distinct specialty keeps coming back (R9.1) — suggests a participant
// for it: a registered one that is not here (`existing`) or a draft of a new
// one (`new`). The suggestion is a row in `participant_recommendations`; the
// roster draws it as a dashed chip and the user saves or throws it away.
//
// THE RUNTIME OWNS THE RULES (`participant-recommend.ts`: the cursor rule, the
// transcript, the prompt, the strict parser with the threshold and the dedupe).
// This module owns the plumbing around them, in the shape `reflection.ts` gave
// the reflection sweep:
//
//   * `analyzeSession(store, sessionId, judge)` — one session: is it due, ask
//     the judge once, keep what survives the parser, write the rows, the usage
//     row and the activity log, and MOVE THE CURSOR even when the answer is
//     "nothing" (R9.7). A judge that throws leaves the cursor where it was: an
//     attempt that failed has not read anything.
//   * `kickRecommendationSweep(store, {sessionId?, excludeSessionId?})` — fire
//     and forget, one in flight per process, never throws (R9.4). Skipped when
//     the setting is off or no provider can answer (R9.6) — and then the judge
//     is never called at all.
//   * `modelRecommendationJudge(store)` — the model call: ONE tool-less
//     `engine.run` at `RECOMMEND_TIER`, on the provider the user picked
//     (`resolveJudgeBackend`, the same choice every background call makes).
//
// NOTHING HERE TOUCHES A TURN. No message is written to the transcript (the
// engine is driven directly, not through `runTurn`); the only rows written are
// the recommendation rows, the cursor, the usage row (so the cost total includes
// the call, §8.6) and the activity log.

import {
  activeClaudeAccountId,
  BUILTIN_PERSONA_ID,
  ClaudeAgentSdkEngine,
  logActivity,
  parseRecommendations,
  recommendationDue,
  recommendPrompt,
  recommendTranscript,
  RECOMMEND_FAILURE_COOLDOWN_MS,
  RECOMMEND_FIRST_AT,
  RECOMMEND_MAX_PENDING,
  RECOMMEND_SWEEP_SESSIONS,
  RECOMMEND_TIER,
  RECOMMEND_USER_MESSAGE,
  type Agent,
  type Engine,
  type ParsedRecommendation,
  type ParticipantRecommendation,
  type ParticipantRecommendationDraft,
  type SessionParticipant,
  type Store,
  type UsageRecord,
} from '../../../../../../../dist/naby-runtime.mjs';
import { modelValueForTier } from './modelRoute';
import { composeDraft, type DraftFields } from './participantDraft';
import { isParticipant, readParticipantSettings, validateParticipantName } from './participants';
import { resolveJudgeBackend, selectedJudgeProviderId, type JudgeBackend } from './reflection';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The usage one recommendation call cost, as the judge measured it. */
export type RecommendationUsage = Omit<UsageRecord, 'at'> & { durationMs?: number };

/** What the judge answers: the model's raw text (parsed strictly here) and,
 *  when it measured any, the call's usage. */
export type RecommendationJudgeAnswer = { text: string; usage?: RecommendationUsage };

/** One recommendation call. `system` is `recommendPrompt(...)`. */
export type RecommendationJudge = (prompt: { system: string; user: string }) => Promise<RecommendationJudgeAnswer>;

/** THERE IS NO JUDGE ON THIS MACHINE — thrown, never returned, for the reason
 *  `ReflectionJudgeUnavailableError` documents: "nobody could read it" must not
 *  look like "read it and found nothing", or the cursor would move past
 *  messages nobody read. The sweep stops at it. */
export class RecommendationJudgeUnavailableError extends Error {
  readonly name = 'RecommendationJudgeUnavailableError';
}

export type AnalyzeStatus =
  /** No such session. */
  | 'no-session'
  /** A temporary session — nothing is read out of it. */
  | 'temporary'
  /** Not enough new user messages since the last look. */
  | 'not-due'
  /** Already two pending: the cursor moved, the judge was not asked. */
  | 'full'
  /** The judge was asked. */
  | 'analyzed';

export type AnalyzeResult = {
  status: AnalyzeStatus;
  /** The rows written by this analysis (pending). */
  created: ParticipantRecommendation[];
  /** User-authored messages the cursor now stands at (when it moved). */
  cursor?: number;
  /** Why the model's answer could not be read at all. */
  malformed?: string;
};

// ---------------------------------------------------------------------------
// Views and transitions shared with the actions
// ---------------------------------------------------------------------------

/** A recommendation as `session.recommendations.list` returns it. */
export type RecommendationView = {
  id: string;
  sessionId: string;
  kind: 'existing' | 'new';
  agentId?: string;
  /** `existing`: the participant row (roster item shape). */
  agent?: Agent;
  /** `new`: the draft, in the `DraftFields` shape the editor fills from. */
  draft?: DraftFields;
  specialty: string;
  reason: string;
  createdAt: number;
};

type ClosureStore = Pick<Store, 'getAgent' | 'getAgentByName' | 'listAgents'>;

/**
 * Can a PENDING recommendation still be acted on? `null` = yes. Otherwise how
 * it should be closed:
 *   existing — its participant is gone (dismissed), has joined the session
 *              (accepted), or the user declined it in this session (dismissed);
 *   new      — its draft is unreadable, or its handle is now taken / no longer
 *              a legal handle (dismissed: saving it would be refused).
 */
export function closureOf(
  store: ClosureStore,
  rec: ParticipantRecommendation,
  rows: readonly Pick<SessionParticipant, 'agentId' | 'status'>[],
): { status: 'accepted' | 'dismissed'; via: string } | null {
  if (rec.kind === 'existing') {
    if (!rec.agentId || !isParticipant(store.getAgent(rec.agentId))) return { status: 'dismissed', via: 'gone' };
    const row = rows.find((r) => r.agentId === rec.agentId);
    if (row?.status === 'active') return { status: 'accepted', via: 'joined' };
    if (row?.status === 'declined') return { status: 'dismissed', via: 'declined' };
    return null;
  }
  if (!rec.draft) return { status: 'dismissed', via: 'gone' };
  if (!validateParticipantName(rec.draft.name, store).ok) return { status: 'dismissed', via: 'name-taken' };
  return null;
}

export function viewOfRecommendation(
  store: Pick<Store, 'getAgent'>,
  rec: ParticipantRecommendation,
): RecommendationView {
  const agent = rec.agentId ? store.getAgent(rec.agentId) : undefined;
  return {
    id: rec.id,
    sessionId: rec.sessionId,
    kind: rec.kind,
    ...(rec.agentId ? { agentId: rec.agentId } : {}),
    ...(rec.kind === 'existing' && isParticipant(agent) ? { agent } : {}),
    ...(rec.kind === 'new' && rec.draft ? { draft: rec.draft as DraftFields } : {}),
    specialty: rec.specialty,
    reason: rec.reason,
    createdAt: rec.createdAt,
  };
}

/** The session's PENDING recommendations as the roster shows them. One that
 *  can no longer be acted on (`closureOf`: its participant joined, was
 *  declined or is gone; its draft's handle is taken) is left out — the next
 *  analysis closes it. */
export function pendingRecommendationViews(
  store: ClosureStore & Pick<Store, 'listParticipantRecommendations' | 'listSessionParticipants'>,
  sessionId: string,
): RecommendationView[] {
  const rows = store.listSessionParticipants(sessionId);
  return store
    .listParticipantRecommendations(sessionId, 'pending')
    .filter((r) => closureOf(store, r, rows) === null)
    .map((r) => viewOfRecommendation(store, r));
}

/** The activity-log line for one recommendation (R9.7). */
function logRecommendation(
  rec: Pick<ParticipantRecommendation, 'sessionId' | 'kind' | 'agentId' | 'specialty' | 'evidence'> & {
    draft?: ParticipantRecommendationDraft;
  },
  name: string,
  decision: 'pending' | 'accepted' | 'dismissed',
  extra: Record<string, unknown> = {},
): void {
  logActivity('participant_recommendation', {
    sessionId: rec.sessionId,
    kind: rec.kind,
    ...(rec.agentId ? { agentId: rec.agentId } : {}),
    name,
    specialty: rec.specialty,
    decision,
    evidence: rec.evidence,
    ...extra,
  });
}

function nameOf(store: Pick<Store, 'getAgent'>, rec: ParticipantRecommendation): string {
  if (rec.kind === 'new') return rec.draft?.name ?? '';
  return (rec.agentId ? store.getAgent(rec.agentId)?.name : undefined) ?? rec.agentId ?? '';
}

/**
 * Close a PENDING recommendation as `accepted` or `dismissed` (the two actions,
 * and the proposal path). Refuses an unknown id and one that is not pending —
 * a recommendation is closed once.
 */
export function closeRecommendation(
  store: Pick<Store, 'getAgent' | 'getParticipantRecommendation' | 'setParticipantRecommendationStatus'>,
  id: string,
  status: 'accepted' | 'dismissed',
  extra: Record<string, unknown> = {},
): { ok: true; recommendation: ParticipantRecommendation } | { ok: false; error: string } {
  const rec = store.getParticipantRecommendation(id);
  if (!rec) return { ok: false, error: 'no recommendation with that id' };
  if (rec.status !== 'pending') return { ok: false, error: `the recommendation is already ${rec.status}` };
  const moved = store.setParticipantRecommendationStatus(id, status);
  if (!moved) return { ok: false, error: 'no recommendation with that id' };
  logRecommendation(rec, nameOf(store, rec), status, extra);
  return { ok: true, recommendation: moved };
}

/**
 * A participant just joined the session through naby's proposal (R3.9): a
 * pending `existing` recommendation of the same participant is now done — close
 * it as `accepted` (R9.5). Never throws; returns how many it closed.
 */
export function closeRecommendationsOnJoin(
  store: Pick<
    Store,
    'getAgent' | 'getParticipantRecommendation' | 'listParticipantRecommendations' | 'setParticipantRecommendationStatus'
  >,
  sessionId: string,
  agentId: string,
  via: string = 'proposal',
): number {
  let n = 0;
  try {
    for (const rec of store.listParticipantRecommendations(sessionId, 'pending')) {
      if (rec.kind !== 'existing' || rec.agentId !== agentId) continue;
      if (closeRecommendation(store, rec.id, 'accepted', { via }).ok) n += 1;
    }
  } catch (e) {
    console.warn(`[recommend] could not close recommendations on join: ${e instanceof Error ? e.message : String(e)}`);
  }
  return n;
}

/**
 * The user declined naby's proposal of `agentId` in this session (R3.9): a
 * pending `existing` recommendation of the same participant is answered too —
 * close it as `dismissed`. Never throws; returns how many it closed.
 */
export function closeRecommendationsOnDecline(
  store: Pick<
    Store,
    'getAgent' | 'getParticipantRecommendation' | 'listParticipantRecommendations' | 'setParticipantRecommendationStatus'
  >,
  sessionId: string,
  agentId: string,
): number {
  let n = 0;
  try {
    for (const rec of store.listParticipantRecommendations(sessionId, 'pending')) {
      if (rec.kind !== 'existing' || rec.agentId !== agentId) continue;
      if (closeRecommendation(store, rec.id, 'dismissed', { via: 'declined' }).ok) n += 1;
    }
  } catch (e) {
    console.warn(`[recommend] could not close recommendations on decline: ${e instanceof Error ? e.message : String(e)}`);
  }
  return n;
}

/** Close what can no longer be acted on (`closureOf`) before counting the
 *  pending ones. */
export function tidyPending(store: Store, sessionId: string): void {
  const rows = store.listSessionParticipants(sessionId);
  for (const rec of store.listParticipantRecommendations(sessionId, 'pending')) {
    const closure = closureOf(store, rec, rows);
    if (closure) closeRecommendation(store, rec.id, closure.status, { via: closure.via });
  }
}

// ---------------------------------------------------------------------------
// One session
// ---------------------------------------------------------------------------

function rosterOf(store: Pick<Store, 'listSessionParticipants'>, sessionId: string) {
  const rows = store.listSessionParticipants(sessionId);
  return {
    activeIds: rows.filter((r) => r.status === 'active').map((r) => r.agentId),
    declinedIds: rows.filter((r) => r.status === 'declined').map((r) => r.agentId),
  };
}

function hubOf(store: Pick<Store, 'getAgent'>): { id: string; name: string } {
  const persona = store.getAgent(BUILTIN_PERSONA_ID);
  return { id: BUILTIN_PERSONA_ID, name: persona?.name ?? 'naby' };
}

/** A `new` draft held to the in-chat draft's FULL validation against the store
 *  as it is now (`composeDraft`: the name rule with case-insensitive
 *  uniqueness, the sizes, the profile gate). */
function draftStillValid(store: Store, rec: Extract<ParsedRecommendation, { kind: 'new' }>): boolean {
  const d = rec.draft;
  const checked = composeDraft(store, {
    action: 'create',
    name: d.name,
    displayName: d.displayName,
    description: d.description,
    instructions: d.instructions,
    guardrailsPolicy: d.guardrailsPolicy,
    greeting: d.greeting,
    ...(d.avatar.kind === 'emoji' ? { avatar: d.avatar.value } : {}),
    color: d.color,
  });
  return checked.ok;
}

/**
 * Analyse ONE session: due → ask the judge once → keep what the parser keeps →
 * write → move the cursor. `force` skips the due check (tests, a manual run).
 * A judge failure PROPAGATES with the cursor unmoved.
 */
export async function analyzeSession(
  store: Store,
  sessionId: string,
  judge: RecommendationJudge,
  opts: { force?: boolean; now?: () => number } = {},
): Promise<AnalyzeResult> {
  const now = opts.now ?? Date.now;
  const session = store.getSession(sessionId);
  if (!session) return { status: 'no-session', created: [] };
  if (session.noLearn) return { status: 'temporary', created: [] };
  const hub = hubOf(store);
  const transcript = recommendTranscript(store.getMessages(sessionId), { hubLabel: hub.name });
  const count = transcript.userMessageCount;
  const cursor = store.getRecommendationCursor(sessionId)?.userMessageCount;
  if (!opts.force && !recommendationDue(count, cursor)) return { status: 'not-due', created: [] };

  tidyPending(store, sessionId);
  const known = store.listParticipantRecommendations(sessionId);
  const pending = known.filter((r) => r.status === 'pending');
  if (pending.length >= RECOMMEND_MAX_PENDING) {
    // Nothing could be added: do not pay for a call, but the messages were
    // "seen" — the next look is 8 messages on, like any other (D17).
    store.setRecommendationCursor(sessionId, count, now());
    return { status: 'full', created: [], cursor: count };
  }

  const agents = store.listAgents();
  const registered = agents.filter((a) => a.kind === 'participant');
  const nameById = new Map(registered.map((a) => [a.id, a.name]));
  const { activeIds, declinedIds } = rosterOf(store, sessionId);
  const describe = (r: ParticipantRecommendation) => ({
    kind: r.kind,
    name: r.kind === 'new' ? (r.draft?.name ?? '') : (nameById.get(r.agentId ?? '') ?? r.agentId ?? ''),
    specialty: r.specialty,
  });

  const system = recommendPrompt({
    lines: transcript.lines,
    registered: registered.map((a) => ({ id: a.id, name: a.name, description: a.description ?? '' })),
    inSession: activeIds.map((id) => nameById.get(id)).filter((n): n is string => !!n),
    declined: declinedIds.map((id) => nameById.get(id)).filter((n): n is string => !!n),
    dismissed: known.filter((r) => r.status === 'dismissed').map(describe),
    pending: pending.map(describe),
    slots: RECOMMEND_MAX_PENDING - pending.length,
  });

  const answer = await judge({ system, user: RECOMMEND_USER_MESSAGE });

  // THE WORLD MOVED DURING THE CALL. The session may have been deleted (then
  // nothing is written — `appendUsage` and the cursor would re-create its row),
  // and its roster, the registry or the recommendations may have changed (then
  // the parse runs against the state as it is NOW, not as it was asked).
  const gone = !store.getSession(sessionId);

  // §8.6: not a `runTurn`, so no usage row appears by itself — written here so
  // the cost total includes the call. Billed to the session it read.
  const u = answer.usage;
  if (u && (u.inputTokens > 0 || u.outputTokens > 0 || u.cachedInputTokens > 0)) {
    const { durationMs, ...record } = u;
    if (!gone) {
      try {
        store.appendUsage(sessionId, { at: now(), ...record });
      } catch (e) {
        console.warn(`[recommend] usage not recorded: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    logActivity('usage', {
      sessionId,
      agentId: hub.id,
      agentName: hub.name,
      source: 'participant-recommend',
      ...record,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(gone ? { sessionDeleted: true } : {}),
    });
  }
  if (gone) return { status: 'no-session', created: [] };

  const nowAgents = store.listAgents();
  const nowRoster = rosterOf(store, sessionId);
  const nowKnown = store.listParticipantRecommendations(sessionId);
  const parsed = parseRecommendations(answer.text, {
    userNumbers: transcript.userNumbers,
    registered: nowAgents.filter((a) => a.kind === 'participant').map((a) => ({ id: a.id, name: a.name })),
    inSession: nowRoster.activeIds,
    declined: nowRoster.declinedIds,
    known: nowKnown.map((r) => ({
      kind: r.kind,
      ...(r.agentId ? { agentId: r.agentId } : {}),
      ...(r.draft?.name ? { name: r.draft.name } : {}),
      status: r.status,
    })),
    takenNames: nowAgents.filter((a) => a.kind !== 'participant').map((a) => a.name),
    hubNames: nowAgents.filter((a) => a.kind === 'persona').map((a) => a.name),
  });

  const created: ParticipantRecommendation[] = [];
  for (const rec of parsed.recommendations) {
    if (rec.kind === 'new' && !draftStillValid(store, rec)) continue;
    const row = store.putParticipantRecommendation({
      sessionId,
      kind: rec.kind,
      ...(rec.kind === 'existing' ? { agentId: rec.agentId } : { draft: rec.draft }),
      specialty: rec.specialty,
      reason: rec.reason,
      evidence: rec.evidence,
    });
    created.push(row);
    logRecommendation(row, rec.name, 'pending');
  }
  if (created.length === 0) {
    logActivity('participant_recommendation', {
      sessionId,
      decision: 'none',
      evidence: [],
      ...(parsed.malformed ? { malformed: parsed.malformed } : {}),
      ...(parsed.dropped.length > 0 ? { dropped: parsed.dropped.map((d) => d.why) } : {}),
    });
  }
  // R9.7: the cursor moves even when the answer was "nothing" (or unreadable —
  // a model that cannot answer this transcript will not answer it better on the
  // next turn; it gets the next 8 messages instead).
  store.setRecommendationCursor(sessionId, count, now());
  return {
    status: 'analyzed',
    created,
    cursor: count,
    ...(parsed.malformed ? { malformed: parsed.malformed } : {}),
  };
}

// ---------------------------------------------------------------------------
// The sweep (R9.4)
// ---------------------------------------------------------------------------

export type RecommendationSweepOptions = {
  /** The session whose turn just ended: looked at first when it is due. */
  sessionId?: string;
  /** A session the sweep must not touch. */
  excludeSessionId?: string;
  /** The clock (tests). */
  now?: () => number;
};

export type RecommendationSweepDeps = {
  judge: RecommendationJudge;
  /** Can any provider answer? False = the sweep is skipped, the judge never called. */
  available: () => Promise<boolean>;
};

export type RecommendationSweepResult = {
  skipped?: 'disabled' | 'nothing-due' | 'no-provider';
  /** The setting was switched off while the sweep ran; it stopped there. */
  stopped?: 'disabled' | 'judge-error';
  /** Sessions analysed, in order. */
  analyzed: string[];
  /** Recommendations written. */
  created: number;
  /** Sessions whose analysis failed (judge error) — cursor unmoved, the
   *  failure recorded for the cooldown. */
  failed: string[];
};

/** Did this session's analysis fail within the cooldown? */
function coolingDown(store: Store, sessionId: string, now: number): boolean {
  const failedAt = store.getRecommendationCursor(sessionId)?.failedAt;
  return failedAt !== undefined && failedAt >= now - RECOMMEND_FAILURE_COOLDOWN_MS;
}

/** The sessions one sweep looks at: the current one first when it is due, then
 *  the store's due list (cursor-less or 8+ behind, newest first, within the 30
 *  most recent), at most `RECOMMEND_SWEEP_SESSIONS` in all. A session whose
 *  analysis failed within `RECOMMEND_FAILURE_COOLDOWN_MS` is left out. */
export function sweepTargets(store: Store, opts: RecommendationSweepOptions): string[] {
  const now = (opts.now ?? Date.now)();
  const out: string[] = [];
  const skip = new Set([opts.excludeSessionId].filter((s): s is string => !!s));
  if (opts.sessionId && !skip.has(opts.sessionId)) {
    const s = store.getSession(opts.sessionId);
    if (s && !s.noLearn && !coolingDown(store, opts.sessionId, now)) {
      const count = recommendTranscript(store.getMessages(opts.sessionId), { limit: 0 }).userMessageCount;
      if (recommendationDue(count, store.getRecommendationCursor(opts.sessionId)?.userMessageCount)) {
        out.push(opts.sessionId);
      }
    }
  }
  const due = store.listSessionsForRecommendation({
    limit: RECOMMEND_SWEEP_SESSIONS + out.length + skip.size,
    minUserMessages: RECOMMEND_FIRST_AT,
    skipFailedSince: now - RECOMMEND_FAILURE_COOLDOWN_MS,
  });
  for (const c of due) {
    if (out.length >= RECOMMEND_SWEEP_SESSIONS) break;
    if (skip.has(c.sessionId) || out.includes(c.sessionId)) continue;
    out.push(c.sessionId);
  }
  return out.slice(0, RECOMMEND_SWEEP_SESSIONS);
}

/** One sweep, awaited. Skipped (no judge call) when the setting is off, when
 *  nothing is due, or when no provider can answer. The setting is read again
 *  before EACH session, so switching it off stops a running sweep. The FIRST
 *  judge error ends the sweep: the session is marked failed (skipped for the
 *  cooldown) and the rest wait for the next sweep — a provider that just failed
 *  is most likely to fail the next call too, and retrying it every turn would
 *  bill nothing but errors. */
export async function runRecommendationSweep(
  store: Store,
  opts: RecommendationSweepOptions,
  deps: RecommendationSweepDeps,
): Promise<RecommendationSweepResult> {
  const result: RecommendationSweepResult = { analyzed: [], created: 0, failed: [] };
  if (!readParticipantSettings(store).recommendationsEnabled) return { ...result, skipped: 'disabled' };
  const targets = sweepTargets(store, opts);
  if (targets.length === 0) return { ...result, skipped: 'nothing-due' };
  if (!(await deps.available())) return { ...result, skipped: 'no-provider' };
  const now = opts.now ?? Date.now;
  for (const sessionId of targets) {
    if (!readParticipantSettings(store).recommendationsEnabled) {
      result.stopped = 'disabled';
      break;
    }
    try {
      const r = await analyzeSession(store, sessionId, deps.judge, { now });
      if (r.status === 'analyzed' || r.status === 'full') result.analyzed.push(sessionId);
      result.created += r.created.length;
    } catch (e) {
      result.failed.push(sessionId);
      result.stopped = 'judge-error';
      const why = e instanceof RecommendationJudgeUnavailableError ? 'no judge' : 'judge error';
      console.warn(`[recommend] session ${sessionId} not analysed (${why}): ${e instanceof Error ? e.message : String(e)}`);
      try {
        // Recorded only for a session that still exists: a failure row must
        // not outlive (or stand in for) a deleted conversation.
        if (store.getSession(sessionId)) store.markRecommendationFailed(sessionId, now());
      } catch {
        /* bookkeeping only */
      }
      break;
    }
  }
  return result;
}

/** One sweep at a time per PROCESS (R9.4). Kept on `globalThis` rather than in
 *  a module variable because the boot kick and the turn kick live in different
 *  server bundles (`dist/bootReconcile.mjs`, the engine's) — each bundle has its
 *  own copy of this module, and two copies of a module-level flag would let the
 *  boot sweep and the first turn's sweep analyse the same session at once. */
const IN_FLIGHT = Symbol.for('naby.participantRecommend.sweepInFlight');
type SweepSlot = { [IN_FLIGHT]?: Promise<RecommendationSweepResult | undefined> | null };
const slot = globalThis as unknown as SweepSlot;

/** Test seam: the sweep in flight, if any. */
export function recommendationSweepInFlight(): Promise<RecommendationSweepResult | undefined> | null {
  return slot[IN_FLIGHT] ?? null;
}

/**
 * `NABY_PARTICIPANT_RECOMMEND=0` turns the DEFAULT (model-backed) sweep off for
 * the process. The shell's vitest setup sets it, so no test can reach a real
 * provider through a turn that happened to leave a due session behind; a test
 * that covers the sweep injects its own judge and availability.
 */
export function recommendationsDisabledByEnv(): boolean {
  return process.env.NABY_PARTICIPANT_RECOMMEND === '0';
}

/** The production dependencies: the model judge, and "is there a backend". */
export function defaultRecommendationDeps(store: Store): RecommendationSweepDeps {
  return {
    judge: modelRecommendationJudge(store),
    available: async () => {
      if (recommendationsDisabledByEnv()) return false;
      try {
        const providerId = selectedJudgeProviderId(store);
        return !!(await resolveJudgeBackend(providerId ? { providerId } : {}));
      } catch {
        return false;
      }
    },
  };
}

/**
 * Kick a sweep from a finished turn (or the boot). Returns IMMEDIATELY and never
 * throws: the turn is over and must stay byte-for-byte what it was. A second
 * kick while one runs is dropped (returns `undefined`). The returned promise is
 * for tests; production callers `void` it.
 *
 * NO TRANSCRIPT READ ON THE CALLER'S TICK. The cheap gates run here — the env
 * switch (default deps only: an injected judge is a test's own) and the one
 * setting row — and everything else (`sweepTargets`' message reads, the due
 * list, the provider check) is deferred with `setImmediate`, so the turn's
 * request returns before the sweep touches a transcript.
 */
export function kickRecommendationSweep(
  store: Store,
  opts: RecommendationSweepOptions = {},
  deps?: RecommendationSweepDeps,
): Promise<RecommendationSweepResult | undefined> | undefined {
  if (slot[IN_FLIGHT]) return undefined;
  if (!deps && recommendationsDisabledByEnv()) return undefined;
  try {
    if (!readParticipantSettings(store).recommendationsEnabled) return undefined;
  } catch {
    return undefined;
  }
  const run: Promise<RecommendationSweepResult | undefined> = new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => runRecommendationSweep(store, opts, deps ?? defaultRecommendationDeps(store)))
    .catch((e) => {
      console.warn(`[recommend] sweep failed: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    });
  const tracked = run.finally(() => {
    if (slot[IN_FLIGHT] === tracked) slot[IN_FLIGHT] = null;
  });
  slot[IN_FLIGHT] = tracked;
  return tracked;
}

// ---------------------------------------------------------------------------
// The model judge (R9.6)
// ---------------------------------------------------------------------------

/** How long one recommendation call may take — the reflection judge's limit. */
export const RECOMMEND_JUDGE_TIMEOUT_MS = 60_000;

/** Usage bookkeeping for a backend: a key is metered, the sign-in is not. */
function backendBilling(backend: JudgeBackend): { engine: string; providerId: string; costBasis: 'metered' | 'subscription' } {
  const subscription = backend.model.providerId === 'dev-claude';
  return {
    engine: subscription ? 'dev-claude' : 'ai-sdk',
    providerId: backend.model.providerId,
    costBasis: subscription ? 'subscription' : 'metered',
  };
}

/**
 * The model-backed judge: ONE tool-less call. The backend is the one every
 * background call uses (`resolveJudgeBackend` over the user's provider choice,
 * read INSIDE the call so a provider switch is followed). The model is
 * `RECOMMEND_TIER` through the catalogue on the Claude sign-in (the routing
 * call's tier, R9.6); on a provider key it is that provider's configured model —
 * a Claude tier alias means nothing to another provider.
 */
export function modelRecommendationJudge(
  store: Store,
  opts: {
    resolveBackend?: () => Promise<JudgeBackend | undefined>;
    /** Builds the subscription engine for the active Claude account (tests). */
    claudeEngine?: (accountId: string | undefined) => Engine;
  } = {},
): RecommendationJudge {
  return async ({ system, user }) => {
    // Belt and braces for the env switch: with it set, the judge never builds
    // a real backend on its own (only an injected one runs).
    if (!opts.resolveBackend && recommendationsDisabledByEnv()) {
      throw new RecommendationJudgeUnavailableError('participant recommendations are disabled (NABY_PARTICIPANT_RECOMMEND=0)');
    }
    const backend = opts.resolveBackend
      ? await opts.resolveBackend()
      : await (async () => {
          const providerId = selectedJudgeProviderId(store);
          return resolveJudgeBackend(providerId ? { providerId } : {});
        })();
    if (!backend) {
      throw new RecommendationJudgeUnavailableError(
        'no recommendation judge is available: no provider API key is configured and the Claude Agent SDK is not installed',
      );
    }
    const billing = backendBilling(backend);
    // THE CHOSEN CLAUDE ACCOUNT PAYS. `resolveJudgeBackend` builds the Agent SDK
    // engine with no account, i.e. the default sign-in; the turn builds it with
    // `activeClaudeAccountId(store)` (engines/naby.ts). A multi-account user is
    // billed to the account they picked here too.
    //
    // An INJECTED backend (a test) keeps its own engine unless the test also
    // injects `claudeEngine`: a stand-in backend must never be swapped for the
    // real SDK behind the test's back.
    const buildClaude =
      opts.claudeEngine ??
      (opts.resolveBackend
        ? undefined
        : (accountId: string | undefined) => new ClaudeAgentSdkEngine(accountId ? { accountId } : {}));
    const engine =
      billing.costBasis === 'subscription' && buildClaude ? buildClaude(activeClaudeAccountId(store)) : backend.engine;
    const model =
      billing.costBasis === 'subscription'
        ? { providerId: backend.model.providerId, model: modelValueForTier(store, RECOMMEND_TIER) }
        : backend.model;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RECOMMEND_JUDGE_TIMEOUT_MS);
    const started = Date.now();
    let text = '';
    let partial = '';
    let served = model.model ?? '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let reportedCostUsd: number | undefined;
    try {
      for await (const ev of engine.run({
        model,
        messages: [{ role: 'user', content: user }],
        system,
        toolSchemas: [],
        executors: {},
        // Tool-less by construction; a backend that offers built-ins anyway is
        // refused here, so the call can never act.
        gate: async () => ({ behavior: 'deny' as const, reason: 'the recommendation call has no tools' }),
        signal: controller.signal,
      })) {
        if (ev.kind === 'init' && ev.model) served = ev.model;
        else if (ev.kind === 'text' && ev.role === 'assistant' && !ev.agentToolCallId) {
          if (ev.partial) partial += ev.text;
          else text += ev.text;
        } else if (ev.kind === 'result') {
          inputTokens = ev.usage?.inputTokens ?? 0;
          outputTokens = ev.usage?.outputTokens ?? 0;
          cachedInputTokens = ev.usage?.cachedInputTokens ?? 0;
          reportedCostUsd = ev.costUsd;
        }
      }
    } finally {
      clearTimeout(timer);
    }
    return {
      text: text || partial,
      usage: {
        ...billing,
        model: served,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
        durationMs: Date.now() - started,
      },
    };
  };
}
