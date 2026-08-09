// packages/feature/agent/src/server/lib/sessionHandoff.ts
//
// CONTINUE IN A NEW TAB (specs/session-context-management.md §2.2).
//
// THE PROBLEM IT ANSWERS. A long conversation eventually fills the window, and
// naby's answer to that is deliberately NOT a `/clear` or `/compact` command —
// the tab IS the clear (§3). But a new tab is only an answer if continuing in it
// feels like continuing: confirmed memory is injected automatically, so what a new
// session loses is exactly the part that was only ever true INSIDE the old
// conversation — what was agreed, what is half-done, what is still open.
//
// So this compresses that, and only that, into a short HANDOFF stored on the new
// session's row (`SessionRef.handoff`), which the engine injects into every turn of
// that session (engines/naby.ts).
//
// THE RULE THAT SHAPES EVERY FAILURE PATH: A FAILED SUMMARY MUST NOT BLOCK THE
// TAB. The user asked to continue somewhere else; a model that is offline, a
// machine with no credentials, a summariser that times out — none of them are
// reasons to refuse. The session is created either way and the tab opens either
// way; without a handoff it is exactly the empty new tab the previous build gave.
//
// THIS FILE IS PURE + INJECTED. The model call lives behind the `summarize` seam
// (production: lib/handoffSummary.ts), so the whole flow is testable with a fake.

import type { RuntimeMessage, SessionRef, Store } from '../../../../../../../dist/naby-runtime.mjs';

/**
 * Everything the flow reads or writes on the store, and nothing more.
 *
 * The last four are the ENVIRONMENT CARRY (see `continueSessionInNewTab`): the
 * new session is only "the same conversation somewhere else" if the things that
 * were true of the OLD session — its project, its privacy, its session-scoped
 * memory, its plan mode — are true of it too.
 */
export type HandoffStore = Pick<
  Store,
  | 'getSession'
  | 'getMessages'
  | 'createSession'
  | 'setSessionHandoff'
  | 'setSetting'
  | 'getSetting'
  | 'setSessionNoLearn'
  | 'getAllMemory'
  | 'setMemory'
>;

/** The seam the model call hides behind. Returns the handoff text, or '' when it
 *  could not produce one. It must NOT throw for an ordinary failure — but the flow
 *  below survives a throw anyway, because "must not" is not "cannot". */
export type HandoffSummarizer = (input: {
  messages: readonly RuntimeMessage[];
  signal?: AbortSignal;
}) => Promise<string>;

/**
 * HOW MUCH OF THE OLD CONVERSATION IS READ.
 *
 * Two caps, and both are needed. The MESSAGE cap keeps the summariser's own call
 * small on a long session — it is being asked what matters NOW, and the last
 * stretch is where that lives. The CHARACTER cap is the one that actually binds
 * when a session is full of enormous tool results, which the message cap alone
 * would let through (60 messages can be a megabyte).
 *
 * Both are applied from the END: the newest material is what a handoff is about.
 */
export const HANDOFF_SOURCE_MAX_MESSAGES = 60;
export const HANDOFF_SOURCE_MAX_CHARS = 24_000;

/** The handoff is injected into EVERY turn of the new session, so it is bounded —
 *  an unbounded one would spend the new window on describing the old one. */
export const HANDOFF_MAX_CHARS = 3_000;

/** The label the injected block carries. Named rather than disguised: the model is
 *  told this is a summary of an earlier conversation, not something just said. */
export const HANDOFF_BLOCK_HEADER = 'PREVIOUS SESSION HANDOFF';

/**
 * The system-prompt block for a session that was continued from another one.
 * Returns undefined when there is no handoff, which is what keeps an ordinary
 * session's prompt byte-for-byte what it was before this feature existed.
 */
export function handoffInstruction(handoff: string | undefined): string | undefined {
  const text = (handoff ?? '').trim();
  if (!text) return undefined;
  return [
    `${HANDOFF_BLOCK_HEADER}: this conversation continues an earlier one that got too long.`,
    'What follows is a summary of that conversation — treat it as established context,',
    'not as something the user just said, and do not answer it again. When it conflicts',
    'with what the user says now, the user now wins.',
    '',
    text,
  ].join('\n');
}

