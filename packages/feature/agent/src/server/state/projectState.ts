/**
 * projectState — what a POST to `/api/project-state` MEANS, as a pure function.
 *
 * The route (src/app/api/project-state/route.ts) keeps the HTTP: parse the JSON,
 * turn a rejection into a ValidationError, wrap the store work in Effect.try,
 * broadcast. Everything that decides *what happens* lives here, against an
 * injected store, so it is a unit rather than something only a running server
 * can answer.
 *
 * TWO REQUEST SHAPES, NOT ONE SHAPE WITH AN OPTIONAL cwd.
 *
 * A project save is what a tab writes: "these are my sessions in this project,
 * this one is active, these plan modes, and these I closed". It is meaningless
 * without a cwd, and that requirement is NOT relaxed here — a save whose cwd went
 * missing is still refused, because the alternative (link nothing, silently) is a
 * far worse bug than the one this file was reopened to fix.
 *
 * A PROJECTLESS CLOSE is a different sentence: "delete these session ids". It
 * carries no cwd because there is no project, and it carries no `sessions`
 * because there is no list to link. It is marked `scope: 'projectless'` rather
 * than being inferred from a missing cwd, so the two can never be confused:
 * a project save never sets `scope`, so a lost cwd can only ever land in the
 * project branch and fail there.
 *
 * WHY IT EXISTS AT ALL. Legacy rows arrive with `cwd === ''` and are deliberately
 * still listed in the recent views (recentFilter.ts). Removal has exactly one
 * channel — `closedSessionIds` on this route — and that channel used to be
 * addressable only through a project, so those rows could not be deleted at all;
 * the × on them was rendered disabled. The capability was never missing:
 * `store.deleteSession(sessionId)` takes an id and nothing else. Only the
 * REQUEST was shaped around a project. So this adds a shape, not a second route
 * and not a second removal path — both shapes end in the same deletion loop.
 */
import type { SessionRef, Store } from '../../../../../../../dist/naby-runtime.mjs';
// The plan-mode setting key is OWNED by the handoff flow's module, which also
// writes one when a session is continued in a new tab. Imported rather than
// re-derived: a second copy of the key is how a continued session gets its plan
// mode stored where this reader never looks.
import { sessionPlanModeKey } from '../lib/sessionHandoff';

/** The slice of the store this route touches. Narrow on purpose: it is the whole
 *  contract, so a test can satisfy it without a database. */
export type ProjectStateStore = Pick<
  Store,
  | 'listSessionsByProject'
  | 'getSession'
  | 'setSessionProject'
  | 'deleteSession'
  | 'getSetting'
  | 'setSetting'
>;

/** The wire state of one project — what a GET answers and a POST echoes back. */
export interface ProjectState {
  sessions: string[];
  activeSessionId?: string;
  planModes?: Record<string, boolean>;
}

export const activeSessionKey = (cwd: string) => `ui.activeSession.${cwd}`;
export const planModeKey = sessionPlanModeKey;

/**
 * A save from a project tab. `cwd` is REQUIRED and load-bearing: it is what the
 * incoming sessions get linked to, what the active session is keyed by, and what
 * the response is read back from.
 */
export interface ProjectSaveRequest {
  kind: 'project';
  cwd: string;
  sessions: string[];
  activeSessionId?: string;
  planModes: Record<string, boolean>;
  closedSessionIds: string[];
}

/**
 * A removal with no project behind it. Deletion only — no cwd, no session list,
 * nothing to link. `closedSessionIds` is non-empty by construction: a request
 * that removes nothing has no reason to exist and would broadcast a change that
 * did not happen.
 */
export interface ProjectlessCloseRequest {
  kind: 'projectless';
  closedSessionIds: string[];
}

export type ProjectStateRequest = ProjectSaveRequest | ProjectlessCloseRequest;

/** Why a body was refused — the exact pair the route hands to ValidationError. */
export interface ProjectStateRequestError {
  field: string;
  reason: string;
}

export type ParsedProjectStateRequest =
  | { ok: true; request: ProjectStateRequest }
  | { ok: false; error: ProjectStateRequestError };

/** The discriminator that names a projectless close. */
export const PROJECTLESS_SCOPE = 'projectless';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length > 0);

const fail = (field: string, reason: string): ParsedProjectStateRequest => ({
  ok: false,
  error: { field, reason },
});

/**
 * Interpret a POST body as one of the two shapes, or say why it is neither.
 *
 * Order matters and is the whole safety argument: `scope` is read FIRST, and
 * anything without it is a project save that must produce a cwd. A tab whose cwd
 * went missing therefore fails loudly here instead of being mistaken for a
 * projectless close and skipping every link it owed.
 *
 * The projectless branch is strict in the other direction: it refuses a `cwd` and
 * refuses a `sessions` list, so a project save cannot be mislabelled into it
 * either. The two shapes have no body that satisfies both.
 */
