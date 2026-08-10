// packages/feature/agent/src/server/lib/reflection.ts
//
// THE SESSION-REFLECTION SWEEP (Phase 3, P3-M8a + P3-M8b + P3-M8c + P3-M8d) —
// specs/phase-3-continuous-learning.md §4, §5, §6.4 and §7.2.
//
// M8d ADDS ONE WRITE: every action the sweep actually put before the judge is
// stamped `reviewedAt`, corrected or not. It is a small change with a specific
// purpose — until now the ledger could not tell "nobody has looked at this" from
// "someone looked and the user let it stand", so the second, which is real
// (weak) evidence, was indistinguishable from silence. The meter blends it in at
// a quarter weight (trust-meter §4.11); this file is the only thing that writes it.
//
// The runtime owns the rules (when a session is due, which actions become cases,
// which verdicts and which memory proposals are admissible —
// runtime/reflection.ts); this owns the three things only the shell can do: find
// the idle sessions, call a model once per session, and write the results to the
// ledger and to memory.
//
// M8b ADDS TWO STEPS, both on the same one-call-per-session budget:
//
//   * PROPOSALS. The judge's second answer — durable facts about the user — is
//     validated against the session's real user messages and written as
//     `proposed`/`artifact` memory through the ordinary `putMemory` gate. A
//     refused write is counted and the sweep carries on; reflection gets no more
//     latitude than a `naby_remember` call the user watched happen.
//   * CONSOLIDATION, once at the end. If (and only if) the user opted in, a
//     `proposed` row that distinct sessions keep agreeing with is confirmed. It
//     rides the end of the sweep rather than a timer of its own, for the reason
//     §4.3 gives about the sweep itself.
//
// WHY IT RIDES ON A TURN AND NOT ON A TIMER (§4.3). A background daemon in a
// desktop app is a process that keeps spending the user's money while they are not
// using the app, and it is one more thing that can be running when the machine
// sleeps. Instead the sweep is kicked, fire-and-forget, when the next run starts:
// it only ever runs while the app is in use, it cannot delay the turn that started
// it (nothing awaits it), and it excludes the session being typed in — reflecting
// on a live conversation would judge an action the user has not finished reacting
// to yet.
//
// THE CURSOR RULES, which are what make repeated sweeps cheap and safe:
//
//   * a session with NO cases still advances its cursor. Otherwise every sweep
//     would re-scan the same evidence-free transcript forever. Since M8c such a
//     session may FIRST earn a memory-only judge call, if it has said enough
//     since the cursor to be worth one (§6.4) — the cursor advances either way.
//   * a session whose JUDGE FAILED does not. A failed call is not an answer, and
//     advancing past unread messages would silently discard the evidence in them.
//   * NO JUDGE AT ALL is a third case, and getting it wrong was a real bug. On a
//     machine with no provider key and no local Claude sign-in there is nothing
//     to ask, and "nothing to ask" used to be reported as an empty answer — which
//     is indistinguishable from "asked, found nothing", so the sweep stamped every
//     case `reviewedAt` and advanced. Since `reviewedAt`-without-correction is the
//     weak ACCEPT the meter blends in, that invented evidence out of an absence.
//     It now THROWS (`ReflectionJudgeUnavailableError`) and ends the sweep.
//   * one session's failure never ends the sweep — each is wrapped on its own.
//     The unavailable-judge throw is the single exception, for the reason above.

import {
  AiSdkEngine,
  apiKeyCredential,
  applyConsolidation,
  buildReflectionCases,
  buildReflectionPrompt,
  BUILTIN_PERSONA_ID,
  ClaudeAgentSdkEngine,
  collectReflectionUserMessages,
  computeStyleFingerprint,
  CORROBORATION_THRESHOLD,
  DEFAULT_USER_ID,
  isClaudeAgentSdkAvailable,
  isSessionDueForReflection,
  makeModelResolver,
  matchCandidates,
  memoryHandle,
  MEMORY_DECAY_REVIEW_MS,
  mergeStyleFingerprint,
  normalizeReflectionAnswer,
  pairKey,
  parseReflectionAnswer,
  parseStyleFingerprint,
  logActivity,
  readLearningEnabled,
  REFLECTION_EXISTING_CAP,
  REFLECTION_IDLE_MS,
  REFLECTION_SWEEP_CAP,
  readSettings,
  resolveMemoryScopeKey,
  resolveProviderCredential,
  serializeStyleFingerprint,
  toSelectOptions,
  shouldAutoConfirmMemory,
  staleReviewCutoff,
  shouldExtractMemoryOnly,
  STYLE_FINGERPRINT_KEY,
  validateMemoryCandidates,
  validatePairRelations,
  validateReflectionVerdicts,
  validateStyleCandidates,
  type Agent,
  type ConsolidationOp,
  type Engine,
  type EvalEvent,
  type EvalEventKind,
  type MemoryItem,
  type ModelSelection,
  type MemoryWriteRequest,
  type PairRelationLookup,
  type ReflectionCase,
  type ReflectionCursor,
  type ReflectionJudge,
  type ReflectionSessionContext,
  type ReflectionUserMessage,
  type ReflectionVerdict,
  type RuntimeMessage,
  type SessionRef,
  type Store,
  type StyleFingerprint,
  type ValidatedMemoryCandidate,
} from '../../../../../../../dist/naby-runtime.mjs';

/** The narrow slice of the store the sweep needs. Same trick as
 *  `GrowthLedgerStore`: a test can hand this a plain object instead of a whole
 *  SQLite database, and the production `Store` satisfies it structurally. */
export interface ReflectionStore {
  listSessions(): SessionRef[];
  getMessages(sessionId: string): RuntimeMessage[];
  listAgents(): Agent[];
  listEvalEvents(
    agentId: string,
    opts?: { kind?: EvalEventKind; taskType?: string; sessionId?: string; limit?: number },
  ): EvalEvent[];
  markEvalEventCorrected(id: string): boolean;
  /** P3-M8d: stamp WHEN an action was put before the judge. Autonomous rows
   *  only, first timestamp wins — the store enforces both. */
  markEvalEventReviewed(id: string, reviewedAt: number): boolean;
  getReflectionCursor(sessionId: string): ReflectionCursor | undefined;
  setReflectionCursor(sessionId: string, lastSeq: number, reflectedAt: number): void;
  // -- P3-M8b: memory proposals and consolidation --------------------------
  putMemory(req: MemoryWriteRequest): MemoryItem;
  confirmMemory(id: string): void;
  listCorroboratedProposed(threshold: number): MemoryItem[];
  getMemoryCorroboration(memoryIds: readonly string[]): Record<string, number>;
  getSetting(key: string): string | undefined;
  // -- P3-M10: the stale-review derivation the consolidation step reports ----
  listStaleConfirmedMemory(
    before: number,
    opts?: { limit?: number; windowMs?: number },
  ): MemoryItem[];
  // -- P3-M13a: the four-op update, its reservation, and its activation -----
  //
  // `getScopedMemory` is what MATCHING reads (step 1 is code, and code needs the
  // rows). `corroborateMemory` is the NOOP operation — see the Store interface
  // for why an equivalent restatement must not go through `putMemory`.
  // `supersedeMemory` + `getMemoryById` are the activation: a reservation
  // becomes two stamps only at the moment its owner is confirmed.
  getScopedMemory(
    scope: MemoryItem['scope'],
    scopeKey: string,
    opts?: { status?: MemoryItem['status']; superseded?: boolean; limit?: number },
  ): MemoryItem[];
  getMemoryById(id: string): MemoryItem | undefined;
  corroborateMemory(
    id: string,
    sessionId: string,
    opts?: { createdFrom?: string; at?: number },
  ): boolean;
  supersedeMemory(oldId: string, newId: string, at?: number): boolean;
  // -- P3-M13c: the style fingerprint's single settings key -----------------
  setSetting(key: string, value: string): void;
}