/** The slice of the old transcript the summariser is asked about (see the caps). */
export function handoffSourceMessages(
  messages: readonly RuntimeMessage[],
): RuntimeMessage[] {
  const tail = messages.slice(-HANDOFF_SOURCE_MAX_MESSAGES);
  let chars = 0;
  const out: RuntimeMessage[] = [];
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const m = tail[i]!;
    const size = m.role === 'tool' ? m.output.content.length : m.content.length;
    if (chars + size > HANDOFF_SOURCE_MAX_CHARS && out.length > 0) break;
    chars += size;
    out.unshift(m);
  }
  return out;
}

/** Bound whatever the summariser produced. Empty in, empty out — an empty handoff
 *  is stored as no handoff at all, never as an empty block in the prompt. */
export function normalizeHandoff(text: string | undefined): string {
  const trimmed = (text ?? '').trim();
  return trimmed.length > HANDOFF_MAX_CHARS ? trimmed.slice(0, HANDOFF_MAX_CHARS) : trimmed;
}

/**
 * The new session's TITLE, when the client did not send one.
 *
 * English, deliberately, and only as the fallback: this server has no locale (the
 * same constraint the fast-growth session's title is under), so the words normally
 * travel from the client. A wrong-language title is recoverable; an untitled
 * session is the "I cannot find the conversation I just made" bug twice over.
 */
export const CONTINUED_TITLE_PREFIX = 'Continued — ';
export const CONTINUED_TITLE_MAX = 80;

