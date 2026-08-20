import { describe, it, expect } from 'vitest';
import {
  attachQuotedContext,
  buildQuotedMessage,
  clampPopupPosition,
  clampPopupSize,
  clampPopupWithinFrame,
  normalizePopupSize,
  parseStoredPopupSize,
  planPopupClose,
  popupDragPosition,
  popupFrameBounds,
  popupGrabOffset,
  popupResizeBox,
  popupSessionTitle,
  popupSize,
  popupSizeFromSettings,
  popupSizeSettingsPatch,
  quotePreview,
  resolvePopupSize,
  serializePopupSize,
  shouldStartPopupDrag,
  POPUP_MIN_HEIGHT,
  POPUP_MIN_WIDTH,
  POPUP_SIZE_STORAGE_KEY,
  POPUP_PREFERRED_HEIGHT,
  POPUP_PREFERRED_WIDTH,
} from './selectionChatOps';

describe('buildQuotedMessage — what the first turn actually says', () => {
  it('blockquotes every line of the selection', () => {
    expect(buildQuotedMessage('one\ntwo', 'why?')).toBe('> one\n> two\n\nwhy?');
  });

  it('keeps empty lines inside the selection as empty quote lines', () => {
    // Dropping them would glue two paragraphs of the reply together and change
    // what the user is asking about.
    expect(buildQuotedMessage('a\n\nb', 'q')).toBe('> a\n> \n> b\n\nq');
  });

  it('is the quote alone when the question is blank', () => {
    expect(buildQuotedMessage('a', '   ')).toBe('> a');
  });

  it('trims the question but not the quote', () => {
    expect(buildQuotedMessage('  a  ', '  q  ')).toBe('>   a  \n\nq');
  });
});

describe('attachQuotedContext — the quote rides the FIRST message only', () => {
  it('quotes the first send', () => {
    expect(attachQuotedContext('sel', 'q', false)).toBe('> sel\n\nq');
  });

  it('leaves every later send alone', () => {
    // This is the whole point of the feature: the side question must not be
    // dragged into the context of every subsequent turn.
    expect(attachQuotedContext('sel', 'follow up', true)).toBe('follow up');
  });

  it('is a no-op with no selection at all', () => {
    expect(attachQuotedContext(undefined, 'q', false)).toBe('q');
    expect(attachQuotedContext('', 'q', false)).toBe('q');
  });
});

describe('clampPopupPosition — it stays inside the window', () => {
  const base = {
    width: 460,
    height: 520,
    viewportWidth: 1200,
    viewportHeight: 900,
  };

  it('sits just below/right of the anchor when it fits', () => {
    const p = clampPopupPosition({ ...base, anchorX: 100, anchorY: 100 });
    expect(p).toEqual({ x: 100, y: 108, flippedAbove: false });
  });

  it('pulls back from the right edge', () => {
    const p = clampPopupPosition({ ...base, anchorX: 1150, anchorY: 100 });
    expect(p.x).toBe(1200 - 460 - 16);
    expect(p.x + base.width).toBeLessThanOrEqual(1200 - 16);
  });

  it('never goes past the left margin', () => {
    const p = clampPopupPosition({ ...base, anchorX: -50, anchorY: 100 });
    expect(p.x).toBe(16);
  });

  it('FLIPS ABOVE the anchor when it would hang off the bottom', () => {
    // Near the bottom of the screen a popup that hangs below the pointer is a
    // popup the user cannot read — same rule the old card used.
    const p = clampPopupPosition({ ...base, anchorX: 100, anchorY: 800 });
    expect(p.flippedAbove).toBe(true);
    expect(p.y).toBe(800 - 520 - 8);
    expect(p.y).toBeGreaterThanOrEqual(16);
  });

  it('still reports the flip when the space above is short too', () => {
    // The flag records the DECISION, not the final coordinate: the clamp is a
    // last resort and the caller must not be told the popup hangs below.
    const p = clampPopupPosition({
      ...base,
      anchorX: 100,
      anchorY: 300,
      viewportHeight: 400,
    });
    expect(p.flippedAbove).toBe(true);
    expect(p.y).toBe(16);
  });

  it('clamps both axes at once in a corner', () => {
    const p = clampPopupPosition({ ...base, anchorX: 1190, anchorY: 890 });
    expect(p.x).toBe(1200 - 460 - 16);
    expect(p.flippedAbove).toBe(true);
    expect(p.y).toBe(890 - 520 - 8);
  });
});

