/**
 * messageQueue — the composer's "send when this turn is done" queue
 * (specs/chat-message-queue.md).
 *
 * One run per session is a server rule (a second POST is a 409), so a message
 * written while naby is answering cannot go out at once. Instead of blocking
 * Enter, the composer parks it here; when the run ends the queue is settled:
 *
 *   ended normally         → everything queued goes out as ONE merged message
 *   stopped by the user    → nothing is sent; the text goes back to the composer
 *   ended in an error      → same as stopped
 *
 * Pure on purpose: Chat.tsx keeps the state in a ref and applies the returned
 * action, so every rule here — including "two end signals never send twice" —
 * is pinned by unit tests rather than by clicking.
 */
import type { ImageInfo } from './types';

/** One parked message. `id` is display-side only (React key, edit/delete). */
export interface QueuedMessage {
  id: string;
  content: string;
  images?: ImageInfo[];
}

/** The queue plus what happened to the run it is waiting on. */
export interface MessageQueueState {
  items: readonly QueuedMessage[];
  /** The user stopped the run (ESC / stop button) since it was last settled. */
  stopped: boolean;
  /** The run reported an error since it was last settled. */
  errored: boolean;
}

export const EMPTY_MESSAGE_QUEUE: MessageQueueState = { items: [], stopped: false, errored: false };

/** A message body plus its images, in the shape the send path takes. */
export interface MergedMessage {
  content: string;
  images?: ImageInfo[];
}

/** What settling a finished run asks the caller to do. */
export type SettleAction =
  | { kind: 'none' }
  | ({ kind: 'send' } & MergedMessage)
  | ({ kind: 'restore' } & MergedMessage);

let seq = 0;
/** A queue id unique within this page; never persisted. */
export function newQueuedId(): string {
  seq += 1;
  return `queued-${Date.now().toString(36)}-${seq}`;
}

/** Park a message. Empty content with no images is not a message — ignored. */
export function enqueueMessage(
  state: MessageQueueState,
  content: string,
  images?: ImageInfo[],
  id: string = newQueuedId(),
): MessageQueueState {
  const text = content.trim();
  const imgs = images && images.length > 0 ? images : undefined;
  if (!text && !imgs) return state;
  const item: QueuedMessage = imgs ? { id, content: text, images: imgs } : { id, content: text };
  return { ...state, items: [...state.items, item] };
}

/** Drop one queued message (the card's delete button). Unknown id → unchanged. */
export function removeQueued(state: MessageQueueState, id: string): MessageQueueState {
  if (!state.items.some((m) => m.id === id)) return state;
  return { ...state, items: state.items.filter((m) => m.id !== id) };
}

/** Take one queued message out to edit it (the card's edit button). */
export function takeQueued(
  state: MessageQueueState,
  id: string,
): { state: MessageQueueState; item: QueuedMessage | null } {
  const item = state.items.find((m) => m.id === id) ?? null;
  if (!item) return { state, item: null };
  return { state: removeQueued(state, id), item };
}

/**
 * Several queued messages as the ONE message that is sent: bodies joined by a
 * blank line, images in queue order. `null` when there is nothing to send.
 */
export function mergeQueued(items: readonly QueuedMessage[]): MergedMessage | null {
  if (items.length === 0) return null;
  const content = items
    .map((m) => m.content)
    .filter((c) => c.length > 0)
    .join('\n\n');
  const images = items.flatMap((m) => m.images ?? []);
  if (!content && images.length === 0) return null;
  return images.length > 0 ? { content, images } : { content };
}

/**
 * Put text back into the composer without losing what is already there: an
 * existing draft keeps its place and the returned text follows a blank line.
 */
export function appendToDraft(draft: string, text: string): string {
  if (!text) return draft;
  const head = draft.replace(/\s+$/, '');
  return head ? `${head}\n\n${text}` : text;
}

/** The run was stopped by the user. */
export function markStopped(state: MessageQueueState): MessageQueueState {
  return state.stopped ? state : { ...state, stopped: true };
}

/** The run reported an error. */
export function markErrored(state: MessageQueueState): MessageQueueState {
  return state.errored ? state : { ...state, errored: true };
}

/** A new turn is being sent: what happened to the previous one no longer applies. */
export function clearRunOutcome(state: MessageQueueState): MessageQueueState {
  return state.stopped || state.errored ? { ...state, stopped: false, errored: false } : state;
}

/**
 * The run ended. Decide what the queue does and return the state to keep.
 *
 * The returned state always has an empty queue and a clean outcome, which is
 * what makes a second end signal harmless: settling twice yields one action
 * and then `none`.
 */
export function settleRunEnd(state: MessageQueueState): { state: MessageQueueState; action: SettleAction } {
  const merged = mergeQueued(state.items);
  const next: MessageQueueState =
    state.items.length === 0 && !state.stopped && !state.errored ? state : EMPTY_MESSAGE_QUEUE;
  if (!merged) return { state: next, action: { kind: 'none' } };
  const kind = state.stopped || state.errored ? 'restore' : 'send';
  return { state: next, action: { kind, ...merged } };
}
