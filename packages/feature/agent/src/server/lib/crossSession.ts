// packages/feature/agent/src/server/lib/crossSession.ts
//
// SESSIONS ASKING EACH OTHER FOR WORK (specs/cross-session-messaging.md).
//
// "2번 세션에 보내서 검색하고 결과를 받아 줘." naby in tab A calls
// `naby_send_to_session`; the tool returns at once with a request id, and A's
// turn carries on (or ends) without waiting. Behind it this module:
//
//   1. starts an ordinary turn in session B through `dispatchChat` — so B's tab
//      shows the work live over /ws/session-stream, exactly like a Telegram turn;
//   2. waits for that turn to leave the run registry and reads its answer out
//      (`extractRunAnswer`, the Telegram bridge's reader);
//   3. starts a NEW turn in A whose prompt is that answer, so naby there picks up
//      where it left off. A failure is reported the same way.
//
// NO NEW TURN MACHINERY, for the reason `backgroundJobReport.ts` gives: both legs
// are `dispatchChat(nabySpec, …)`, so memory, the gate, the unread badge and the
// activity log's run records are these turns' too. The busy-session race (a 409)
// gets the job report's BOUNDED retry, not a queue.
//
// THE PENDING SET IS MEMORY ONLY (§3.2): pinned on `globalThis` so a dev hot
// reload does not fork it, gone on restart. A request in flight when the app
// quits is simply lost; nothing is announced on the next boot (first-cut limit).
//
// THE PURE HALF — schemas, parser, the three prompts and their fencing — is the
// runtime's (`src/runtime/cross-session.ts`). This file is only the delivery.

import { randomUUID } from 'crypto';
import { defaultSessionName } from '@cockpit/shared-utils';
import {
  buildCrossSessionFailurePrompt,
  buildCrossSessionReplyPrompt,
  buildCrossSessionRequestPrompt,
  isUserAuthored,
  LIST_SESSIONS_TOOL_SCHEMA,
  logActivity,
  parseSendToSessionInput,
  SEND_TO_SESSION_TOOL_SCHEMA,
} from '../../../../../../../dist/naby-runtime.mjs';
import type {
  CrossSessionFailureReason,
  CrossSessionMeta,
  Executor,
  SessionRef,
  Store,
  ToolOutput,
  ToolSchema,
} from '../../../../../../../dist/naby-runtime.mjs';
import { extractRunAnswer } from './telegramChat';

/** The `source` stamped on both legs' runs (activity log, `roundEligible`). */
export const CROSS_SESSION_SOURCE = 'cross-session';

/** R10: the switch. Default ON; `'false'` turns both tools off. */
export const CROSS_SESSION_ENABLED_KEY = 'sessions.crossSession.enabled';

/** §3.4: unfinished requests one session may have out at once. */
export const CROSS_SESSION_MAX_PENDING = 3;

/** R8: how long B's turn may run before the request is reported as timed out. */
export const CROSS_SESSION_TURN_DEADLINE_MS = 30 * 60_000;

/** How long an answer waits for the SENDER to go idle before it is dropped. A
 *  long autonomous turn in A is legitimate, so this is the same bound as B's
 *  turn rather than the delivery retry's 2.5 minutes. */
export const CROSS_SESSION_SENDER_WAIT_MS = 30 * 60_000;

/** The 409 retry, the job report's numbers: five attempts, 30s apart (R8). */
export const CROSS_SESSION_MAX_ATTEMPTS = 5;
export const CROSS_SESSION_RETRY_MS = 30_000;

/** How often the wait asks whether B's turn is still alive. */
const POLL_MS = 500;

export function readCrossSessionEnabled(store: Pick<Store, 'getSetting'>): boolean {
  return (store.getSetting(CROSS_SESSION_ENABLED_KEY) ?? 'true') !== 'false';
}

export function writeCrossSessionEnabled(store: Pick<Store, 'setSetting'>, enabled: boolean): void {
  store.setSetting(CROSS_SESSION_ENABLED_KEY, enabled ? 'true' : 'false');
}

