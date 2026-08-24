import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyProjectStateRequest,
  broadcastCwdOf,
  parseProjectStateRequest,
  planModeKey,
  readProjectState,
  type ProjectStateRequest,
  type ProjectStateStore,
} from './projectState';
import { SqliteStore } from '../../../../../../../dist/naby-runtime.mjs';

/**
 * What a POST to /api/project-state means.
 *
 * THE DEFECT THIS SUITE WAS REOPENED FOR. A session with no project (`cwd ''`)
 * is listed in the recent views on purpose and could not be deleted from them:
 * the only removal channel was `closedSessionIds` on a request that had to name
 * a project, so the row's × was rendered disabled. The deletion itself was never
 * project-shaped — `store.deleteSession(sessionId)` takes an id and nothing
 * else — so what was missing was a REQUEST SHAPE, not a capability.
 *
 * Both halves are asserted here, and the second matters as much as the first:
 * a projectless close must work, AND a project save must still be refused
 * without its cwd. A tab that quietly stopped linking its sessions would be a
 * worse bug than the one being fixed.
 *
 * Run against a REAL SqliteStore where the claim is about the database, exactly
 * as storeUnification.test.ts does, because "the session is gone" is a statement
 * about rows.
 */

const dir = mkdtempSync(join(tmpdir(), 'naby-project-state-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const openStore = (name: string) =>
  new SqliteStore({ path: join(dir, `${name}.db`) }) as unknown as ProjectStateStore & {
    createSession: (providerId: string, title?: string, cwd?: string) => { sessionId: string };
    close: () => void;
  };

const parsed = (body: unknown): ProjectStateRequest => {
  const out = parseProjectStateRequest(body);
  if (!out.ok) throw new Error(`expected a valid request, got ${out.error.field}/${out.error.reason}`);
  return out.request;
};

const CWD = '/Users/me/work/naby';

describe('project-state request — two shapes, one channel', () => {
  it('a projectless close names ids and nothing else', () => {
    const request = parsed({ scope: 'projectless', closedSessionIds: ['s1', 's2'] });
    expect(request).toEqual({ kind: 'projectless', closedSessionIds: ['s1', 's2'] });
  });

  it('a project save still REQUIRES its cwd — a lost cwd is refused, not reinterpreted', () => {
    // The failure mode this guards: a tab save whose cwd went missing must not
    // slide into the projectless shape and silently link nothing.
    const out = parseProjectStateRequest({ sessions: ['s1'], closedSessionIds: ['s2'] });
    expect(out).toEqual({ ok: false, error: { field: 'cwd', reason: 'missing' } });
    expect(parseProjectStateRequest({ cwd: '', sessions: [] })).toEqual({
      ok: false,
      error: { field: 'cwd', reason: 'missing' },
    });
    // ...and `sessions` is still mandatory when a cwd IS given.
    expect(parseProjectStateRequest({ cwd: CWD })).toEqual({
      ok: false,
      error: { field: 'sessions', reason: 'must be array' },
    });
  });

  it('the two shapes have no body that satisfies both', () => {
    // A projectless request carries no project and no session list, so a save
    // cannot be mislabelled into it either.
    expect(parseProjectStateRequest({ scope: 'projectless', cwd: CWD, closedSessionIds: ['s1'] })).toEqual({
      ok: false,
      error: { field: 'cwd', reason: 'not allowed for a projectless close' },
    });
    expect(parseProjectStateRequest({ scope: 'projectless', sessions: [], closedSessionIds: ['s1'] })).toEqual({
      ok: false,
      error: { field: 'sessions', reason: 'not allowed for a projectless close' },
    });
  });

  it('a projectless close that removes nothing is refused', () => {
    // It would broadcast a change that did not happen.
    for (const body of [
      { scope: 'projectless' },
      { scope: 'projectless', closedSessionIds: [] },
      { scope: 'projectless', closedSessionIds: [''] },
      { scope: 'projectless', closedSessionIds: [1, 2] },
    ]) {
      expect(parseProjectStateRequest(body)).toEqual({
        ok: false,
        error: { field: 'closedSessionIds', reason: 'must be a non-empty array of session ids' },
      });
    }
  });

  it('an unknown scope is refused rather than treated as a save', () => {
    expect(parseProjectStateRequest({ scope: 'global', cwd: CWD, sessions: [] })).toEqual({
      ok: false,
      error: { field: 'scope', reason: 'unknown' },
    });
    expect(parseProjectStateRequest(null)).toEqual({
      ok: false,
      error: { field: 'body', reason: 'must be an object' },
    });
  });

  it('the broadcast carries the project for a save, and "" for a projectless close', () => {
    // "" is not a missing value — it is the cwd those sessions carry everywhere
    // on the wire, and the client reads it as "applies to every viewer".
    expect(broadcastCwdOf(parsed({ cwd: CWD, sessions: [] }))).toBe(CWD);
    expect(broadcastCwdOf(parsed({ scope: 'projectless', closedSessionIds: ['s1'] }))).toBe('');
  });
});

describe('project-state — applied to a real store', () => {
  it('DELETES A PROJECTLESS SESSION, which used to be impossible', () => {
    const store = openStore('projectless');
    const orphan = store.createSession('anthropic'); // no cwd: the legacy row
    const kept = store.createSession('anthropic', undefined, CWD);
    expect(store.getSession(orphan.sessionId)).toBeTruthy();

    const state = applyProjectStateRequest(
      store,
      parsed({ scope: 'projectless', closedSessionIds: [orphan.sessionId] }),
    );

    expect(store.getSession(orphan.sessionId)).toBeFalsy();
    // Nothing else is touched, and there is no project to answer with.
    expect(store.getSession(kept.sessionId)).toBeTruthy();
    expect(state).toEqual({ sessions: [] });
    store.close();
  });

  it('a project save links, activates and persists plan modes as before', () => {
    const store = openStore('save');
    const a = store.createSession('anthropic');
    const b = store.createSession('anthropic');

    const state = applyProjectStateRequest(
      store,
      parsed({
        cwd: CWD,
        sessions: [a.sessionId, b.sessionId, 'never-existed'],
        activeSessionId: b.sessionId,
        planModes: { [a.sessionId]: true, [b.sessionId]: false },
      }),
    );

    expect(state.sessions.sort()).toEqual([a.sessionId, b.sessionId].sort());
    // A tab cannot conjure a session row.
    expect(state.sessions).not.toContain('never-existed');
    expect(state.activeSessionId).toBe(b.sessionId);
    expect(state.planModes).toEqual({ [a.sessionId]: true });
    expect(store.getSetting(planModeKey(b.sessionId))).toBe('false');
    store.close();
  });

  it('the removal loop runs first, so a session both listed and closed ends up closed', () => {
    const store = openStore('closed-wins');
    const doomed = store.createSession('anthropic', undefined, CWD);

    const state = applyProjectStateRequest(
      store,
      parsed({
        cwd: CWD,
        sessions: [doomed.sessionId],
        activeSessionId: doomed.sessionId,
        planModes: { [doomed.sessionId]: true },
        closedSessionIds: [doomed.sessionId],
      }),
    );

    expect(store.getSession(doomed.sessionId)).toBeFalsy();
    expect(state.sessions).toEqual([]);
    // No settings were written for the session that went.
    expect(store.getSetting(planModeKey(doomed.sessionId))).toBeFalsy();
    store.close();
  });

  it('a save only ADDS links — a tab that lists nothing collapses nothing', () => {
    const store = openStore('union');
    const mine = store.createSession('anthropic', undefined, CWD);
    applyProjectStateRequest(store, parsed({ cwd: CWD, sessions: [] }));
    expect(readProjectState(store, CWD).sessions).toEqual([mine.sessionId]);
    store.close();
  });
});