export function parseProjectStateRequest(body: unknown): ParsedProjectStateRequest {
  if (!isRecord(body)) return fail('body', 'must be an object');

  if (body.scope !== undefined) {
    if (body.scope !== PROJECTLESS_SCOPE) return fail('scope', 'unknown');
    // A projectless close is deletion and nothing else.
    if (body.cwd !== undefined) return fail('cwd', 'not allowed for a projectless close');
    if (body.sessions !== undefined) {
      return fail('sessions', 'not allowed for a projectless close');
    }
    if (!isStringArray(body.closedSessionIds) || body.closedSessionIds.length === 0) {
      return fail('closedSessionIds', 'must be a non-empty array of session ids');
    }
    return { ok: true, request: { kind: 'projectless', closedSessionIds: [...body.closedSessionIds] } };
  }

  // ── a project save: the original contract, unrelaxed ──
  if (typeof body.cwd !== 'string' || body.cwd.length === 0) {
    return fail('cwd', 'missing');
  }
  if (!Array.isArray(body.sessions)) return fail('sessions', 'must be array');

  const closedSessionIds = Array.isArray(body.closedSessionIds)
    ? body.closedSessionIds.filter((s): s is string => typeof s === 'string' && s.length > 0)
    : [];
  const planModesIn = isRecord(body.planModes) ? body.planModes : {};
  const planModes: Record<string, boolean> = {};
  for (const [sid, on] of Object.entries(planModesIn)) planModes[sid] = Boolean(on);

  return {
    ok: true,
    request: {
      kind: 'project',
      cwd: body.cwd,
      sessions: body.sessions.filter((s): s is string => typeof s === 'string'),
      ...(typeof body.activeSessionId === 'string' ? { activeSessionId: body.activeSessionId } : {}),
      planModes,
      closedSessionIds,
    },
  };
}

/**
 * The cwd a `project-state-changed` broadcast carries for this request.
 *
 * A projectless close announces `''` — the very cwd those sessions carry
 * everywhere else on the wire (recentSessions.ts normalises `ref.cwd ?? ''`).
 * The broadcast is NOT optional for them: a projectless session can be open in a
 * tab of any project, so its removal has to reach every viewer, and `''` matches
 * no viewer's own cwd by design — the client treats it as "applies to all"
 * (closedSessionIdsForViewer in projectSessionTree.ts).
 */
export function broadcastCwdOf(request: ProjectStateRequest): string {
  return request.kind === 'projectless' ? '' : request.cwd;
}

/**
 * Build the wire state for a project from the store: the MRU session list, the
 * stored/derived active session, and the per-session plan-mode flags for exactly
 * the sessions in the list.
 */
export function readProjectState(store: ProjectStateStore, cwd: string): ProjectState {
  const sessions = store.listSessionsByProject(cwd).map((s: SessionRef) => s.sessionId);
  const inSet = new Set(sessions);

  const storedActive = store.getSetting(activeSessionKey(cwd));
  const activeSessionId = storedActive && inSet.has(storedActive) ? storedActive : sessions[0];

  const planModes: Record<string, boolean> = {};
  for (const sid of sessions) {
    if (store.getSetting(planModeKey(sid)) === 'true') planModes[sid] = true;
  }

  return {
    sessions,
    ...(activeSessionId ? { activeSessionId } : {}),
    ...(Object.keys(planModes).length ? { planModes } : {}),
  };
}

/**
 * Apply a parsed request to the store and return what the caller reads back.
 *
 * ONE REMOVAL LOOP, shared by both shapes — `deleteSession` drops the session and
 * everything keyed to it, and it takes a session id and nothing else, which is
 * why a projectless close was always possible. It runs FIRST so a session that is
 * both listed and closed ends up closed.
 *
 * A projectless close answers with an empty list rather than with some project's
 * state: there is no project to read, and inventing one would be a lie the client
 * would then render.
 */
export function applyProjectStateRequest(
  store: ProjectStateStore,
  request: ProjectStateRequest
): ProjectState {
  for (const sid of request.closedSessionIds) store.deleteSession(sid);
  if (request.kind === 'projectless') return { sessions: [] };

  const { cwd } = request;
  const closed = new Set(request.closedSessionIds);

  // Link each incoming session to this project. Only for sessions that exist in
  // the store (a tab should not conjure a session row); linking is idempotent and
  // never touches messages/memory. This is the UNION add — sessions other tabs
  // linked stay linked.
  for (const sid of request.sessions) {
    if (closed.has(sid)) continue;
    if (store.getSession(sid)) store.setSessionProject(sid, cwd);
  }

  // Persist per-session plan-mode flags (skip closed/deleted ids).
  for (const [sid, on] of Object.entries(request.planModes)) {
    if (closed.has(sid)) continue;
    store.setSetting(planModeKey(sid), String(Boolean(on)));
  }

  // Persist the active session when it survives (present and not closed).
  const activeIn = request.activeSessionId;
  if (activeIn && !closed.has(activeIn) && store.getSession(activeIn)) {
    store.setSetting(activeSessionKey(cwd), activeIn);
  }

  return readProjectState(store, cwd);
}
