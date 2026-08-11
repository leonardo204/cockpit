/**
 * THE LAST RUN'S FAILURE, AS A RUN-LEVEL ARTIFACT.
 *
 * A turn that fails says so through a `{type:'error'}` stream event, and that
 * notice used to live in the assistant bubble's text — which is to say, in the
 * TRANSCRIPT. The transcript is not where it can live:
 *
 *   1. `RuntimeMessage` is a closed three-variant contract with no `system`
 *      role (see the note in `src/runtime/engine.ts`), so an error is never
 *      written to disk. That is deliberate; a failed turn is not something the
 *      conversation said.
 *   2. When the run ends, `onRunComplete → reconcileFromDiskRef` re-syncs the
 *      screen to the persisted messages. Anything that is on screen but not on
 *      disk is erased by that sync.
 *
 * Together those two produce the reported bug: an answer that "appears and then
 * instantly disappears" was never an answer — it was the error, wiped by the
 * reconcile a moment later. The user is left with a turn that silently did
 * nothing, when the provider had in fact said something extremely useful
 * ("limit: 0 for gemini-2.5-pro on the free tier" means that model can never
 * answer, no amount of retrying will help).
 *
 * So the failure is kept OUTSIDE the message array, as one record about the last
 * run. A disk reconcile cannot touch it, because it is not made of messages.
 *
 * WHAT ENDS IT — progression, never a clock:
 *   • the next send (a new question supersedes the failed one), and
 *   • moving to another session (the record belongs to the session it happened
 *     in), and
 *   • the user dismissing it.
 * Notably NOT a history reconcile, which is the whole point; `runFailureReducer`
 * takes that event explicitly so the rule is stated rather than implied.
 *
 * Pure and dependency-free so the rules above are testable without a DOM (this
 * suite has none — see vitest.config.ts), the same way composerHistory.ts is.
 */

/** A run that ended in failure, as the client remembers it. */
export interface RunFailure {
  /** The engine's / provider's own message, VERBATIM. Never summarised here —
   *  the provider's wording is the actionable part (quota, model, retry-after). */
  readonly message: string;
  /** The engine brand that was answering ("Gemini", "Claude", …), when known. */
  readonly engine?: string;
  /** The model that was asked, when known — a resolved label or the picked slug. */
  readonly model?: string;
  /** The session this failure belongs to. Moving to another one clears it. */
  readonly sessionId: string | null;
  /** When it was observed (epoch ms). Display + React key. */
  readonly at: number;
}

export type RunFailureEvent =
  /** A run ended in failure. */
  | {
      readonly type: 'run-failed';
      readonly message: string;
      readonly engine?: string;
      readonly model?: string;
      readonly sessionId: string | null;
      readonly at: number;
    }
  /** The user sent something new — the failed question has been superseded. */
  | { readonly type: 'send' }
  /** The tab is now showing this session. */
  | { readonly type: 'session'; readonly sessionId: string | null }
  /** The transcript was re-synced from disk after the run ended. Changes NOTHING
   *  — this is the event the whole module exists to survive. */
  | { readonly type: 'history-reconciled' }
  /** The user closed the notice. */
  | { readonly type: 'dismiss' };

/**
 * The state machine. Returns the SAME object when nothing changed, so a caller
 * holding it in React state does not re-render a memo'd subtree on every
 * reconcile (shell React performance conventions).
 */
export function runFailureReducer(state: RunFailure | null, ev: RunFailureEvent): RunFailure | null {
  switch (ev.type) {
    case 'run-failed': {
      const message = ev.message.trim();
      // Nothing quotable to show. Keeping whatever was already there beats
      // replacing a real provider message with an empty box; every call site
      // passes a translated fallback, so this is the pathological case.
      if (!message) return state;
      return {
        message,
        ...(ev.engine ? { engine: ev.engine } : {}),
        ...(ev.model ? { model: ev.model } : {}),
        sessionId: ev.sessionId,
        at: ev.at,
      };
    }
    case 'send':
      return state === null ? state : null;
    case 'session':
      if (state === null) return state;
      // Same session (including the reconcile's re-report of the id it was
      // already recorded under) → untouched.
      if (state.sessionId === ev.sessionId) return state;
      // A turn can fail BEFORE the session has an id — the POST never started
      // the run, or the engine errored before its `system/init`. The id landing
      // afterwards is this same conversation finally naming itself, not a move
      // to another one; adopting it (rather than reading it as a switch) is
      // what stops the notice from vanishing on the very first turn of a new
      // session, which is precisely when a misconfigured provider fails.
      if (state.sessionId === null && ev.sessionId !== null) return { ...state, sessionId: ev.sessionId };
      // Anything else is another conversation on screen — this record is not
      // about what the user is reading now.
      return null;
    case 'history-reconciled':
      // THE POINT. Re-reading the conversation from disk says nothing about
      // whether the last run failed, because the failure was never written
      // there. Anything but `return state` here reintroduces the bug.
      return state;
    case 'dismiss':
      return state === null ? state : null;
  }
}

/**
 * The one line the collapsed notice shows: the first non-empty line of the
 * provider's message, whitespace-collapsed and length-capped.
 *
 * Only ever a PREVIEW — the full message stays available verbatim underneath.
 * Provider errors are routinely a paragraph ("Failed after 3 attempts. Last
 * error: … Quota exceeded for metric … Please retry in 53.4s"), and the first
 * line is the part that says what happened.
 */
export function runFailureHeadline(message: string, max = 160): string {
  const line = message
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return '';
  const collapsed = line.replace(/\s+/g, ' ');
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * WHERE the failure came from, as one label: "Gemini · gemini-2.5-pro".
 *
 * Both parts are optional and the label degrades rather than inventing: two
 * known → joined, one known → that one, neither → '' and the notice simply does
 * not claim to know. A wrong provider name here would send the user to the
 * wrong settings page.
 */
export function runFailureOrigin(failure: Pick<RunFailure, 'engine' | 'model'>): string {
  const parts = [failure.engine, failure.model].map((p) => (p ?? '').trim()).filter((p) => p.length > 0);
  // A resolved model label often already contains the brand ("Gemini 2.5 Pro"),
  // and "Gemini · Gemini 2.5 Pro" reads like a bug rather than like detail.
  if (parts.length === 2 && parts[1]!.toLowerCase().startsWith(parts[0]!.toLowerCase())) return parts[1]!;
  return parts.join(' · ');
}
