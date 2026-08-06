// packages/feature/agent/src/server/lib/fastGrowthKickoff.ts
//
// THE FAST-GROWTH SESSION SPEAKS FIRST (Phase 3, P3-M12b-3 — fast-evolution
// §3.3b).
//
// THE REPORT THIS EXISTS FOR. The button now creates a named session and opens
// it (§3.3a), and the user arrived at an EMPTY conversation. They did not know
// what was expected of them, typed "시작" to find out, and only then did naby
// begin the interview. The session whose entire purpose is that naby asks the
// questions was waiting to be asked a question.
//
// WHAT THIS DOES. Right after `session.fastGrowth.create` mints the session, one
// ordinary turn is dispatched into it headlessly, so the greeting is already in
// the transcript (or streaming into it) by the time the tab opens.
//
// NO NEW TURN MACHINERY. `dispatchChat(nabySpec, …)` is the SAME entry point the
// chat route, the scheduled-task manager (`scheduledTasks.ts:149`) and the
// Telegram bridge (`telegramChat.ts:634`) use. That matters beyond tidiness: the
// interview instruction, the memory-capture gate, the check-in sink and its
// session-derived `drill` stamp all hang off the engine's own per-turn reads, so
// a turn that took a side door would be a fast-growth turn that behaved like
// none of the others. This one is byte-for-byte what the user would have got by
// typing the same sentence.
//
// THE FOUR RULES IT IS BOUND BY, each one a way this could have gone wrong:
//
//   1. ONLY A FAST-GROWTH SESSION. The flag is re-read from the session row here
//      rather than trusted from the caller, so no other create path can grow a
//      kickoff by passing the wrong argument.
//   2. AT MOST ONCE, EVER. A marker setting is written BEFORE the dispatch, so a
//      re-open, a double click or a duplicated request cannot produce a second
//      opening question — and the second one would arrive with no context, which
//      is worse than none.
//   3. CREATION NEVER FAILS FOR IT. No engine configured, a refused preflight, a
//      thrown dispatch: all of it is logged and swallowed. The session still
//      exists, the tab still opens, and the user is where the previous build
//      left them — which is a worse screen, not a broken one.
//   4. IT DOES NOT HOLD THE RESPONSE. The caller does not await it (see
//      `startFastGrowthKickoff`), and the dispatch's own START is time-boxed so a
//      hung preflight cannot leave a promise pinned for the process's lifetime.
//      The run itself is detached by the orchestrator, and the tab renders it
//      live over /ws/session-stream whenever it lands.
//
// THE USER SIDE OF THE TURN IS AN HONEST SENTENCE, NOT A DISGUISE. `runTurn`
// appends the prompt as a `user` row (src/runtime/session.ts:169) and the
// transcript view renders every user row as a bubble; there is no "hidden
// message" concept in the schema, and both other headless callers — the
// scheduled task and the Telegram message — store their prompt as a plain user
// row too. Rather than invent a hidden kind for one feature, the kickoff says
// what actually happened: "빠른 성장 세션을 시작합니다." The words come from the
// CLIENT, like the session title and for the same reason — this server has no
// locale.

import type { Store } from '../../../../../../../dist/naby-runtime.mjs';
import { reserveRun, releaseRun } from '../sessionRunHub';

/** The marker that says this session's opening turn has already been fired. Per
 *  session, like `session.customTitle.*`, so it can never mean "some session was
 *  kicked off". */
export const kickoffKey = (sessionId: string) => `session.fastGrowthKickoff.${sessionId}`;

/** What the turn says when the client sent no words (no locale on this server).
 *  English, deliberately: a wrong-language sentence is recoverable, an empty
 *  prompt is a 400 and no greeting at all. */
export const DEFAULT_KICKOFF_TEXT = 'Starting the fast-growth session.';

/** A kickoff is one short sentence. The bound is here so a malformed request
 *  cannot turn the opening user bubble into an essay. */
export const KICKOFF_TEXT_MAX = 200;

/** How long to wait for the dispatch to START (not to finish — the run is
 *  detached). Preflight can talk to the network, and a preflight that never
 *  returns must not leave this promise pending for the life of the process. */
export const KICKOFF_START_TIMEOUT_MS = 15_000;

/** Everything the kickoff reads or writes on the store, and nothing more. */
export type KickoffStore = Pick<Store, 'getSession' | 'getSetting' | 'setSetting'>;

/** Start a turn. The production one is `dispatchChat(nabySpec, …)`; a test
 *  supplies its own so no model, key or network is involved. */
export type KickoffDispatch = (input: {
  sessionId: string;
  prompt: string;
  cwd?: string;
}) => Promise<{ ok: boolean; error?: string; status?: number }>;

export interface KickoffDeps {
  store: KickoffStore;
  dispatch: KickoffDispatch;
  /** Overridable so a test does not wait 15 seconds to observe the guard. */
  startTimeoutMs?: number;
}

/** Why a kickoff did not happen — returned for the caller's log and the tests,
 *  never shown to the user (the session is open either way). */
export type KickoffOutcome =
  | { started: true }
  | {
      started: false;
      reason: 'no-session' | 'not-fast-growth' | 'already-kicked' | 'refused' | 'threw' | 'timeout';
      error?: string;
    };

/**
 * Fire the opening turn of a fast-growth session, once.
 *
 * Awaitable so the tests can assert on it; the route does not await it (rule 4).
 * It NEVER throws: every failure path answers with a reason.
 */
