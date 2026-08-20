/**
 * The store's message stream → the chat view's message list.
 *
 * A SEPARATE MODULE, not a helper inside `history.ts`, for a mechanical reason:
 * `history.ts` is re-exported wholesale by the Next route shim
 * (`src/app/api/session/[sessionId]/history/route.ts` does `export *`), and Next
 * type-checks a route's exports against a closed set — a route that exports a
 * plain function fails the build. So the pure mapping lives here, where it can
 * also be unit-tested without dragging in the store.
 */
import type { RuntimeMessage } from '../../engines/naby';
import {
  appendTextSegment,
  appendToolCallSegment,
  type TurnSegment,
} from '../../../shared/turnSegments';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
  /** HOW LONG THE TURN TOOK, as the engine measured it (ms). Assistant bubbles
   *  only, and only on turns recorded after this existed — absent everywhere
   *  else, which is what the view keys on to show nothing at all. */
  durationMs?: number;
  /** WHEN THE TURN ENDED (ISO). Deliberately not `timestamp`, which is the
   *  bubble's creation time: on a four-minute turn the two are four minutes
   *  apart, and the user is asking when the answer ARRIVED. */
  completedAt?: string;
  /** WHAT HAPPENED IN WHAT ORDER — text runs and tool-call runs, in the order
   *  the rows were written. Built with the SAME pure helpers the live reducer
   *  uses (`shared/turnSegments.ts`), so a reloaded turn renders as the
   *  sequence it did while it was streaming. */
  segments?: TurnSegment[];
  toolCalls?: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    result?: string;
    isLoading: boolean;
    skillContent?: string;
    // Which SUBAGENT made the call, as the backend attributed it when the call
    // ran. Persisted WITH the call, so a reloaded transcript can still show a
    // delegated run as its own block — the events that describe a subagent's
    // life are observational and never stored, so the call is the only witness
    // left. (What a reload cannot show is the run's outcome; see subagentGroups.)
    agentId?: string;
    agentType?: string;
    parentToolCallId?: string;
  }>;
}

/**
 * Map the store's RuntimeMessage stream into the client's ChatMessage list.
 * `tool` rows are not rendered as their own bubbles — their output is folded
 * into the matching assistant message's tool call (by toolCallId), mirroring the
 * old tool_use/tool_result pairing.
 *
 * COALESCING (why this is not a 1:1 row→bubble map). The runtime persists ONE
 * assistant row PER TOOL CALL — `session.ts` appends
 * `{ role:'assistant', content:'', toolCalls:[one] }` on every `tool_request`,
 * because the provider pairing contract wants each call adjacent to its result.
 * That is right for the transcript and wrong for the transcript VIEW: mapped
 * naively, a reloaded turn that ran eight tools rendered as eight separate
 * assistant bubbles, each announcing "1 tool call" — while the SAME turn watched
 * live showed one bubble with eight rows in it, because `applyStreamEvent`
 * appends every call into the current assistant bubble.
 *
 * So a tool-call-only assistant row (empty content, non-empty toolCalls) is
 * merged into the assistant bubble immediately preceding it, reproducing what
 * the live stream produces. `tool` rows never break the run — they are consumed
 * below and emit nothing — but a `user` row does, since it emits a bubble of its
 * own and therefore stops being "the previous assistant message".
 *
 * An assistant row that CARRIES TEXT always starts a new bubble. That keeps the
 * final answer as its own bubble with the machinery that produced it above it,
 * instead of appending prose to a block of tool rows.
 *
 * Ids stay deterministic: a merged group keeps the id of the row that opened it,
 * so the same stored transcript always reloads with the same message ids.
 *
 * ORDER SURVIVES, AND IS RECORDED. The runtime writes each text run and each
 * tool call as its own row, in the order they happened (`src/runtime/session.ts`
 * — `text` → an assistant row, `tool_request` → an assistant row with one
 * call), so a reloaded turn knows exactly where the model stopped talking and
 * started working. That order is written onto each bubble as `segments`, using
 * the same helpers the live reducer uses, so the reload renders the turn as the
 * same sequence of bubbles and tool batches the user watched. Nothing is
 * inferred: the split points are read off the rows, never guessed at.
 */
export function toChatMessages(messages: RuntimeMessage[]): ChatMessage[] {
  // First pass: collect every tool output keyed by the call it answers.
  const toolResults = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'tool') {
      toolResults.set(m.toolCallId, m.output?.content ?? '');
    }
  }

  // Second pass: build user/assistant bubbles in order.
  const out: ChatMessage[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'user') {
      out.push({ id: `user-${i}`, role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const toolCalls = (m.toolCalls ?? []).map((tc) => ({
        id: tc.toolCallId,
        name: tc.toolName,
        input: (tc.input as Record<string, unknown>) ?? {},
        result: toolResults.get(tc.toolCallId),
        isLoading: false,
        ...(tc.subagent
          ? {
              agentId: tc.subagent.agentId,
              ...(tc.subagent.agentType ? { agentType: tc.subagent.agentType } : {}),
              ...(tc.subagent.parentToolCallId
                ? { parentToolCallId: tc.subagent.parentToolCallId }
                : {}),
            }
          : {}),
      }));
      // A tool-call-only row folds into the assistant bubble it continues —
      // appending its calls at the END of that bubble's order, which is where
      // they happened relative to whatever the bubble already holds.
      // The turn's measurement, written back onto its LAST assistant row when
      // the turn ended (Store.stampTurnEnd). Kept in one place so the merge
      // branch below and the new-bubble branch cannot drift.
      const turn = m.turn
        ? { durationMs: m.turn.durationMs, completedAt: new Date(m.turn.endedAt).toISOString() }
        : undefined;
      const previous = out[out.length - 1];
      const isToolCallOnly = m.content.trim() === '' && toolCalls.length > 0;
      if (isToolCallOnly && previous && previous.role === 'assistant') {
        previous.toolCalls = [...(previous.toolCalls ?? []), ...toolCalls];
        let segments = previous.segments;
        for (const tc of toolCalls) segments = appendToolCallSegment(segments, tc.id);
        previous.segments = segments;
        // A turn that ended ON a tool call carries the stamp on a row that folds
        // into the bubble above it — so the stamp has to fold with it, or the
        // closing line would be dropped for exactly those turns.
        if (turn) Object.assign(previous, turn);
        return;
      }
      let segments = appendTextSegment(undefined, m.content);
      for (const tc of toolCalls) segments = appendToolCallSegment(segments, tc.id);
      out.push({
        id: `assistant-${i}`,
        role: 'assistant',
        content: m.content,
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(segments.length ? { segments } : {}),
        ...(turn ?? {}),
      });
    }
    // role === 'tool' is consumed above (folded into its assistant call).
  });
  return out;
}