// ---------------------------------------------------------------------------
// Deps (injected, so a test runs with no model, no orchestrator, no timers)
// ---------------------------------------------------------------------------

export type CrossSessionStore = Pick<Store, 'getSession' | 'listSessionsByProject' | 'getMessages'>;

/** Start a turn. Production is `dispatchChat(nabySpec, …)`. */
export type CrossSessionDispatch = (input: {
  sessionId: string;
  prompt: string;
  cwd?: string;
  crossSession: CrossSessionMeta;
}) => Promise<{ ok: true; runKey: string } | { ok: false; status?: number; error?: string }>;

/** The slice of `sessionRunHub` the wait and the list read. */
export interface CrossSessionHub {
  isRunActive(key: string): boolean;
  getRunSnapshot(key: string): { events: readonly unknown[] } | undefined;
  requestStop(key: string): boolean;
  /** Announce a turn about to start (the job report's reservation). Optional:
   *  a no-op when absent. */
  reserveRun?(key: string): void;
  releaseRun?(key: string): void;
}

export interface CrossSessionDeps {
  store: CrossSessionStore;
  dispatch: CrossSessionDispatch;
  hub: CrossSessionHub;
  retryDelayMs?: number;
  maxAttempts?: number;
  turnDeadlineMs?: number;
  /** How long the reply / failure may wait for A to go idle (default 30 min). */
  senderWaitMs?: number;
  pollMs?: number;
  now?: () => number;
  /** Activity log sink; defaults to the runtime's `logActivity`. */
  log?: (kind: 'cross_session_message', payload: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// The pending set
// ---------------------------------------------------------------------------

export type PendingCrossSession = {
  requestId: string;
  fromSessionId: string;
  fromTitle: string;
  targetSessionId: string;
  targetTitle: string;
  cwd: string;
  request: string;
  context?: string;
  expectReply: boolean;
  createdAt: number;
};

const REGISTRY_KEY = Symbol.for('naby.crossSession.pending');

function pendingRegistry(): Map<string, PendingCrossSession> {
  const g = globalThis as unknown as Record<symbol, Map<string, PendingCrossSession> | undefined>;
  let m = g[REGISTRY_KEY];
  if (!m) {
    m = new Map();
    g[REGISTRY_KEY] = m;
  }
  return m;
}

/** Unfinished requests sent FROM this session (the §3.4 cap). */
export function pendingCountFrom(sessionId: string): number {
  let n = 0;
  for (const r of pendingRegistry().values()) if (r.fromSessionId === sessionId) n += 1;
  return n;
}

/** Tests only: forget every pending request. */
export function resetCrossSessionRegistry(): void {
  pendingRegistry().clear();
}

// ---------------------------------------------------------------------------
// Labels and the list
// ---------------------------------------------------------------------------

/** The name a tab shows for a session — its title, or the same default name the
 *  tab strip computes. */
export function sessionLabel(s: Pick<SessionRef, 'sessionId' | 'title' | 'createdAt'>): string {
  const t = (s.title ?? '').trim();
  return t.length > 0 ? t.slice(0, 80) : defaultSessionName(s.sessionId, s.createdAt);
}

export type CrossSessionListEntry = {
  sessionId: string;
  title: string;
  lastUserMessage?: string;
  running: boolean;
};

/** R1: the OTHER sessions of this project (open tabs == project sessions). */
export function listOtherSessions(
  store: CrossSessionStore,
  hub: Pick<CrossSessionHub, 'isRunActive'>,
  self: { sessionId: string; cwd: string },
): CrossSessionListEntry[] {
  return store
    .listSessionsByProject(self.cwd)
    .filter((s) => s.sessionId !== self.sessionId)
    .map((s) => {
      let last: string | undefined;
      try {
        const msgs = store.getMessages(s.sessionId);
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (m && m.role === 'user' && isUserAuthored(m)) {
            last = m.content.replace(/\s+/g, ' ').trim().slice(0, 120);
            break;
          }
        }
      } catch {
        // A transcript that cannot be read still lists by title.
      }
      return {
        sessionId: s.sessionId,
        title: sessionLabel(s),
        ...(last ? { lastUserMessage: last } : {}),
        running: hub.isRunActive(s.sessionId),
      };
    });
}

// ---------------------------------------------------------------------------
// The delivery
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type DispatchResult =
  | { started: true; runKey: string; attempts: number }
  | { started: false; reason: 'busy' | 'refused' | 'target-closed'; error?: string; attempts: number };

/** One dispatch with the job report's bounded 409 retry. `alive` is asked before
 *  every attempt, so a session closed while we wait is not resurrected. */
async function dispatchWithRetry(
  deps: CrossSessionDeps,
  input: Parameters<CrossSessionDispatch>[0],
  alive: () => boolean,
): Promise<DispatchResult> {
  const maxAttempts = deps.maxAttempts ?? CROSS_SESSION_MAX_ATTEMPTS;
  let attempts = 0;
  for (;;) {
    if (!alive()) return { started: false, reason: 'target-closed', attempts };
    attempts += 1;
    let outcome: Awaited<ReturnType<CrossSessionDispatch>>;
    try {
      outcome = await deps.dispatch(input);
    } catch (e) {
      return { started: false, reason: 'refused', error: e instanceof Error ? e.message : String(e), attempts };
    }
    if (outcome.ok) return { started: true, runKey: outcome.runKey, attempts };
    const error = outcome.status ? `${outcome.error ?? 'refused'} (${outcome.status})` : (outcome.error ?? 'refused');
    // 409 = a turn is running there right now; anything else will not improve.
    if (outcome.status !== 409) return { started: false, reason: 'refused', error, attempts };
    if (attempts >= maxAttempts) return { started: false, reason: 'busy', error, attempts };
    await sleep(deps.retryDelayMs ?? CROSS_SESSION_RETRY_MS);
  }
}

export type CrossSessionOutcome =
  | { phase: 'replied' | 'answered' }
  | { phase: 'dropped'; why: 'sender-closed' | 'sender-busy' | 'sender-refused' }
  | { phase: 'failed'; reason: CrossSessionFailureReason; reported: boolean };

/**
 * Carry one request to its end. Awaitable for the tests; the tool does not await
 * it. NEVER THROWS, and always removes the request from the pending set.
 */
export async function deliverCrossSession(
  deps: CrossSessionDeps,
  req: PendingCrossSession,
): Promise<CrossSessionOutcome> {
  const log = deps.log ?? ((kind, payload) => logActivity(kind, payload));
  const now = deps.now ?? (() => Date.now());
  const base = {
    requestId: req.requestId,
    fromSessionId: req.fromSessionId,
    targetSessionId: req.targetSessionId,
  };
  const targetAlive = () => deps.store.getSession(req.targetSessionId) !== undefined;
  const senderAlive = () => deps.store.getSession(req.fromSessionId) !== undefined;

  /** Put a reply or a failure into A (R4, R8). */
  const backToSender = async (
    prompt: string,
    role: 'reply' | 'failure',
  ): Promise<{ ok: true } | { ok: false; why: 'sender-closed' | 'sender-busy' | 'sender-refused'; error?: string }> => {
    // NOT the bounded 5×30s retry: A may legitimately be in a long turn (it
    // often is — it sent the request and kept working). The answer WAITS for A
    // to go idle, up to `senderWaitMs`, and is dropped only past that or when
    // A's tab was closed. A 409 at dispatch is the race of a new turn starting
    // in the gap, and just means "keep waiting".
    const a = req.fromSessionId;
    const deadline = now() + (deps.senderWaitMs ?? CROSS_SESSION_SENDER_WAIT_MS);
    const pollMs = deps.pollMs ?? POLL_MS;
    let lastError: string | undefined;
    for (;;) {
      if (!senderAlive()) {
        deps.hub.releaseRun?.(a);
        return { ok: false, why: 'sender-closed' };
      }
      if (!deps.hub.isRunActive(a)) {
        // Renewed on every attempt, as the job report does: the reservation has
        // a TTL, and a no-op while A's own run is live.
        deps.hub.reserveRun?.(a);
        let outcome: Awaited<ReturnType<CrossSessionDispatch>>;
        try {
          outcome = await deps.dispatch({
            sessionId: a,
            prompt,
            cwd: req.cwd,
            crossSession: {
              requestId: req.requestId,
              fromSessionId: req.targetSessionId,
              fromTitle: req.targetTitle,
              role,
            },
          });
        } catch (e) {
          deps.hub.releaseRun?.(a);
          return { ok: false, why: 'sender-refused', error: e instanceof Error ? e.message : String(e) };
        }
        if (outcome.ok) return { ok: true };
        lastError = outcome.status ? `${outcome.error ?? 'refused'} (${outcome.status})` : (outcome.error ?? 'refused');
        if (outcome.status !== 409) {
          deps.hub.releaseRun?.(a);
          return { ok: false, why: 'sender-refused', error: lastError };
        }
      }
      if (now() >= deadline) {
        deps.hub.releaseRun?.(a);
        return { ok: false, why: 'sender-busy', ...(lastError ? { error: lastError } : {}) };
      }
      await sleep(pollMs);
    }
  };

  const fail = async (reason: CrossSessionFailureReason, detail?: string): Promise<CrossSessionOutcome> => {
    log('cross_session_message', { ...base, phase: 'failed', reason, ...(detail ? { error: detail } : {}) });
    // `expectReply:false` was a fire-and-forget: the failure stays in the log.
    if (!req.expectReply) return { phase: 'failed', reason, reported: false };
    const back = await backToSender(
      buildCrossSessionFailurePrompt({
        requestId: req.requestId,
        targetSessionId: req.targetSessionId,
        targetTitle: req.targetTitle,
        request: req.request,
        reason,
        ...(detail ? { detail } : {}),
      }),
      'failure',
    );
    if (!back.ok) {
      log('cross_session_message', { ...base, phase: 'dropped', why: back.why, ...(back.error ? { error: back.error } : {}) });
    }
    return { phase: 'failed', reason, reported: back.ok };
  };

  try {
    // 1. Start B's turn.
    const started = await dispatchWithRetry(
      deps,
      {
        sessionId: req.targetSessionId,
        prompt: buildCrossSessionRequestPrompt({
          requestId: req.requestId,
          fromSessionId: req.fromSessionId,
          fromTitle: req.fromTitle,
          request: req.request,
          ...(req.context ? { context: req.context } : {}),
          expectReply: req.expectReply,
        }),
        cwd: req.cwd,
        crossSession: {
          requestId: req.requestId,
          fromSessionId: req.fromSessionId,
          fromTitle: req.fromTitle,
          role: 'request',
        },
      },
      targetAlive,
    );
    if (!started.started) return await fail(started.reason, started.error);
    log('cross_session_message', { ...base, phase: 'delivered', attempts: started.attempts });

    // 2. Wait for it to end (Telegram's wait: poll the registry, bounded).
    const deadline = now() + (deps.turnDeadlineMs ?? CROSS_SESSION_TURN_DEADLINE_MS);
    const pollMs = deps.pollMs ?? POLL_MS;
    while (deps.hub.isRunActive(started.runKey)) {
      if (!targetAlive()) {
        deps.hub.requestStop(started.runKey);
        return await fail('target-closed');
      }
      if (now() >= deadline) {
        deps.hub.requestStop(started.runKey);
        return await fail('timeout');
      }
      await sleep(pollMs);
    }
    if (!targetAlive()) return await fail('target-closed');
    const snap = deps.hub.getRunSnapshot(started.runKey);
    const answer = snap ? extractRunAnswer(snap.events) : { ok: false, error: 'the run left no result' };
    if (!answer.ok) return await fail('error', answer.error);
    const text = answer.text ?? '';
    log('cross_session_message', { ...base, phase: 'answered', answerChars: text.length });
    if (!req.expectReply) return { phase: 'answered' };

    // 3. The answer back into A — unless A's tab is gone (R8: drop it).
    if (!senderAlive()) {
      log('cross_session_message', { ...base, phase: 'dropped', why: 'sender-closed' });
      return { phase: 'dropped', why: 'sender-closed' };
    }
    const back = await backToSender(
      buildCrossSessionReplyPrompt({
        requestId: req.requestId,
        targetSessionId: req.targetSessionId,
        targetTitle: req.targetTitle,
        request: req.request,
        answer: text || '(the other session finished without a text answer)',
      }),
      'reply',
    );
    if (!back.ok) {
      log('cross_session_message', { ...base, phase: 'dropped', why: back.why, ...(back.error ? { error: back.error } : {}) });
      return { phase: 'dropped', why: back.why };
    }
    log('cross_session_message', { ...base, phase: 'replied' });
    return { phase: 'replied' };
  } catch (e) {
    // Defensive: every step above answers rather than throws.
    const why = e instanceof Error ? e.message : String(e);
    log('cross_session_message', { ...base, phase: 'failed', reason: 'error', error: why });
    return { phase: 'failed', reason: 'error', reported: false };
  } finally {
    pendingRegistry().delete(req.requestId);
  }
}

/**
 * The production deps: the ONE orchestrator every other turn goes through, and
 * the run hub. Imported HERE, inside the call — this module is imported by the
 * engine adapter, and the adapter by the orchestrator, so a static import back
 * would be a cycle (the `jobReportDispatch` precedent).
 */
export async function crossSessionRuntimeDeps(): Promise<CrossSessionDeps> {
  const [{ dispatchChat }, { nabySpec, getStore }, hub] = await Promise.all([
    import('../engines/orchestrator'),
    import('../engines/naby'),
    import('../sessionRunHub'),
  ]);
  return {
    store: getStore(),
    hub: {
      isRunActive: (k) => hub.isRunActive(k),
      getRunSnapshot: (k) => hub.getRunSnapshot(k) ?? undefined,
      requestStop: (k) => hub.requestStop(k),
      reserveRun: (k) => hub.reserveRun(k),
      releaseRun: (k) => hub.releaseRun(k),
    },
    dispatch: async ({ sessionId, prompt, cwd, crossSession }) => {
      const outcome = await dispatchChat(nabySpec, {
        source: CROSS_SESSION_SOURCE,
        prompt,
        sessionId,
        ...(cwd ? { cwd } : {}),
        engine: 'naby',
        crossSession,
      });
      return outcome.ok
        ? { ok: true, runKey: outcome.runKey }
        : { ok: false, status: outcome.status, error: outcome.error };
    },
  };
}

// ---------------------------------------------------------------------------
// The two tools
// ---------------------------------------------------------------------------

export interface CrossSessionToolDeps {
  store: CrossSessionStore;
  /** The session this turn runs in (the sender). */
  sessionId: string;
  /** This turn's project. The tools are only built when there is one. */
  cwd: string;
  /** For the list's `running` flag. */
  isRunActive: (key: string) => boolean;
  /** Resolved when a request is actually sent. */
  deliveryDeps?: () => Promise<CrossSessionDeps>;
  newId?: () => string;
  now?: () => number;
  log?: (kind: 'cross_session_message', payload: Record<string, unknown>) => void;
  /** Tests: observe the detached delivery. */
  onDelivery?: (p: Promise<CrossSessionOutcome>) => void;
}

const refuse = (content: string): ToolOutput => ({ content, isError: true });

/** Build `naby_list_sessions` + `naby_send_to_session` for one turn. */
export function makeCrossSessionTools(deps: CrossSessionToolDeps): {
  schemas: ToolSchema[];
  executors: Record<string, Executor>;
} {
  const log = deps.log ?? ((kind, payload) => logActivity(kind, payload));
  const newId = deps.newId ?? (() => `xs-${randomUUID().slice(0, 8)}`);
  const now = deps.now ?? (() => Date.now());

  const list: Executor = async () => {
    const rows = listOtherSessions(deps.store, { isRunActive: deps.isRunActive }, {
      sessionId: deps.sessionId,
      cwd: deps.cwd,
    });
    if (rows.length === 0) {
      return { content: 'No other session is open in this project.', data: { sessions: [] } };
    }
    const lines = rows.map(
      (r) =>
        `- ${r.sessionId} — "${r.title}"${r.running ? ' (running a turn now)' : ''}` +
        (r.lastUserMessage ? `\n  last user message: ${r.lastUserMessage}` : ''),
    );
    return { content: `Other sessions in this project:\n${lines.join('\n')}`, data: { sessions: rows } };
  };

  const send: Executor = async (raw) => {
    const parsed = parseSendToSessionInput(raw);
    if (!parsed.ok) return refuse(`Not sent: ${parsed.error}.`);
    const input = parsed.input;
    if (input.sessionId === deps.sessionId) return refuse('Not sent: that is this session — pick another one.');
    const target = deps.store.getSession(input.sessionId);
    if (!target) return refuse(`Not sent: no session ${input.sessionId} exists. Call naby_list_sessions for the ids.`);
    // R6: the same project only.
    if (target.cwd !== deps.cwd) return refuse('Not sent: that session belongs to another project.');
    if (pendingCountFrom(deps.sessionId) >= CROSS_SESSION_MAX_PENDING) {
      return refuse(
        `Not sent: this session already has ${CROSS_SESSION_MAX_PENDING} requests waiting for an answer. Wait for one to come back.`,
      );
    }
    const self = deps.store.getSession(deps.sessionId);
    const req: PendingCrossSession = {
      requestId: newId(),
      fromSessionId: deps.sessionId,
      fromTitle: self ? sessionLabel(self) : 'untitled',
      targetSessionId: target.sessionId,
      targetTitle: sessionLabel(target),
      cwd: deps.cwd,
      request: input.request,
      ...(input.context ? { context: input.context } : {}),
      expectReply: input.expectReply,
      createdAt: now(),
    };
    pendingRegistry().set(req.requestId, req);
    log('cross_session_message', {
      requestId: req.requestId,
      fromSessionId: req.fromSessionId,
      targetSessionId: req.targetSessionId,
      phase: 'sent',
      expectReply: req.expectReply,
      requestChars: req.request.length,
      contextChars: req.context?.length ?? 0,
    });
    const delivery = (async () => {
      try {
        const d = await (deps.deliveryDeps ?? crossSessionRuntimeDeps)();
        return await deliverCrossSession({ ...d, ...(deps.log ? { log: deps.log } : {}) }, req);
      } catch (e) {
        pendingRegistry().delete(req.requestId);
        const why = e instanceof Error ? e.message : String(e);
        log('cross_session_message', { requestId: req.requestId, phase: 'failed', reason: 'error', error: why });
        return { phase: 'failed', reason: 'error', reported: false } as CrossSessionOutcome;
      }
    })();
    deps.onDelivery?.(delivery);
    return {
      content: [
        `Sent to "${req.targetTitle}" (request ${req.requestId}). It runs there now, in its own tab.`,
        req.expectReply
          ? 'Its answer will arrive in this session as a new message — do not wait or poll for it. Tell the user it was sent and end your turn.'
          : 'No answer will come back here.',
      ].join(' '),
      data: { ok: true, requestId: req.requestId },
    };
  };

  return {
    schemas: [LIST_SESSIONS_TOOL_SCHEMA, SEND_TO_SESSION_TOOL_SCHEMA],
    executors: {
      [LIST_SESSIONS_TOOL_SCHEMA.name]: list,
      [SEND_TO_SESSION_TOOL_SCHEMA.name]: send,
    },
  };
}