describe('popupFrameBounds — which space the popup is positioned in', () => {
  it('is the PANEL when the popup is portaled into one', () => {
    // `position: fixed` resolves against PanelPortalProvider's transformed
    // wrapper, not the window — so left/top are panel-local and the frame
    // carries the viewport offset needed to convert pointers into that space.
    const panel = { left: 260, top: 48, width: 900, height: 720 };
    expect(popupFrameBounds(panel, 1600, 900)).toEqual(panel);
  });

  it('falls back to the viewport with no panel provider', () => {
    // Portal drops to document.body, `fixed` means the window again, and the
    // two spaces coincide — offset zero.
    expect(popupFrameBounds(null, 1600, 900)).toEqual({
      left: 0,
      top: 0,
      width: 1600,
      height: 900,
    });
  });

  it('ignores a panel that has not been laid out yet', () => {
    // A zero-sized rect would clamp every position to the margin and park the
    // popup in a corner on first paint.
    expect(popupFrameBounds({ left: 0, top: 0, width: 0, height: 0 }, 1600, 900)).toEqual({
      left: 0,
      top: 0,
      width: 1600,
      height: 900,
    });
  });
});

describe('clampPopupWithinFrame — a dragged popup cannot be lost', () => {
  const base = { width: 460, height: 520, frameWidth: 800, frameHeight: 700 };
  // margin 16 ⇒ x ∈ [16, 324], y ∈ [16, 164]

  it('leaves a position that is already inside alone', () => {
    expect(clampPopupWithinFrame({ ...base, x: 170, y: 142 })).toEqual({ x: 170, y: 142 });
  });

  it('stops at the right edge', () => {
    expect(clampPopupWithinFrame({ ...base, x: 999, y: 100 })).toEqual({ x: 324, y: 100 });
  });

  it('stops at the left edge', () => {
    expect(clampPopupWithinFrame({ ...base, x: -400, y: 100 })).toEqual({ x: 16, y: 100 });
  });

  it('stops at the bottom edge — the header must never be pushed under it', () => {
    // The whole popup stays visible, which is stronger than "the header stays
    // reachable": the header IS the only way to move it back.
    expect(clampPopupWithinFrame({ ...base, x: 100, y: 999 })).toEqual({ x: 100, y: 164 });
  });

  it('stops at the top edge', () => {
    expect(clampPopupWithinFrame({ ...base, x: 100, y: -300 })).toEqual({ x: 100, y: 16 });
  });

  it('clamps BOTH axes at once in a corner', () => {
    expect(clampPopupWithinFrame({ ...base, x: 5000, y: 5000 })).toEqual({ x: 324, y: 164 });
    expect(clampPopupWithinFrame({ ...base, x: -5000, y: -5000 })).toEqual({ x: 16, y: 16 });
  });

  it('parks at the top-left when the popup is bigger than the frame', () => {
    // A short window: the low bound wins, so the header — handle and both
    // controls — is the part that stays on screen.
    expect(
      clampPopupWithinFrame({ ...base, x: 200, y: 200, frameWidth: 400, frameHeight: 300 }),
    ).toEqual({ x: 16, y: 16 });
  });

  it('re-clamps an already-placed popup when the frame SHRINKS — the resize rule', () => {
    // The popup was dragged to the bottom-right of a big panel; the window is
    // then made smaller. Without this it sits outside the panel, unreachable.
    const dragged = { x: 300, y: 150 };
    expect(
      clampPopupWithinFrame({ ...dragged, ...base, frameWidth: 600, frameHeight: 600 }),
    ).toEqual({ x: 124, y: 64 });
  });
});

