/**
 * selectionChatOps — every DECISION the selection popup chat makes, as pure
 * functions.
 *
 * The popup itself is a portal, a react-render-prop and two host callbacks; the
 * interesting parts are the rules, and they are all here so they can be tested
 * without a DOM. What replaced what:
 *
 *   BEFORE  select text in a reply → "Send to AI" → a one-line card → the
 *           question was injected into the CURRENT session as a quoted message.
 *           The side question then lived forever in the main transcript and was
 *           dragged into the context of every later turn.
 *   NOW     the same selection opens a SELF-CONTAINED conversation with its own
 *           session. Close it and it is gone; promote it and it becomes a tab.
 *
 * `buildQuotedMessage` survives verbatim from the old path — the quoting itself
 * was never the problem, only where the answer landed.
 */

/**
 * Quote-reply formatter — inlined from the removed `@cockpit/feature-comments`
 * `buildAIMessage()` (F1-03 chat-first trim). The persistent code-annotation
 * store is gone; the only surviving path is "select text in a reply, ask a
 * question about it", which needs nothing more than markdown blockquoting.
 */
export function buildQuotedMessage(selectedText: string, question: string): string {
  const quoted = selectedText.split('\n').map((l) => `> ${l}`).join('\n');
  const q = question.trim();
  return q ? `${quoted}\n\n${q}` : quoted;
}

/**
 * What actually goes on the wire for one send from the popup composer.
 *
 * THE QUOTE RIDES THE FIRST MESSAGE AND ONLY THE FIRST. The popup exists
 * because a side question should not be dragged into every later turn of the
 * main conversation; re-quoting the selection on every turn of the POPUP would
 * reproduce that fault one level down, and the engine already has the quote in
 * this session's own history from turn one.
 *
 * `alreadyAttached` is the caller's latch (a ref in the component). Passing it
 * in rather than keeping module state here is what makes two popups open at
 * once impossible to confuse — there is no shared cell to confuse.
 */
export function attachQuotedContext(
  quote: string | undefined,
  content: string,
  alreadyAttached: boolean,
): string {
  if (!quote || alreadyAttached) return content;
  return buildQuotedMessage(quote, content);
}

// ─────────────────────────────────────────────────────────
// Placement
// ─────────────────────────────────────────────────────────

export interface PopupPlacementInput {
  /** Where the user's pointer finished the selection, in VIEWPORT coordinates. */
  anchorX: number;
  anchorY: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  /** Keep-out band at every edge. */
  margin?: number;
  /** Distance between the anchor and the popup's near edge. */
  gap?: number;
}

export interface PopupPlacement {
  x: number;
  y: number;
  /** True when the popup was moved ABOVE the anchor because it did not fit
   *  below. Reported so the caller can point a visual affordance the right way
   *  and so the rule is assertable. */
  flippedAbove: boolean;
}

/**
 * Where the popup goes, given where the selection ended.
 *
 * VIEWPORT COORDINATES, NOT CONTAINER ONES, and that is the whole difference
 * from the card this replaces. `SendToAIInput` positioned itself `absolute`
 * inside the message list, which works only because it is small: the list's
 * host is `overflow-hidden` (Chat.tsx) and the three-panel shell wraps
 * everything in a `translateX` container, so a box the size of a conversation
 * would be clipped by both. The popup is portaled and `fixed`, so it is placed
 * against the window and the clipping ancestors never apply.
 *
 * The flip-above rule is `CodeInputCards.tsx`'s, kept deliberately: near the
 * bottom of the screen a popup that hangs below the pointer is a popup the user
 * cannot read.
 */
export function clampPopupPosition({
  anchorX,
  anchorY,
  width,
  height,
  viewportWidth,
  viewportHeight,
  margin = 16,
  gap = 8,
}: PopupPlacementInput): PopupPlacement {
  let x = anchorX;
  if (x + width > viewportWidth - margin) x = viewportWidth - width - margin;
  if (x < margin) x = margin;

  let y = anchorY + gap;
  let flippedAbove = false;
  if (y + height > viewportHeight - margin) {
    y = anchorY - height - gap;
    flippedAbove = true;
  }
  // A popup taller than the space above the anchor still has to start
  // somewhere on screen. It stays FLIPPED (the flag records the decision, not
  // the final coordinate) — `popupSize` caps the height so this clamp only
  // trims the last few pixels rather than hiding the composer.
  if (y < margin) y = margin;

  return { x, y, flippedAbove };
}

// ─────────────────────────────────────────────────────────
// The frame the popup lives in, and dragging inside it
// ─────────────────────────────────────────────────────────

/**
 * The box the popup's `left`/`top` are measured against, in VIEWPORT
 * coordinates.
 *
 * READ THIS BEFORE TOUCHING ANY COORDINATE HERE. The popup is `position: fixed`
 * inside a `<Portal>`, and that portal lands in `PanelPortalProvider`'s target
 * — a wrapper carrying `transform: translateZ(0)`. A transform makes its element
 * the containing block for `fixed` descendants, so the popup's `left`/`top` are
 * NOT viewport coordinates: they are relative to that panel's padding box, which
 * the `absolute inset-0` portal target covers exactly. Everything the popup
 * stores as a position is therefore PANEL-LOCAL, and every number that arrives
 * from a pointer event (`clientX/clientY`) or from a selection anchor is
 * VIEWPORT. `left`/`top` here is what converts between the two.
 *
 * With no panel provider the portal falls back to `document.body`, `fixed`
 * resolves against the viewport again, and the two spaces coincide — which is
 * exactly what the null branch returns.
 */
