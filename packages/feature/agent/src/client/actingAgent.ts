/**
 * WHO THE LOADING BUBBLE NAMES (2026-08-04).
 *
 * The bubble used to say "Claude is thinking" — the engine brand, derived in
 * engineName.ts. That is the one fact about a turn the user did not ask about.
 * Whichever model answers, it is the same naby; the engine is already named in
 * the session toolbar ("엔진 Claude (subscription)"), and repeating it here — in
 * the sentence that stands in for the agent while it works — quietly tells the
 * user they are talking to a vendor rather than to their own agent.
 *
 * So the bubble names the ACTING AGENT of the turn:
 *
 *   * an ordinary turn        -> the built-in persona (the engine's `growthSubject`
 *                               falls back to it, so this is not a UI assumption
 *                               about what the server does — it is what it does),
 *   * an `@name` turn         -> that agent, by its own handle,
 *   * no agent identity at all -> the engine brand, unchanged. Reached only by a
 *                               path where the persona is genuinely not in play
 *                               (a legacy engine whose init carries no agent, an
 *                               install with no persona row).
 *
 * WHERE THE ANSWER COMES FROM. The naby engine puts `acting_agent` on the turn's
 * `system/init` event — the same event the client already reads for the resolved
 * model label. No parallel channel, and no client-side re-implementation of the
 * `@` routing rules (which resolve against the agent store, something this tree
 * cannot see).
 *
 * Pure and separate from the React so the rule is testable without a DOM: the two
 * ways it breaks (the persona shown by its stored handle instead of the localized
 * product name; the engine brand leaking back in as a default) are both invisible
 * to the type checker.
 */

/** The agent a turn is running as, as reported by `system/init`. */
export interface ActingAgent {
  /** The agent's stored handle (`naby`, `researcher`, …). Only used for a
   *  non-persona agent — see `persona`. */
  name: string;
  /** Is this the built-in persona? Then the bubble uses the LOCALIZED product
   *  name (ko 나비 / en naby) instead of the stored handle: the handle is `naby`
   *  on a normal install but stays `persona` on one that hit the name-collision
   *  concession, and a Korean user should read 나비 either way. */
  persona: boolean;
}

/**
 * What the client assumes until the turn's `init` arrives.
 *
 * The persona, deliberately — an unaddressed turn IS the persona's turn, which is
 * every ordinary turn — so the sentence does not flip brand → agent a second into
 * every send. `init` corrects it for the `@other-agent` case.
 */
export const ASSUMED_ACTING_AGENT: ActingAgent = { name: 'naby', persona: true };

/** The subset of a `system/init` event this reads. */
export interface InitEventLike {
  acting_agent?: unknown;
}

/**
 * Read the acting agent off a `system/init` event, or `null` when the event
 * carries none (a non-naby engine, or a turn with no agent identity at all).
 *
 * Defensive about the shape: this crosses a wire, and a malformed field must
 * degrade to the engine-brand fallback rather than render `[object Object] is
 * thinking`.
 */
export function actingAgentFromInit(event: InitEventLike | null | undefined): ActingAgent | null {
  const raw = event?.acting_agent;
  if (!raw || typeof raw !== 'object') return null;
  const { name, persona } = raw as { name?: unknown; persona?: unknown };
  if (typeof name !== 'string' || name.trim() === '') return null;
  return { name, persona: persona === true };
}

/** Everything the bubble's name depends on. */
export interface ThinkingNameInput {
  /** The turn's acting agent, or `null` when none was reported. */
  acting: ActingAgent | null;
  /** The localized product name for the built-in persona (ko 나비 / en naby). */
  personaLabel: string;
  /** The short engine brand from engineName.ts — the fallback, and only that. */
  engineName: string;
}

/**
 * The name shown in "… is thinking". Never throws; always returns a string.
 */
export function thinkingDisplayName({ acting, personaLabel, engineName }: ThinkingNameInput): string {
  if (!acting) return engineName;
  if (acting.persona) return personaLabel || acting.name;
  return acting.name;
}