describe('popupDragPosition — viewport pointer in, panel-local position out', () => {
  const frame = { left: 300, top: 48, width: 800, height: 700 };
  const size = { width: 460, height: 520 };
  const grab = { grabX: 30, grabY: 10 };

  it('follows the pointer, keeping the grab offset', () => {
    // The popup must not jump so its corner meets the cursor.
    expect(popupDragPosition({ pointerX: 500, pointerY: 200, ...grab, frame, ...size })).toEqual({
      x: 170,
      y: 142,
    });
  });

  it('subtracts the frame offset — a pointer on the panel edge is local zero-ish', () => {
    // Forgetting frame.left/top is exactly the bug this repo keeps hitting: the
    // popup would sit a top-bar's height too low and a sidebar too far right.
    expect(
      popupDragPosition({ pointerX: 316, pointerY: 74, ...grab, frame, ...size }),
    ).toEqual({ x: 16, y: 16 });
  });

  it('clamps at every edge of the frame', () => {
    expect(popupDragPosition({ pointerX: 1090, pointerY: 200, ...grab, frame, ...size }).x).toBe(324);
    expect(popupDragPosition({ pointerX: 200, pointerY: 200, ...grab, frame, ...size }).x).toBe(16);
    expect(popupDragPosition({ pointerX: 500, pointerY: 900, ...grab, frame, ...size }).y).toBe(164);
    expect(popupDragPosition({ pointerX: 500, pointerY: 0, ...grab, frame, ...size }).y).toBe(16);
  });

  it('clamps both axes at once when the pointer runs off a corner', () => {
    expect(popupDragPosition({ pointerX: 4000, pointerY: 4000, ...grab, frame, ...size })).toEqual({
      x: 324,
      y: 164,
    });
  });

  it('round-trips with popupGrabOffset — pressing without moving does not shift it', () => {
    const pos = { x: 170, y: 142 };
    const offset = popupGrabOffset({ pointerX: 500, pointerY: 200, frame, ...pos });
    expect(offset).toEqual({ grabX: 30, grabY: 10 });
    expect(popupDragPosition({ pointerX: 500, pointerY: 200, ...offset, frame, ...size })).toEqual(pos);
  });
});

describe('shouldStartPopupDrag — the controls in the handle still work', () => {
  it('accepts a press on the title', () => {
    expect(shouldStartPopupDrag([{ tag: 'SPAN' }])).toBe(true);
  });

  it('accepts a press on the handle itself (an empty path)', () => {
    expect(shouldStartPopupDrag([])).toBe(true);
  });

  it('REJECTS a press on a button in the header', () => {
    // "세션으로 변경" and ✕ own their press. A drag started there would swallow
    // the click, which is the whole reason the user pressed.
    expect(shouldStartPopupDrag([{ tag: 'BUTTON' }])).toBe(false);
  });

  it('rejects a press on the icon INSIDE a button', () => {
    // `e.target` for the ✕ is the <svg>/<path>, never the button — checking only
    // the pressed node would let the close control start a drag.
    expect(shouldStartPopupDrag([{ tag: 'path' }, { tag: 'svg' }, { tag: 'BUTTON' }])).toBe(false);
  });

  it('rejects anything else that owns a press', () => {
    expect(shouldStartPopupDrag([{ tag: 'A' }])).toBe(false);
    expect(shouldStartPopupDrag([{ tag: 'INPUT' }])).toBe(false);
    expect(shouldStartPopupDrag([{ tag: 'TEXTAREA' }])).toBe(false);
    expect(shouldStartPopupDrag([{ tag: 'DIV', role: 'button' }])).toBe(false);
  });

  it('is case-insensitive about the tag name', () => {
    expect(shouldStartPopupDrag([{ tag: 'button' }])).toBe(false);
  });

  it('lets a plain wrapper div through', () => {
    expect(shouldStartPopupDrag([{ tag: 'SPAN' }, { tag: 'DIV', role: null }])).toBe(true);
  });
});

