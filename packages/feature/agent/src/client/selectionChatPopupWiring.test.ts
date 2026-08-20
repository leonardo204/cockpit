import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The selection popup's wiring, asserted at the source.
 *
 * Everything the popup DECIDES lives in selectionChatOps.ts and is unit-tested
 * there. What is left is the part a pure test cannot reach and jsdom cannot
 * either — it has no layout, no portals worth speaking of, and no second chat
 * tab — yet each of these is a way to ship the feature looking correct and
 * being wrong:
 *
 *   1. THE POPUP IS CLIPPED AWAY. The message list's host is `overflow-hidden`
 *      and the shell wraps everything in a `translateX` container; an in-place
 *      popup the size of a conversation is cut off by both. Same bug that once
 *      erased three sidebar panels and the file-browser context menu.
 *   2. THE POPUP HIJACKS THE APP-WIDE SENDER. `ChatContext.setActiveTab` is a
 *      last-writer-wins ref that every `chatCtx.sendMessage` / `useAIBridge()`
 *      caller resolves through. A popup that wrote it would take delivery of
 *      messages meant for the real tab — and would keep doing so after being
 *      discarded.
 *   3. THE DETACHED RUN OUTLIVES THE POPUP. Closing a socket does not stop a
 *      run; deleting before stopping races the run against the row it writes.
 *   4. A PROMOTED CONVERSATION IS DELETED ANYWAY, by the close path that
 *      follows the promotion.
 */

const CLIENT = __dirname;
const read = (name: string) => readFileSync(join(CLIENT, name), 'utf8');
const LOCALES = join(CLIENT, '..', '..', '..', '..', 'shared', 'i18n', 'locales');

describe('selection popup — it escapes the hosts that clip', () => {
  it('renders through Portal and is fixed-positioned', () => {
    const src = read('SelectionChatPopup.tsx');
    expect(src).toContain("from '@cockpit/shared-ui'");
    expect(src).toContain('<Portal>');
    const rootClass = /className="fixed z-\[200\][^"]*"/.exec(src)?.[0];
    expect(rootClass, 'popup root className not found — did the markup change?').toBeDefined();
    expect(rootClass).not.toContain('absolute');
  });

  it('still opens from a transcript that clips — the premise of the rule above', () => {
    // If the message list ever stops clipping, the rule is free to relax.
    // Asserting the premise keeps the test honest instead of guarding nothing.
    const chat = read('Chat.tsx');
    expect(chat).toContain('flex-1 flex flex-col min-h-0 overflow-hidden');
  });

  it('carries the z-[200] class the host mousedown guard matches on', () => {
    // React routes portal events through the COMPONENT tree, so a click in the
    // popup's composer still reaches MessageList's "clear the toolbar" handler.
    // The class string is the contract between the two.
    const list = read('MessageList.tsx');
    expect(list).toContain('[class*="z-[200]"]');
    expect(read('SelectionChatPopup.tsx')).toContain('fixed z-[200]');
  });

  it('does not import Chat back — the popup is rendered BY Chat', () => {
    const src = read('SelectionChatPopup.tsx');
    expect(src).not.toMatch(/from '\.\/Chat'/);
    // The conversation surface arrives as a render prop instead.
    expect(src).toContain('children(wiring)');
  });
});

