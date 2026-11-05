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
  crossSessionTitleFromRequest,
  isUserAuthored,
  LIST_SESSIONS_CROSS_PROJECT_TOOL_SCHEMA,
  LIST_SESSIONS_TOOL_SCHEMA,
  logActivity,
  parseListSessionsInput,
  parseSendToSessionInput,
  resolveProjectRef,
  SEND_TO_SESSION_CROSS_PROJECT_TOOL_SCHEMA,
  SEND_TO_SESSION_TOOL_SCHEMA,
} from '../../../../../../../dist/naby-runtime.mjs';
import type {
  CrossSessionFailureReason,
  CrossSessionMeta,
  Executor,
  ListSessionsScope,
  SendToSessionInput,
  SessionRef,
  Store,
  ToolOutput,
  ToolSchema,
} from '../../../../../../../dist/naby-runtime.mjs';
import { extractRunAnswer } from './telegramChat';
import {
  crossProjectAccess,
  projectRefCandidates,
  readProjectGroups,
  type CrossProjectGuard,
  type CrossProjectStore,
} from './crossProject';
import { projectDisplayNames } from './projectDisplayName';

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
  /** The SENDER's project — the reply and the failure go back into it. */
  cwd: string;
  /** The target's project, when it is another one (cross-project-context R9):
   *  the request runs there. Absent = `cwd`. */
  targetCwd?: string;
  /** Project names, set only when the two sessions are in different projects:
   *  the sender's for B's header and pill, the target's for A's (R9, R10). */
  fromProject?: string;
  targetProject?: string;
  request: string;
  context?: string;
  expectReply: boolean;
  createdAt: number;
  /** cross-project-context R7d: the target session was opened by naby for a
   *  request (this one, or an earlier one still running there). */
  openedSession?: boolean;
  /** R7d: an earlier request to the same opened session that has not finished
   *  there yet — this one starts after it instead of racing it. */
  afterRequestId?: string;
  /** Set once the target's turn for this request is over (answered or failed),
   *  whatever is still left of the reply leg. */
  targetDone?: boolean;
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

/**
 * R7d: the session naby opened in `targetCwd` that is still busy with an
 * unfinished request — the next request to that project goes there rather
 * than opening a second one. The latest such request is returned so the next
 * one can line up behind it.
 */
export function openedSessionInFlight(
  store: Pick<Store, 'getSession'>,
  targetCwd: string,
): PendingCrossSession | undefined {
  let latest: PendingCrossSession | undefined;
  for (const r of pendingRegistry().values()) {
    if (!r.openedSession || r.targetDone || r.targetCwd !== targetCwd) continue;
    if (store.getSession(r.targetSessionId) === undefined) continue;
    if (!latest || r.createdAt >= latest.createdAt) latest = r;
  }
  return latest;
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
  /** cross-project-context R7: the tab's project, on every line when the
   *  cross-project list is in use. */
  project?: string;
  cwd?: string;
  /** A tab of another project not permanently allowed — same group included
   *  (cross-project-context 0.2.0): a send asks the user first. */
  needsApproval?: boolean;
};

/** R1: the OTHER sessions of this project (open tabs == project sessions). */
export function listOtherSessions(
  store: CrossSessionStore,
  hub: Pick<CrossSessionHub, 'isRunActive'>,
  self: { sessionId: string; cwd: string },
): CrossSessionListEntry[] {
  return sessionsOf(store, hub, self.cwd, self.sessionId);
}

