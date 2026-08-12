import { updateGlobalState, getSessionTitle } from '../state/globalState';
import {
  startRun,
  appendRun,
  rekeyRun,
  markRunIdle,
  isRunActive,
  setRunAbort,
  reserveRun,
  releaseRun,
} from '../sessionRunHub';
import { snapshotOnRunStart, snapshotOnRunEvent } from '../snapshot/hook';
import { mirrorTurn } from '../lib/telegramSync';
import { resolveCommandPrompt } from '../lib/slashCommands';
import { createTranscriptRecorder } from '../state/transcriptRecorder';
import { getStore } from './naby';
import { logActivity } from '../../../../../../../dist/naby-runtime.mjs';
import { randomUUID } from 'crypto';
import type { DispatchParams, DispatchOutcome, RunCtx, RunEvent, EngineSpec } from './types';

/**
 * The single run-lifecycle skeleton for ALL engines.
 *
 * Both the /api/chat[/engine] HTTP route and the scheduled-task manager call this directly
 * (no HTTP loopback → no port). It owns the guards (#10 one-active-per-session, #5 runId
 * idempotency), the run-registry lifecycle (startRun → setRunAbort → appendRun → markRunIdle),
 * the 'loading'/'unread' global-state transitions, and the detached fire-and-forget run.
 *
 * Engines provide ONLY `spec.runner.run(ctx)` — the engine-specific loop — plus optional
 * `preflight` and `resolveTitle`. Every event flows to the registry exactly as before, so
 * viewers still stream live via /ws/session-stream and the one-writer guard still holds.
 */