describe('selection popup — dragging it by the header', () => {
  // The maths is pure and tested in selectionChatOps.test.ts. What is left is
  // the wiring, and every item here is a way to ship a draggable window that
  // looks right and is wrong in a way no unit test can see.
  const src = () => read('SelectionChatPopup.tsx');

  it('the handle is the header row, and it says so with a cursor', () => {
    const handle = /data-testid="selection-chat-drag-handle"[\s\S]{0,700}?\/>|data-testid="selection-chat-drag-handle"[\s\S]{0,700}?>/.exec(src())?.[0];
    expect(handle, 'the drag handle was not found').toBeDefined();
    expect(handle).toContain('onPointerDown={handlePointerDown}');
    expect(handle).toContain('onPointerMove={handlePointerMove}');
    expect(handle).toContain('onPointerUp={handlePointerEnd}');
    expect(handle).toContain('onPointerCancel={handlePointerEnd}');
    // The classes, read off the className itself rather than off a comment
    // that happens to name them.
    const cls = /className="([^"]*)"/.exec(handle!)?.[1] ?? '';
    // Discoverability: the user had to guess that the row could be grabbed.
    expect(cls).toContain('cursor-move');
    // A press that both drags the window and highlights the title is neither.
    expect(cls).toContain('select-none');
    // Without touch-action:none the browser claims a touch drag as a scroll
    // before a single pointermove is delivered.
    expect(cls).toContain('touch-none');
    // The title lives in the same row, so it is the handle.
    expect(src()).toMatch(/selection-chat-drag-handle[\s\S]{0,900}selectionChat\.title/);
  });

  it('uses POINTER CAPTURE, not document-level mouse listeners', () => {
    // Capture is what keeps a fast drag attached to the element it started on,
    // and it brings pen/touch with it.
    const s = src();
    expect(s).toContain('setPointerCapture(e.pointerId)');
    expect(s).toContain('releasePointerCapture(e.pointerId)');
    expect(s).not.toMatch(/document\.addEventListener\(\s*'mousemove'/);
    expect(s).not.toMatch(/addEventListener\(\s*'mouseup'/);
    // Released on cancel as well as up — both are wired to the same handler.
    expect(s).toMatch(/const handlePointerEnd = useCallback\([\s\S]{0,400}releasePointerCapture/);
  });

  it('releases a captured pointer on unmount', () => {
    // Esc, promote and the discard confirm can all unmount the popup mid-drag.
    expect(src()).toMatch(
      /useEffect\(\s*\(\) => \(\) => \{[\s\S]{0,600}handle\?\.hasPointerCapture\(drag\.pointerId\)[\s\S]{0,200}releasePointerCapture/,
    );
  });

  it('the press is refused when it lands on a control in the header', () => {
    // The ✕ and "세션으로 변경" must keep their clicks. The component walks the
    // real ancestor chain; the RULE is pure (shouldStartPopupDrag).
    const s = src();
    expect(s).toContain('shouldStartPopupDrag(path)');
    expect(s).toMatch(/for \(let el = e\.target as Element \| null; el && el !== e\.currentTarget; el = el\.parentElement\)/);
    expect(s).toMatch(/if \(!shouldStartPopupDrag\(path\)\) return;/);
    // …and the refusal happens BEFORE anything captures the pointer.
    expect(s.indexOf('if (!shouldStartPopupDrag(path)) return;')).toBeLessThan(
      s.indexOf('setPointerCapture(e.pointerId)'),
    );
  });

  it('moves the FRAME, not the conversation — no state write per pointer move', () => {
    // The popup hosts a live streaming transcript. A setState per pointermove
    // would re-render it sixty times a second (React Performance Conventions).
    const s = src();
    const move = /const handlePointerMove = useCallback\([\s\S]*?\n  \);/.exec(s)?.[0];
    expect(move, 'handlePointerMove was not found').toBeDefined();
    expect(move).not.toMatch(/\bset[A-Z][A-Za-z]*\(/);
    expect(move).toContain('posRef.current = popupDragPosition(');
    expect(move).toContain('applyPosition()');
    // The position is a ref, and the DOM write is the only writer of left/top.
    expect(s).toMatch(/const applyPosition = useCallback\([\s\S]{0,400}el\.style\.left = `\$\{pos\.x\}px`/);
  });

  it('the style prop never carries left/top, so a re-render cannot undo a drag', () => {
    // React re-committing a stale style is how a dragged window snaps back
    // mid-stream. The rendered pair is a constant; applyPosition owns the rest.
    const s = src();
    const style = /style=\{[\s\S]*?\n        \}/.exec(s)?.[0];
    expect(style, 'the frame style prop was not found').toBeDefined();
    expect(style).not.toMatch(/left: (pos|box|size)\./);
    expect(style).toContain('left: -9999');
    // …and it is re-applied after EVERY render, not on a dependency.
    expect(s).toContain('useLayoutEffect(applyPosition);');
  });

  it('once moved, the anchored placement never runs again', () => {
    // The user put it there. Re-anchoring on the next resize would take it back.
    const s = src();
    const place = /const place = useCallback\([\s\S]*?\n  \}, \[/.exec(s)?.[0];
    expect(place, 'place() was not found').toBeDefined();
    expect(place).toMatch(/if \(movedRef\.current && posRef\.current\) \{/);
    // The moved branch only re-clamps; the anchored branch is the else.
    expect(place).toContain('clampPopupWithinFrame(');
    expect(place!.indexOf('clampPopupWithinFrame(')).toBeLessThan(
      place!.indexOf('clampPopupPosition('),
    );
    expect(s).toContain('movedRef.current = true');
    // A resize still runs place(), which is what re-clamps a stranded popup.
    expect(s).toMatch(/addEventListener\('resize', place\)/);
  });

  it('measures the frame it is actually positioned against', () => {
    // `fixed` inside PanelPortalProvider resolves against that panel's
    // transformed wrapper, NOT the viewport. Assuming the window here is the
    // recurring bug in this repo; the frame is read from the portal target and
    // the anchor is converted into its space.
    const s = src();
    expect(s).toContain('usePanelPortalTarget()');
    expect(s).toContain('panelTarget?.getBoundingClientRect()');
    expect(s).toContain('popupFrameBounds(');
    expect(s).toMatch(/anchorX: anchor\.x - frame\.left/);
    expect(s).toMatch(/anchorY: anchor\.y - frame\.top/);
    // The panel is the containing block, so its size is the placement bound.
    expect(s).toMatch(/viewportWidth: frame\.width/);
    // The provider that makes this true is still doing it.
    const portal = readFileSync(
      join(CLIENT, '..', '..', '..', '..', 'shared', 'ui', 'src', 'Portal.tsx'),
      'utf8',
    );
    expect(portal).toContain("transform: 'translateZ(0)'");
  });
});

describe('selection popup — resizing it from the bottom edge', () => {
  // The maths is pure and tested in selectionChatOps.test.ts. What is left is
  // the wiring — and the resize shares every load-bearing property the drag has,
  // so each of these is a way to ship a resizable window that looks right and
  // regresses something that was hard-won.
  const src = () => read('SelectionChatPopup.tsx');
  const GRIPS = [
    ['selection-chat-resize-s', 's', 'cursor-ns-resize'],
    ['selection-chat-resize-sw', 'sw', 'cursor-nesw-resize'],
    ['selection-chat-resize-se', 'se', 'cursor-nwse-resize'],
  ] as const;

  const grip = (testid: string) =>
    new RegExp(`data-testid="${testid}"[\\s\\S]{0,700}?(?:\\/>|>)`).exec(src())?.[0];

  it('every grip is wired, and says what it does with the right cursor', () => {
    for (const [testid, dir, cursor] of GRIPS) {
      const el = grip(testid);
      expect(el, `${testid} was not found`).toBeDefined();
      expect(el).toContain(`data-resize-dir="${dir}"`);
      expect(el).toContain('onPointerDown={handleResizeDown}');
      expect(el).toContain('onPointerMove={handleResizeMove}');
      expect(el).toContain('onPointerUp={handleResizeEnd}');
      expect(el).toContain('onPointerCancel={handleResizeEnd}');
      const cls = /className="([^"]*)"/.exec(el!)?.[1] ?? '';
      // Discoverability, the same problem the header had before it got
      // `cursor-move`: an invisible affordance is not an affordance.
      expect(cls, `${testid} does not advertise its axis`).toContain(cursor);
      // Without touch-action:none the browser claims a touch drag as a scroll
      // before a single pointermove is delivered.
      expect(cls).toContain('touch-none');
      expect(cls).toContain('select-none');
    }
  });

  it('the bottom-right corner is DRAWN, not just a cursor', () => {
    const el = grip('selection-chat-resize-se');
    expect(el).toContain('cursor-nwse-resize');
    // The grip glyph lives inside the handle element.
    expect(src()).toMatch(/selection-chat-resize-se[\s\S]{0,900}<svg/);
  });

  it('the corners come after the edge strip, so they win the overlap', () => {
    const s = src();
    expect(s.indexOf('selection-chat-resize-s"')).toBeLessThan(
      s.indexOf('selection-chat-resize-sw"'),
    );
    expect(s.indexOf('selection-chat-resize-sw"')).toBeLessThan(
      s.indexOf('selection-chat-resize-se"'),
    );
  });

  it('the grips are OUTSIDE the drag handle — the two gestures cannot both run', () => {
    // A grip nested in the header would get the header's pointerdown as well,
    // and a press on a header BUTTON would still be refused by
    // shouldStartPopupDrag while the resize started anyway.
    const s = src();
    const handle = /data-testid="selection-chat-drag-handle"[\s\S]*?\n        <\/div>/.exec(s)?.[0];
    expect(handle, 'the drag handle was not found').toBeDefined();
    expect(handle).not.toContain('data-resize-dir');
    // …and no handle sits on the top edge, which is the drag handle's own row.
    expect(s).not.toContain('data-resize-dir="n');
  });

  it('ONE handler for three grips, with the direction on the element', () => {
    // Three inline arrows would allocate three new callbacks on every streamed
    // delta of the popup's own conversation (React Performance Conventions).
    const s = src();
    expect(s).toContain("e.currentTarget.dataset.resizeDir as PopupResizeDirection");
    expect(s).toMatch(/const handleResizeDown = useCallback\(/);
    expect(s).not.toMatch(/onPointerDown=\{\(e\) =>/);
  });

  it('resizes the FRAME, not the conversation — no state write per pointer move', () => {
    const s = src();
    const move = /const handleResizeMove = useCallback\([\s\S]*?\n  \);/.exec(s)?.[0];
    expect(move, 'handleResizeMove was not found').toBeDefined();
    expect(move).not.toMatch(/\bset[A-Z][A-Za-z]*\(/);
    expect(move).toContain('sizeRef.current = ');
    expect(move).toContain('popupResizeBox(');
    expect(move).toContain('applyGeometry()');
    // width/height have exactly one writer, and it is a DOM write.
    expect(s).toMatch(
      /const applySize = useCallback\([\s\S]{0,400}el\.style\.width = `\$\{box\.width\}px`/,
    );
    // The box is not React state at all any more — there is nothing to set.
    expect(s).not.toContain('setSize(');
    // …and it is re-applied after EVERY render, not on a dependency, so a
    // streamed delta mid-gesture cannot snap the box back.
    expect(s).toContain('useLayoutEffect(applySize);');
  });

  it('the style prop carries no geometry at all', () => {
    const s = src();
    const style = /style=\{\{[\s\S]*?\n        \}\}/.exec(s)?.[0];
    expect(style, 'the frame style prop was not found').toBeDefined();
    expect(style).not.toMatch(/width: (size|box|next)\./);
    expect(style).not.toMatch(/height: (size|box|next)\./);
    expect(style).toContain('width: 1');
  });

  it('uses pointer capture and releases it on up, cancel and unmount', () => {
    const s = src();
    const down = /const handleResizeDown = useCallback\([\s\S]*?\n  \}, \[\]\);/.exec(s)?.[0];
    expect(down).toContain('setPointerCapture(e.pointerId)');
    const end = /const handleResizeEnd = useCallback\([\s\S]*?\n  \}, \[\]\);/.exec(s)?.[0];
    expect(end, 'handleResizeEnd was not found').toBeDefined();
    expect(end).toContain('releasePointerCapture(e.pointerId)');
    // Esc, promote and the discard confirm can all unmount the popup mid-resize.
    // The captured element rides in the gesture because there are three grips.
    expect(s).toMatch(
      /resize\?\.element\.hasPointerCapture\(resize\.pointerId\)[\s\S]{0,200}releasePointerCapture/,
    );
  });

  it('the SIZE is remembered and the POSITION is not', () => {
    const s = src();
    // Written once per gesture, at the end — not once per pixel.
    const end = /const handleResizeEnd = useCallback\([\s\S]*?\n  \}, \[\]\);/.exec(s)?.[0];
    expect(end).toContain('writeStoredPopupSize(box)');
    expect(end).not.toContain('posRef');
    // The synchronous fast path, read while the popup is being placed.
    expect(s).toMatch(/window\.localStorage\.getItem\(POPUP_SIZE_STORAGE_KEY\)/);
    expect(s).toMatch(/window\.localStorage\.setItem\(POPUP_SIZE_STORAGE_KEY/);
    // Storage can throw on mere access (private mode); a popup must not fail to
    // open because it could not remember how big it was.
    expect(s).toMatch(/function readStoredPopupSize\(\)[\s\S]{0,400}catch \{[\s\S]{0,80}return null;/);
    // Read before the first placement, which runs in a layout effect.
    expect(s).toMatch(/desiredSizeRef\.current = readStoredPopupSize\(\);/);
    expect(s.indexOf('desiredSizeRef.current = readStoredPopupSize();')).toBeLessThan(
      s.indexOf('const place = useCallback('),
    );
  });

  it('…and it survives a RESTART, because localStorage alone cannot', () => {
    // The desktop shell boots Next on an ephemeral port and localStorage is
    // scoped per origin, port included: every launch is an empty store. This is
    // the hazard bootTheme.ts documents, and the resolution is its pair —
    // settings.json durable, localStorage synchronous.
    const s = src();
    // Write-through, in persistTheme/persistFonts' fire-and-forget shape: a
    // failed preference write must never interrupt the UI.
    expect(s).toContain('saveAgentSettings(popupSizeSettingsPatch(size))');
    expect(s).toMatch(/BrowserRuntime\.runFork\([\s\S]{0,200}Effect\.orElse\(\(\) => Effect\.void\)/);
    const end = /const handleResizeEnd = useCallback\([\s\S]*?\n  \}, \[\]\);/.exec(s)?.[0];
    expect(end).toContain('persistPopupSize(box)');
    // Both stores, and the fast one first — it is what the next popup reads.
    expect(end!.indexOf('writeStoredPopupSize(box)')).toBeLessThan(
      end!.indexOf('persistPopupSize(box)'),
    );
    // THE PREMISE, asserted rather than assumed: the preference layer this
    // copies still says an ephemeral port is why localStorage cannot be the
    // durable store. If that ever stops being true, this pair is free to
    // collapse back to one store — and this test is where it says so.
    const bootTheme = readFileSync(
      join(CLIENT, '..', '..', '..', '..', 'shared', 'utils', 'src', 'bootTheme.ts'),
      'utf8',
    );
    expect(bootTheme).toContain('EPHEMERAL port');
    expect(bootTheme).toContain('PUT /api/settings');
    // …and the popup goes to the same file, through feature-agent's own client
    // (importing feature-workspace's would make the two packages a cycle).
    expect(read('effect/agentClient.ts')).toContain('httpPutJson("/api/settings"');
    expect(s).toContain("from './effect/agentClient'");
  });

  it('the durable copy SEEDS an empty fast path, and placement never waits on it', () => {
    const s = src();
    const seed = /useEffect\(\(\) => \{\s*if \(seedRequestedRef\.current[\s\S]*?\n  \}, \[place\]\);/.exec(s)?.[0];
    expect(seed, 'the seed effect was not found').toBeDefined();
    // Only when localStorage had nothing — within a run it is the newer of the
    // two (ThemeProvider's precedence), so a value there wins.
    expect(seed).toContain('if (seedRequestedRef.current || desiredSizeRef.current) return;');
    expect(seed).toContain('await loadPersistedPopupSize()');
    // Mirrored into the fast path: one request per app launch, not per popup.
    expect(seed).toContain('writeStoredPopupSize(stored)');
    // Re-placed, which re-CLAMPS the seeded size against the current frame — a
    // size stored on a big monitor is trimmed, not honoured.
    expect(seed).toContain('place();');
    // The user's own gesture outranks the disk, and a popup must not resize
    // itself under a live one.
    expect(seed).toContain('movedRef.current || resizeRef.current');
    // Cancelled on UNMOUNT, not on an effect re-run: re-running must not drop a
    // request that is already in flight.
    expect(seed).toContain('if (!mountedRef.current');

    // PLACEMENT IS SYNCHRONOUS. The whole reason localStorage stays in the
    // picture: an awaited settings read here would open the popup at the
    // default box and then jump.
    const place = /const place = useCallback\([\s\S]*?\n  \}, \[/.exec(s)?.[0];
    expect(place).not.toContain('await');
    expect(place).not.toContain('loadPersistedPopupSize');
    expect(place).not.toContain('loadAgentSettings');
    expect(s).toMatch(/const place = useCallback\(\(\) => \{/);
  });

  it('a window resize re-clamps the remembered size, as it re-clamps the position', () => {
    const s = src();
    const place = /const place = useCallback\([\s\S]*?\n  \}, \[/.exec(s)?.[0];
    expect(place, 'place() was not found').toBeDefined();
    // The stored size goes through the clamp on every placement — including the
    // one the window-resize listener triggers.
    expect(place).toContain('resolvePopupSize(desiredSizeRef.current');
    expect(place).toContain('clampPopupWithinFrame(');
    expect(s).toMatch(/addEventListener\('resize', place\)/);
    // The clamped-down size is NOT written back to the preference, so making the
    // window big again restores the box the user actually chose.
    expect(place).not.toContain('writeStoredPopupSize');
  });

  it('a resize pins the popup where it is, like a drag does', () => {
    // `sw` moves the origin, and even a plain `se` grow is the user choosing
    // this box here — re-anchoring to the selection afterwards would undo it.
    const move = /const handleResizeMove = useCallback\([\s\S]*?\n  \);/.exec(src())?.[0];
    expect(move).toContain('movedRef.current = true');
  });
});

describe('selection popup — the composer inside is capped against THIS box', () => {
  /**
   * THE BUG. `composerHeight` caps the textarea at a fraction of the column it
   * shares with the transcript — and the composer measured that fraction against
   * `window.innerHeight`. A popup is a ~320px box inside a large window, so the
   * rule evaporated in the one place a column is genuinely short: resizing the
   * popup smaller left a composer sized for the window, eating the conversation.
   *
   * The arithmetic is pure and pinned in composerHeight.test.ts. What is left is
   * the wiring, and each item below is a way to ship the fix looking right and
   * being wrong — none of it visible to jsdom, which has no layout at all.
   */
  const popup = () => read('SelectionChatPopup.tsx');

  it('the composer is handed the popup\'s column, not the window', () => {
    const input = read('ChatInput.tsx');
    // The window remains the FALLBACK — a chat in a tab fills it — but a host
    // that knows better must win.
    expect(input).toMatch(
      /const available = composerViewport\s*\?\s*composerViewport\.getAvailableHeight\(\)/,
    );
    expect(input).toContain('composerHeight(textarea.scrollHeight, available)');
    // …and the old unconditional read is gone.
    expect(input).not.toMatch(/composerHeight\([^)]*window\.innerHeight\)/);
  });

  it('and it is threaded, not reached for — popup → Chat → ChatInput', () => {
    const chat = read('Chat.tsx');
    expect(popup()).toContain('composerViewport');
    // The popup publishes it through the same wiring object as everything else.
    expect(popup()).toMatch(/composerViewport: ComposerViewport;/);
    expect(chat).toMatch(/renderPopupChat[\s\S]{0,1200}composerViewport=\{w\.composerViewport\}/);
    expect(chat).toContain('composerViewport={composerViewport}');
    // Optional on Chat, so every existing caller keeps the window fallback.
    expect(chat).toMatch(/composerViewport\?: ComposerViewport;/);
  });

  it('the height is MEASURED off the conversation column, not guessed from the box', () => {
    // The popup's height is not the composer's column: a header, a quote block
    // and a hint row sit around it. Subtracting a constant would rot the moment
    // any of that chrome changed.
    const s = popup();
    expect(s).toContain('getAvailableHeight: () => columnRef.current?.clientHeight ?? 0');
    expect(s).toMatch(/<div ref=\{columnRef\}[^>]*className="min-h-0 flex-1"/);
  });

  it('THE POINT: a resize re-measures the composer, not only a keystroke', () => {
    // A popup dragged smaller that left the composer at its old height is the
    // same bug in a new place.
    const move = /const handleResizeMove = useCallback\([\s\S]*?\n  \);/.exec(popup())?.[0];
    expect(move, 'handleResizeMove was not found').toBeDefined();
    expect(move).toContain('notifyComposerViewport()');
    // …and the first placement counts too: the frame is 1×1 off-screen until
    // then, so the composer's own mount had nothing to measure.
    const place = /const place = useCallback\([\s\S]*?\n  \}, \[/.exec(popup())?.[0];
    expect(place).toContain('notifyComposerViewport()');
    // place() is also what runs on a window resize, which covers that too.
    expect(popup()).toMatch(/addEventListener\('resize', place\)/);
  });

  it('…and does it WITHOUT a state write, like every other pixel of the gesture', () => {
    // The whole reason the box lives in a ref: a setState per pointer move would
    // re-render a streaming transcript sixty times a second. Handing the height
    // down as a number prop would have forced it into state and undone that.
    const s = popup();
    const move = /const handleResizeMove = useCallback\([\s\S]*?\n  \);/.exec(s)?.[0];
    expect(move).not.toMatch(/\bset[A-Z][A-Za-z]*\(/);
    const notify = /const notifyComposerViewport = useCallback\([\s\S]*?\n  \}, \[\]\);/.exec(s)?.[0];
    expect(notify, 'notifyComposerViewport was not found').toBeDefined();
    expect(notify).not.toMatch(/\bset[A-Z][A-Za-z]*\(/);
    expect(notify).toContain('viewportListenersRef.current');
    // The published object is created ONCE — a fresh one per render would defeat
    // the memo on the chat inside on every streamed delta.
    expect(s).toMatch(/const composerViewport = useMemo<ComposerViewport>\([\s\S]*?\n    \[\],\n  \);/);
  });

  it('the composer subscribes in a LAYOUT effect, and unsubscribes', () => {
    // Child effects run before the parent's, so a layout subscription is in
    // place before the popup's own layout effect places the frame. Miss that
    // first notification and the composer keeps the absolute cap it picked while
    // there was nothing to measure.
    const input = read('ChatInput.tsx');
    const sub = /useLayoutEffect\(\(\) => \{\s*if \(!composerViewport\) return;[\s\S]*?\}, \[composerViewport, adjustTextareaHeight\]\);/.exec(input)?.[0];
    expect(sub, 'the viewport subscription was not found, or is not a layout effect').toBeDefined();
    expect(sub).toContain('return composerViewport.subscribe(adjustTextareaHeight);');
  });

  it('the popup asks for the SHORT placeholder, so the floor has less to defend', () => {
    // The floor exists so the multi-line placeholder is not clipped — which
    // makes the placeholder what sets the floor's cost. The full hint documents
    // `/`, `@` and mid-sentence skills; in a narrow popup it wraps far enough
    // that the hint alone makes the input greedy. The popup is one throwaway
    // question, not a session that runs commands.
    const chat = read('Chat.tsx');
    expect(chat).toContain('compactPlaceholder={ephemeral}');
    const input = read('ChatInput.tsx');
    expect(input).toContain("t(compactPlaceholder ? 'chat.placeholderCompact' : 'chat.placeholder')");
    expect(input).toContain(
      "t(compactPlaceholder ? 'chat.placeholderDisabledCompact' : 'chat.placeholderDisabled')",
    );

    const en = JSON.parse(readFileSync(join(LOCALES, 'en.json'), 'utf8')) as Record<string, Record<string, string>>;
    const ko = JSON.parse(readFileSync(join(LOCALES, 'ko.json'), 'utf8')) as Record<string, Record<string, string>>;
    for (const key of ['placeholderCompact', 'placeholderDisabledCompact'] as const) {
      expect(en.chat![key], `chat.${key} missing from en.json`).toBeTruthy();
      expect(ko.chat![key], `chat.${key} missing from ko.json`).toBeTruthy();
      // SHORTER IS THE WHOLE POINT. A "compact" variant that was not compact
      // would silently reintroduce the height it was added to remove.
      expect(en.chat![key]!.length).toBeLessThan(en.chat!['placeholder']!.length);
      expect(ko.chat![key]!.length).toBeLessThan(ko.chat!['placeholder']!.length);
    }
    // …and it is still a hint, not a clipped stub: the send gesture survives.
    expect(en.chat!.placeholderCompact).toContain('Enter');
    expect(ko.chat!.placeholderCompact).toContain('Enter');
  });
});

describe('selection popup — it never becomes the active tab', () => {
  it('Chat guards setActiveTab on the ephemeral flag', () => {
    const src = read('Chat.tsx');
    expect(src).toMatch(/if \(tabId && isActive && chatContext && !ephemeral\)[\s\S]{0,80}setActiveTab\(tabId\)/);
  });

  it('…and does not publish its loading state app-wide either', () => {
    const src = read('Chat.tsx');
    expect(src).toMatch(/if \(isActive && !ephemeral\)[\s\S]{0,80}setIsLoading\(isLoading\)/);
  });

  it('the popup mounts its chat as ephemeral, and on screen', () => {
    const src = read('Chat.tsx');
    // `isActive` (measurable, so the transcript scrolls) and `ephemeral` (never
    // the active tab) are separate questions and both must be answered.
    expect(src).toMatch(/renderPopupChat[\s\S]{0,900}isActive\s*\n\s*ephemeral/);
  });

  it('it still REGISTERS, under an id that cannot collide with a tab', () => {
    // Registration is harmless — nothing resolves a sender except through the
    // active id — and keeps the popup symmetric with every other chat.
    expect(read('SelectionChatPopup.tsx')).toContain('`selection-popup-${++popupSeq}`');
  });

  it('the popup composer does not go through ChatContext', () => {
    // MessageList's old quote-reply path called chatCtx.sendMessage; the popup
    // has its own session and its own composer, so the coupling is gone.
    const list = read('MessageList.tsx');
    expect(list).not.toContain("from './ChatContext'");
    expect(list).not.toContain('useChatContextOptional');
    // No live reads of the app-wide sender or its loading flag either — only
    // the comment that records why they left.
    expect(list).not.toMatch(/chatCtx\.sendMessage\(/);
    expect(list).not.toMatch(/chatCtx\?\./);
  });
});

describe('selection popup — closing', () => {
  it('runs the planned actions IN ORDER, stop before delete', () => {
    const src = read('SelectionChatPopup.tsx');
    expect(src).toContain('planPopupClose(');
    const loop = /for \(const action of plan\.actions\) \{[\s\S]*?\n      \}/.exec(src)?.[0];
    expect(loop, 'the close loop was not found').toBeDefined();
    expect(loop!.indexOf("'stop'")).toBeLessThan(loop!.indexOf("'delete'"));
    // AWAITED: two un-awaited fetches can reach the server in either order, and
    // the losing order deletes the session out from under a live run.
    expect(loop).toContain('await stop?.()');
    expect(loop).toContain('onDiscardSession?.(sid)');
  });

  it('the stop call the popup awaits actually resolves on the server round trip', () => {
    // A `handleStop` that returned void would make the await above a no-op that
    // reads as an ordering guarantee.
    const stream = read('useChatStream.ts');
    expect(stream).toContain('handleStop: () => Promise<void>;');
    expect(stream).toMatch(/const handleStop = useCallback\(\(\): Promise<void> =>/);
    expect(stream).toContain('return posted;');
  });

  it('the popup itself closes immediately, without waiting on the network', () => {
    const src = read('SelectionChatPopup.tsx');
    expect(src.indexOf('onClose();')).toBeLessThan(src.indexOf('for (const action of plan.actions)'));
    // …and the stop function is captured before the unmount clears the ref.
    expect(src.indexOf('const stop = stopRef.current;')).toBeLessThan(src.indexOf('onClose();'));
  });

  it('confirms before any of it, and escapes the preview it interpolates', () => {
    const src = read('SelectionChatPopup.tsx');
    // `confirm()` builds its dialog with innerHTML and the i18n singleton runs
    // with `escapeValue: false`, so the user's own selected text must be escaped
    // before it is interpolated.
    expect(src).toMatch(/preview: escapeHtml\(quotePreview\(selectedText\)\)/);
    expect(src).toMatch(/if \(!agreed\) return;/);
    // The confirm has to be UPSTREAM of the actions, not beside them.
    expect(src.indexOf('await confirm(')).toBeLessThan(src.indexOf('for (const action of plan.actions)'));
  });

  it('promotion goes through the same close path, which then plans nothing', () => {
    const src = read('SelectionChatPopup.tsx');
    const promote = /const promote = useCallback\(\(\) => \{[\s\S]*?\}, \[/.exec(src)?.[0];
    expect(promote, 'promote() was not found').toBeDefined();
    expect(promote).toContain('promotedRef.current = true');
    expect(promote).toContain('onOpenSession?.(sessionId');
    expect(promote).toContain('requestClose()');
    // The flag is set BEFORE the close, or the plan would still say "delete".
    expect(promote!.indexOf('promotedRef.current = true')).toBeLessThan(
      promote!.indexOf('requestClose()'),
    );
    // …and the plan reads it.
    expect(src).toContain('promoted: promotedRef.current');
  });

  it('the promote control is hidden until a session has been minted', () => {
    // Sessions are created lazily on the first turn; before that there is
    // nothing to promote and a live-looking control would do nothing.
    const src = read('SelectionChatPopup.tsx');
    expect(src).toContain('const canPromote = !!sessionId;');
    expect(src).toMatch(/\{canPromote && \([\s\S]{0,400}selection-chat-promote/);
  });

  it('the chat hands its stop function up — the run is detached server-side', () => {
    const chat = read('Chat.tsx');
    expect(chat).toMatch(/onStopHandle\(handleStop\)/);
    expect(chat).toMatch(/return \(\) => onStopHandle\(null\)/);
  });
});

describe('selection popup — the old card is gone', () => {
  it('MessageList no longer builds or injects a quoted message', () => {
    const list = read('MessageList.tsx');
    expect(list).not.toContain('SendToAIInput');
    expect(list).not.toContain('buildQuotedMessage');
    expect(list).not.toContain('sendSelectionToAI');
  });

  it('it reports the gesture upward instead', () => {
    const list = read('MessageList.tsx');
    expect(list).toContain('onAskSelection?.({ text: tb.selectedText, anchor: { x: tb.x, y: tb.y } })');
    // No handler → no toolbar. That is what stops a popup opening out of a popup.
    expect(list).toMatch(/\{outerEl && onAskSelection && \(/);
  });

  it('the host offers the toolbar to real tabs only, and only one popup at a time', () => {
    const chat = read('Chat.tsx');
    expect(chat).toContain('onAskSelection={ephemeral ? undefined : handleAskSelection}');
    expect(chat).toContain('askOpen={!!selectionAsk}');
    expect(read('MessageList.tsx')).toMatch(/if \(askOpen\) return;/);
  });

  it('the quote still rides the first send, through the chat that owns it', () => {
    const chat = read('Chat.tsx');
    expect(chat).toContain('attachQuotedContext(quotedContext, content, quoteAttachedRef.current)');
    expect(chat).toContain('handleSend(withQuotedContext(content), images)');
  });

  it('the popup inherits the host chat cwd so tools resolve in the same project', () => {
    const chat = read('Chat.tsx');
    expect(chat).toMatch(/renderPopupChat[\s\S]{0,600}initialCwd=\{initialCwd\}/);
  });
});

describe('selection popup — i18n', () => {
  it('every key exists in BOTH locales', () => {
    // A key added to en.json and forgotten in ko.json shows a Korean user the
    // raw key path.
    const en = JSON.parse(readFileSync(join(LOCALES, 'en.json'), 'utf8')) as Record<string, Record<string, string>>;
    const ko = JSON.parse(readFileSync(join(LOCALES, 'ko.json'), 'utf8')) as Record<string, Record<string, string>>;
    expect(en.selectionChat).toBeDefined();
    expect(ko.selectionChat).toBeDefined();
    expect(Object.keys(ko.selectionChat!).sort()).toEqual(Object.keys(en.selectionChat!).sort());

    const src = read('SelectionChatPopup.tsx');
    for (const key of Object.keys(en.selectionChat!)) {
      expect(src, `selectionChat.${key} is in the dictionary but unused`).toContain(
        `selectionChat.${key}`,
      );
    }
  });

  it('the promote control reads 세션으로 변경 in Korean', () => {
    const ko = JSON.parse(readFileSync(join(LOCALES, 'ko.json'), 'utf8')) as Record<string, Record<string, string>>;
    expect(ko.selectionChat!.promote).toBe('세션으로 변경');
  });

  it('the discard message names what is being thrown away', () => {
    const en = JSON.parse(readFileSync(join(LOCALES, 'en.json'), 'utf8')) as Record<string, Record<string, string>>;
    const ko = JSON.parse(readFileSync(join(LOCALES, 'ko.json'), 'utf8')) as Record<string, Record<string, string>>;
    expect(en.selectionChat!.discardMessage).toContain('{{preview}}');
    expect(ko.selectionChat!.discardMessage).toContain('{{preview}}');
  });
});

describe('selection popup — the discard reuses the one deletion path', () => {
  it('the host wires onDiscardSession to the existing deleteSession Effect', () => {
    const tm = readFileSync(
      join(CLIENT, '..', '..', '..', 'workspace', 'src', 'client', 'TabManager.tsx'),
      'utf8',
    );
    expect(tm).toContain("import { deleteSession } from './projectSessionTree'");
    expect(tm).toContain('deleteSession(initialCwd, sessionId)');
    expect(tm).toContain('onDiscardSession={handleDiscardSession}');
  });

  it('and that path is still the same one a tab close takes', () => {
    const tree = readFileSync(
      join(CLIENT, '..', '..', '..', 'workspace', 'src', 'client', 'projectSessionTree.ts'),
      'utf8',
    );
    expect(tree).toContain('closedSessionIds: [sessionId]');
  });

  it('feature-agent does not reach into feature-workspace to do it', () => {
    // The Effect lives in the integrator package; importing it here would make
    // the two packages a cycle. The callback is the seam.
    for (const f of ['SelectionChatPopup.tsx', 'Chat.tsx', 'ChatPanel.tsx']) {
      expect(read(f)).not.toContain('@cockpit/feature-workspace');
    }
  });
});