describe('popupSize — a conversation, not a one-line card', () => {
  it('uses the preferred box on a normal window', () => {
    expect(popupSize(1600, 1000)).toEqual({
      width: POPUP_PREFERRED_WIDTH,
      height: POPUP_PREFERRED_HEIGHT,
    });
  });

  it('shrinks to fit a small window, margins included', () => {
    expect(popupSize(400, 600)).toEqual({ width: 400 - 32, height: 520 });
  });

  it('never collapses below a usable floor', () => {
    const s = popupSize(120, 120);
    expect(s.width).toBe(240);
    expect(s.height).toBe(240);
  });
});

describe('clampPopupSize — a floor and a ceiling on the box itself', () => {
  const frame = { frameWidth: 1200, frameHeight: 900 };
  // margin 16 ⇒ available 1168 × 868, floor 320 × 320

  it('leaves a size that already fits alone', () => {
    expect(clampPopupSize({ width: 600, height: 700, ...frame })).toEqual({
      width: 600,
      height: 700,
    });
  });

  it('CEILING: never wider or taller than the frame the drag is bounded to', () => {
    // The ceiling is `frame - 2 × margin` — exactly the widest box
    // clampPopupWithinFrame will accept — so a popup can never be resized into
    // a shape it cannot be dragged back from.
    expect(clampPopupSize({ width: 5000, height: 5000, ...frame })).toEqual({
      width: 1168,
      height: 868,
    });
  });

  it('CEILING on one axis at a time', () => {
    expect(clampPopupSize({ width: 5000, height: 400, ...frame })).toEqual({
      width: 1168,
      height: 400,
    });
    expect(clampPopupSize({ width: 400, height: 5000, ...frame })).toEqual({
      width: 400,
      height: 868,
    });
  });

  it('FLOOR: a 100px chat is not a chat', () => {
    // Header, quoted-context strip, hint bar and composer are ~200px of chrome
    // before a single message is shown.
    expect(clampPopupSize({ width: 100, height: 100, ...frame })).toEqual({
      width: POPUP_MIN_WIDTH,
      height: POPUP_MIN_HEIGHT,
    });
    expect(POPUP_MIN_WIDTH).toBeLessThan(POPUP_PREFERRED_WIDTH);
    expect(POPUP_MIN_HEIGHT).toBeLessThan(POPUP_PREFERRED_HEIGHT);
  });

  it('the FLOOR wins when the frame cannot hold it', () => {
    // Same trade popupSize already makes: a popup bigger than a tiny window is
    // recoverable (clampPopupWithinFrame parks it top-left, header on screen);
    // a 268px chat is not usable at any window size.
    expect(clampPopupSize({ width: 900, height: 900, frameWidth: 300, frameHeight: 300 })).toEqual({
      width: POPUP_MIN_WIDTH,
      height: POPUP_MIN_HEIGHT,
    });
  });
});

describe('resolvePopupSize — the remembered size, honoured only as far as it fits', () => {
  it('opens at the preferred box when nothing was ever remembered', () => {
    expect(resolvePopupSize(null, 1200, 900)).toEqual(popupSize(1200, 900));
    expect(resolvePopupSize(undefined, 1200, 900)).toEqual({
      width: POPUP_PREFERRED_WIDTH,
      height: POPUP_PREFERRED_HEIGHT,
    });
  });

  it('uses the remembered size when it still fits', () => {
    expect(resolvePopupSize({ width: 700, height: 600 }, 1200, 900)).toEqual({
      width: 700,
      height: 600,
    });
  });

  it('CLAMPS a size stored in a bigger window — smaller window, same popup', () => {
    // The user resized it in a maximised window, then made the window small.
    // Trimming it to fit is friendlier than forgetting the preference, and it
    // is the only option that keeps the popup wholly inside the panel.
    expect(resolvePopupSize({ width: 900, height: 800 }, 800, 700)).toEqual({
      width: 768,
      height: 668,
    });
  });

  it('floors a stored size that is too small to be a conversation', () => {
    expect(resolvePopupSize({ width: 10, height: 10 }, 1200, 900)).toEqual({
      width: POPUP_MIN_WIDTH,
      height: POPUP_MIN_HEIGHT,
    });
  });
});