export async function kickoffFastGrowthSession(
  deps: KickoffDeps,
  input: { sessionId: string; cwd?: string; text?: string },
): Promise<KickoffOutcome> {
  const { store } = deps;
  const sessionId = input.sessionId;

  // Rule 1 — re-read the flag from the row rather than trusting the caller. This
  // is the same reasoning the check-in sink applies to the `drill` stamp: the
  // session decides, and being asked nicely is not a decision.
  const session = store.getSession(sessionId);
  if (!session) return { started: false, reason: 'no-session' };
  if (session.fastGrowth !== true) return { started: false, reason: 'not-fast-growth' };

  // Rule 2 — the mark goes down BEFORE the await, so two callers racing here
  // cannot both pass. Left in place on failure too: "at most once" is the
  // invariant that protects the user from a second, contextless opening
  // question, and it outranks retrying an opening that did not work.
  if (store.getSetting(kickoffKey(sessionId))) {
    return { started: false, reason: 'already-kicked' };
  }
  store.setSetting(kickoffKey(sessionId), String(Date.now()));

  const text = normalizeKickoffText(input.text);

  // Rule 4 — the START is time-boxed. Losing the race only ends the WAIT: the
  // dispatch, if it ever gets going, still runs and still streams into the tab.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), deps.startTimeoutMs ?? KICKOFF_START_TIMEOUT_MS);
  });

  try {
    const raced = await Promise.race([
      deps.dispatch({ sessionId, prompt: text, ...(input.cwd ? { cwd: input.cwd } : {}) }),
      timeout,
    ]);
    if (raced === 'timeout') {
      console.warn(`[fastGrowth] kickoff did not start within the deadline (session ${sessionId})`);
      return { started: false, reason: 'timeout' };
    }
    if (!raced.ok) {
      // The ordinary shape of "there is no engine configured": preflight refuses
      // before a run starts, so NOTHING was written — not even the user row —
      // and the session is exactly the empty one the previous build produced.
      const why = raced.status ? `${raced.error} (${raced.status})` : (raced.error ?? 'refused');
      console.warn(`[fastGrowth] kickoff refused for session ${sessionId}: ${why}`);
      return { started: false, reason: 'refused', error: why };
    }
    console.log(`[fastGrowth] kickoff turn started on session ${sessionId}`);
    return { started: true };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    console.warn(`[fastGrowth] kickoff failed for session ${sessionId}: ${why}`);
    return { started: false, reason: 'threw', error: why };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Trim, bound, and fall back to English when the client sent nothing usable. */
export function normalizeKickoffText(text: string | undefined): string {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  return trimmed ? trimmed.slice(0, KICKOFF_TEXT_MAX) : DEFAULT_KICKOFF_TEXT;
}

/**
 * The production dispatch: the ONE orchestrator every other turn goes through.
 *
 * The engine modules are imported HERE, inside the call, exactly as
 * `chatRuntimeDeps` does it — `/api/naby` is imported by every settings request,
 * and a static import would drag the engine composition root into requests that
 * only ever wanted to read a checkbox.
 */
export async function kickoffDispatch(): Promise<KickoffDispatch> {
  const [{ dispatchChat }, { nabySpec }] = await Promise.all([
    import('../engines/orchestrator'),
    import('../engines/naby'),
  ]);
  return async ({ sessionId, prompt, cwd }) => {
    const outcome = await dispatchChat(nabySpec, {
      // Descriptive only: the activity log stamps it so a drill's first turn is
      // distinguishable from something the user typed.
      source: 'kickoff',
      prompt,
      sessionId,
      ...(cwd ? { cwd } : {}),
      engine: 'naby',
    });
    return outcome.ok
      ? { ok: true }
      : { ok: false, error: outcome.error, status: outcome.status };
  };
}

/**
 * FIRE AND FORGET (rule 4). Returns immediately; the caller answers its own
 * request without waiting for a model.
 *
 * The returned promise is for the TESTS (and for a caller that wants to log the
 * outcome); it never rejects.
 *
 * IT SAYS "A TURN IS COMING" BEFORE IT DOES ANYTHING ELSE (§3.3c). The route
 * that calls this returns the session id straight afterwards, and the client
 * OPENS that session — so the tab's /ws/session-stream attach races everything
 * below, including the dynamic import of the engine composition root inside
 * `kickoffDispatch`. The tab usually won that race and was told the session was
 * idle, which is the empty conversation the user reported. The reservation is
 * therefore made SYNCHRONOUSLY, before the first await, so the attach cannot
 * arrive ahead of it; `startRun` converts it, and every path that ends without a
 * turn drops it again so the indicator can never outlive the thing it describes.
 */
export function startFastGrowthKickoff(input: {
  store: KickoffStore;
  sessionId: string;
  cwd?: string;
  text?: string;
}): Promise<KickoffOutcome> {
  reserveRun(input.sessionId);
  return (async () => {
    try {
      const dispatch = await kickoffDispatch();
      const outcome = await kickoffFastGrowthSession(
        { store: input.store, dispatch },
        {
          sessionId: input.sessionId,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.text ? { text: input.text } : {}),
        },
      );
      // No turn started (no engine, a refusal, a session that is not fast-growth,
      // a kickoff already spent, or a START that timed out). Whoever is watching
      // this session must stop waiting for it. A turn that DID start already owns
      // the key, and releaseRun stays silent in that case.
      if (!outcome.started) releaseRun(input.sessionId);
      return outcome;
    } catch (e) {
      // Even loading the engine module must not surface as a failed creation.
      releaseRun(input.sessionId);
      const why = e instanceof Error ? e.message : String(e);
      console.warn(`[fastGrowth] kickoff could not be started: ${why}`);
      return { started: false, reason: 'threw', error: why } as const;
    }
  })();
}
