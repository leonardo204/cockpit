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

/** Everything the flow reads or writes on the store, and nothing more. */
export type HandoffStore = Pick<
  Store,
  'getSession' | 'getMessages' | 'createSession' | 'setSessionHandoff' | 'setSetting'
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

export type ContinueOutcome =
  | {
      ok: true;
      sessionId: string;
      title: string;
      /** Whether a handoff was actually stored. False = the tab still opens, with
       *  no handoff — the degraded path, never an error. */
      handoff: boolean;
      /** Why there is no handoff, for the log and the tests. Never shown to the
       *  user: the tab opened, which is what they asked for. */
      reason?: 'empty-source' | 'summary-failed';
    }
  | { ok: false; error: string };

/**
 * Run the whole flow: summarize the source session, mint the new one, store the
 * handoff on it, and answer with its id.
 *
 * ORDER MATTERS. The summary is taken BEFORE the session is created, so a slow
 * model does not leave a half-made session lying around if the process dies — and
 * so the created session is either complete with its handoff or complete without
 * one, never a session whose handoff arrives later than its first turn.
 */
export async function continueSessionInNewTab(
  deps: { store: HandoffStore; summarize: HandoffSummarizer; setCustomTitle?: (sessionId: string, title: string) => void },
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
  // The provider is left empty, as everywhere else a session is minted: the turn
  // that answers records who actually did (it is a hint, not a key).
  const created = store.createSession('', title, input.cwd);
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

  return {
    ok: true,
    sessionId: created.sessionId,
    title,
    handoff: handoffText.length > 0,
    ...(handoffText ? {} : reason ? { reason } : {}),
  };
}
