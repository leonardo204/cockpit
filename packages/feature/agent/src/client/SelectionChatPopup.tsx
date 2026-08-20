'use client';

/**
 * SelectionChatPopup — the throwaway conversation that opens out of a selection.
 *
 * WHAT IT REPLACES. Selecting text in a reply used to open a one-line card
 * whose question was injected into the CURRENT session as a quoted message. The
 * side question then lived forever in the main transcript and was dragged into
 * the context of every later turn — "what does this word mean" permanently
 * attached to a conversation about something else. This is the same gesture
 * with a different destination: a self-contained chat with its own session that
 * is DISCARDED on close, or promoted into a real tab if it turns out to matter.
 *
 * IT DOES NOT IMPORT `Chat`. The conversation surface arrives as a render prop,
 * because the popup is rendered BY Chat: importing it back would make the two
 * modules a cycle for no gain. `children(wiring)` hands the caller the four
 * callbacks the close decision needs and nothing else.
 *
 * PORTALED, AND THAT IS LOAD-BEARING. The message list's host is
 * `overflow-hidden` (Chat.tsx) and the three-panel shell wraps everything in a
 * `translateX` container, so an in-place popup the size of a conversation is
 * clipped by both — the exact bug that once erased three sidebar panels and the
 * file-browser context menu (see shell/CLAUDE.md). jsdom has no layout and
 * cannot see clipping, so this is additionally guarded by a source assertion in
 * selectionChatPopupWiring.test.ts.
 *
 * DRAGGABLE BY ITS HEADER. The header row reads as a title bar, so it is one:
 * pointer capture on that row moves the popup, clamped to stay wholly inside the
 * panel it is portaled into. The position lives in a REF and is written straight
 * to the frame's style, never in state — this popup contains a live streaming
 * conversation, and re-rendering it on every pointer move would re-render that
 * transcript sixty times a second. The maths is in selectionChatOps.
 *
 * A SECOND CONCURRENT STREAM IS ALREADY SUPPORTED. Nothing in useChatStream /
 * useLiveStream / applyStreamEvent holds module-level mutable state, the WS
 * connection is shared per-URL with the run key inside the URL, and the server's
 * run registry is keyed per run. The one server rule — ONE ACTIVE RUN PER
 * sessionId — a popup with its own session never trips.
 */

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Portal,
  confirm,
  escapeHtml,
  useEscToClose,
  usePanelPortalTarget,
} from '@cockpit/shared-ui';
import {
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
  type PopupFrame,
  type PressPathNode,
} from './selectionChatOps';

/** Distinct per popup instance, so the chat inside registers under an id that
 *  can never collide with a real tab's. */
let popupSeq = 0;

export interface SelectionChatPopupWiring {
  /** The inner chat's ChatContext key. It REGISTERS (harmless) but must never
   *  mark itself the active tab — see the `ephemeral` prop on Chat. */
  tabId: string;
  /** The selection, handed to the inner chat so it rides the first send. */
  quotedContext: string;
  onSessionIdChange: (sessionId: string) => void;
  onLoadingChange: (isLoading: boolean) => void;
  onTitleChange: (title: string) => void;
  /** The inner chat hands up a stop function for its own in-flight run. Null on
   *  unmount. Without it, closing mid-stream would leave the detached run going. */
  onStopHandle: (stop: (() => Promise<void>) | null) => void;
}

export interface SelectionChatPopupProps {
  /** The text the conversation is about. Shown in the popup and quoted into the
   *  first message. */
  selectedText: string;
  /** Where the selection finished, in viewport coordinates. */
  anchor: { x: number; y: number };
  /** Close and forget. The popup calls this only after its own close plan has
   *  run (confirm → stop → delete), or immediately after a promotion. */
  onClose: () => void;
  /** Host hook: open an existing session in a new tab. Already threaded to every
   *  ChatPanel, which is why promotion is one call rather than a feature. */
  onOpenSession?: (sessionId: string, title?: string) => void;
  /** Host hook: delete a session through the same `closedSessionIds` path a tab
   *  close takes. Lives in the host because the Effect that does it belongs to
   *  feature-workspace, which feature-agent must not depend on. */
  onDiscardSession?: (sessionId: string) => void;
  children: (wiring: SelectionChatPopupWiring) => ReactNode;
}

