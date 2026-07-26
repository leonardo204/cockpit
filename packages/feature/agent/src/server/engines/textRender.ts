/**
 * Whether a text event should be RENDERED, ACCUMULATED, or both.
 *
 * A streaming engine emits the same words twice by design: once as token deltas
 * (`partial: true`) and once as the finished message. Getting this branch wrong
 * does not fail loudly — it prints the answer twice, or counts every token as a
 * conversational turn, and both look like the model misbehaving rather than like a
 * bug here. So the rule lives in one tested function.
 *
 *   partial delta      → render it, accumulate nothing (the complete event owns
 *                        the transcript copy)
 *   complete message   → accumulate always; render ONLY if no deltas already put
 *                        these words on screen
 *
 * The second line is what makes a non-streaming engine work unchanged: with no
 * partials, the complete event is the only chance to render.
 */
export type TextRenderPlan = {
  /** Emit a `content_block_delta` for this text. */
  render: boolean;
  /** Add to the turn's assistant text and count it as a turn. */
  accumulate: boolean;
  /** The `sawPartial` value the caller should carry forward. */
  sawPartialNext: boolean;
};

export function planTextRender(isPartial: boolean, sawPartial: boolean): TextRenderPlan {
  if (isPartial) return { render: true, accumulate: false, sawPartialNext: true };
  // A complete message closes the block, so the flag resets for the next one — an
  // engine may stream one message and not the next.
  return { render: !sawPartial, accumulate: true, sawPartialNext: false };
}