/** The open tabs of one project, minus `selfId`, as list rows. */
function sessionsOf(
  store: CrossSessionStore,
  hub: Pick<CrossSessionHub, 'isRunActive'>,
  cwd: string,
  selfId: string,
): CrossSessionListEntry[] {
  return store
    .listSessionsByProject(cwd)
    .filter((s) => s.sessionId !== selfId)
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

/**
 * cross-project-context R7: the open tabs within `scope`. `project` is R1's
 * list; `group` adds the tabs of this project's sidebar group; `all` adds every
 * other project's. Listing needs no approval (titles are not content); a tab of
 * a project not permanently approved — same group included — is marked
 * `needsApproval`, and one this session declined is left out. Every row names
 * its project.
 */
export function listSessionsInScope(
  store: CrossSessionStore,
  projectStore: CrossProjectStore,
  hub: Pick<CrossSessionHub, 'isRunActive'>,
  self: { sessionId: string; cwd: string },
  scope: ListSessionsScope,
): CrossSessionListEntry[] {
  const nameOf = projectDisplayNames(projectStore);
  const tag = (rows: CrossSessionListEntry[], cwd: string, needsApproval = false) =>
    rows.map((r) => ({ ...r, project: nameOf(cwd) || cwd, cwd, ...(needsApproval ? { needsApproval: true } : {}) }));
  const out = tag(sessionsOf(store, hub, self.cwd, self.sessionId), self.cwd);
  if (scope === 'project') return out;
  let cwds: string[] = [];
  if (scope === 'group') {
    const mine = readProjectGroups(projectStore).find((g) => g.cwds.includes(self.cwd));
    cwds = mine ? mine.cwds.filter((c) => c !== self.cwd) : [];
  } else {
    try {
      cwds = projectStore.listProjects().map((p) => p.cwd).filter((c) => c !== self.cwd);
    } catch {
      cwds = [];
    }
  }
  for (const cwd of cwds) {
    const v = crossProjectAccess(projectStore, self.cwd, cwd, self.sessionId);
    if (v === 'denied' || v === 'unknown-project' || v === 'same-project') continue;
    out.push(...tag(sessionsOf(store, hub, cwd, self.sessionId), cwd, v === 'needs-approval'));
  }
  return out;
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
              ...(req.targetProject ? { fromProject: req.targetProject } : {}),
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
    req.targetDone = true;
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
        ...(req.targetProject ? { targetProject: req.targetProject } : {}),
      }),
      'failure',
    );
    if (!back.ok) {
      log('cross_session_message', { ...base, phase: 'dropped', why: back.why, ...(back.error ? { error: back.error } : {}) });
    }
    return { phase: 'failed', reason, reported: back.ok };
  };

  try {
    // 0. R7d: an earlier request to the same opened session is still running
    // there — start after it rather than burn the bounded busy retry on it.
    if (req.afterRequestId) {
      const waitUntil = now() + (deps.turnDeadlineMs ?? CROSS_SESSION_TURN_DEADLINE_MS);
      const pollMs = deps.pollMs ?? POLL_MS;
      for (;;) {
        const before = pendingRegistry().get(req.afterRequestId);
        if (!before || before.targetDone) break;
        if (!targetAlive()) return await fail('target-closed');
        if (now() >= waitUntil) return await fail('busy', 'an earlier request is still running there');
        await sleep(pollMs);
      }
    }

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
          ...(req.fromProject ? { fromProject: req.fromProject } : {}),
        }),
        // B works in ITS project (cross-project-context R9).
        cwd: req.targetCwd ?? req.cwd,
        crossSession: {
          requestId: req.requestId,
          fromSessionId: req.fromSessionId,
          fromTitle: req.fromTitle,
          role: 'request',
          ...(req.fromProject ? { fromProject: req.fromProject } : {}),
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
    req.targetDone = true;
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
        ...(req.targetProject ? { targetProject: req.targetProject } : {}),
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
  /** cross-project-context R7, R8: present when the setting is on. The list
   *  takes a `scope`, and a send to another project's tab passes the one
   *  access decision (asking the user when needed) instead of R6's refusal. */
  crossProject?: {
    /** Writable: R7d opens a session in the target project and names it. */
    store: CrossProjectStore & Pick<Store, 'createSession' | 'setSetting'>;
    guard: CrossProjectGuard;
    /** Tell the sidebar a project's session list changed (R7d). Defaults to the
     *  `project-state-changed` push the session tree refetches on. */
    announce?: (cwd: string) => void;
  };
}

/** The recent list's custom-title key — the same spelling as
 *  `customTitleKey` in `api/sessions/nabyBrowse.ts`, which cannot be imported
 *  here: it imports the engine adapter, and the adapter imports this module. */
export const crossSessionCustomTitleKey = (sessionId: string) => `session.customTitle.${sessionId}`;