export function continuedTitle(
  source: SessionRef | undefined,
  requested: string | undefined,
): string {
  const asked = (requested ?? '').trim();
  if (asked) return asked.slice(0, CONTINUED_TITLE_MAX);
  const base = (source?.title ?? '').trim();
  if (base) return `${CONTINUED_TITLE_PREFIX}${base}`.slice(0, CONTINUED_TITLE_MAX);
  // No title to continue FROM: name the day instead of leaving it blank, so the
  // row is recognisable in a list of "새 세션".
  const when = new Date(source?.createdAt ?? Date.now());
  const stamp = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(
    when.getDate(),
  ).padStart(2, '0')}`;
  return `${CONTINUED_TITLE_PREFIX}${stamp}`;
}

/**
 * THE PLAN-MODE SETTING KEY, owned here and imported by /api/project-state.
 *
 * One question, one answer: the route READS these keys to build `planModes`, and
 * the carry below WRITES one. Two copies of the derivation is how a continued
 * session ends up with plan mode stored under a key nobody reads.
 */
export const sessionPlanModeKey = (sessionId: string): string =>
  `session.planMode.${sessionId}`;

/** Which piece of the environment carry did not make it. Diagnostic only — every
 *  one of them is forgiven, exactly as a failed summary is. */
export type CarryFailure = 'no-learn' | 'memory' | 'plan-mode' | 'telegram' | 'scheduled-tasks';

/** What actually travelled from the old session to the new one. */
export type CarryReport = {
  /** True when the source session was marked temporary and the new one now is. */
  noLearn: boolean;
  /** How many session-scoped memory rows were copied. */
  memoryKeys: number;
  /** True when the source was in plan mode and the new session now is. */
  planMode: boolean;
  /** Empty on the ordinary path. */
  failed: CarryFailure[];
};

export type ContinueOutcome =
  | {
      ok: true;
      sessionId: string;
      title: string;
      /** Whether a handoff was actually stored. False = the tab still opens, with
       *  no handoff — the degraded path, never an error. */
      handoff: boolean;
      /** The project the new session is linked to: what the caller asked for, or
       *  the SOURCE session's project when it asked for nothing. Returned because
       *  the client navigates on it (`Topics.OpenProject` needs a cwd), and a tab
       *  that was opened without a cwd prop has none of its own to fall back to. */
      cwd?: string;
      /** Why there is no handoff, for the log and the tests. Never shown to the
       *  user: the tab opened, which is what they asked for. */
      reason?: 'empty-source' | 'summary-failed';
      /** What travelled with the session, and what did not. */
      carried: CarryReport;
    }
  | { ok: false; error: string };

/**
 * The whole flow's dependencies. Everything that reaches OUTSIDE the store is a
 * seam, for the same reason `summarize` is one: the tests build fakes, and no
 * test of a continuation touches a Telegram poll loop or the scheduled-task file.
 */
export type ContinueDeps = {
  store: HandoffStore;
  summarize: HandoffSummarizer;
  /** The name's second home (the Recent list and the tab bar). */
  setCustomTitle?: (sessionId: string, title: string) => void;
  /**
   * Repoint the phone's chat link when it names the OLD session. Without it, a
   * reply typed on Telegram lands in the conversation the user just left — for
   * up to the link's idle window (an hour).
   */
  rebindTelegramLink?: (fromSessionId: string, toSessionId: string) => void | Promise<void>;
  /**
   * Repoint scheduled tasks bound to the OLD session. A task resumes the session
   * it names; left alone it would keep firing into the abandoned one.
   */
  rebindScheduledTasks?: (
    fromSessionId: string,
    toSessionId: string,
  ) => void | Promise<void>;
};

/**
 * Run the whole flow: summarize the source session, mint the new one, carry the
 * SESSION-SCOPED environment onto it, and answer with its id.
 *
 * ORDER MATTERS. The summary is taken BEFORE the session is created, so a slow
 * model does not leave a half-made session lying around if the process dies — and
 * so the created session is either complete with its handoff or complete without
 * one, never a session whose handoff arrives later than its first turn. Everything
 * carried below happens AFTER the session exists, because all of it is keyed on
 * the id the creation hands back.
 *
 * WHAT CARRIES, AND WHY EACH ONE (environment continuity).
 * App- and project-scoped state — the MCP registry, skills, the style profile, the
 * model pick, policies — is not listed here because it never had to be: it is
 * resolved per turn from the app or the project, so a new session in the same
 * project already has it. What is listed is exactly what was keyed on the SESSION,
 * and would therefore be silently lost:
 *   - the PROJECT LINK (`cwd`), without which the client cannot even open the tab;
 *   - `noLearn`, because a conversation the user marked temporary must not quietly
 *     become one that is learned from just because it got long (a privacy setting
 *     that fails open is not a setting);
 *   - `scope='session'` MEMORY, the facts that were established inside this
 *     conversation and never promoted out of it;
 *   - PLAN MODE, the working posture the user selected for this thread.
 * And two things keyed on the session id OUTSIDE the store, both of which would
 * otherwise keep pointing at a conversation nobody is in any more: the Telegram
 * chat link and scheduled tasks (the `rebind*` seams).
 *
 * WHAT IS DELIBERATELY DROPPED. Each of these is about the OLD session, not about
 * the work:
 *   - PINNED — pinning is a gesture on one specific conversation ("keep this one
 *     where I can find it"); a continuation the user has not looked at yet has not
 *     earned it, and copying it would grow the pinned list on its own.
 *   - FAST GROWTH — a drill has its own kickoff lifecycle (`fastGrowthKickoff`);
 *     a continuation that inherited the flag would be a practice session with no
 *     opening question, which is neither a drill nor an ordinary chat.
 *   - STATUS, the ROLLING SUMMARY, the REFLECTION CURSOR and USAGE — all four are
 *     derived from a transcript. The new session's transcript is empty, so copying
 *     them would describe work that is not there: a cursor past the end, a summary
 *     of messages this session never had, and token counts billed twice in the
 *     context gauge.
 * The HANDOFF is what replaces them, and it is the only thing that should.
 *
 * EVERY CARRY IS FORGIVEN, exactly as the summary is. The user asked to continue
 * somewhere else; a memory copy that throws is a reason to record a reason, never
 * a reason to refuse the tab.
 */
export async function continueSessionInNewTab(
  deps: ContinueDeps,
  input: { sessionId: string; cwd?: string; title?: string; signal?: AbortSignal },
): Promise<ContinueOutcome> {
  const { store } = deps;
  const source = store.getSession(input.sessionId);
  if (!source) return { ok: false, error: 'session not found' };

  let messages: RuntimeMessage[] = [];
  try {
    messages = store.getMessages(input.sessionId);
  } catch {
    // An unreadable transcript is a missing handoff, not a failed continue.
    messages = [];
  }
  const sourceSlice = handoffSourceMessages(messages);

  let handoffText = '';
  let reason: 'empty-source' | 'summary-failed' | undefined;
  if (sourceSlice.length === 0) {
    reason = 'empty-source';
  } else {
    try {
      handoffText = normalizeHandoff(
        await deps.summarize({
          messages: sourceSlice,
          ...(input.signal ? { signal: input.signal } : {}),
        }),
      );
    } catch (e) {
      console.warn(
        `[handoff] summary failed for session ${input.sessionId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    if (!handoffText) reason = 'summary-failed';
  }

  const title = continuedTitle(source, input.title);
  // THE PROJECT LINK. What the caller asked for wins; when it asked for nothing
  // the SOURCE session's project is used, because "continue this conversation"
  // means the same project unless the user says otherwise. Dropping it used to
  // leave the client with no cwd to navigate with, so the tab never opened.
  const cwd = firstNonEmpty(input.cwd, source.cwd);
  // The provider is left empty, as everywhere else a session is minted: the turn
  // that answers records who actually did (it is a hint, not a key).
  const created = store.createSession('', title, cwd);
  if (handoffText) {
    try {
      store.setSessionHandoff(created.sessionId, handoffText);
    } catch (e) {
      // The session exists and the tab will open; it simply has no handoff.
      console.warn(
        `[handoff] could not store the handoff on ${created.sessionId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      handoffText = '';
      reason = 'summary-failed';
    }
  }
  // The name lives in BOTH places a name can live, exactly as the fast-growth
  // session's does: `sessions.title` for the project browser, the custom-title
  // setting for the Recent list and the tab bar.
  deps.setCustomTitle?.(created.sessionId, title);

  const carried = await carrySessionEnvironment(deps, source, created.sessionId);

  return {
    ok: true,
    sessionId: created.sessionId,
    title,
    handoff: handoffText.length > 0,
    ...(cwd ? { cwd } : {}),
    ...(handoffText ? {} : reason ? { reason } : {}),
    carried,
  };
}

/** The first of these that has non-whitespace in it, or undefined. */
function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

/**
 * Move the session-scoped environment onto the new session (see the doc above for
 * what is carried and what is deliberately not).
 *
 * EACH STEP IS INDEPENDENTLY FORGIVEN. They are separate try/catches rather than
 * one, so a store that refuses the memory copy still gets the privacy flag: the
 * cheapest possible failure is one step, and the most expensive one is "the first
 * thing that threw silently cancelled everything after it".
 */
async function carrySessionEnvironment(
  deps: ContinueDeps,
  source: SessionRef,
  newSessionId: string,
): Promise<CarryReport> {
  const { store } = deps;
  const report: CarryReport = { noLearn: false, memoryKeys: 0, planMode: false, failed: [] };
  const record = (step: CarryFailure, e: unknown): void => {
    report.failed.push(step);
    console.warn(
      `[handoff] could not carry ${step} onto ${newSessionId}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  };

  // PRIVACY FIRST, and before anything else can throw. A temporary conversation
  // that continues into a learning one is the one failure here that costs the
  // user something they cannot take back.
  if (source.noLearn) {
    try {
      store.setSessionNoLearn(newSessionId, true);
      report.noLearn = true;
    } catch (e) {
      record('no-learn', e);
    }
  }

  // SESSION-SCOPED MEMORY. The legacy pair is used on purpose: `getAllMemory` /
  // `setMemory` read and write exactly the `scope='session'` rows, while
  // `putMemory` would run every copied row back through the WRITE GATE — which
  // can throw on a deny or park the row as 'proposed' on a hold. These facts were
  // already accepted in the conversation being continued; re-judging them would
  // make the continuation forget things the user watched it learn.
  try {
    const rows = store.getAllMemory(source.sessionId);
    for (const [key, value] of Object.entries(rows)) {
      store.setMemory(newSessionId, key, value);
      report.memoryKeys += 1;
    }
  } catch (e) {
    record('memory', e);
  }

  // PLAN MODE — the working posture the user chose for this thread. The UI picks
  // it up the next time /api/project-state loads for the project (it reads
  // `session.planMode.<id>` for every session in the list), so nothing here has
  // to tell the client about it.
  try {
    if (store.getSetting(sessionPlanModeKey(source.sessionId)) === 'true') {
      store.setSetting(sessionPlanModeKey(newSessionId), 'true');
      report.planMode = true;
    }
  } catch (e) {
    record('plan-mode', e);
  }

  // The two bindings that live OUTSIDE the store. Both are awaited so that the
  // response the client navigates on cannot race a rebind that is still in
  // flight, and both are optional: a deployment with no Telegram bot and no
  // scheduled tasks simply does not pass them.
  try {
    await deps.rebindTelegramLink?.(source.sessionId, newSessionId);
  } catch (e) {
    record('telegram', e);
  }
  try {
    await deps.rebindScheduledTasks?.(source.sessionId, newSessionId);
  } catch (e) {
    record('scheduled-tasks', e);
  }

  return report;
}
