/**
 * The composer's own message history: what YOU typed in THIS session, offered
 * back on `↑` from an empty input.
 *
 * Everything here is pure and derived from the transcript the chat already
 * holds — there is no request, no store and no separate copy of the drafts to
 * keep in sync. `Chat` recomputes it from `messages`; a message the user just
 * sent is in the list the moment it is rendered.
 *
 * The key handling is pure too (`composerHistoryKey`). It is not a convenience:
 * this repository has no DOM environment in its test setup (see
 * vitest.config.ts — no `environment`, no jsdom), so a decision that lives
 * inside a `handleKeyDown` closure cannot be tested at all. Modelled as
 * key + state → action, every rule below is asserted directly against the same
 * function the component calls.
 */

/** The shape this module needs off a chat message. Structurally satisfied by
 *  `ChatMessage`, but stated narrowly so the derivation never grows a
 *  dependency on the rest of the transcript model. */
export interface ComposerHistorySource {
  role: string;
  content: string;
}

/** How far back the list goes. A session can run to hundreds of turns and the
 *  popup is a pick list, not an archive — the older ones are found by scrolling
 *  the transcript, which is what it is for. */
export const COMPOSER_HISTORY_LIMIT = 50;

/** Longest single-line preview a row shows before it is cut. */
const PREVIEW_MAX = 120;

/** One shared empty array, so "no history" is referentially stable and cannot
 *  by itself defeat ChatInput's `memo`. */
export const EMPTY_COMPOSER_HISTORY: readonly string[] = Object.freeze([]);

/**
 * The user's messages from this session, NEWEST FIRST, trimmed, with blanks
 * dropped and consecutive repeats collapsed, capped at COMPOSER_HISTORY_LIMIT.
 *
 * Consecutive-only de-duplication is deliberate: sending "continue" three times
 * in a row should occupy one row, but the same word sent again an hour later is
 * a different moment in the conversation and keeps its place in the order.
 */
export function buildComposerHistory(
  messages: readonly ComposerHistorySource[] | null | undefined,
): readonly string[] {
  if (!messages || messages.length === 0) return EMPTY_COMPOSER_HISTORY;
  const out: string[] = [];
  // Walk backwards: newest first is the order the list is shown in, and the cap
  // then keeps the RECENT end rather than the ancient one.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    const text = typeof m.content === 'string' ? m.content.trim() : '';
    // A whitespace-only or empty row is usually an image-only send. There is
    // nothing to put back in the box, so it is not offered.
    if (!text) continue;
    if (out.length > 0 && out[out.length - 1] === text) continue;
    out.push(text);
    if (out.length >= COMPOSER_HISTORY_LIMIT) break;
  }
  return out.length === 0 ? EMPTY_COMPOSER_HISTORY : out;
}

/**
 * Are these two derived histories the same list?
 *
 * `buildComposerHistory` runs off `messages`, whose identity churns on every
 * streamed chunk — so a fresh array would be handed to the `memo`'d ChatInput
 * several times a second while the assistant is answering, for a list that only
 * changes when the USER sends something. The caller keeps the previous array
 * when this says nothing moved (see Chat.tsx).
 */
export function sameComposerHistory(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The single line a row shows. Multi-line messages keep their first non-empty
 *  line and are marked as cut, so a pasted spec does not become a wall of text
 *  in a pick list. */
export function composerHistoryPreview(entry: string, max: number = PREVIEW_MAX): string {
  const lines = entry.split('\n');
  const first = (lines.find((l) => l.trim() !== '') ?? '').trim();
  const hasMore = lines.length > 1 && lines.slice(1).some((l) => l.trim() !== '');
  const cut = first.length > max ? `${first.slice(0, max).trimEnd()}…` : first;
  return hasMore && !cut.endsWith('…') ? `${cut} …` : cut;
}

/** What the composer should do with a key press, decided without a DOM. */
export type ComposerHistoryAction =
  /** Not ours — let the textarea (and the send handler) have the key. */
  | { readonly type: 'none' }
  /** Open the list with this row selected. */
  | { readonly type: 'open'; readonly index: number }
  /** Move the selection. */
  | { readonly type: 'move'; readonly index: number }
  /** Put this row in the box. FILL ONLY — never a send. */
  | { readonly type: 'accept'; readonly index: number }
  /** Close the list, changing nothing. */
  | { readonly type: 'close' };

const NONE: ComposerHistoryAction = { type: 'none' };

export interface ComposerHistoryState {
  /** Is the list currently open? */
  readonly open: boolean;
  /** Selected row while open. */
  readonly index: number;
  /** The composer's CURRENT text (not the trimmed draft). */
  readonly text: string;
  /** How many rows `buildComposerHistory` produced. */
  readonly historyLength: number;
  /** Is the slash / mention palette showing? It owns the same keys and wins. */
  readonly paletteOpen: boolean;
}

/**
 * The whole key contract of the history popup.
 *
 * The rules that are easy to get wrong, and why they are the way they are:
 *
 *  * `↑` only opens on an EMPTY box. In a multi-line draft `↑` means "move the
 *    caret up a line", and taking that away to show a pick list would break
 *    ordinary editing. Attached images do not count as text — an image with no
 *    words still leaves nothing to move the caret through.
 *  * The first `↑` lands on index 0, the most recent message. Opening on
 *    "nothing selected" and asking for a second press is the behaviour every
 *    shell trained the user out of expecting.
 *  * `↑` then walks OLDER (index up), `↓` walks NEWER (index down), clamped at
 *    both ends. Shell semantics: the list is drawn newest-first, so older is
 *    further down it.
 *  * `Enter` and `Tab` FILL. Sending straight from history would make an
 *    unreviewed resend one keystroke away, and the whole point of putting the
 *    text back in the box is to edit it first.
 *  * An empty history never opens. A popup with no rows is a dead end that
 *    still has to be dismissed.
 *  * While the palette is open it takes every key. Two lists reading the same
 *    arrows at once is how one of them silently stops working.
 */
export function composerHistoryKey(key: string, state: ComposerHistoryState): ComposerHistoryAction {
  if (state.paletteOpen) return NONE;

  if (!state.open) {
    if (key !== 'ArrowUp') return NONE;
    if (state.text !== '') return NONE;
    if (state.historyLength <= 0) return NONE;
    return { type: 'open', index: 0 };
  }

  const last = state.historyLength - 1;
  // Open with nothing to show cannot happen through this function, but the
  // component's state and the derived list are separate values: if the history
  // empties underneath an open list, close rather than index into nothing.
  if (last < 0) return { type: 'close' };
  const index = Math.min(Math.max(state.index, 0), last);

  switch (key) {
    case 'ArrowUp':
      return index >= last ? { type: 'move', index: last } : { type: 'move', index: index + 1 };
    case 'ArrowDown':
      return index <= 0 ? { type: 'move', index: 0 } : { type: 'move', index: index - 1 };
    case 'Enter':
    case 'Tab':
      return { type: 'accept', index };
    case 'Escape':
      return { type: 'close' };
    default:
      return NONE;
  }
}