describe('popupResizeBox — the grips along the bottom edge', () => {
  const frame = { left: 300, top: 48, width: 800, height: 700 };
  const start = { x: 100, y: 100, width: 460, height: 520 };
  const startPointer = { x: 900, y: 600 };
  // margin 16 ⇒ growing east stops at width 684, south at height 584

  it('se: grows both axes by the pointer delta', () => {
    expect(
      popupResizeBox({
        direction: 'se',
        start,
        startPointer,
        pointer: { x: 940, y: 630 },
        frame,
      }),
    ).toEqual({ x: 100, y: 100, width: 500, height: 550 });
  });

  it('se: CEILING on each axis — the popup stops at the frame edge', () => {
    const box = popupResizeBox({
      direction: 'se',
      start,
      startPointer,
      pointer: { x: 4000, y: 4000 },
      frame,
    });
    expect(box).toEqual({ x: 100, y: 100, width: 684, height: 584 });
    // …which is the same edge the drag clamp stops at.
    expect(box.x + box.width).toBe(frame.width - 16);
    expect(box.y + box.height).toBe(frame.height - 16);
  });

  it('se: FLOOR on each axis, and on both at once', () => {
    expect(
      popupResizeBox({ direction: 'se', start, startPointer, pointer: { x: 100, y: 620 }, frame }),
    ).toMatchObject({ width: POPUP_MIN_WIDTH, height: 540 });
    expect(
      popupResizeBox({ direction: 'se', start, startPointer, pointer: { x: 920, y: 100 }, frame }),
    ).toMatchObject({ width: 480, height: POPUP_MIN_HEIGHT });
    expect(
      popupResizeBox({ direction: 'se', start, startPointer, pointer: { x: 0, y: 0 }, frame }),
    ).toEqual({ x: 100, y: 100, width: POPUP_MIN_WIDTH, height: POPUP_MIN_HEIGHT });
  });

  it('s: height only — the width and the origin are untouched', () => {
    expect(
      popupResizeBox({ direction: 's', start, startPointer, pointer: { x: 4000, y: 630 }, frame }),
    ).toEqual({ x: 100, y: 100, width: 460, height: 550 });
  });

  it('s: floors and ceilings the height alone', () => {
    expect(
      popupResizeBox({ direction: 's', start, startPointer, pointer: { x: 900, y: 0 }, frame }).height,
    ).toBe(POPUP_MIN_HEIGHT);
    expect(
      popupResizeBox({ direction: 's', start, startPointer, pointer: { x: 900, y: 4000 }, frame }).height,
    ).toBe(584);
  });

  it('sw: MOVES THE ORIGIN, nailing the right edge down', () => {
    // Growing leftward is the whole point of this grip: a popup pushed against
    // the right edge of the panel has nothing left for `se` to grow into.
    const box = popupResizeBox({
      direction: 'sw',
      start,
      startPointer,
      pointer: { x: 860, y: 600 },
      frame,
    });
    expect(box).toEqual({ x: 60, y: 100, width: 500, height: 520 });
    expect(box.x + box.width).toBe(start.x + start.width);
  });

  it('sw: shrinking from the left keeps the right edge where it was', () => {
    const box = popupResizeBox({
      direction: 'sw',
      start,
      startPointer,
      pointer: { x: 1200, y: 600 },
      frame,
    });
    expect(box.width).toBe(POPUP_MIN_WIDTH);
    expect(box.x + box.width).toBe(560);
  });

  it('sw: stops at the left margin — the header stays reachable', () => {
    const box = popupResizeBox({
      direction: 'sw',
      start,
      startPointer,
      pointer: { x: -4000, y: 600 },
      frame,
    });
    expect(box.x).toBe(16);
    expect(box.width).toBe(544);
    // The one calculation that could strand the user, closed twice over: the
    // origin never crosses the margin, and `y` is not touched by any handle, so
    // the title bar cannot be pushed under an edge in either direction.
    expect(box.y).toBe(start.y);
  });

  it('sw: even in a frame too small for the floor, the origin holds at the margin', () => {
    // The floor wins over the ceiling (clampPopupSize's rule), so the popup now
    // overflows the RIGHT edge — the side that has no controls on it. The
    // header's left, the drag area and the title stay on screen.
    const tiny = { left: 0, top: 0, width: 300, height: 300 };
    const box = popupResizeBox({
      direction: 'sw',
      start: { x: 16, y: 16, width: 268, height: 268 },
      startPointer,
      pointer: { x: 400, y: 600 },
      frame: tiny,
    });
    expect(box.x).toBe(16);
    expect(box.width).toBe(POPUP_MIN_WIDTH);
  });

  it('no handle ever moves the top edge', () => {
    for (const direction of ['s', 'se', 'sw'] as const) {
      const box = popupResizeBox({
        direction,
        start,
        startPointer,
        pointer: { x: 0, y: 0 },
        frame,
      });
      expect(box.y, `${direction} moved the header`).toBe(start.y);
    }
  });

  it('a popup dragged into the bottom-right corner does not teleport when resized', () => {
    // 324,164 is where the drag clamp parks a 460×520 popup in this frame, so it
    // is already flush against both ceilings: resizing it outward moves nothing
    // at all rather than jumping the origin.
    const cornered = { x: 324, y: 164, width: 460, height: 520 };
    expect(
      popupResizeBox({
        direction: 'se',
        start: cornered,
        startPointer,
        pointer: { x: 4000, y: 4000 },
        frame,
      }),
    ).toEqual(cornered);
  });

  it('and the size it ends up with is what the DRAG is then clamped against', () => {
    // The two gestures share clampPopupWithinFrame's bounds by construction.
    const resized = popupResizeBox({
      direction: 'se',
      start: { x: 16, y: 16, width: 460, height: 520 },
      startPointer,
      pointer: { x: 1140, y: 680 },
      frame,
    });
    expect(resized).toMatchObject({ width: 700, height: 600 });
    expect(
      clampPopupWithinFrame({
        x: 9999,
        y: 9999,
        width: resized.width,
        height: resized.height,
        frameWidth: frame.width,
        frameHeight: frame.height,
      }),
    ).toEqual({ x: 84, y: 84 });
  });
});

