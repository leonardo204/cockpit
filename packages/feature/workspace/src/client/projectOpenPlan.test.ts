import { describe, it, expect } from 'vitest';
import {
  planAdoptsIntoSeedTab,
  projectOpenPlan,
  type ProjectOpenState,
} from './projectOpenPlan';

/**
 * A PROJECT WITH SESSIONS IN IT DOES NOT OPEN ON A BLANK CHAT.
 *
 * That is the whole contract, and every case below is a way it could quietly
 * stop holding: a load that failed, a state that is incoherent, a pinned tab
 * that got there first, a deep link that must outrank all of it.
 *
 * The old rule — "opening a project starts a NEW session" — is deliberately
 * inverted here, and the module header states why that is not the "기존 세션
 * 연결" complaint returning: the multi-tab layout is still never rebuilt.
 */

const state = (sessions: string[], activeSessionId?: string): ProjectOpenState => ({
  sessions,
  ...(activeSessionId ? { activeSessionId } : {}),
});

describe('a project with sessions resumes one', () => {
  it('opens the session the user was last in', () => {
    const plan = projectOpenPlan(undefined, state(['s-b', 's-a'], 's-a'));
    expect(plan).toEqual({ kind: 'resume', sessionId: 's-a' });
  });

  it('takes the server’s answer rather than recomputing "most recent"', () => {
    // `readProjectState` returns the STORED active session when it still exists
    // and falls back to `sessions[0]` when it does not. Deriving it again here
    // would be a second copy of that rule — and this case is exactly where the
    // two would disagree: the head of the list is `s-b`, the stored active is
    // `s-a`, and `s-a` is where the user actually was.
    expect(projectOpenPlan(undefined, state(['s-b', 's-a'], 's-a')).sessionId).toBe('s-a');
  });

  it('adopts it into the seed tab', () => {
    expect(planAdoptsIntoSeedTab(projectOpenPlan(undefined, state(['s-a'], 's-a')))).toBe(true);
  });
});

describe('a project with nothing in it still opens a blank tab', () => {
  it('is fresh when the project has no sessions', () => {
    // The branch that was NOT up for debate: with nothing to resume, a blank tab
    // is the only honest thing to show. It mints no session row — the first turn
    // does that — so this costs nothing on disk.
    expect(projectOpenPlan(undefined, state([]))).toEqual({ kind: 'fresh' });
  });

  it('is fresh when the load failed', () => {
    // `loadProjectState` resolves to null rather than rejecting. A project whose
    // state could not be read must still open.
    expect(projectOpenPlan(undefined, null)).toEqual({ kind: 'fresh' });
  });

  it('is fresh when the state names no active session', () => {
    expect(projectOpenPlan(undefined, state(['s-a']))).toEqual({ kind: 'fresh' });
  });

  it('refuses an active id that the session list does not contain', () => {
    // An incoherent state — an active session with no sessions behind it — would
    // otherwise open a tab onto something that is not there.
    expect(projectOpenPlan(undefined, state([], 's-ghost'))).toEqual({ kind: 'fresh' });
  });

  it('never adopts anything into the seed tab', () => {
    expect(planAdoptsIntoSeedTab(projectOpenPlan(undefined, null))).toBe(false);
  });
});

describe('an explicitly named session outranks everything', () => {
  it('wins over a more recent session', () => {
    // A deep link, or a pick from the session browser. Resuming something else
    // because it happened to be more recent would be the app overruling a choice
    // the user just made.
    const plan = projectOpenPlan('s-linked', state(['s-recent'], 's-recent'));
    expect(plan).toEqual({ kind: 'explicit', sessionId: 's-linked' });
  });

  it('wins even when the project state could not be read', () => {
    expect(projectOpenPlan('s-linked', null)).toEqual({ kind: 'explicit', sessionId: 's-linked' });
  });

  it('is not re-adopted — the seed tab already carries it', () => {
    // `useTabState` seeds the tab with `initialSessionId` in its initialiser, so
    // adopting again would be writing the value it already holds.
    expect(planAdoptsIntoSeedTab(projectOpenPlan('s-linked', null))).toBe(false);
  });
});

describe('the pinned-restore race', () => {
  // Both halves are correct on their own and land in either order: TabManager
  // reopens pinned sessions when ITS fetch resolves, this decision runs when
  // `loadProjectState` resolves.

  it('focuses the existing tab instead of opening the session twice', () => {
    const plan = projectOpenPlan(undefined, state(['s-a'], 's-a'), ['s-a']);
    expect(plan).toEqual({ kind: 'focus', sessionId: 's-a' });
    expect(planAdoptsIntoSeedTab(plan)).toBe(false);
  });

  it('resumes normally when the open tabs are other sessions', () => {
    const plan = projectOpenPlan(undefined, state(['s-a'], 's-a'), ['s-other']);
    expect(plan).toEqual({ kind: 'resume', sessionId: 's-a' });
  });

  it('reads a tab bar holding blank tabs without tripping', () => {
    // A seed tab's `sessionId` is `undefined` — the list really does contain
    // holes, and they must not match anything.
    const plan = projectOpenPlan(undefined, state(['s-a'], 's-a'), [undefined, undefined]);
    expect(plan.kind).toBe('resume');
  });

  it('leaves the invariant true in BOTH orderings', () => {
    // Whichever request lands first, the project opens showing a session and
    // never a blank chat — which is the thing the user asked for.
    const pinnedWon = projectOpenPlan(undefined, state(['s-a'], 's-a'), ['s-a']);
    const adoptionWon = projectOpenPlan(undefined, state(['s-a'], 's-a'), [undefined]);
    expect(pinnedWon.sessionId).toBe('s-a');
    expect(adoptionWon.sessionId).toBe('s-a');
    expect([pinnedWon.kind, adoptionWon.kind]).toEqual(['focus', 'resume']);
  });
});
