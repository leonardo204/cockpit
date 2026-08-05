/**
 * A TURN IS A SEQUENCE, NOT A BUBBLE AND A PILE OF TOOLS.
 *
 * A turn used to render as ONE assistant bubble that kept growing: every text
 * delta was appended to the same `content` string, and every tool call was
 * pushed onto the same `toolCalls` array, which the view drew as one collapsed
 * batch UNDER the bubble. So a turn that said "let me look", read four files,
 * said "now I will fix it", edited two, and then explained itself came out as a
 * single paragraph of three merged utterances with six anonymous calls beneath
 * it. The transcript no longer told you what happened in what order — which is
 * the one thing a transcript is for.
 *
 * This module is the ordered model that replaces it. A turn is a list of
 * SEGMENTS in the order the events arrived:
 *
 *   text  — one contiguous run of assistant prose (its own bubble)
 *   tools — one contiguous run of tool calls (one collapsed batch)
 *
 * The rule that matters: a text delta arriving after ANY tool activity opens a
 * NEW text segment. It is never appended to the earlier bubble, because the
 * model did not say those two things at the same moment.
 *
 * WHY THE CORE IS IN `shared/`. Both ends have to build the same list: the live
 * reducer (`client/applyStreamEvent.ts`) from the stream, and the reload mapper
 * (`server/api/session/toChatMessages.ts`) from the persisted rows. One
 * implementation, so the two cannot drift into rendering the same turn
 * differently. The RENDER-side half (resolving ids to calls, anchoring subagent
 * blocks) needs client types and lives in `client/turnSegments.ts`.
 *
 * A tools segment stores tool call IDS, not the calls themselves. The calls stay
 * in `ChatMessage.toolCalls`, which remains their single source of truth — a
 * tool RESULT arriving late then updates the call in place and leaves the
 * segment list untouched, so the memoized rows above it are not woken.
 */

export type TurnSegment =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'tools'; id: string; callIds: string[] };

/**
 * The next segment id: `s0`, `s1`, … derived from the highest id already used.
 *
 * NOT the array index. Segments are only ever APPENDED, so an index would be
 * stable today — but it is stable by accident, and a React key that is right by
 * accident is the kind of thing that re-mounts every bubble in a turn the first
 * time something is inserted. Deriving from the max keeps the id monotonic
 * whatever happens to the array.
 */
export function nextSegmentId(segments: readonly TurnSegment[]): string {
  let max = -1;
  for (const s of segments) {
    const n = Number(s.id.slice(1));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `s${max + 1}`;
}

/**
 * Fold a run of assistant text into the segment list.
 *
 * Extends the last segment when it is already text (the ordinary streaming
 * case: hundreds of deltas, one bubble). Otherwise — meaning tools have run
 * since the last thing that was said — starts a NEW text segment.
 *
 * Leading whitespace is dropped when OPENING a segment: a new run of prose
 * almost always begins with the newlines that separated it from the tool block,
 * and carrying them in would draw an empty first line in the bubble. Inside an
 * open segment whitespace is kept verbatim, because there it is the text's own
 * formatting.
 *
 * Returns the SAME array when nothing was added, so a memoized renderer sees no
 * change.
 */
export function appendTextSegment(
  segments: readonly TurnSegment[] | undefined,
  text: string
): TurnSegment[] {
  const list = (segments ?? []) as TurnSegment[];
  if (!text) return list;
  const last = list[list.length - 1];
  if (last && last.kind === 'text') {
    const out = list.slice();
    out[out.length - 1] = { ...last, text: last.text + text };
    return out;
  }
  const opening = text.replace(/^\s+/, '');
  if (!opening) return list;
  return [...list, { kind: 'text', id: nextSegmentId(list), text: opening }];
}

/**
 * Fold one tool call into the segment list, at the position it happened.
 *
 * IDEMPOTENT by id across the WHOLE list, not just the last segment: the viewer
 * replays an entire turn through the reducer on every reconnect snapshot, and a
 * call that came back a second time must not be listed twice — nor split a
 * contiguous batch in half by re-appending at the end.
 */
export function appendToolCallSegment(
  segments: readonly TurnSegment[] | undefined,
  callId: string
): TurnSegment[] {
  const list = (segments ?? []) as TurnSegment[];
  if (!callId) return list;
  for (const s of list) {
    if (s.kind === 'tools' && s.callIds.includes(callId)) return list;
  }
  const last = list[list.length - 1];
  if (last && last.kind === 'tools') {
    const out = list.slice();
    out[out.length - 1] = { ...last, callIds: [...last.callIds, callId] };
    return out;
  }
  return [...list, { kind: 'tools', id: nextSegmentId(list), callIds: [callId] }];
}

/** Every call id the list places, in order — for callers that need to know
 *  which calls the segments account for (see `buildRenderSegments`). */
export function segmentedCallIds(segments: readonly TurnSegment[] | undefined): string[] {
  const out: string[] = [];
  for (const s of segments ?? []) {
    if (s.kind === 'tools') out.push(...s.callIds);
  }
  return out;
}