export interface PopupFrame {
  /** Viewport offset of the frame's origin. Subtract it from a viewport
   *  coordinate to get a popup-local one. */
  left: number;
  top: number;
  width: number;
  height: number;
}

export function popupFrameBounds(
  panelRect: { left: number; top: number; width: number; height: number } | null,
  viewportWidth: number,
  viewportHeight: number,
): PopupFrame {
  if (!panelRect || panelRect.width <= 0 || panelRect.height <= 0) {
    return { left: 0, top: 0, width: viewportWidth, height: viewportHeight };
  }
  return panelRect;
}

export interface PopupClampInput {
  /** Popup-local position being proposed. */
  x: number;
  y: number;
  width: number;
  height: number;
  frameWidth: number;
  frameHeight: number;
  margin?: number;
}

/**
 * Keep a dragged popup inside its frame.
 *
 * WHAT "INSIDE THE CHAT AREA" MEANS HERE, precisely: the frame is the panel that
 * holds the tab bar and the conversation column — the `PanelPortalProvider`
 * wrapper, which is also the containing block for the popup's `fixed`. It
 * excludes the app top bar above it and the file browser beside it. That is the
 * region the user pointed at ("대화창 안에서"), and it is the only region whose
 * coordinates the popup can express without a second conversion.
 *
 * THE POPUP STAYS WHOLLY VISIBLE — not merely "the header stays reachable". A
 * window whose header can be pushed under an edge is a window that cannot be
 * dragged back, and this one has no other way to move. The clamp is applied per
 * axis, so a corner is just both clamps at once.
 *
 * When the popup is LARGER than the frame (a very short window; `popupSize`
 * has a 240px floor it will not go under) the low bound wins and the popup
 * settles at the frame's top-left. That keeps the header — the drag handle and
 * both controls — on screen, which is the property that must never be lost.
 */
export function clampPopupWithinFrame({
  x,
  y,
  width,
  height,
  frameWidth,
  frameHeight,
  margin = 16,
}: PopupClampInput): { x: number; y: number } {
  const clampAxis = (v: number, size: number, frame: number): number => {
    const max = frame - size - margin;
    return Math.max(margin, Math.min(max, v));
  };
  return {
    x: clampAxis(x, width, frameWidth),
    y: clampAxis(y, height, frameHeight),
  };
}

/**
 * Where the pointer grabbed the popup, as an offset from the popup's own
 * top-left. Taken once at pointer-down and held for the whole gesture, which is
 * what keeps the popup from jumping so its corner meets the cursor.
 *
 * `pointerX/pointerY` are VIEWPORT (`clientX/clientY`); `x/y` are POPUP-LOCAL.
 */
export function popupGrabOffset({
  pointerX,
  pointerY,
  frame,
  x,
  y,
}: {
  pointerX: number;
  pointerY: number;
  frame: Pick<PopupFrame, 'left' | 'top'>;
  x: number;
  y: number;
}): { grabX: number; grabY: number } {
  return {
    grabX: pointerX - frame.left - x,
    grabY: pointerY - frame.top - y,
  };
}

/**
 * The popup's new POPUP-LOCAL position for one pointer move: convert the
 * viewport pointer into the frame's space, subtract the grab offset, clamp.
 *
 * The frame is re-read by the caller on every move rather than captured at
 * pointer-down, so a panel that resizes mid-drag (the file browser opening, a
 * window resize) does not skew the conversion.
 */
export function popupDragPosition({
  pointerX,
  pointerY,
  grabX,
  grabY,
  frame,
  width,
  height,
  margin,
}: {
  pointerX: number;
  pointerY: number;
  grabX: number;
  grabY: number;
  frame: PopupFrame;
  width: number;
  height: number;
  margin?: number;
}): { x: number; y: number } {
  return clampPopupWithinFrame({
    x: pointerX - frame.left - grabX,
    y: pointerY - frame.top - grabY,
    width,
    height,
    frameWidth: frame.width,
    frameHeight: frame.height,
    margin,
  });
}

/** One step of the ancestor chain from the pressed element up to the handle. */
export interface PressPathNode {
  /** `Element.tagName`, i.e. already upper-case for HTML. */
  tag: string;
  role?: string | null;
}

/**
 * Elements inside the drag handle that own the press instead. Anything focusable
 * or clickable: starting a drag on one of them would swallow the click that was
 * the user's actual intent (the ✕ and "세션으로 변경" both live in the handle).
 */
export const POPUP_DRAG_IGNORE_TAGS: readonly string[] = [
  'BUTTON',
  'A',
  'INPUT',
  'TEXTAREA',
  'SELECT',
  'LABEL',
  'SUMMARY',
];