function SelectionChatPopupInner({
  selectedText,
  anchor,
  onClose,
  onOpenSession,
  onDiscardSession,
  children,
}: SelectionChatPopupProps) {
  const { t } = useTranslation();
  const tabIdRef = useRef<string>('');
  if (!tabIdRef.current) tabIdRef.current = `selection-popup-${++popupSeq}`;

  /** The measured box SIZE only. The popup's POSITION is deliberately not state
   *  — see `posRef` / `applyPosition` below. */
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  // THE POPUP'S OWN CONVERSATION STATE, and the only reason it is here rather
  // than inside the inner chat: closing is the host's decision, and it needs all
  // four of these to make it (planPopupClose).
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  /** The user has sent at least one message — there is something to lose. The
   *  rising edge of `isLoading` is the signal: every send path goes through it,
   *  including one whose POST fails (the user's bubble is on screen either way). */
  const [hasContent, setHasContent] = useState(false);
  const [title, setTitle] = useState<string | null>(null);
  const stopRef = useRef<(() => Promise<void>) | null>(null);
  /** Set the instant a promotion is dispatched, and read by the close plan.
   *  A ref, not state: promotion closes in the same tick, and a state write
   *  would not be visible to the close that immediately follows it. */
  const promotedRef = useRef(false);
  /** Guards the async confirm: a second Esc while the dialog is open must not
   *  open a second dialog. */
  const closingRef = useRef(false);

  // ── Placement and dragging ─────────────────────────────────────────────
  //
  // WHICH COORDINATE SPACE. The popup is `position: fixed` inside a `<Portal>`,
  // and that portal lands in `PanelPortalProvider`'s target, whose wrapper
  // carries `transform: translateZ(0)`. A transform is a containing block for
  // `fixed` descendants, so `left/top` here are measured from THE PANEL (tab bar
  // + conversation column), not from the window. Everything stored in `posRef`
  // is panel-local; `anchor` and every `clientX/clientY` are viewport, and
  // `frame.left/top` is the one conversion between them (see `popupFrameBounds`).
  // Getting this backwards is the recurring bug in this repo, so it is measured
  // from the actual portal target rather than assumed.
  const panelTarget = usePanelPortalTarget();
  const frameRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  /** The popup's live panel-local position. THE source of truth, and not state:
   *  a streamed delta re-renders this component many times a second, and a
   *  position that lived in state would be re-committed from a stale render
   *  mid-drag. */
  const posRef = useRef<{ x: number; y: number } | null>(null);
  const sizeRef = useRef<{ width: number; height: number } | null>(null);
  /** The user has picked the popup up at least once. From then on the popup
   *  stays where it was PUT: the initial anchoring never runs again. */
  const movedRef = useRef(false);
  const dragRef = useRef<{ pointerId: number; grabX: number; grabY: number } | null>(null);

  const readFrame = useCallback((): PopupFrame => {
    const rect = panelTarget?.getBoundingClientRect();
    return popupFrameBounds(
      rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null,
      window.innerWidth,
      window.innerHeight,
    );
  }, [panelTarget]);

  /** The ONLY writer of the frame's left/top. React's style prop never carries
   *  them (it holds a constant off-screen pair), so moving the popup writes two
   *  style properties on one element and re-renders nothing — the live
   *  transcript inside is untouched (React Performance Conventions). */
  const applyPosition = useCallback(() => {
    const el = frameRef.current;
    const pos = posRef.current;
    if (!el || !pos) return;
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
  }, []);

  const place = useCallback(() => {
    if (typeof window === 'undefined') return;
    const frame = readFrame();
    const { width, height } = popupSize(frame.width, frame.height);

    if (movedRef.current && posRef.current) {
      // ALREADY MOVED — never re-anchor. The user put it here. A resize may only
      // pull it back inside the frame, because a popup left outside the panel
      // has no scrollbar and no other way to be reached.
      posRef.current = clampPopupWithinFrame({
        ...posRef.current,
        width,
        height,
        frameWidth: frame.width,
        frameHeight: frame.height,
      });
    } else {
      // The original anchored placement, unchanged in rule (below the selection,
      // flipped above when it would hang off the bottom) — only its space is
      // stated properly now. `viewportWidth/Height` are the parameter names
      // clampPopupPosition was born with; what it is being handed is the frame.
      const { x, y } = clampPopupPosition({
        anchorX: anchor.x - frame.left,
        anchorY: anchor.y - frame.top,
        width,
        height,
        viewportWidth: frame.width,
        viewportHeight: frame.height,
      });
      posRef.current = { x, y };
    }

    sizeRef.current = { width, height };
    // Referentially stable when nothing changed, so a resize that does not
    // change the box does not re-render the conversation.
    setSize((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
    applyPosition();
  }, [anchor.x, anchor.y, readFrame, applyPosition]);

  useLayoutEffect(() => {
    place();
  }, [place]);

  // AFTER EVERY RENDER, on purpose (no dependency array). The popup re-renders
  // on every streamed delta of its own conversation; this is what guarantees the
  // dragged position survives all of them instead of snapping back.
  useLayoutEffect(applyPosition);

  useEffect(() => {
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [place]);

  // POINTER EVENTS WITH CAPTURE, not mouse events with document listeners: a
  // fast drag that outruns the header keeps delivering to it, and pen/touch work
  // without a second code path.
  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const pos = posRef.current;
      if (!pos) return;

      // The chain from the pressed node out to the handle. A press that landed
      // on ✕ or "세션으로 변경" — or on the <svg> inside one — is left alone:
      // its click must still fire, and a drag would swallow it.
      const path: PressPathNode[] = [];
      for (let el = e.target as Element | null; el && el !== e.currentTarget; el = el.parentElement) {
        path.push({ tag: el.tagName, role: el.getAttribute('role') });
      }
      if (!shouldStartPopupDrag(path)) return;

      const { grabX, grabY } = popupGrabOffset({
        pointerX: e.clientX,
        pointerY: e.clientY,
        frame: readFrame(),
        x: pos.x,
        y: pos.y,
      });
      dragRef.current = { pointerId: e.pointerId, grabX, grabY };
      e.currentTarget.setPointerCapture(e.pointerId);
      // Stops the title from being text-selected by the same press that moves
      // the window (the handle is `select-none` as well, for the drag that
      // wanders out over the transcript).
      e.preventDefault();
    },
    [readFrame],
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      const box = sizeRef.current;
      if (!drag || !box || drag.pointerId !== e.pointerId) return;
      // The frame is re-read per move rather than captured at pointer-down, so a
      // panel that changes size mid-drag does not skew the conversion.
      posRef.current = popupDragPosition({
        pointerX: e.clientX,
        pointerY: e.clientY,
        grabX: drag.grabX,
        grabY: drag.grabY,
        frame: readFrame(),
        width: box.width,
        height: box.height,
      });
      movedRef.current = true;
      // NO setState. Move the frame, not the content.
      applyPosition();
    },
    [readFrame, applyPosition],
  );

  const handlePointerEnd = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  useEffect(
    () => () => {
      // Unmounted mid-drag (Esc, promote, the confirm dialog): drop the gesture
      // and hand the pointer back rather than leaving a captured element behind.
      const drag = dragRef.current;
      const handle = handleRef.current;
      dragRef.current = null;
      if (drag && handle?.hasPointerCapture(drag.pointerId)) {
        handle.releasePointerCapture(drag.pointerId);
      }
    },
    [],
  );

  // ── Wiring handed to the inner chat ───────────────────────────────────
  // Stable identities: the host chat re-renders on every streamed delta of the
  // MAIN conversation, and an unstable callback here would push that churn into
  // the popup's own transcript (React Performance Conventions, shell/CLAUDE.md).
  const handleSessionId = useCallback((sid: string) => setSessionId(sid), []);
  const handleLoading = useCallback((loading: boolean) => {
    setIsStreaming(loading);
    if (loading) setHasContent(true);
  }, []);
  const handleTitle = useCallback((next: string) => setTitle(next), []);
  const handleStopHandle = useCallback((stop: (() => Promise<void>) | null) => {
    stopRef.current = stop;
  }, []);

  const wiring = useMemo<SelectionChatPopupWiring>(
    () => ({
      tabId: tabIdRef.current,
      quotedContext: selectedText,
      onSessionIdChange: handleSessionId,
      onLoadingChange: handleLoading,
      onTitleChange: handleTitle,
      onStopHandle: handleStopHandle,
    }),
    [selectedText, handleSessionId, handleLoading, handleTitle, handleStopHandle],
  );

  // ── Closing ───────────────────────────────────────────────────────────
  const requestClose = useCallback(async () => {
    if (closingRef.current) return;
    const plan = planPopupClose({
      sessionId,
      hasContent,
      isStreaming,
      promoted: promotedRef.current,
    });

    if (plan.confirm) {
      closingRef.current = true;
      // escapeHtml because `confirm()` builds its dialog with innerHTML and the
      // i18n singleton runs with `escapeValue: false` — the preview is the
      // user's own selected text, which can be anything at all.
      const message = t('selectionChat.discardMessage', {
        preview: escapeHtml(quotePreview(selectedText)),
      });
      const agreed = await confirm(message, {
        title: t('selectionChat.discardTitle'),
        confirmText: t('selectionChat.discardConfirm'),
        danger: true,
      });
      closingRef.current = false;
      if (!agreed) return;
    }

    // Captured BEFORE the close, because closing unmounts the chat that owns
    // the stop function and clears the ref on the way out.
    const stop = stopRef.current;
    const sid = sessionId;

    // The popup goes NOW. The user asked for it to be gone, and making that
    // wait on two network round trips would leave a discarded conversation on
    // screen for as long as the server took to answer.
    onClose();

    if (plan.actions.length === 0) return;
    void (async () => {
      for (const action of plan.actions) {
        // AWAITED, AND SEQUENTIAL ON PURPOSE. The run is detached server-side:
        // a delete issued alongside the stop is two un-awaited fetches that can
        // arrive in either order, and the losing order deletes the session row
        // out from under a run that is still writing to it.
        if (action === 'stop') await stop?.();
        if (action === 'delete' && sid) onDiscardSession?.(sid);
      }
    })();
  }, [sessionId, hasContent, isStreaming, selectedText, t, onDiscardSession, onClose]);

  const promote = useCallback(() => {
    if (!sessionId) return;
    promotedRef.current = true;
    onOpenSession?.(sessionId, popupSessionTitle(title, selectedText));
    // Through the same close path, which now plans NOTHING: no confirm, no
    // stop, no delete. One exit, so "promoted conversations are never deleted"
    // is a property of the plan rather than of remembering to skip a branch.
    void requestClose();
  }, [sessionId, title, selectedText, onOpenSession, requestClose]);

  // ESC IS LAYERED, the way it already is over the chat area and the blame
  // view: it stops a running turn first, and only closes an idle popup. One key
  // that both killed the answer and threw away the conversation would make the
  // irreversible action the easiest one to reach by accident.
  const handleEsc = useCallback(() => {
    if (isStreaming) {
      stopRef.current?.();
      return;
    }
    void requestClose();
  }, [isStreaming, requestClose]);
  useEscToClose(handleEsc);

  const canPromote = !!sessionId;

  return (
    <Portal>
      {/* `z-[200]` is not decoration: MessageList clears its selection toolbar
          on any mousedown whose target is not `.floating-toolbar` or
          `[class*="z-[200]"]`, and React routes portal events through the
          COMPONENT tree — so without this class the host would fight the popup
          for every click inside it. */}
      {/* NO CLICK-OUTSIDE-TO-CLOSE, and no backdrop, unlike the card this
          replaces. Closing DISCARDS a conversation; a stray click on the
          transcript behind must not be able to trigger something irreversible,
          and the user is expected to keep reading the main chat while asking
          about it here. Closing is the ✕ or Esc, both of which confirm.

          DRAGGABLE BY ITS HEADER, not resizable. The header reads as a title
          bar, so it behaves like one; the size is still `popupSize`'s. */}
      <div
        ref={frameRef}
        data-testid="selection-chat-popup"
        className="fixed z-[200] flex flex-col rounded-lg border border-border bg-card shadow-2xl overflow-hidden"
        style={
          // LEFT/TOP ARE NOT HERE. They are written by `applyPosition` alone, so
          // a re-render can never re-commit a stale position over a dragged one;
          // this constant pair is only what keeps the popup off-screen until it
          // has been measured, instead of flashing at 0,0.
          size
            ? { left: -9999, top: -9999, width: size.width, height: size.height }
            : { left: -9999, top: -9999, width: 1, height: 1 }
        }
      >
        <div
          ref={handleRef}
          data-testid="selection-chat-drag-handle"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          title={t('selectionChat.dragHint')}
          // `cursor-move` is the affordance — the row looks like a title bar and
          // now is one, but only a cursor says so. `select-none` stops the title
          // being highlighted by the same press, `touch-none` stops a touch drag
          // being taken over as a scroll before pointermove ever arrives.
          className="flex cursor-move touch-none select-none items-center justify-between gap-2 border-b border-border bg-brand/10 px-3 py-2"
        >
          <span className="text-xs font-medium text-brand">{t('selectionChat.title')}</span>
          <div className="flex items-center gap-1.5">
            {/* Hidden until a session exists. There is nothing to promote before
                the first turn mints one, and a control that silently does
                nothing is worse than no control. */}
            {canPromote && (
              <button
                type="button"
                data-testid="selection-chat-promote"
                onClick={promote}
                title={t('selectionChat.promoteHint')}
                // `cursor-pointer` explicitly: the row around it is
                // `cursor-move` and `cursor` inherits, so without this the
                // control would advertise a drag it does not do.
                className="cursor-pointer rounded-md border border-brand px-2 py-0.5 text-xs font-medium text-brand transition-colors hover:bg-brand/10"
              >
                {t('selectionChat.promote')}
              </button>
            )}
            <button
              type="button"
              data-testid="selection-chat-close"
              onClick={() => void requestClose()}
              title={t('selectionChat.closeHint')}
              className="cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
              aria-label={t('selectionChat.close')}
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* WHAT THIS CONVERSATION IS ABOUT, kept on screen. The quote only rides
            the FIRST message, so after one turn this block is the sole remaining
            reminder of which sentence the user picked. Capped and scrollable —
            a selection can be a whole paragraph, and it must not push the
            composer out of the popup. */}
        <div className="max-h-24 shrink-0 overflow-y-auto border-b border-border bg-secondary/50 px-3 py-2">
          <div className="mb-1 text-[0.65rem] uppercase tracking-wide text-muted-foreground/70">
            {t('selectionChat.contextLabel')}
          </div>
          <pre className="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
            {selectedText}
          </pre>
        </div>

        <div className="min-h-0 flex-1">{children(wiring)}</div>

        <div className="shrink-0 border-t border-border px-3 py-1 text-[0.65rem] text-muted-foreground/70">
          {t('selectionChat.throwawayHint')}
        </div>
      </div>
    </Portal>
  );
}

/** Memoized: the HOST chat re-renders on every streamed delta of the main
 *  conversation, and each of those would otherwise re-render the popup's whole
 *  transcript. Every prop above is passed with a stable identity from Chat. */
export const SelectionChatPopup = memo(SelectionChatPopupInner);
