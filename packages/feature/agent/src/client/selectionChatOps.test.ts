import { describe, it, expect } from 'vitest';
import {
  attachQuotedContext,
  buildQuotedMessage,
  clampPopupPosition,
  clampPopupWithinFrame,
  planPopupClose,
  popupDragPosition,
  popupFrameBounds,
  popupGrabOffset,
  popupSessionTitle,
  popupSize,
  quotePreview,
  shouldStartPopupDrag,
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
