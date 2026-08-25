/**
 * WHAT A TAB SHOWS WHEN A PROJECT OPENS.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE THIS REPLACES, AND WHY IT IS NOT THE OLD COMPLAINT COMING BACK
 *
 * `useTabState` used to state, in a comment, that "opening a project starts a
 * NEW session", and it meant it: the saved state was loaded and then thrown
 * away. That rule existed for a real reason — a fresh open once REBUILT THE
 * WHOLE MULTI-TAB LAYOUT and silently reconnected whatever had been active,
 * which was reported as "기존 세션 연결".
 *
 * What replaces it is not that. The layout is still not rebuilt: a project
 * opens with ONE tab, exactly as it does today. The only change is WHICH
 * conversation that one tab is showing — the one the user was last in, rather
 * than a blank one. A project with sessions in it stops greeting its owner with
 * an empty chat and a name they have never seen.
 *
 * The distinction is the whole design:
 *
 *     rebuild the layout   ✗  still refused — that was the complaint
 *     resume one session   ✓  this module
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE SERVER'S `activeSessionId` AND NOT `sessions[0]`
 *
 * `readProjectState` (server/state/projectState.ts) already answers this
 * question and has for a long time: it returns the stored active session when
 * that session still exists, and falls back to `sessions[0]` — the most recently
 * used — when it does not. Recomputing "most recent" here would be a second copy
 * of a rule that is already written down, and the two would disagree the first
 * time someone changed one of them. So the client asks for the answer rather
 * than deriving it, and `sessions` is read ONLY to know whether the project has
 * anything at all.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A MODULE AND NOT AN `if` IN THE HOOK
 *
 * It is a rule, not wiring — the same reason `untitledTabTitle`, `titleLock` and
 * `tabKinds` each live alone in this directory. The hook it serves runs inside
 * an iframe, against a fetch, in a component jsdom cannot lay out; a branch
 * written inline there is a branch no test can reach.
 */

/** What the load found, narrowed to the two fields this decision reads. Shaped
 *  as a subset of `LoadedProjectState` rather than importing it, so this module
 *  is testable without the Effect client and stays honest about what it uses. */
export interface ProjectOpenState {
  /** Every session the project owns, most-recently-used first. Read for its
   *  EMPTINESS only — which session to resume is the server's answer below. */
  sessions: string[];
  /** Where the user left off: the stored active session if it still exists,
   *  otherwise the most recent one. Absent when the project has no sessions. */
  activeSessionId?: string;
}

export interface ProjectOpenPlan {
  /**
   * - `explicit` — a deep link or a pick from the session browser. It outranks
   *   everything: the user named a session, and resuming a different one because
   *   it happened to be more recent would be the app overruling them.
   * - `resume` — the project has sessions and none was named. Show the one they
   *   were last in.
   * - `focus` — the session to resume is ALREADY OPEN in a tab. Nothing to
   *   adopt; the caller activates that tab instead. See the race note below.
   * - `fresh` — the project has no sessions at all. A blank tab is the only
   *   honest thing to show, and it mints no row until the first message.
   */
  kind: 'explicit' | 'resume' | 'focus' | 'fresh';
  /** The session the tab should end up on. Absent only for `fresh`. */
  sessionId?: string;
}

/**
 * Decide what the seeded tab becomes.
 *
 * `openSessionIds` IS THE RACE FIX, and it is worth being explicit about the
 * hazard because both halves are correct on their own. Pinned sessions are
 * reopened by `TabManager` when its own fetch lands, and this adoption happens
 * when `loadProjectState` lands — two independent requests, either order. If the
 * pinned restore wins and this then adopted the same id anyway, the project
 * would open showing the same conversation twice; if it adopted blindly while a
 * pinned tab already held it, the empty seed tab would be left active BESIDE the
 * session the user wanted, which is the feature visibly failing.
 *
 * So an id that is already on screen produces `focus`: the answer stops being
 * "put this session in the seed tab" and becomes "the session is already here,
 * go to it". The invariant holds either way round — a project with sessions
 * opens showing a session, never a blank chat.
 */
export function projectOpenPlan(
  initialSessionId: string | undefined,
  state: ProjectOpenState | null,
  openSessionIds: readonly (string | undefined)[] = [],
): ProjectOpenPlan {
  // The user named one. Nothing below gets to second-guess that, including the
  // case where the load failed entirely — an explicit open must work whether or
  // not the project's saved state is readable.
  if (initialSessionId) return { kind: 'explicit', sessionId: initialSessionId };

  // No state, or a project with nothing in it. `sessions` is checked as well as
  // `activeSessionId` because a state carrying an active id but no sessions is
  // incoherent, and resuming out of it would open a tab on a session that is not
  // there.
  if (!state || state.sessions.length === 0) return { kind: 'fresh' };

  const resumeId = state.activeSessionId;
  if (!resumeId) return { kind: 'fresh' };

  if (openSessionIds.includes(resumeId)) return { kind: 'focus', sessionId: resumeId };

  return { kind: 'resume', sessionId: resumeId };
}

/** Whether the plan puts a session into the seed tab. `focus` deliberately does
 *  NOT: the session is already in a tab of its own, and writing it into the seed
 *  as well is the duplicate this guards against. */
export function planAdoptsIntoSeedTab(plan: ProjectOpenPlan): boolean {
  return plan.kind === 'resume';
}
