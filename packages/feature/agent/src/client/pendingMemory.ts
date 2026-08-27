/**
 * pendingMemory.ts — the memory a turn just proposed, offered where it happened.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THERE IS A BUTTON AND NOT A TOOL
 *
 * A memory captured from conversation is written `proposed` and `artifact`-tier,
 * and it stays that way until a PERSON agrees to it. That is not caution for its
 * own sake: `naby_remember` cannot tell an instruction the user gave from a fact
 * naby inferred, and promoting on the model's say-so would let it choose which
 * tier judges its own writes — the failure this codebase already fixed once in
 * the voice layer, where a rewrite could buy a looser band by mixing in a few
 * characters.
 *
 * So the confirm could not be a tool. `confirmMemory` is documented as "the ONLY
 * path external-origin memory becomes confirmed… a threshold can never do it,
 * only a user", and a tool call is the model, however faithfully it reports what
 * the user just said. The click is the user, through the same HTTP action the
 * settings screen uses.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AND WHY THE TURN IS NOT SUSPENDED
 *
 * Tool approvals pause the turn because the answer decides what happens next.
 * Nothing waits on this one — the turn's work is done either way, and blocking
 * it to ask "shall I remember that you like polite answers?" would interrupt the
 * thing the user actually asked for. The offer sits in the transcript and is
 * answered whenever they feel like it.
 *
 * `naby_checkin` was the other candidate and is deliberately NOT reused: it
 * writes to the trust ledger, so a "shall I remember this?" question would be
 * scored as a prediction about the user's preferences and would move the meter.
 */

/** The tool whose result this reads. Named once so the renderer and the tests
 *  cannot disagree about which call carries an offer. */
export const REMEMBER_TOOL = 'naby_remember';

export interface PendingMemory {
  /** The row to confirm. */
  id: string;
  /** Its slug, for a label the reader can recognise. */
  key: string;
}

/**
 * The offer a `naby_remember` result carries, or null when there is nothing to
 * offer.
 *
 * Null for a call that is still running, one that failed, and — the case worth
 * naming — one whose memory is ALREADY `confirmed`. The write gate can confirm
 * on the spot when the claim is corroborated across sessions, and a button that
 * asks for agreement already given is a button that does nothing.
 *
 * Total: this reads a payload that crossed a JSON boundary, and a shape it does
 * not recognise must produce no button rather than throw inside a render.
 */
export function pendingMemoryOf(
  toolName: string,
  resultData: unknown,
): PendingMemory | null {
  if (toolName !== REMEMBER_TOOL) return null;
  // ABSENT IS THE ORDINARY CASE, not an error: a live turn carries only the
  // prose (the stream has no structured half), and every tool that is not this
  // one has nothing to offer. Both simply produce no button.
  if (!resultData || typeof resultData !== 'object') return null;
  const row = resultData as Record<string, unknown>;
  if (row.status !== 'proposed') return null;
  const id = typeof row.id === 'string' ? row.id : '';
  const key = typeof row.key === 'string' ? row.key : '';
  if (!id) return null;
  return { id, key: key || id };
}