/**
 * Tell every /ws/global-state viewer that `cwd`'s sessions changed, so an
 * expanded sidebar branch refetches and shows a session naby opened (R7d).
 * The removal list is empty: a viewer's tabs reconcile REMOVALS only
 * (useTabState), so nothing opens on screen. The client set is the one
 * `src/lib/globalStateBroadcast.ts` pins on `globalThis`; this package cannot
 * import that module, so it reads the same pin.
 */
export function announceProjectSessionsChanged(cwd: string): void {
  const clients = (globalThis as unknown as {
    __cockpitGlobalStateClients?: Set<{ readyState: number; send(data: string): void }>;
  }).__cockpitGlobalStateClients;
  if (!clients) return;
  const data = JSON.stringify({ type: 'project-state-changed', cwd, closedSessionIds: [] });
  for (const ws of clients) {
    // 1 = WebSocket.OPEN.
    if (ws.readyState !== 1) continue;
    try {
      ws.send(data);
    } catch {
      // One dead viewer must not stop the others.
    }
  }
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

  const list: Executor = async (raw) => {
    const self = { sessionId: deps.sessionId, cwd: deps.cwd };
    const hub = { isRunActive: deps.isRunActive };
    const scope = deps.crossProject ? parseListSessionsInput(raw).scope : 'project';
    const rows = deps.crossProject
      ? listSessionsInScope(deps.store, deps.crossProject.store, hub, self, scope)
      : listOtherSessions(deps.store, hub, self);
    const where = scope === 'project' ? 'in this project' : scope === 'group' ? "in this project's group" : 'in any project';
    if (rows.length === 0) {
      return { content: `No other session is open ${where}.`, data: { sessions: [] } };
    }
    const lines = rows.map(
      (r) =>
        `- ${r.sessionId} — "${r.title}"${r.project ? ` [project "${r.project}" — ${r.cwd}]` : ''}` +
        `${r.running ? ' (running a turn now)' : ''}${r.needsApproval ? ' (needsApproval: the user is asked before a request goes there)' : ''}` +
        (r.lastUserMessage ? `\n  last user message: ${r.lastUserMessage}` : ''),
    );
    return { content: `Other sessions ${where}:\n${lines.join('\n')}`, data: { sessions: rows } };
  };

  /** Register one request and start its delivery (detached). */
  const enqueue = (
    input: SendToSessionInput,
    target: SessionRef,
    extra: {
      targetCwd?: string;
      projectNames?: { from: string; target: string };
      openedSession?: { created: boolean; afterRequestId?: string };
    },
  ): ToolOutput => {
    const self = deps.store.getSession(deps.sessionId);
    const req: PendingCrossSession = {
      requestId: newId(),
      fromSessionId: deps.sessionId,
      fromTitle: self ? sessionLabel(self) : 'untitled',
      targetSessionId: target.sessionId,
      targetTitle: sessionLabel(target),
      cwd: deps.cwd,
      ...(extra.projectNames && extra.targetCwd
        ? { targetCwd: extra.targetCwd, fromProject: extra.projectNames.from, targetProject: extra.projectNames.target }
        : {}),
      request: input.request,
      ...(input.context ? { context: input.context } : {}),
      expectReply: input.expectReply,
      createdAt: now(),
      ...(extra.openedSession ? { openedSession: true } : {}),
      ...(extra.openedSession?.afterRequestId ? { afterRequestId: extra.openedSession.afterRequestId } : {}),
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
      ...(req.targetCwd ? { targetCwd: req.targetCwd } : {}),
      ...(extra.openedSession?.created ? { openedSession: true } : {}),
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
    const of = req.targetProject ? ` of project "${req.targetProject}"` : '';
    const where = extra.openedSession?.created
      ? `Opened a new conversation "${req.targetTitle}" in project "${req.targetProject ?? ''}" and sent the request there (request ${req.requestId}). ` +
        'It runs there now; the user finds it in the sidebar under that project (no tab was opened on screen).'
      : `Sent to "${req.targetTitle}"${of} (request ${req.requestId}). It runs there now, in its own tab.`;
    return {
      content: [
        where,
        req.expectReply
          ? 'Its answer will arrive in this session as a new message — do not wait or poll for it. Tell the user it was sent and end your turn.'
          : 'No answer will come back here.',
      ].join(' '),
      data: {
        ok: true,
        requestId: req.requestId,
        sessionId: req.targetSessionId,
        ...(extra.openedSession?.created ? { openedSession: true } : {}),
      },
    };
  };

  const capReached = (): ToolOutput | undefined =>
    pendingCountFrom(deps.sessionId) >= CROSS_SESSION_MAX_PENDING
      ? refuse(
          `Not sent: this session already has ${CROSS_SESSION_MAX_PENDING} requests waiting for an answer. Wait for one to come back.`,
        )
      : undefined;

  /**
   * cross-project-context R7c, R7d: `project` and no `sessionId`. The project
   * is resolved here — a cwd, a name or a sidebar number, with the sidebar's
   * own numbers (R7a, R7b) — then its tabs decide: one → that tab; several →
   * nothing is sent and the tabs are listed; none → a new session is opened
   * there, AFTER the approval card, and the request runs as its first turn.
   * A session opened for an earlier request that is still running there takes
   * the next one too, so one request never fans out into several new sessions.
   */
  const sendToProject = async (input: SendToSessionInput, toolCallId: string): Promise<ToolOutput> => {
    const cp = deps.crossProject!;
    const ref = resolveProjectRef(projectRefCandidates(cp.store), input.project ?? '', { selfCwd: deps.cwd });
    if (!ref.ok) return refuse(`Not sent: ${ref.error}.`);
    if (ref.cwd === deps.cwd) {
      return refuse('Not sent: that is this project — pass the sessionId of one of its tabs (naby_list_sessions).');
    }
    const full = capReached();
    if (full) return full;
    const nameOf = projectDisplayNames(cp.store);
    const projectNames = { from: nameOf(deps.cwd) || deps.cwd, target: ref.name };

    type Choice =
      | { kind: 'reuse'; session: SessionRef; after: PendingCrossSession }
      | { kind: 'tab'; session: SessionRef }
      | { kind: 'many'; tabs: SessionRef[] }
      | { kind: 'new' };
    // Synchronous on purpose: between this read and the session it may create
    // there is no await, so two calls released by one card cannot both open one.
    const choose = (): Choice => {
      const after = openedSessionInFlight(deps.store, ref.cwd);
      const opened = after ? deps.store.getSession(after.targetSessionId) : undefined;
      if (after && opened) return { kind: 'reuse', session: opened, after };
      const tabs = deps.store.listSessionsByProject(ref.cwd).filter((t) => t.sessionId !== deps.sessionId);
      if (tabs.length === 1) return { kind: 'tab', session: tabs[0]! };
      if (tabs.length > 1) return { kind: 'many', tabs };
      return { kind: 'new' };
    };
    const listTabs = (tabs: SessionRef[]): ToolOutput => ({
      content: [
        `Nothing was sent: project "${ref.name}" has ${tabs.length} open tabs. Ask the user which one, then call again with its sessionId:`,
        ...tabs.map((t) => `- ${t.sessionId} — "${sessionLabel(t)}"${deps.isRunActive(t.sessionId) ? ' (running a turn now)' : ''}`),
      ].join('\n'),
      data: {
        ok: false,
        reason: 'choose-tab',
        project: ref.name,
        cwd: ref.cwd,
        sessions: tabs.map((t) => ({ sessionId: t.sessionId, title: sessionLabel(t) })),
      },
    });

    let choice = choose();
    if (choice.kind === 'many') return listTabs(choice.tabs);
    const access = await cp.guard.check(
      { cwd: ref.cwd, name: ref.name },
      choice.kind === 'new'
        ? { feature: 'send', op: 'send', toolCallId, newSession: true }
        : { feature: 'send', op: 'send', toolCallId, sessionTitle: sessionLabel(choice.session) },
    );
    if (!access.ok) return refuse(access.content);
    // The card may have waited minutes: tabs, the opened session and the cap
    // are read again.
    choice = choose();
    if (choice.kind === 'many') return listTabs(choice.tabs);
    const fullNow = capReached();
    if (fullNow) return fullNow;
    if (choice.kind === 'reuse') {
      return enqueue(input, choice.session, {
        targetCwd: ref.cwd,
        projectNames,
        openedSession: { created: false, afterRequestId: choice.after.requestId },
      });
    }
    if (choice.kind === 'tab') return enqueue(input, choice.session, { targetCwd: ref.cwd, projectNames });

    // R7d: a normal session of the target project — its cwd, so its turns run
    // under that project's harness and it lists in that project's sidebar
    // branch — named after the request's first line, in both places a name
    // lives (the row's title for the session browser, the custom title for the
    // recent list), exactly as a fast-growth session is named at birth.
    const title = crossSessionTitleFromRequest(input.request);
    let created: SessionRef;
    try {
      created = cp.store.createSession('', title, ref.cwd);
      cp.store.setSetting(crossSessionCustomTitleKey(created.sessionId), title);
    } catch (e) {
      return refuse(`Not sent: could not open a new conversation in "${ref.name}": ${e instanceof Error ? e.message : String(e)}.`);
    }
    const out = enqueue(input, created, { targetCwd: ref.cwd, projectNames, openedSession: { created: true } });
    try {
      (cp.announce ?? announceProjectSessionsChanged)(ref.cwd);
    } catch {
      // The sidebar catches up on its next refetch; the request is already out.
    }
    return out;
  };

  const send: Executor = async (raw, ctx) => {
    const parsed = parseSendToSessionInput(raw, { allowProject: !!deps.crossProject });
    if (!parsed.ok) return refuse(`Not sent: ${parsed.error}.`);
    const input = parsed.input;
    if (!input.sessionId && input.project && deps.crossProject) return sendToProject(input, ctx.toolCall.toolCallId);
    if (input.sessionId === deps.sessionId) return refuse('Not sent: that is this session — pick another one.');
    const target = deps.store.getSession(input.sessionId);
    if (!target) return refuse(`Not sent: no session ${input.sessionId} exists. Call naby_list_sessions for the ids.`);
    const full = capReached();
    if (full) return full;
    // R6 — the same project only — unless cross-project is on, in which case the
    // one access decision answers (cross-project-context R8): a permanently
    // approved project goes; any other — same group included — asks first.
    const targetCwd = target.cwd ?? '';
    const otherProject = targetCwd !== deps.cwd;
    let projectNames: { from: string; target: string } | undefined;
    if (input.project && deps.crossProject) {
      // Both named: they must agree, or the model is confused about where it sends.
      const ref = resolveProjectRef(projectRefCandidates(deps.crossProject.store), input.project, {});
      if (ref.ok && ref.cwd !== targetCwd) {
        return refuse(`Not sent: session ${input.sessionId} is not in project "${ref.name}". Pass one of the two, not both.`);
      }
    }
    if (otherProject) {
      if (!deps.crossProject) return refuse('Not sent: that session belongs to another project.');
      const nameOf = projectDisplayNames(deps.crossProject.store);
      projectNames = { from: nameOf(deps.cwd) || deps.cwd, target: nameOf(targetCwd) || targetCwd || 'no project' };
      const access = await deps.crossProject.guard.check(
        { cwd: targetCwd, name: projectNames.target },
        { feature: 'send', op: 'send', toolCallId: ctx.toolCall.toolCallId, sessionTitle: sessionLabel(target) },
      );
      if (!access.ok) return refuse(access.content);
      // The card may have waited minutes: the cap and the tab are checked again.
      if (!deps.store.getSession(target.sessionId)) return refuse('Not sent: that session was closed while waiting for the user.');
      if (pendingCountFrom(deps.sessionId) >= CROSS_SESSION_MAX_PENDING) {
        return refuse(`Not sent: this session already has ${CROSS_SESSION_MAX_PENDING} requests waiting for an answer.`);
      }
    }
    return enqueue(input, target, projectNames ? { targetCwd, projectNames } : {});
  };

  return {
    schemas: deps.crossProject
      ? [LIST_SESSIONS_CROSS_PROJECT_TOOL_SCHEMA, SEND_TO_SESSION_CROSS_PROJECT_TOOL_SCHEMA]
      : [LIST_SESSIONS_TOOL_SCHEMA, SEND_TO_SESSION_TOOL_SCHEMA],
    executors: {
      [LIST_SESSIONS_TOOL_SCHEMA.name]: list,
      [SEND_TO_SESSION_TOOL_SCHEMA.name]: send,
    },
  };
}