/** The opt-in that lets consolidation confirm a corroborated proposal without a
 *  person (spec §5.4). Absent reads as OFF: silent promotion of memory is not
 *  something to opt someone out of after the fact. */
export const MEMORY_AUTO_CONFIRM_KEY = 'memory.autoConfirmCorroborated';

/** Read the opt-in. `'true'` and nothing else means on — the same 'true'/'false'
 *  spelling the telegram and gate settings already use. */
export function readAutoConfirmSetting(store: Pick<ReflectionStore, 'getSetting'>): boolean {
  return (store.getSetting(MEMORY_AUTO_CONFIRM_KEY) ?? 'false') === 'true';
}

/** Write the opt-in. */
export function writeAutoConfirmSetting(
  store: { setSetting(key: string, value: string): void },
  enabled: boolean,
): void {
  store.setSetting(MEMORY_AUTO_CONFIRM_KEY, enabled ? 'true' : 'false');
}

export type ReflectionSweepOptions = {
  /** The session currently being typed in — never reflected on (§4.3). */
  excludeSessionId?: string;
  /** Max sessions this sweep may process. Defaults to REFLECTION_SWEEP_CAP. */
  cap?: number;
  /** Injected clock, so a spike/test can make a session idle without waiting. */
  now?: number;
  /** Whose ledgers to read. Defaults to every registered agent (the ledger is
   *  keyed by agent and a session may hold rows for more than one). */
  agentIds?: string[];
};

export type ReflectionSweepResult = {
  /** Sessions whose cursor advanced — i.e. that were fully reflected on. */
  sweptSessions: number;
  /** Ledger rows marked `correctedAfter`. */
  markedEvents: number;
  /** Ledger rows stamped `reviewedAt` — every action that was actually put
   *  before the judge (P3-M8d). Always ≥ `markedEvents`: a corrected action was
   *  reviewed too. */
  reviewedEvents: number;
  /** Verdicts thrown out by the validator (bad case id, ungrounded quote). */
  droppedVerdicts: number;
  /** Memory rows written as `proposed` (P3-M8b). */
  proposedMemories: number;
  /** Memory candidates refused — ungrounded quote, a guard, or a gate deny.
   *  Counted rather than swallowed for the same reason `droppedVerdicts` is: a
   *  silent refusal is indistinguishable from a judge that proposed nothing. */
  droppedCandidates: number;
  /** Proposals the consolidation step confirmed on corroboration (P3-M8b §5.4).
   *  Always 0 while the opt-in setting is off. */
  autoConfirmed: number;
  /**
   * Confirmed memories nobody has used in `MEMORY_DECAY_REVIEW_MS` (P3-M10 §2.2)
   * — the size of the stale-review queue as of this sweep.
   *
   * A COUNT, and deliberately nothing more. The sweep does not delete these, does
   * not flag them and does not store the number: it is derived on every read from
   * `COALESCE(lastInjectedAt, updatedAt)`, reported here so the log says the queue
   * exists, and shown to the user behind the browser's "stale" filter, where a
   * PERSON decides between deleting a row and keeping it. §2.2 is explicit that
   * automatic deletion is not on the table.
   */
  staleForReview: number;
  /**
   * Sessions skipped because they are TEMPORARY (`noLearn`, §3). Reported so a
   * user who wonders why a long conversation taught nothing can see that it was
   * the flag rather than a failure — and so a spike can assert the skip happened
   * rather than merely that nothing was written.
   */
  skippedNoLearn: number;
  // -- P3-M13a (§3.1): what the four-op update actually did ------------------
  /** `equivalent` verdicts: an existing memory was corroborated and NOT
   *  rewritten. The operation that changes the least, counted so it is visible
   *  that the sweep decided to change nothing rather than failing to. */
  consolidatedNoops: number;
  /** `refines` verdicts: an existing key was written with a better value. */
  consolidatedUpdates: number;
  /** `contradicts` verdicts that produced a live RESERVATION — a new proposal
   *  that will retire an existing row if it is ever confirmed. Not the number of
   *  rows retired: a proposal supersedes nothing (§3.1). */
  supersessionsReserved: number;
  /** Reservations ACTIVATED during this sweep's consolidation — i.e. rows
   *  actually stamped `superseded_at`, each one behind a confirmation. */
  supersessionsActivated: number;
  /** Pair labels the validator threw out (an ungrounded quote, a pair the code's
   *  matcher never produced). Separate from `droppedCandidates` so "the model
   *  claimed a contradiction it could not evidence" is legible on its own. */
  droppedRelations: number;
  // -- P3-M13c (§3.3): the style half ---------------------------------------
  /** Style preferences written as `proposed` memory rows. */
  proposedStyles: number;
  /** User messages that went into this sweep's style-fingerprint batch. 0 when
   *  learning is off, which is the same thing as "no fingerprint was updated". */
  fingerprintSamples: number;
};

/** Every agent whose ledger might hold rows for these sessions. Best-effort: with
 *  no agent list the built-in persona is the only one that could have written. */
function agentIdsFor(store: ReflectionStore, opts?: ReflectionSweepOptions): string[] {
  if (opts?.agentIds) return opts.agentIds;
  try {
    const ids = store.listAgents().map((a) => a.id);
    return ids.length > 0 ? ids : [BUILTIN_PERSONA_ID];
  } catch {
    return [BUILTIN_PERSONA_ID];
  }
}

/** One session's ledger rows across every agent, oldest first. */
function sessionEvents(store: ReflectionStore, sessionId: string, agentIds: string[]): EvalEvent[] {
  const rows: EvalEvent[] = [];
  for (const agentId of agentIds) {
    try {
      rows.push(...store.listEvalEvents(agentId, { sessionId }));
    } catch {
      /* one agent's ledger being unreadable must not lose the others' */
    }
  }
  return rows.sort((a, b) => a.at - b.at);
}