describe('the remembered size — what is written and what is read back', () => {
  it('round-trips through the store', () => {
    expect(parseStoredPopupSize(serializePopupSize({ width: 700, height: 600 }))).toEqual({
      width: 700,
      height: 600,
    });
  });

  it('rounds the sub-pixel values a trackpad produces', () => {
    expect(serializePopupSize({ width: 460.4, height: 520.6 })).toBe('{"width":460,"height":521}');
  });

  it('NEVER writes the position, even when handed a whole box', () => {
    // The popup is anchored to wherever the selection is on every open;
    // reopening it at a remembered position would put it somewhere the user is
    // not looking. The fields are picked out, not spread, so this cannot rot.
    const written = serializePopupSize({ width: 400, height: 500, x: 7, y: 9 } as {
      width: number;
      height: number;
    });
    expect(Object.keys(JSON.parse(written) as object).sort()).toEqual(['height', 'width']);
  });

  it('reads nothing as nothing, and opens at the default', () => {
    expect(parseStoredPopupSize(null)).toBeNull();
    expect(parseStoredPopupSize(undefined)).toBeNull();
    expect(parseStoredPopupSize('')).toBeNull();
  });

  it('refuses anything that is not a size rather than throwing mid-placement', () => {
    // A hand-edited or stale-shape value must fall back to the default box; the
    // popup is being PLACED when this is read.
    expect(parseStoredPopupSize('not json at all')).toBeNull();
    expect(parseStoredPopupSize('null')).toBeNull();
    expect(parseStoredPopupSize('"460x520"')).toBeNull();
    expect(parseStoredPopupSize('{}')).toBeNull();
    expect(parseStoredPopupSize('{"width":460}')).toBeNull();
    expect(parseStoredPopupSize('{"width":"460","height":"520"}')).toBeNull();
    expect(parseStoredPopupSize('{"width":null,"height":520}')).toBeNull();
    expect(parseStoredPopupSize('{"width":0,"height":520}')).toBeNull();
    expect(parseStoredPopupSize('{"width":-460,"height":520}')).toBeNull();
  });

  it('accepts an over-sized stored value — clamping is resolvePopupSize\'s job', () => {
    // Rejecting it here would FORGET the preference the moment the window got
    // small once; clamping keeps it and restores it when there is room again.
    expect(parseStoredPopupSize('{"width":9000,"height":9000}')).toEqual({
      width: 9000,
      height: 9000,
    });
    expect(resolvePopupSize(parseStoredPopupSize('{"width":9000,"height":9000}'), 800, 700)).toEqual({
      width: 768,
      height: 668,
    });
  });

  // ── The durable half of the pair ──────────────────────────────────────
  //
  // localStorage is scoped per ORIGIN, port included, and the desktop shell
  // boots Next on an ephemeral one — so a size kept only there resets on every
  // restart, which is the app window's own complaint one layer down. The
  // resolution is bootTheme.ts's: settings.json is durable, localStorage is the
  // synchronous fast path, and ONE KEY names both.

  it('names the localStorage key and the settings.json field with one constant', () => {
    expect(popupSizeSettingsPatch({ width: 700, height: 600 })).toEqual({
      [POPUP_SIZE_STORAGE_KEY]: { width: 700, height: 600 },
    });
    // A field name, not a namespaced storage key — it sits in settings.json
    // beside `theme` and `fonts`.
    expect(POPUP_SIZE_STORAGE_KEY).toBe('selectionPopupSize');
  });

  it('the settings patch NEVER carries the position either, and rounds the same', () => {
    // Same guard as the localStorage half: the fields are picked out, not
    // spread, so the two stores cannot drift in shape.
    const patch = popupSizeSettingsPatch({ width: 400.4, height: 500.6, x: 7, y: 9 } as {
      width: number;
      height: number;
    });
    expect(Object.keys(patch[POPUP_SIZE_STORAGE_KEY]!).sort()).toEqual(['height', 'width']);
    expect(patch[POPUP_SIZE_STORAGE_KEY]).toEqual({ width: 400, height: 501 });
  });

  it('the patch is ONE FIELD — the merge-update must not touch theme or fonts', () => {
    expect(Object.keys(popupSizeSettingsPatch({ width: 700, height: 600 }))).toEqual([
      POPUP_SIZE_STORAGE_KEY,
    ]);
  });

  it('reads the size back out of a whole settings payload', () => {
    expect(
      popupSizeFromSettings({
        theme: 'dark',
        fonts: { uiFont: 'system' },
        [POPUP_SIZE_STORAGE_KEY]: { width: 700, height: 600 },
      }),
    ).toEqual({ width: 700, height: 600 });
  });

  it('is null when the settings file has never seen a popup', () => {
    // The seed then does nothing and the popup opens at the preferred box.
    expect(popupSizeFromSettings({ theme: 'dark' })).toBeNull();
    expect(popupSizeFromSettings({})).toBeNull();
    expect(popupSizeFromSettings(null)).toBeNull();
    expect(popupSizeFromSettings(undefined)).toBeNull();
    expect(popupSizeFromSettings('not an object')).toBeNull();
  });

  it('judges a hand-edited settings.json by the SAME rule as localStorage', () => {
    // Two stores, one normalizer: a stale shape must not be accepted by one
    // path and rejected by the other.
    for (const bad of [null, 'x', 42, {}, { width: 460 }, { width: '460', height: '520' }, { width: 0, height: 520 }, { width: -1, height: 520 }]) {
      expect(normalizePopupSize(bad), JSON.stringify(bad)).toBeNull();
      expect(popupSizeFromSettings({ [POPUP_SIZE_STORAGE_KEY]: bad })).toBeNull();
    }
    expect(normalizePopupSize({ width: 700, height: 600 })).toEqual({ width: 700, height: 600 });
    // …and the string path is the object path with a JSON.parse in front.
    expect(parseStoredPopupSize(serializePopupSize({ width: 700, height: 600 }))).toEqual(
      normalizePopupSize({ width: 700, height: 600 }),
    );
  });

  it('a size seeded from settings is clamped like any other — big monitor, small window', () => {
    // The durable copy is not privileged: it goes through the same
    // resolvePopupSize against the CURRENT frame.
    const seeded = popupSizeFromSettings({ [POPUP_SIZE_STORAGE_KEY]: { width: 1400, height: 1100 } });
    expect(resolvePopupSize(seeded, 800, 700)).toEqual({ width: 768, height: 668 });
    // …and the trimmed value is not what gets written back — the popup writes
    // only what the user actually dragged (see the wiring assertions).
    expect(seeded).toEqual({ width: 1400, height: 1100 });
  });

  it('round-trips through the durable store as well as the fast one', () => {
    const size = { width: 640, height: 580 };
    expect(popupSizeFromSettings(popupSizeSettingsPatch(size))).toEqual(size);
    expect(parseStoredPopupSize(serializePopupSize(size))).toEqual(size);
  });
});