/**
 * Does this press begin a drag?
 *
 * Takes the ancestor CHAIN rather than a DOM node so the decision is testable
 * where the tests actually run — this suite has no DOM environment (vitest
 * defaults to node here), and a rule expressed as `target.closest(...)` could
 * only be tested against a fake `closest`. The component walks the real chain
 * and hands it over.
 *
 * The path runs from the pressed element outward and stops AT the handle, so an
 * ignored tag anywhere along it — the `<svg>` inside the ✕ button reports itself,
 * its button is the next node up — rejects the drag.
 */
export function shouldStartPopupDrag(path: readonly PressPathNode[]): boolean {
  for (const node of path) {
    if (POPUP_DRAG_IGNORE_TAGS.includes(node.tag.toUpperCase())) return false;
    if (node.role === 'button' || node.role === 'link') return false;
  }
  return true;
}

/** Preferred popup box, before it is placed. */
export const POPUP_PREFERRED_WIDTH = 460;
export const POPUP_PREFERRED_HEIGHT = 520;

/**
 * How big the popup may be in this window.
 *
 * It is sized for a CONVERSATION — many turns, a composer, a scrollback — not
 * for the one-line question the old card asked, so it takes the preferred box
 * and only shrinks when the window is smaller than that plus its margins.
 */
export function popupSize(
  viewportWidth: number,
  viewportHeight: number,
  margin = 16,
): { width: number; height: number } {
  return {
    width: Math.max(240, Math.min(POPUP_PREFERRED_WIDTH, viewportWidth - margin * 2)),
    height: Math.max(240, Math.min(POPUP_PREFERRED_HEIGHT, viewportHeight - margin * 2)),
  };
}

// ─────────────────────────────────────────────────────────
// Closing
// ─────────────────────────────────────────────────────────

export type PopupCloseAction = 'stop' | 'delete';

export interface PopupCloseState {
  /** The session the engine MINTED for this popup, or null if no turn has ever
   *  been sent. Sessions are created lazily server-side on the first turn
   *  (server/engines/naby.ts), so null here means there is nothing on disk. */
  sessionId: string | null;
  /** The user has sent at least one message — there is something to lose. */
  hasContent: boolean;
  /** A turn is in flight right now. */
  isStreaming: boolean;
  /** The conversation was just handed to a real tab. It is no longer throwaway. */
  promoted: boolean;
}

export interface PopupClosePlan {
  /** Ask first. Discarding a conversation that has content is irreversible. */
  confirm: boolean;
  /** IN ORDER. `stop` before `delete` is not cosmetic: the run is detached
   *  server-side (closing a socket does not stop it), so deleting first would
   *  race a live run against the row it is writing into — and would leave the
   *  machine working on a conversation nobody will ever read. */
  actions: readonly PopupCloseAction[];
}

/**
 * What closing the popup should do.
 *
 * The four cases, stated once so the component cannot get them subtly wrong:
 *
 *   nothing ever sent   → nothing. No session was minted, so there is no row to
 *                         delete and no dialog to justify. A popup opened and
 *                         closed without a question has ZERO footprint.
 *   sent, idle          → confirm, then delete.
 *   sent, streaming     → confirm, then STOP the run, then delete.
 *   promoted            → nothing, ever. The conversation is a tab now; deleting
 *                         it here would delete the thing the user just chose to
 *                         keep.
 */
export function planPopupClose(state: PopupCloseState): PopupClosePlan {
  if (state.promoted) return { confirm: false, actions: [] };

  const actions: PopupCloseAction[] = [];
  if (state.isStreaming) actions.push('stop');
  if (state.sessionId) actions.push('delete');

  return { confirm: state.hasContent || actions.length > 0, actions };
}

// ─────────────────────────────────────────────────────────
// Naming
// ─────────────────────────────────────────────────────────

/** Collapse to one line and cut to `max` graphemes-ish, with an ellipsis. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The quoted selection, shrunk to something a confirm dialog can hold.
 *
 * Callers MUST escape the result before interpolating it into a translated
 * string bound for `confirm()` — that dialog builds its markup with innerHTML
 * and the i18n singleton runs with `escapeValue: false` (see
 * fileBrowserOps.escapeHtml). This function only shortens; it does not escape,
 * because the same preview is also rendered as React text where escaping would
 * show the user `&lt;`.
 */
export function quotePreview(selectedText: string, max = 60): string {
  return oneLine(selectedText, max);
}

/**
 * The title the promoted tab opens under.
 *
 * Prefers the SERVER-DERIVED session title — the popup's inner chat already
 * fetches it after the first turn through the same `onTitleChange` path every
 * tab uses, so a promoted conversation is named exactly as it would have been
 * had it started as a tab. Falls back to the selection, which is the only thing
 * that certainly exists: a popup can be promoted the moment its session is
 * minted, which is before any title has been computed.
 */
export function popupSessionTitle(
  serverTitle: string | null | undefined,
  selectedText: string,
  max = 60,
): string {
  const fromServer = (serverTitle ?? '').trim();
  if (fromServer) return oneLine(fromServer, max);
  return oneLine(selectedText, max);
}
