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