describe('planPopupClose — the close decision matrix', () => {
  const state = {
    sessionId: null as string | null,
    hasContent: false,
    isStreaming: false,
    promoted: false,
  };

  it('NOTHING EVER SENT → no confirm, no delete', () => {
    // Sessions are minted lazily on the first turn, so there is no row to
    // delete and fabricating a delete call would be a request about nothing.
    expect(planPopupClose(state)).toEqual({ confirm: false, actions: [] });
  });

  it('sent and idle → confirm, then delete', () => {
    expect(
      planPopupClose({ ...state, sessionId: 's1', hasContent: true }),
    ).toEqual({ confirm: true, actions: ['delete'] });
  });

  it('sent and STREAMING → confirm, then stop, THEN delete — in that order', () => {
    // The run is detached server-side: closing a socket does not stop it, and
    // deleting first would race the run against the row it is writing.
    const plan = planPopupClose({
      ...state,
      sessionId: 's1',
      hasContent: true,
      isStreaming: true,
    });
    expect(plan.confirm).toBe(true);
    expect(plan.actions).toEqual(['stop', 'delete']);
  });

  it('sent, streaming, session not minted yet → stop but nothing to delete', () => {
    // The POST is in flight and `system/init` has not come back. The stop call
    // still works: it carries the client-generated runId as well as sessionId.
    expect(
      planPopupClose({ ...state, hasContent: true, isStreaming: true }),
    ).toEqual({ confirm: true, actions: ['stop'] });
  });

  it('PROMOTED → never delete, never confirm, never stop', () => {
    // The conversation is a tab now. Deleting here would delete exactly the
    // thing the user just chose to keep; stopping would kill the turn the new
    // tab is about to show.
    expect(
      planPopupClose({
        sessionId: 's1',
        hasContent: true,
        isStreaming: true,
        promoted: true,
      }),
    ).toEqual({ confirm: false, actions: [] });
  });
});