/**
 * Reflect on up to `cap` idle sessions. Returns what it did, for logging and for
 * the `reflection.run` action.
 *
 * The judge is INJECTED (spec §4.4): production passes `modelReflectionJudge`,
 * spikes and tests pass a deterministic stub and drive this exact function, the
 * real validator and the real store.
 */
export async function runReflectionSweep(
  store: ReflectionStore,
  judge: ReflectionJudge,
  opts: ReflectionSweepOptions = {},
): Promise<ReflectionSweepResult> {
  const now = opts.now ?? Date.now();
  const cap = Math.max(0, opts.cap ?? REFLECTION_SWEEP_CAP);
  const result: ReflectionSweepResult = {
    sweptSessions: 0,
    markedEvents: 0,
    reviewedEvents: 0,
    droppedVerdicts: 0,
    proposedMemories: 0,
    droppedCandidates: 0,
    autoConfirmed: 0,
    staleForReview: 0,
    skippedNoLearn: 0,
    consolidatedNoops: 0,
    consolidatedUpdates: 0,
    supersessionsReserved: 0,
    supersessionsActivated: 0,
    droppedRelations: 0,
    proposedStyles: 0,
    fingerprintSamples: 0,
  };
  if (cap === 0) return result;

  // P3-M13c (§3.3): the style-fingerprint batch, accumulated across every
  // session this sweep reads and folded into the stored profile ONCE at the end.
  //
  // ONE WRITE PER SWEEP, not one per session, for the same reason consolidation
  // runs once: the profile is a property of the person, not of a conversation,
  // and rewriting a settings row three times to land on the same value is three
  // chances for two of them to be observed half-applied.
  const styleTexts: string[] = [];

  // P3-M10 (§3): the app-wide learning switch, read ONCE for the whole sweep.
  // Per-session would let a user flipping the setting mid-sweep get half a pass
  // with proposals and half without, which is a state nobody asked for.
  //
  // IT ONLY SILENCES THE MEMORY HALF. Corrections still run with learning off:
  // they are the agent being told it got something wrong, not a durable fact
  // being learned about the user, and the trust meter would go blind without
  // them (§3 scopes the switch to memory capture and says so).
  //
  // A THROWN READ MEANS "DO NOT LEARN", which is the opposite of
  // `readLearningEnabled`'s own default, and the two are answering different
  // questions. That function decides what an ABSENT or malformed VALUE means,
  // where the documented behaviour (learning on) is the right answer. Here the
  // STORE ITSELF could not be asked — so we do not know whether the user turned
  // learning off, and writing durable memory about them on a guess is the one
  // mistake a sovereignty switch must not make. Nothing is lost by waiting: the
  // next sweep with a readable store learns everything this one skipped, because
  // a session whose cursor did not advance is still due.
  //
  // It also keeps the sweep's oldest promise — it NEVER throws (see the
  // `listSessions` catch below and the per-session catch further down).
  let learningEnabled = false;
  try {
    learningEnabled = readLearningEnabled(store);
  } catch {
    console.warn('[reflection] learning setting unreadable — proposing no memory this sweep');
  }

  let sessions: SessionRef[];
  try {
    sessions = store.listSessions();
  } catch {
    return result; // no session list ⇒ nothing to reflect on; never a thrown sweep
  }

  const agentIds = agentIdsFor(store, opts);

  for (const session of sessions) {
    if (result.sweptSessions >= cap) break;
    if (session.sessionId === opts.excludeSessionId) continue;
    // A TEMPORARY SESSION IS NOT REFLECTED ON AT ALL (P3-M10 §3). Not "reflected
    // on but with the memory half suppressed" — skipped, before the transcript is
    // even read. The whole promise of the flag is that the conversation is not
    // mined afterwards, and a corrections-only pass would still be reading it and
    // still be writing `reviewedAt` rows that name it.
    //
    // The cursor is deliberately NOT advanced: the session simply never becomes
    // due, so if the user later clears the flag the backlog is still there to be
    // read rather than having been silently marked as already seen.
    if (session.noLearn === true) {
      result.skippedNoLearn += 1;
      continue;
    }
    // Cheap test first: the transcript is only loaded for a session that is
    // already idle, so a busy machine's active sessions cost nothing here.
    if (session.lastUsedAt + REFLECTION_IDLE_MS > now) continue;

    try {
      const messages = store.getMessages(session.sessionId);
      const latestSeq = messages.length - 1;
      const cursorSeq = store.getReflectionCursor(session.sessionId)?.lastSeq ?? -1;
      if (!isSessionDueForReflection(session, cursorSeq, latestSeq, now)) continue;

      const cases = buildReflectionCases({
        messages,
        events: sessionEvents(store, session.sessionId, agentIds),
        sinceSeq: cursorSeq,
      });

      // NO CASES IS NO LONGER THE END OF IT (M8c, §6.4). Through M8b a session
      // with nothing to judge was swept and dropped, which meant every purely
      // CONVERSATIONAL session — exactly the ones where a person says how they
      // want things done — taught nothing at all. Now such a session still earns
      // one memory-extraction call, provided it has said enough since the cursor
      // to be worth one.
      //
      // Below the threshold the old behaviour is unchanged and deliberate: no
      // call, and the cursor STILL advances, because the messages have been
      // looked at and re-reading them could only produce the same nothing.
      //
      // P3-M10: WITH LEARNING OFF THERE IS NO MEMORY-ONLY CALL. That call exists
      // for one purpose — extracting durable facts — so making it while the user
      // has said "do not learn from me" would spend their money on an answer the
      // sweep must then throw away. A case-less session is therefore swept and
      // dropped exactly as it was before M8c, and the cursor still advances,
      // because the messages HAVE been looked at (for corrections) and re-reading
      // them could only produce the same nothing.
      const mayExtractMemory = learningEnabled && shouldExtractMemoryOnly(messages, cursorSeq);
      if (cases.length === 0 && !mayExtractMemory) {
        store.setReflectionCursor(session.sessionId, latestSeq, now);
        result.sweptSessions += 1;
        continue;
      }

      // The user's own words in this window, with the seq of each — the evidence
      // space for the memory task AND the coordinate a proposal records as
      // `createdFrom` (§5.2).
      const userMessages = collectReflectionUserMessages(messages);
      // The threshold is counted over the WHOLE span since the cursor, while the
      // prompt only ever shows the recent window. On a transcript long enough for
      // those two to disagree there is nothing to put in a memory-only call, so
      // it is swept without one rather than sent an empty prompt.
      if (cases.length === 0 && userMessages.length === 0) {
        store.setReflectionCursor(session.sessionId, latestSeq, now);
        result.sweptSessions += 1;
        continue;
      }
      // P3-M13a (§3.1 step 1): what naby ALREADY remembers in the scopes this
      // session may propose into. Read here rather than inside the prompt
      // builder because only this layer has a store — the runtime stays pure.
      // A read failure is not fatal: with no existing rows the relation task is
      // simply dropped and every proposal is an ADD, which is exactly the
      // pre-M13a behaviour.
      const existingMemories = learningEnabled
        ? readExistingMemories(store, session.sessionId, session.cwd)
        : [];
      const context: ReflectionSessionContext = {
        sessionId: session.sessionId,
        ...(session.cwd ? { cwd: session.cwd } : {}),
        userMessages,
        ...(existingMemories.length > 0 ? { existingMemories } : {}),
      };

      // ONE model call per session (§6), answering BOTH tasks. A throw here
      // leaves the cursor where it was, so the evidence is re-read on the next
      // sweep rather than skipped.
      const answer = normalizeReflectionAnswer(await judge(cases, context));
      const { kept, dropped } = validateReflectionVerdicts(answer.corrections, cases);
      result.droppedVerdicts += dropped;

      // REVIEWED comes first, and it covers EVERY case that was put to the judge
      // — including the ones about to be marked corrected (P3-M8d, spec §7.2).
      //
      // WHY THE WHOLE LIST AND NOT JUST THE UNCORRECTED ONES. `reviewedAt` does
      // not mean "this was fine", it means "this was looked at". Stamping only
      // the survivors would make the field mean two things at once, and the
      // implicit half of the meter reads exactly this pair: reviewed AND not
      // corrected is the weak accept, reviewed AND corrected is the weak miss.
      // Stamping it before the corrections also keeps the ordering honest if a
      // store write throws halfway: a row can be reviewed-but-not-yet-corrected
      // (which the next sweep fixes), never corrected-but-never-reviewed.
      //
      // AND ONLY THE CASES. An action dropped before the call — no later user
      // message, no anchor, over the cap — was never put in front of anything,
      // so it stays unreviewed and simply does not count either way. A judge
      // that THREW never reaches this line at all (the catch below), which is
      // the same rule the cursor already follows.
      for (const one of cases) {
        if (store.markEvalEventReviewed(one.caseId, now)) result.reviewedEvents += 1;
      }

      for (const verdict of kept) {
        if (!verdict.corrected) continue;
        // `markEvalEventCorrected` refuses anything that is not an `autonomous`
        // row, so even a case list built from a corrupted ledger cannot rewrite a
        // check-in's label (contract invariant 8).
        if (store.markEvalEventCorrected(verdict.caseId)) result.markedEvents += 1;
      }

      // P3-M10: proposals are the half the learning switch silences (§3). The
      // judge may still have answered with some — the prompt asks for both tasks
      // — and they are dropped here rather than counted as refused: they were
      // never eligible, and inflating `droppedCandidates` would make "the model
      // proposed things the guards rejected" indistinguishable from "the user
      // turned learning off".
      if (learningEnabled) {
        // The PAIR LABELS, validated once for the whole session: a relation is
        // admissible only when the model quoted the user's own words for it, and
        // an `unrelated` (or missing) label is the ADD that M8b always did.
        const relations = validatePairRelations(answer.relations, userMessages);
        result.droppedRelations += relations.dropped;

        const { kept, dropped } = validateMemoryCandidates(answer.memories, userMessages, {
          hasCwd: Boolean(context.cwd),
        });
        result.droppedCandidates += dropped;
        proposeMemories(store, kept, context, relations, result);

        // P3-M13c (§3.3): style preferences travel the SAME path — they are
        // ordinary `procedural`/`user` memory with a namespaced key, so they go
        // through the same consolidation, the same gate and the same review
        // queue. Counted separately only so the log can say what kind of thing
        // the sweep learned.
        const styles = validateStyleCandidates(answer.styles ?? [], userMessages);
        result.droppedCandidates += styles.dropped;
        const beforeStyles = result.proposedMemories;
        proposeMemories(store, styles.kept, context, relations, result);
        result.proposedStyles += result.proposedMemories - beforeStyles;

        // And the deterministic half: the user's own words, banked for the one
        // fingerprint recomputation at the end of the sweep.
        for (const message of userMessages) styleTexts.push(message.text);
      }

      store.setReflectionCursor(session.sessionId, latestSeq, now);
      result.sweptSessions += 1;
    } catch (e) {
      // NO JUDGE AT ALL ends the sweep, and only this one does. Every other
      // failure is about ONE session and the next may still be readable, but a
      // machine with no judge will fail identically on all of them — so trying is
      // just N pointless attempts and N warnings for a single fact. Stopping here
      // leaves every session untouched: nothing stamped, no cursor moved, so the
      // whole backlog is still there for the first sweep that has a judge.
      //
      // Deliberately BEFORE the per-session warning, and deliberately a `break`
      // rather than a rethrow: consolidation below still runs, because promoting
      // an already-corroborated memory needs no model.
      if (e instanceof ReflectionJudgeUnavailableError) {
        console.log(`[reflection] sweep stopped: ${e.message}`);
        break;
      }
      // One unreadable session (or one failed judge call) must not end the sweep:
      // the others still have evidence worth reading.
      console.warn(
        `[reflection] session ${session.sessionId} skipped: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // CONSOLIDATION, once, at the END of the whole sweep (§5.4) — after every
  // session this pass will read has had its say, so a fact corroborated by two
  // sessions read in the SAME sweep is promoted in that sweep rather than
  // waiting for the next one.
  consolidateMemory(store, result, now);

  // THE STYLE FINGERPRINT, once, at the very end (P3-M13c §3.3). After
  // consolidation because it depends on nothing consolidation does, and after
  // the loop because it is one profile folded from every session read.
  updateStyleFingerprint(store, styleTexts, result, now);

  if (result.sweptSessions > 0 || result.markedEvents > 0 || result.proposedMemories > 0) {
    console.log(
      `[reflection] swept ${result.sweptSessions} session(s), reviewed ${result.reviewedEvents} action(s), ` +
        `marked ${result.markedEvents} corrected, ` +
        `dropped ${result.droppedVerdicts} verdict(s), proposed ${result.proposedMemories} memory row(s) ` +
        `(${result.proposedStyles} style), ` +
        `dropped ${result.droppedCandidates} candidate(s), auto-confirmed ${result.autoConfirmed}, ` +
        `consolidated ${result.consolidatedNoops} noop / ${result.consolidatedUpdates} update, ` +
        `supersession ${result.supersessionsReserved} reserved / ${result.supersessionsActivated} activated, ` +
        `dropped ${result.droppedRelations} relation(s), fingerprint samples ${result.fingerprintSamples}, ` +
        `stale-for-review ${result.staleForReview}, skipped-no-learn ${result.skippedNoLearn}`,
    );
  }
  // THE SWEEP, DURABLY (naby-activity-log §3). The console line above is the same
  // information and it is gone the moment the process is; a sweep is the one thing
  // that changes what the agent believes WITHOUT anybody watching, so its counts
  // belong in a file. The whole result object goes in: every field is a count.
  logActivity('reflection_run', { ...result });
  return result;
}

// ---------------------------------------------------------------------------
// The memory half (P3-M8b §5.2)
// ---------------------------------------------------------------------------

/** Fixed confidence for a reflection-captured row — the same value
 *  `naby_remember` stamps, and for the same reason: the model has no calibrated
 *  probability to report, the row is `proposed`, and a human decides. */
const REFLECTION_CONFIDENCE = 0.5;

/**
 * Validate the judge's memory proposals and write the survivors as `proposed`,
 * `artifact`-tier rows.
 *
 * EVERY GUARD THE TOOL PATH HAS, PLUS ONE. `validateMemoryCandidates` applies the
 * evidence check and the `naby_remember` guards; `putMemory` then applies the
 * memory write GATE (`decideMemoryWrite`), which is what refuses, for instance, a
 * write over a confirmed higher-tier row. That refusal THROWS by design (contract
 * §6: a refused write must be loud), so it is caught PER CANDIDATE — one denied
 * proposal must not cost the session its other proposals, its corrections, or its
 * cursor.
 *
 * `requestedStatus: 'proposed'` is not negotiable here. Only confirmed memory is
 * injected (contract §5), so nothing a background pass proposes can shape a turn
 * before a person — or the opt-in consolidation below — has agreed to it.
 */
function proposeMemories(
  store: ReflectionStore,
  kept: readonly ValidatedMemoryCandidate[],
  context: ReflectionSessionContext,
  relations: PairRelationLookup,
  result: ReflectionSweepResult,
): void {
  for (const candidate of kept) {
    // Scope → key is a runtime contract fact, so it is resolved by the runtime's
    // own resolver — the same one `naby_remember` uses — rather than by a second
    // copy of the mapping living in the shell.
    const scopeKey = resolveMemoryScopeKey(candidate.scope, {
      sessionId: context.sessionId,
      ...(context.cwd ? { cwd: context.cwd } : {}),
      userId: DEFAULT_USER_ID,
    });
    if (!scopeKey) {
      result.droppedCandidates += 1;
      continue;
    }

    const op = decideOperation(store, candidate, scopeKey, relations);
    const createdFrom = `${context.sessionId}:${candidate.evidenceSeq}`;

    // NOOP: the judge said this proposal is the SAME CLAIM as something already
    // remembered. Nothing is written; this session is recorded as agreeing with
    // the existing row, which is precisely the cross-session corroboration
    // signal §5.3 was built to accumulate. Deliberately NOT through `putMemory`
    // — see the Store interface for the two side effects that would cause.
    if (op.op === 'noop') {
      if (store.corroborateMemory(op.targetId, context.sessionId, { createdFrom })) {
        result.consolidatedNoops += 1;
      }
      continue;
    }

    try {
      store.putMemory({
        scope: candidate.scope,
        scopeKey,
        type: candidate.type,
        // UPDATE writes the EXISTING key (the upsert identity, so it lands on
        // that row); ADD writes the candidate's own.
        key: op.key,
        value: op.value,
        volatility: candidate.volatility,
        provenance: {
          // ARTIFACT, not 'user'. The model reading a preference out of a
          // conversation is not the user stating it, and the trust ordering has
          // to say so — a later `user`-tier row must be able to win.
          source: 'artifact',
          sessionId: context.sessionId,
          basis: 'observed in session reflection',
          // The exact message the quote came from (§5.2) — what makes this row
          // auditable later instead of merely attributed.
          createdFrom,
          // THE RESERVATION (§3.1), and note what it is not: nothing is retired
          // here. The row lands `proposed`, and `activateSupersession` turns this
          // field into two stamps only if and when a person — or the opt-in
          // corroboration path — confirms it.
          ...(op.op === 'add' && op.supersedes ? { supersedes: op.supersedes } : {}),
        },
        confidence: REFLECTION_CONFIDENCE,
        requestedStatus: 'proposed',
      });
      result.proposedMemories += 1;
      if (op.op === 'update') result.consolidatedUpdates += 1;
      if (op.op === 'add' && op.supersedes) result.supersessionsReserved += 1;
    } catch (e) {
      // A memory-gate deny. Counted, logged, and stepped over.
      result.droppedCandidates += 1;
      console.warn(
        `[reflection] proposal "${candidate.key}" refused: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

/**
 * Steps 1 and 3 of §3.1 around the model's step 2: match in CODE, look up the
 * label the model gave that pair, decide the operation in CODE.
 *
 * THE MATCHER IS THE GATE ON THE MODEL. A relation naming an existing row that
 * `matchCandidates` did not produce simply never gets looked up, so the judge
 * cannot invent a pairing — it can only label one the code already found. That
 * is what keeps "matching is code" true even though both happen in one call.
 *
 * The BEST match wins. Matches come back best-first, and the first one carrying a
 * non-`unrelated` label is the one acted on: a candidate relates to at most one
 * existing memory, because a proposal that contradicted three different rows at
 * once would need a policy for which to retire, and no such policy would be
 * better than "ask a person", which is what proposing already does.
 */
function decideOperation(
  store: ReflectionStore,
  candidate: ValidatedMemoryCandidate,
  scopeKey: string,
  relations: PairRelationLookup,
): ConsolidationOp {
  let existing: MemoryItem[] = [];
  try {
    existing = store.getScopedMemory(candidate.scope, scopeKey);
  } catch {
    // No rows readable ⇒ nothing to relate to ⇒ a plain ADD, which is the
    // pre-M13a behaviour. A background pass must not fail over a read.
    return applyConsolidation('unrelated', candidate);
  }

  for (const match of matchCandidates(candidate, existing)) {
    const verdict = relations.verdicts.get(pairKey(candidate.key, memoryHandle(match.item)));
    if (!verdict) continue;
    return applyConsolidation(verdict, candidate, match.item);
  }
  return applyConsolidation('unrelated', candidate);
}

/**
 * The memories the relation task is shown: everything naby holds in the scopes
 * this session could propose into, newest first, capped.
 *
 * BOTH STATUSES. A `proposed` row is still something the agent has written down,
 * and a second proposal that merely restates it should corroborate it rather
 * than create a near-duplicate — which is exactly the accumulation §1 describes.
 * Superseded rows are excluded by the matcher itself.
 *
 * NEVER THROWS: an unreadable scope contributes nothing and the sweep carries on.
 */
function readExistingMemories(
  store: ReflectionStore,
  sessionId: string,
  cwd?: string,
): MemoryItem[] {
  const targets: { scope: MemoryItem['scope']; scopeKey: string }[] = [
    { scope: 'user', scopeKey: DEFAULT_USER_ID },
  ];
  if (cwd) targets.push({ scope: 'project', scopeKey: cwd });
  const rows: MemoryItem[] = [];
  for (const target of targets) {
    try {
      rows.push(...store.getScopedMemory(target.scope, target.scopeKey, { superseded: false }));
    } catch {
      /* one unreadable scope must not cost the other its relations */
    }
  }
  // Newest first, then capped: the row a proposal is really about is
  // overwhelmingly one that was touched recently.
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return rows.slice(0, REFLECTION_EXISTING_CAP);
}

/**
 * TURN A RESERVATION INTO A SUPERSESSION — the one moment an old memory is
 * actually retired (P3-M13a §3.1).
 *
 * CALLED FROM EXACTLY THE TWO PLACES A ROW BECOMES CONFIRMED: the consolidation
 * step below (corroboration promotion) and the `/api/memory` confirm action (a
 * person clicking yes). Exported for the second of those, because the rule
 * "supersession requires confirmation" is only true if every confirmation path
 * runs it — and a rule enforced at one of two call sites is a rule that holds
 * until somebody uses the other one.
 *
 * IT REFUSES AN UNCONFIRMED ROW ITSELF rather than trusting the caller. The
 * whole guarantee of §3.1 is that a `proposed` candidate supersedes nothing, and
 * a guarantee that depends on the caller checking first is not one.
 *
 * The store applies the volatility rule and the already-superseded rule, so this
 * can return false for reasons that are not failures: a transient fact declining
 * to retire a stable one is the system working.
 */
export function activateSupersession(
  store: Pick<ReflectionStore, 'getMemoryById' | 'supersedeMemory'>,
  memoryId: string,
  at: number = Date.now(),
): boolean {
  let item: MemoryItem | undefined;
  try {
    item = store.getMemoryById(memoryId);
  } catch {
    return false;
  }
  if (!item || item.status !== 'confirmed') return false;
  const target = item.provenance.supersedes;
  if (!target) return false;
  try {
    const stamped = store.supersedeMemory(target, item.id, at);
    if (stamped) {
      console.log(
        `[reflection] memory "${item.key}" superseded "${target}" — the older row is kept, not deleted`,
      );
    }
    return stamped;
  } catch {
    return false;
  }
}

/**
 * Recompute the STYLE FINGERPRINT from the user messages this sweep read and
 * fold it into the stored profile (P3-M13c §3.3).
 *
 * NOTHING HERE IS A MODEL. It counts sentences. The gate it obeys is the same
 * `learningEnabled`/`noLearn` pair the LLM half obeys — the caller only ever
 * fills `texts` for sessions that passed both, so an empty batch IS the gate
 * having refused, and this returns having written nothing.
 *
 * NEVER THROWS, like every other end-of-sweep tidy-up: a settings write that
 * fails must not turn a successful sweep into a failed one.
 */
function updateStyleFingerprint(
  store: Pick<ReflectionStore, 'getSetting' | 'setSetting'>,
  texts: readonly string[],
  result: ReflectionSweepResult,
  now: number,
): void {
  if (texts.length === 0) return;
  try {
    const batch = computeStyleFingerprint(texts, now);
    if (batch.sampleCount === 0) return;
    const previous: StyleFingerprint | undefined = parseStyleFingerprint(
      store.getSetting(STYLE_FINGERPRINT_KEY),
    );
    const merged = mergeStyleFingerprint(previous, batch);
    store.setSetting(STYLE_FINGERPRINT_KEY, serializeStyleFingerprint(merged));
    result.fingerprintSamples = batch.sampleCount;
  } catch (e) {
    console.warn(
      `[reflection] style fingerprint skipped: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Promote `proposed` rows that enough DISTINCT sessions keep agreeing with
 * (§5.4). Opt-in, off by default, and never applied to `external`-origin memory
 * whatever the setting says — memory-contracts §4 invariant 1 reserves that path
 * for an explicit user action, and `shouldAutoConfirmMemory` is where all four
 * conditions are stated together.
 *
 * NEVER THROWS. Consolidation is a tidy-up at the end of a background pass; a
 * store hiccup here must not turn a successful sweep into a failed one.
 */
function consolidateMemory(
  store: ReflectionStore,
  result: ReflectionSweepResult,
  now: number,
): void {
  // -- THE STALE-REVIEW DERIVATION (P3-M10 §2.2) ---------------------------
  //
  // Runs FIRST, and unconditionally: it is independent of the auto-confirm
  // opt-in below (which returns early when off) and it must not be skipped by it.
  //
  // IT WRITES NOTHING. No status change, no flag, no deletion — it counts the
  // confirmed rows whose last use is older than the review window so the sweep
  // log can say the queue is there. The browser's "stale" filter re-derives the
  // same set on demand from the same cutoff (`staleReviewCutoff`), which is why
  // there is no stored state to keep in sync between them.
  //
  // Wrapped separately from the consolidation below so a store that cannot answer
  // this read still gets its proposals promoted, and vice versa.
  try {
    // `windowMs` is what makes the queue STRENGTH-AWARE (P3-M13b §3.2): without
    // it the store would answer the fixed 90-day question while
    // `isStaleForReview` answers the strength-scaled one, and the browser's
    // "unused" chip would list rows the runtime does not consider unused.
    const stale = store.listStaleConfirmedMemory(staleReviewCutoff(now, MEMORY_DECAY_REVIEW_MS), {
      windowMs: MEMORY_DECAY_REVIEW_MS,
    });
    result.staleForReview = stale.length;
    if (stale.length > 0) {
      console.log(
        `[reflection] ${stale.length} confirmed memory row(s) unused for over ` +
          `${Math.round(MEMORY_DECAY_REVIEW_MS / 86_400_000)} days — offered for review, not deleted`,
      );
    }
  } catch (e) {
    console.warn(
      `[reflection] stale review skipped: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  try {
    const enabled = readAutoConfirmSetting(store);
    // The read is skipped entirely while the opt-in is off, so the default costs
    // one settings lookup per sweep and nothing else.
    if (!enabled) return;

    const candidates = store.listCorroboratedProposed(CORROBORATION_THRESHOLD);
    if (candidates.length === 0) return;
    const counts = store.getMemoryCorroboration(candidates.map((item) => item.id));

    for (const item of candidates) {
      const corroboration = counts[item.id] ?? 0;
      // `shouldAutoConfirmMemory` is where ALL the conditions live, including
      // P3-M13c's: a `style/global/*` row is never promoted by corroboration
      // however many sessions agree, because a change to the agent's global tone
      // is the adaptation a user is least likely to notice happening.
      if (!shouldAutoConfirmMemory(item, corroboration, { enabled })) continue;
      store.confirmMemory(item.id);
      result.autoConfirmed += 1;
      // AND ONLY NOW may this row retire the one it contradicted (§3.1). The
      // reservation has been sitting on it since it was proposed and has changed
      // nothing; confirmation is what activates it.
      if (activateSupersession(store, item.id, now)) result.supersessionsActivated += 1;
      // Logged per promotion, by name and by evidence: a row that starts shaping
      // answers without anyone clicking anything has to be findable afterwards.
      console.log(
        `[reflection] auto-confirmed memory "${item.key}" (${item.scope}) — corroborated by ${corroboration} sessions`,
      );
    }
  } catch (e) {
    console.warn(
      `[reflection] consolidation skipped: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// The production judge
// ---------------------------------------------------------------------------

/** How long one judge call may take before it is abandoned. It is background work
 *  behind a user's turn — a hung provider must not keep a request alive for
 *  minutes, and giving up simply leaves the cursor unmoved. */
export const REFLECTION_JUDGE_TIMEOUT_MS = 60_000;

/**
 * THERE IS NO JUDGE ON THIS MACHINE. Thrown, never returned — and the difference
 * is the whole bug this class exists to fix.
 *
 * The judge used to answer "no provider configured" by returning `[]`, which is
 * the SAME value it returns for "I read the session and found nothing wrong".
 * The sweep cannot tell those apart, so it did what it does after a real answer:
 * stamped every case `reviewedAt` and advanced the cursor. On a subscription-only
 * machine — where credential resolution ALWAYS fails — that manufactured
 * evidence. `reviewedAt` with no correction is the weak ACCEPT the trust meter
 * blends into its bound (M8d, trust-meter §4.11), so every autonomous action the
 * agent had ever taken was quietly counted as having been looked at and let
 * stand, by nobody. The bound rose on an empty room.
 *
 * A throw is the correct shape because the sweep already handles it correctly:
 * the per-session catch skips the session WITHOUT stamping and WITHOUT moving the
 * cursor, so the evidence waits for a sweep that can actually read it.
 */
export class ReflectionJudgeUnavailableError extends Error {
  readonly name = 'ReflectionJudgeUnavailableError';
  constructor(message: string) {
    super(message);
  }
}

/** What one judge call needs: an engine to drive and the model selection to drive
 *  it with. Which of the two backends produced it is not otherwise interesting —
 *  the prompt, the empty toolset, the deny-all gate and the parse are identical.
 *
 *  Exported because the HANDOFF SUMMARIZER (lib/handoffSummary.ts) is the same
 *  kind of call and must pick its backend the same way. A second copy of that
 *  choice is how one feature ends up believing a sign-in the other cannot see. */
export type JudgeBackend = {
  engine: Engine;
  model: ModelSelection;
  /** Names which backend answered, for the log line — "reflection did nothing"
   *  is a very different report depending on which one was in use. */
  label: string;
};

/** The narrow slice a provider choice is read from: one settings reader. Same
 *  trick as `ReflectionStore` — a test hands this a plain object, and every real
 *  store (`Store`, `VoiceStore`) satisfies it structurally. */
export type JudgeProviderStore = Pick<ReflectionStore, 'getSetting'>;

/**
 * The provider the user picked, read the ONE way the turn path reads it.
 *
 * IT DELEGATES ON PURPOSE. `readSettings` + `toSelectOptions` is exactly what
 * `resolveMeteredProvider` (engines/naby.ts) calls, and re-spelling the settings
 * key here would be a second answer to "which provider did the user pick" — which
 * is how the background calls and the turn came to disagree in the first place.
 * This function exists to give the narrow-store callers (the voice port, the
 * handoff summariser) access to that one answer, not to become a second copy of it.
 *
 * `undefined` means AUTOMATIC — the user has chosen nothing, and the resolution
 * below keeps its old freedom to take the first configured provider.
 */
export function selectedJudgeProviderId(store: JudgeProviderStore): string | undefined {
  // `readSettings` touches nothing on the store but `getSetting`
  // (runtime/settings.ts), so the narrow slice IS its whole dependency. The cast
  // is what lets a caller holding only a settings reader — and a test holding a
  // plain object — reuse the runtime function instead of copying it.
  return toSelectOptions(readSettings(store as unknown as Store)).providerId;
}

export type JudgeBackendOptions = {
  /**
   * The provider the user picked, from `selectedJudgeProviderId`. Undefined means
   * "automatic" and restores the pre-choice behaviour exactly.
   */
  providerId?: string;
};

/**
 * Pick a backend for the judge, in the order that costs the user least.
 *
 * 1. AN API KEY, through the same `resolveProviderCredential` the engine uses,
 *    FOR THE PROVIDER THE USER PICKED. Preferred because it is a cheap, small,
 *    side call on a provider the user has already chosen, and because it is
 *    metered per token rather than counted against a subscription's rate limits.
 * 2. THE CLAUDE AGENT SDK, when a local sign-in is present. This is the path that
 *    used to be missing, and its absence was the reason reflection did nothing on
 *    subscription-only machines. Availability is asked of
 *    `isClaudeAgentSdkAvailable` — the ONE predicate for that question; a second
 *    copy of it here is exactly how a UI ends up believing the wrong one.
 *
 * WHY `providerId` IS AN ARGUMENT AND NOT A LOOKUP. This function used to call
 * `resolveProviderCredential({})` — no provider named at all — while the comment
 * above it claimed the call went to "a provider the user has already chosen".
 * Unforced, that resolution walks the profile list and takes the FIRST one holding
 * a key. So a user who picked Gemini had their reflection sweeps, their handoff
 * summaries and — through the naby voice layer, which runs on every turn — their
 * rewrites billed to whichever profile sorted first. The turn path had the same
 * defect and was fixed in `resolveMeteredProvider`; this is the other half of it.
 *
 * WHEN THE CHOSEN PROVIDER CANNOT BE RESOLVED, DO NOT TRY ANOTHER KEY. Step 1
 * fails and control drops straight to step 2 (the subscription) and, failing that,
 * to `undefined`. Reaching for a different metered key would BE the bug: it
 * charges an account the user never aimed this call at, and it does so silently,
 * because a background call has no screen to disagree on. The subscription is the
 * one permitted fallback precisely because it costs nothing per message and so
 * cannot surprise anyone with a bill. The rule is enforced by
 * `resolveProviderCredential` itself, which filters both the vault and the env
 * fallback by `providerId` when one is given — passing the id is the whole
 * mechanism, and `judgeBackendProviderChoice.test.ts` pins it.
 *
 * Returns undefined when neither exists. The caller turns that into a throw, not
 * into an empty answer — see `ReflectionJudgeUnavailableError`.
 */
export async function resolveJudgeBackend(
  opts: JudgeBackendOptions = {},
): Promise<JudgeBackend | undefined> {
  // An empty string is "automatic", not a provider named "" — `toSelectOptions`
  // already drops a blank choice, and this keeps a caller that spells it
  // differently on the same behaviour.
  const providerId = opts.providerId?.trim() || undefined;
  const resolution = await resolveProviderCredential(providerId ? { providerId } : {});
  if (resolution.ok) {
    const { profile, apiKey } = resolution.value;
    const base = makeModelResolver([profile], () => apiKeyCredential(apiKey));
    return {
      engine: new AiSdkEngine({
        resolveModel: (selection) => base(selection.providerId, selection.model),
      }),
      model: { providerId: profile.id, model: profile.model },
      label: `ai-sdk (${profile.id})`,
    };
  }

  if (isClaudeAgentSdkAvailable()) {
    // The judge names no cwd, and the SDK defaults `cwd` to `process.cwd()` — so
    // a background call would once have loaded THAT directory's CLAUDE.md,
    // settings and hooks (naby's own harness, in a development checkout) into a
    // call the user never made and cannot see. This constructor used to take an
    // `isolated: true` for exactly that. It no longer does, because the engine
    // now passes `settingSources: []` on EVERY call (harness-standalone §2.3) —
    // the judge gets the isolation unconditionally, and so does the user's turn.
    //
    // The model is left unset on purpose: the SDK picks the sign-in's default,
    // which is the same thing a dev-engine turn does (engines/naby.ts). Inventing
    // a model id here would be a guess that outlives the sign-in that made it
    // true.
    return {
      engine: new ClaudeAgentSdkEngine(),
      model: { providerId: 'dev-claude' },
      label: 'claude-agent-sdk (subscription)',
    };
  }

  return undefined;
}

/**
 * The model-backed judge: ONE call per session, no tools, strict JSON out.
 *
 * IT REUSES THE TURN PATH RATHER THAN OPENING A SECOND ONE. Both backends are the
 * ones the engine itself uses — `resolveProviderCredential` + `AiSdkEngine` for a
 * key, `ClaudeAgentSdkEngine` for a local Claude sign-in — so no provider is named
 * here, no key is read here, and adding a provider adds nothing to this file.
 *
 * IT NEVER TOUCHES THE TURN'S STORE STATE. `runTurn` is deliberately NOT used:
 * that would append the judge's prompt and answer to a user's transcript and file
 * a usage row against their conversation. The engine is driven directly, so
 * reflection leaves no trace in the session it is reading.
 *
 * WHAT [] MEANS, AND WHAT IT NO LONGER MEANS. `[]` is an ANSWER: the judge looked
 * and found nothing to correct. It is returned for an empty ask and for output
 * that parsed to no verdicts. "There is no judge here" is NOT that, and returning
 * `[]` for it is the bug documented on `ReflectionJudgeUnavailableError` — so
 * that case THROWS and the sweep leaves the session exactly as it found it. A
 * provider ERROR (a 401, a timeout) likewise propagates: an attempt that failed
 * has not read anything either.
 *
 * THE STORE IS FOR ONE THING: the user's provider choice, so the sweep bills the
 * provider they picked rather than whichever profile sorts first
 * (`resolveJudgeBackend`). It is read INSIDE the call, not here, because a judge
 * built at module scope can outlive the choice it was built under — a user who
 * switches provider mid-session must have the next sweep follow them. Optional so
 * the existing test callers, which inject their own judge anyway, are untouched;
 * omitting it means "automatic", the pre-choice behaviour.
 */
export function modelReflectionJudge(store?: JudgeProviderStore): ReflectionJudge {
  return async (cases: readonly ReflectionCase[], context?: ReflectionSessionContext) => {
    // NOTHING TO ASK ABOUT: no case to judge AND no conversation to read facts
    // out of. Since M8c the first half alone is no longer a reason to skip — a
    // case-less session with a real conversation in it is precisely what the
    // memory-only call exists for (§6.4).
    if (cases.length === 0 && (context?.userMessages.length ?? 0) === 0) {
      return [] as ReflectionVerdict[];
    }

    const providerId = store ? selectedJudgeProviderId(store) : undefined;
    const backend = await resolveJudgeBackend(providerId ? { providerId } : {});
    if (!backend) {
      throw new ReflectionJudgeUnavailableError(
        'no reflection judge is available: no provider API key is configured and the Claude Agent SDK is not installed',
      );
    }

    // The session context is what turns one call into two tasks (§5.2): with it
    // the prompt also asks for memory proposals, without it this is exactly the
    // M8a corrections-only call.
    const prompt = buildReflectionPrompt(cases, context);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REFLECTION_JUDGE_TIMEOUT_MS);
    let answer = '';
    try {
      for await (const event of backend.engine.run({
        model: backend.model,
        messages: [{ role: 'user', content: prompt.user }],
        system: prompt.system,
        toolSchemas: [],
        // The judge is given no tools; a gate that denies everything is the
        // belt-and-braces half of that, so a model that hallucinates a call can
        // do nothing with it. It matters MORE on the Agent SDK backend, whose
        // built-ins are live unless something stops them.
        gate: async () => ({ behavior: 'deny' as const, reason: 'the reflection judge runs without tools' }),
        executors: {},
        signal: controller.signal,
      })) {
        if (event.kind === 'text' && event.role === 'assistant' && !event.partial) {
          answer += event.text;
        }
      }
    } finally {
      clearTimeout(timer);
    }
    return parseReflectionAnswer(answer);
  };
}

// ---------------------------------------------------------------------------
// The fire-and-forget trigger (§4.3)
// ---------------------------------------------------------------------------

/** One sweep at a time per process. Without this, three quick turns would start
 *  three overlapping sweeps that all judge the same sessions and race each other
 *  to the same cursors. */
let sweepInFlight = false;

/**
 * Kick a sweep from a starting turn. Returns IMMEDIATELY and never throws: the
 * turn that triggered it must be byte-for-byte unaffected — nothing here touches
 * its prompt, its events or its timing.
 */
export function kickReflectionSweep(
  store: ReflectionStore,
  opts: ReflectionSweepOptions = {},
  // THE DEFAULT JUDGE IS BUILT FROM THIS SWEEP'S OWN STORE, which is what carries
  // the user's provider choice into the background call. A default argument may
  // name an earlier parameter, so the wiring costs nothing and cannot be forgotten
  // by a caller — the engine's fire-and-forget trigger (engines/naby.ts) passes
  // only the store and gets the right provider for free.
  judge: ReflectionJudge = modelReflectionJudge(store),
): void {
  if (sweepInFlight) return;
  sweepInFlight = true;
  void runReflectionSweep(store, judge, opts)
    .catch((e) => {
      console.warn(`[reflection] sweep failed: ${e instanceof Error ? e.message : String(e)}`);
    })
    .finally(() => {
      sweepInFlight = false;
    });
}