export async function dispatchChat(
  spec: EngineSpec,
  body: DispatchParams,
  request?: Request,
): Promise<DispatchOutcome> {
  const { sessionId, images, cwd, language } = body;

  // #10: one active run per session — a second concurrent write would corrupt the jsonl.
  if (sessionId && isRunActive(sessionId)) {
    return { ok: false, status: 409, error: 'session is already running' };
  }

  // Resolve slash commands (builtins /qa, /fx, … AND Naby-owned commands) by
  // language. `cwd` scopes which owned commands apply (user-scope always + this
  // project's project-scope commands); owned commands override a builtin of the
  // same verb (Phase 1.6 HP-02). Expansion is provider-independent (above the
  // engine seam), so it behaves identically on every engine.
  const rawPrompt = body.prompt;
  const prompt =
    typeof rawPrompt === 'string'
      ? resolveCommandPrompt(rawPrompt, language, cwd)
      : rawPrompt;

  // Allow images-only (no text).
  const hasContent = (prompt && typeof prompt === 'string') || (images && images.length > 0);
  if (!hasContent) {
    return { ok: false, status: 400, error: 'Missing prompt or images' };
  }

  // A turn for this session is now COMING. Said out loud here, before the
  // preflight await, because everything below this line can take a visible
  // amount of time (preflight may resolve a model or talk to the network) and a
  // tab that attaches during it would otherwise be told the session is idle and
  // show an empty conversation. Every headless caller — the fast-growth kickoff,
  // the Telegram bridge, a scheduled task — reaches the user's screen through
  // this one function, so the announcement is theirs too, for free.
  // Converted by startRun below; released on every path that returns without one.
  if (sessionId) reserveRun(sessionId);

  // Engine-specific pre-check BEFORE startRun (may resolve model / validate api key).
  if (spec.preflight) {
    const pre = await spec.preflight(body);
    if (!pre.ok) {
      if (sessionId) releaseRun(sessionId);
      return pre;
    }
  }

  const promptText = typeof prompt === 'string' ? prompt : undefined;

  // #10 ws-converge: the run is fully detached. Start synchronously (client can subscribe by
  // runKey at once), run in the background, return the runKey.
  const abort = new AbortController();
  const runId = (typeof body.runId === 'string' && body.runId) || randomUUID();
  // registry key: real sessionId for resume; provisional runId for new sessions (rekeyed to the
  // engine's real sessionId on reveal). currentKey/actualSessionId are mutated by rekey().
  let currentKey = sessionId || runId;
  let actualSessionId: string | undefined = sessionId;
  let isClosed = false;

  // #5 runId idempotency / #10 one-active: startRun is an atomic test-and-set — it returns false
  // if a turn is already live under currentKey. This is the single authoritative guard (the
  // earlier isRunActive at the top is a fast 409 with a clearer message); because it is atomic
  // it also covers a duplicate submit racing across the preflight await above, where two callers
  // could otherwise both pass a separate check-then-act.
  // runId doubles as the turn's identity marker on the seeded _human event (`_turnId`),
  // letting clients dedup the live user bubble without comparing prompt text.
  if (!startRun(currentKey, cwd || '', promptText, runId)) {
    // No turn is coming from THIS call. Releasing is safe even when the loser of
    // the race is this one: releaseRun stays silent while a run is live under the
    // key, so the winner's turn is never ended early.
    if (sessionId) releaseRun(sessionId);
    return { ok: false, status: 409, error: 'run already active' };
  }
  setRunAbort(currentKey, () => {
    isClosed = true;
    abort.abort();
  });

  // -- THE ACTIVITY LOG: the OUTER lifecycle (naby-activity-log §3) ----------
  //
  // WHY HERE. This function is the one door every turn comes through, on every
  // engine and from every caller — the HTTP route, the Telegram bridge, the
  // scheduler, the fast-growth kickoff. The runtime logs each MODEL turn from
  // inside `runTurn`, which is the right level for "what did the model do" and
  // the wrong one for "what did the user ask for": an autonomous run is many
  // model turns and one request. This pair brackets the request.
  //
  // Non-naby engines (claude / codex / kimi / ollama) never reach `runTurn`, so
  // for them this is the ONLY record — which is exactly why it lives in the
  // orchestrator rather than in the naby adapter.
  const runStartedAt = Date.now();
  const source = typeof body.source === 'string' ? body.source : 'chat';
  logActivity('run_started', {
    runId,
    runKey: currentKey,
    ...(sessionId ? { sessionId } : {}),
    engine: spec.name,
    source,
    ...(cwd ? { cwd } : {}),
    ...(promptText ? { prompt: promptText } : {}),
    imageCount: images?.length ?? 0,
  });
  // What the run reported on its way out, gathered from the event stream because
  // that is the only channel a runner has. `num_turns` and the autonomy markers
  // are already emitted for the client; reading them here costs nothing and
  // spares the engine interface a reporting channel it would otherwise need.
  let emittedEvents = 0;
  let autonomySteps = 0;
  let runResult: { isError?: boolean; numTurns?: number; text?: string } | undefined;
  if (cwd && sessionId) {
    updateGlobalState(cwd, sessionId, 'loading', undefined, promptText).catch(() => {});
  }
  // Tool-call snapshots: baseline commit of any pending external changes so the
  // first tool commit of this run diffs against the true pre-run state.
  snapshotOnRunStart(cwd || '', currentKey, spec.name);

  // Every session the app can show lives in the Naby store. Engines that do not
  // write there themselves get recorded from the event stream below, so that a
  // codex or ollama run is as visible — in the recent lists, the browsers, the
  // transcript view — as a Naby one. Flushed exactly once, on whichever
  // teardown path this run takes.
  const recorder = spec.persistsOwnTranscript
    ? undefined
    : createTranscriptRecorder({
        store: getStore,
        providerId: spec.name,
        ...(cwd ? { cwd } : {}),
        ...(promptText ? { prompt: promptText } : {}),
      });

  const ctx: RunCtx = {
    prompt: promptText,
    images,
    cwd: cwd || '',
    sessionId,
    params: body,
    signal: abort.signal,
    emit(event: RunEvent) {
      if (isClosed) return;
      emittedEvents += 1;
      if (event.type === 'result') {
        runResult = {
          isError: event.is_error === true,
          ...(typeof event.num_turns === 'number' ? { numTurns: event.num_turns } : {}),
          // The answer itself, for the Telegram mirror (telegram-chat §8.2) —
          // the same "last terminal result" the chat path reads from the run
          // snapshot, captured here so the teardown needs no snapshot lookup.
          ...(typeof event.result === 'string' && event.result ? { text: event.result } : {}),
        };
      } else if (event.type === 'system' && event.harness_subtype === 'autonomy') {
        // One marker per completed autonomy step (naby's own loop emits it).
        autonomySteps += 1;
      }
      appendRun(currentKey, event);
      // Tool-call snapshots: observe every engine's tool_use/tool_result here —
      // the single choke point all providers flow through. Fire-and-forget.
      snapshotOnRunEvent(cwd || '', currentKey, spec.name, event);
      // Same choke point, same reason: it is the one place every engine's
      // conversation is visible in a single shape.
      recorder?.observe(event);
    },
    rekey(realSessionId: string) {
      if (!realSessionId) return;
      // Always record the real session id in the registry (rekeyRun handles oldId===newId, the
      // ollama "runId IS the session id" case) so getRunSessionId resolves and scheduled tasks
      // can rebind instead of degrading to a fresh session every round.
      rekeyRun(currentKey, realSessionId);
      currentKey = realSessionId;
      actualSessionId = realSessionId;
      if (cwd) {
        updateGlobalState(cwd, realSessionId, 'loading', undefined, promptText).catch(() => {});
      }
    },
    currentKey() {
      return currentKey;
    },
  };

  /**
   * Telegram mirror (telegram-chat §8) — fire-and-forget, from the completed and
   * failed teardowns only (an abort is something the user did at the desktop).
   * Every mode/source/duplicate guard lives inside `mirrorTurn`; in the default
   * `manual` mode this is a config read and an early return.
   */
  const mirrorRunEnd = (outcome: { ok: boolean; error?: string }): void => {
    mirrorTurn(getStore(), {
      source,
      sessionId: actualSessionId ?? currentKey,
      ...(promptText ? { prompt: promptText } : {}),
      ok: outcome.ok,
      ...(runResult?.text ? { text: runResult.text } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      durationMs: Date.now() - runStartedAt,
      ...(runResult?.numTurns !== undefined ? { numTurns: runResult.numTurns } : {}),
      ...(autonomySteps > 0 ? { steps: autonomySteps } : {}),
    }).catch((e) => console.warn('[telegram] mirror failed:', e));
  };

  /** The closing record, written on every teardown path exactly once. */
  const logRunEnd = (
    kind: 'run_completed' | 'run_failed',
    extra: Record<string, unknown> = {},
  ): void => {
    logActivity(kind, {
      runId,
      runKey: currentKey,
      ...(actualSessionId ? { sessionId: actualSessionId } : {}),
      engine: spec.name,
      source,
      durationMs: Date.now() - runStartedAt,
      events: emittedEvents,
      // Steps, when the run was autonomous. A one-step turn emits no marker, so
      // the honest floor is 1 — and the per-step detail is in the runtime's own
      // `turn_started` records, which carry the same runId.
      steps: autonomySteps > 0 ? autonomySteps : 1,
      ...(runResult?.numTurns !== undefined ? { numTurns: runResult.numTurns } : {}),
      ...(runResult?.isError !== undefined ? { resultIsError: runResult.isError } : {}),
      ...extra,
    });
  };

  void (async () => {
    try {
      await spec.runner.run(ctx);
    } catch (error) {
      if (abort.signal.aborted) {
        // explicit stop: requestStop already emitted the terminal result + marked idle.
        isClosed = true;
        markRunIdle(currentKey, 'idle');
        // A stopped turn still happened: the user asked something and got part
        // of an answer. Record it rather than losing it for having ended early.
        recorder?.flush(actualSessionId);
        logRunEnd('run_completed', { aborted: true });
        return;
      }
      console.error(`[engine:${spec.name}] run error:`, error);
      // Emit the error event BEFORE the terminal mark — appendRun drops events once the run
      // leaves 'running', so the error must reach subscribers first. Prefer the bare message
      // (engines throw Error(msg)) over String(error)'s "Error: " prefix.
      ctx.emit({ type: 'error', error: error instanceof Error ? error.message : String(error) });
      markRunIdle(currentKey, 'error');
      isClosed = true;
      recorder?.flush(actualSessionId);
      logRunEnd('run_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      // A remote user must hear about a failure too — a turn that dies silently
      // reads as a turn still running (telegram-chat §8.2).
      mirrorRunEnd({ ok: false, error: error instanceof Error ? error.message : String(error) });
      // Best-effort teardown of global state even on failure.
      if (cwd && actualSessionId) {
        const title = await getSessionTitle(cwd, actualSessionId).catch(() => undefined);
        await updateGlobalState(cwd, actualSessionId, 'unread', title).catch(() => {});
      }
      return;
    }
    // Success teardown (shared across all engines). The transcript is written
    // BEFORE the status flips to 'unread': the status write is what wakes the
    // recent views, and they must not read a session whose rows are still
    // in flight.
    recorder?.flush(actualSessionId);
    if (cwd && actualSessionId) {
      const title = await (spec.runner.resolveTitle
        ? spec.runner.resolveTitle(cwd, actualSessionId).catch(() => undefined)
        : Promise.resolve(undefined));
      await updateGlobalState(cwd, actualSessionId, 'unread', title).catch(() => {});
    }
    isClosed = true;
    markRunIdle(currentKey, 'idle');
    logRunEnd('run_completed');
    mirrorRunEnd({
      ok: runResult?.isError !== true,
      ...(runResult?.isError === true && runResult.text ? { error: runResult.text } : {}),
    });
  })();

  return { ok: true, runKey: currentKey, sessionId: actualSessionId ?? null };
}