describe('quotePreview — what the discard dialog shows', () => {
  it('collapses newlines and runs of whitespace to one line', () => {
    expect(quotePreview('a\n\n  b\tc')).toBe('a b c');
  });

  it('truncates with an ellipsis', () => {
    expect(quotePreview('abcdefghij', 5)).toBe('abcd…');
  });

  it('does NOT escape — the caller decides, because one call site is React text', () => {
    expect(quotePreview('<b>hi</b>')).toBe('<b>hi</b>');
  });

  it('leaves Korean untouched', () => {
    expect(quotePreview('선택한 문장')).toBe('선택한 문장');
  });
});

describe('popupSessionTitle — the name the promoted tab opens under', () => {
  it('prefers the server-derived session title', () => {
    expect(popupSessionTitle('Why the gate refused', 'some selected text')).toBe(
      'Why the gate refused',
    );
  });

  it('falls back to the selection before any title exists', () => {
    // Promotion is offered as soon as a session is minted, which is before the
    // title has been computed.
    expect(popupSessionTitle(null, 'the selected sentence')).toBe('the selected sentence');
    expect(popupSessionTitle('   ', 'the selected sentence')).toBe('the selected sentence');
  });

  it('is always one truncated line', () => {
    expect(popupSessionTitle(null, 'a\nb', 60)).toBe('a b');
    expect(popupSessionTitle(null, 'x'.repeat(200)).length).toBe(60);
  });
});
