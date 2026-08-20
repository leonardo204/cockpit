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
// Resizing
// ─────────────────────────────────────────────────────────

/** Panel-local geometry: where the popup is AND how big it is. */
export interface PopupBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * THE FLOOR, counted against what is actually inside the popup rather than
 * picked as a round number.
 *
 * Vertically the popup is mostly chrome: the header/title bar (~33px), the
 * quoted-context strip (up to 96px — `max-h-24` — and never less than ~45px for
 * one line plus its label), the throwaway hint bar (~20px) and the composer with
 * its toolbar row (~100px). That is ~200px before a single message is shown, so
 * a 240px popup is two lines of transcript and a 100px one is none at all.
 * 320px leaves roughly 120px of conversation, which is the smallest box in which
 * the thing is still a chat rather than a tooltip.
 *
 * Horizontally the header alone needs the title, "세션으로 변경" and the ✕ side
 * by side (~230px at Korean widths) before it wraps into two rows and stops
 * reading as a title bar, and a reply containing a code block is unreadable much
 * below that. 320px is that plus room for the bubble padding.
 *
 * WHEN THE FRAME CANNOT HOLD THE FLOOR the floor still wins and the popup ends
 * up larger than its frame — the same trade `popupSize` already makes with its
 * own 240px floor, and the same one the app window's `fitIntoWorkArea` makes
 * against `MIN_WINDOW_SIZE`. `clampPopupWithinFrame` then parks it at the
 * frame's top-left, so the header (drag handle and both controls) is the part
 * that stays on screen. A popup too big for a tiny window is recoverable; a
 * 100px chat is not usable at any window size.
 */
export const POPUP_MIN_WIDTH = 320;
export const POPUP_MIN_HEIGHT = 320;

/** Clamp to `[min, available]`, with the FLOOR winning when the two invert. */
function fitAxis(value: number, min: number, available: number): number {
  return Math.max(min, Math.min(value, available));
}

export interface PopupSizeClampInput {
  width: number;
  height: number;
  frameWidth: number;
  frameHeight: number;
  margin?: number;
}

/**
 * A size the popup is allowed to have in this frame.
 *
 * The ceiling is the same box the drag is bounded to (`clampPopupWithinFrame`),
 * so a popup can never be resized into a shape it cannot then be dragged back
 * from: at most `frame - 2 × margin` on each axis, which is exactly the widest
 * position range the clamp permits.
 *
 * This is also what a REMEMBERED size goes through. A size stored in a maximised
 * window and reopened in a small one is trimmed to fit rather than honoured into
 * a popup hanging off the panel.
 */
export function clampPopupSize({
  width,
  height,
  frameWidth,
  frameHeight,
  margin = 16,
}: PopupSizeClampInput): { width: number; height: number } {
  return {
    width: fitAxis(width, POPUP_MIN_WIDTH, frameWidth - margin * 2),
    height: fitAxis(height, POPUP_MIN_HEIGHT, frameHeight - margin * 2),
  };
}

/**
 * How big this popup opens: the remembered size if there is one and it still
 * fits, otherwise the preferred box.
 *
 * `null` means "never resized" — not "resized to nothing" — so the popup keeps
 * opening at `popupSize`'s conversation-shaped default until the user says
 * otherwise. Only the SIZE is ever remembered; the position is anchored to the
 * selection every time, because reopening a popup where the user is not looking
 * is worse than reopening it at the wrong size.
 */
export function resolvePopupSize(
  stored: { width: number; height: number } | null | undefined,
  frameWidth: number,
  frameHeight: number,
  margin = 16,
): { width: number; height: number } {
  if (!stored) return popupSize(frameWidth, frameHeight, margin);
  return clampPopupSize({ ...stored, frameWidth, frameHeight, margin });
}

/**
 * Which grip is being dragged.
 *
 * THE BOTTOM BAND ONLY, and the omissions are the design:
 *
 *   no top edge   — the top edge IS the drag handle. A resize strip there would
 *                   fight the title bar for the same few pixels and could shrink
 *                   the popup out from under the pointer that meant to move it.
 *   no side strips— a full-height strip down the right edge sits exactly on top
 *                   of the transcript's scrollbar, so grabbing the scrollbar
 *                   would resize the window instead of scrolling it.
 *
 * What is left covers every intent: `se` for the ordinary "make it bigger",
 * `s` for height alone, and `sw` for widening a popup that has been pushed
 * against the right edge of the panel — where `se` has nothing left to grow into.
 */
export type PopupResizeDirection = 's' | 'se' | 'sw';

export interface PopupResizeInput {
  direction: PopupResizeDirection;
  /** The popup's PANEL-LOCAL box when the gesture started. */
  start: PopupBox;
  /** VIEWPORT pointer position when the gesture started. */
  startPointer: { x: number; y: number };
  /** VIEWPORT pointer position now. */
  pointer: { x: number; y: number };
  frame: PopupFrame;
  margin?: number;
}

/**
 * The popup's new panel-local box for one pointer move of a resize.
 *
 * SAME SPACE, SAME FRAME, SAME MARGIN AS THE DRAG. The two gestures share
 * `clampPopupWithinFrame`'s bounds by construction — a resize can only reach the
 * frame edge the drag can reach — so resizing a popup that has been dragged into
 * a corner does not teleport it, and dragging one that has been resized is
 * clamped against its new size.
 *
 * `sw` MOVES THE ORIGIN as well as the size, which is the one calculation here
 * that can strand the user. It is expressed as "the RIGHT edge is nailed down":
 * the width grows leftward until `x` would cross the margin, and the low bound
 * on `x` wins over the width when a floor-sized popup no longer fits. `y` is
 * never touched by any handle, so the header row cannot move vertically at all —
 * the two ways a resize could push the title bar out of reach are both closed.
 */
export function popupResizeBox({
  direction,
  start,
  startPointer,
  pointer,
  frame,
  margin = 16,
}: PopupResizeInput): PopupBox {
  const dx = pointer.x - startPointer.x;
  const dy = pointer.y - startPointer.y;

  // The frame offset cancels in the delta, so this needs no conversion — but the
  // frame's SIZE is still the ceiling, and the caller re-reads it every move so
  // a panel that changes size mid-gesture is respected.
  let { x, width, height } = start;
  const y = start.y;

  if (direction.includes('e')) {
    width = fitAxis(start.width + dx, POPUP_MIN_WIDTH, frame.width - margin - x);
  }
  if (direction.includes('w')) {
    const right = start.x + start.width;
    width = fitAxis(start.width - dx, POPUP_MIN_WIDTH, right - margin);
    x = Math.max(margin, right - width);
  }
  if (direction.includes('s')) {
    height = fitAxis(start.height + dy, POPUP_MIN_HEIGHT, frame.height - margin - y);
  }

  return { x, y, width, height };
}

// ─────────────────────────────────────────────────────────
// Remembering the size
// ─────────────────────────────────────────────────────────

/**
 * Where the remembered size is kept — in BOTH stores, which is one mechanism and
 * not two.
 *
 * THE HAZARD THIS AVOIDS is the one `shared-utils/bootTheme.ts` documents: the
 * desktop shell boots Next on an EPHEMERAL port (`electron/next-server.ts` calls
 * `server.listen(0)`) and `localStorage` is scoped per ORIGIN, port included, so
 * every launch is a brand new store. A size kept only there would reset on every
 * restart — the same irritation as an app window that forgets how big it was,
 * one layer down.
 *
 * SO THE THEME'S RESOLUTION IS THE POPUP'S, verbatim:
 *
 *   `settings.json`  the durable copy, under a stable `COCKPIT_HOME`. Written
 *                    through on every resize, read once when the fast path is
 *                    empty (i.e. once per launch).
 *   `localStorage`   the SYNCHRONOUS fast path. It is what the popup is placed
 *                    from, because a placement that waited on a request would
 *                    open at the default and then jump. A value here WINS: within
 *                    a run it is the newer of the two.
 *
 * One key names both, exactly as `THEME_STORAGE_KEY` does: the `localStorage`
 * key and the `settings.json` field.
 */
export const POPUP_SIZE_STORAGE_KEY = 'selectionPopupSize';

/**
 * SIZE ONLY, rounded — the one place both stores get their value from.
 *
 * The fields are picked out one at a time rather than spread, so a caller that
 * hands over a whole `PopupBox` cannot persist the position with it: the popup is
 * anchored to the selection on every open, and a remembered position would put
 * it somewhere the user is not looking. Rounding is for the sub-pixel values a
 * trackpad produces.
 */
function popupSizeOnly(size: { width: number; height: number }): {
  width: number;
  height: number;
} {
  return { width: Math.round(size.width), height: Math.round(size.height) };
}

/** What goes into `localStorage` under `POPUP_SIZE_STORAGE_KEY`. */
export function serializePopupSize(size: { width: number; height: number }): string {
  return JSON.stringify(popupSizeOnly(size));
}

/**
 * What goes into `settings.json` — the same value under the same key, as a patch
 * for the merge-update `PUT /api/settings` performs. Built here rather than at
 * the call site so the durable copy cannot drift from the fast one, in key or in
 * shape.
 */
export function popupSizeSettingsPatch(size: {
  width: number;
  height: number;
}): Record<string, { width: number; height: number }> {
  return { [POPUP_SIZE_STORAGE_KEY]: popupSizeOnly(size) };
}

/**
 * Narrow an untrusted value — a `settings.json` field or a parsed `localStorage`
 * string — into a size, or `null`.
 *
 * ONE RULE FOR BOTH STORES, which is the point: a hand-edited settings file and
 * a stale `localStorage` entry are the same hazard and must not be judged by two
 * different pieces of code. A size that is merely too big for today's window is
 * NOT rejected here — that is `clampPopupSize`'s job, and trimming it is
 * friendlier than forgetting it.
 */
export function normalizePopupSize(value: unknown): { width: number; height: number } | null {
  if (!value || typeof value !== 'object') return null;
  const { width, height } = value as { width?: unknown; height?: unknown };
  if (typeof width !== 'number' || typeof height !== 'number') return null;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * Read back the remembered size from the `localStorage` string.
 *
 * Total: hand-edited, half-written and stale-shape values all fall back to the
 * default box rather than throwing while the popup is being PLACED.
 */
export function parseStoredPopupSize(
  raw: string | null | undefined,
): { width: number; height: number } | null {
  if (!raw) return null;
  try {
    return normalizePopupSize(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Read back the remembered size from a whole `settings.json` payload — the seed
 * used when this origin's `localStorage` is empty, which after an app restart it
 * always is.
 */
export function popupSizeFromSettings(settings: unknown): { width: number; height: number } | null {
  if (!settings || typeof settings !== 'object') return null;
  return normalizePopupSize((settings as Record<string, unknown>)[POPUP_SIZE_STORAGE_KEY]);
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
