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
 * AND RESIZABLE FROM ITS BOTTOM EDGE, under the same discipline for the same
 * reason: the box is a ref written straight to the element, never state. What
 * the box IS, though, the composer inside has to know — its ceiling is a
 * fraction of the column it sits in, and that column is this popup, not the
 * window (composerHeight.ts). It learns it through `ComposerViewport`: a reader
 * plus a change signal, which is what lets the value cross without becoming
 * state and re-rendering the transcript once per pixel.
 *
 * THE SIZE is remembered across popups — `localStorage` for the synchronous read the
 * placement needs, `settings.json` for the copy that survives a restart, which is
 * the pair bootTheme.ts documents — and the POSITION deliberately is not: it is
 * anchored to wherever the selection is, every time.
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
import { Effect } from 'effect';
import { useTranslation } from 'react-i18next';
import { BrowserRuntime } from '@cockpit/effect-runtime';
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
  parseStoredPopupSize,
  planPopupClose,
  popupDragPosition,
  popupFrameBounds,
  popupGrabOffset,
  popupResizeBox,
  popupSessionTitle,
  popupSizeFromSettings,
  popupSizeSettingsPatch,
  quotePreview,
  resolvePopupSize,
  serializePopupSize,
  shouldStartPopupDrag,
  POPUP_SIZE_STORAGE_KEY,
  type PopupBox,
  type PopupFrame,
  type PopupResizeDirection,
  type PressPathNode,
} from './selectionChatOps';
import type { ComposerViewport } from './composerHeight';
import { loadAgentSettings, saveAgentSettings } from './effect/agentClient';

/**
 * THE REMEMBERED SIZE, IN BOTH STORES — the pair `shared-utils/bootTheme.ts`
 * documents, applied one preference later.
 *
 * The desktop shell boots Next on an ephemeral port, so `localStorage` is scoped
 * to an origin that dies with the process: a size kept only there resets on
 * every restart, which is exactly the complaint the app window's own size just
 * had. So `settings.json` holds the durable copy under a stable `COCKPIT_HOME`,
 * and `localStorage` stays the SYNCHRONOUS fast path the popup is actually
 * placed from — a placement that waited on a request would open at the default
 * and then jump.
 *
 * This is all the IO in this file, and it is deliberately dumb: WHAT counts as a
 * valid size, which key it lives under and what shape it takes are all decided in
 * selectionChatOps (pure, tested).
 *
 * Every one of them is total. `localStorage` throws on mere ACCESS when storage
 * is disabled (Safari private mode, a locked-down embedder) and the settings
 * request can simply fail; a popup that failed to open because it could not
 * remember how big it was last time would be an absurd way to lose the feature.
 */
function readStoredPopupSize(): { width: number; height: number } | null {
  if (typeof window === 'undefined') return null;
  try {
    return parseStoredPopupSize(window.localStorage.getItem(POPUP_SIZE_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeStoredPopupSize(size: { width: number; height: number }): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(POPUP_SIZE_STORAGE_KEY, serializePopupSize(size));
  } catch {
    // Storage disabled or full: the durable copy below still holds, and the next
    // popup of this run pays one request to find it.
  }
}

/**
 * The durable write-through, fire-and-forget in exactly the shape `persistTheme`
 * and `persistFonts` use (Providers.tsx): a failed preference write must never
 * interrupt the UI, and `localStorage` has already taken the change for this
 * origin. `PUT /api/settings` is a locked merge-update, so a patch carrying one
 * field cannot clobber the theme or the fonts beside it.
 */
function persistPopupSize(size: { width: number; height: number }): void {
  BrowserRuntime.runFork(
    saveAgentSettings(popupSizeSettingsPatch(size)).pipe(Effect.orElse(() => Effect.void)),
  );
}

/**
 * The durable read, used ONLY to seed an empty fast path — which, after a
 * restart, is every first popup of the run. Placement never waits on it.
 */
async function loadPersistedPopupSize(): Promise<{ width: number; height: number } | null> {
  const exit = await BrowserRuntime.runPromiseExit(loadAgentSettings());
  if (exit._tag !== 'Success') return null;
  return popupSizeFromSettings(exit.value);
}

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
  /** How much column the composer inside actually has. The popup is a ~320px
   *  box hosting a whole chat, and a composer that sized itself against the
   *  WINDOW took a share of a column it was not in — the transcript here is the
   *  one that cannot afford it. A reader plus a signal, not a number, because
   *  the box lives in a ref on purpose (see the header). */
  composerViewport: ComposerViewport;
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
  /** The conversation column — the flex child between the quote block and the
   *  hint row, which is what the chat inside is actually given. The composer's
   *  ceiling is a fraction of THIS, so it is measured rather than derived from
   *  the popup's height minus a guess at the chrome around it. */
  const columnRef = useRef<HTMLDivElement | null>(null);
  /** The popup's live panel-local position. THE source of truth, and not state:
   *  a streamed delta re-renders this component many times a second, and a
   *  position that lived in state would be re-committed from a stale render
   *  mid-drag. */
  const posRef = useRef<{ x: number; y: number } | null>(null);
  /** The popup's live box, in the same space and under the same discipline as
   *  `posRef`: a resize writes width/height to the element, never to state. */
  const sizeRef = useRef<{ width: number; height: number } | null>(null);
  /** The size the user WANTS, which is not always the size they can have: a
   *  remembered 900px popup in a 600px panel is clamped for as long as the panel
   *  is small and springs back when it is not. Kept apart from `sizeRef` so a
   *  temporary window shrink does not overwrite the preference. */
  const desiredSizeRef = useRef<{ width: number; height: number } | null>(null);
  /** Lazy one-shot read of the remembered size — the same pattern `tabIdRef`
   *  uses. SYNCHRONOUS, and it must land BEFORE the first `place()`, which runs
   *  in a layout effect, or the popup would open at the default and then jump.
   *  The durable copy in `settings.json` is only consulted when this comes back
   *  empty (see the seed effect below). */
  const sizeLoadedRef = useRef(false);
  if (!sizeLoadedRef.current) {
    sizeLoadedRef.current = true;
    desiredSizeRef.current = readStoredPopupSize();
  }
  /** At most one settings read per popup, whatever the effect's deps do. */
  const seedRequestedRef = useRef(false);
  /** Unmount, not "this effect run" — a re-run of the seed effect must not
   *  cancel the request the first run has in flight. */
  const mountedRef = useRef(true);
  /** The user has picked the popup up at least once. From then on the popup
   *  stays where it was PUT: the initial anchoring never runs again. A resize
   *  sets it too — `sw` moves the origin, and even a pure `se` grow is the user
   *  choosing this box here, which a re-anchor would throw away. */
  const movedRef = useRef(false);
  const dragRef = useRef<{ pointerId: number; grabX: number; grabY: number } | null>(null);
  /** The live resize gesture. It carries the element it captured on, because
   *  there are three grips and the unmount cleanup must hand the pointer back to
   *  whichever one has it. */
  const resizeRef = useRef<{
    pointerId: number;
    direction: PopupResizeDirection;
    start: PopupBox;
    startPointer: { x: number; y: number };
    element: Element;
  } | null>(null);

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

  /** The ONLY writer of the frame's width/height, and it exists for exactly the
   *  reason `applyPosition` does: a resize that re-rendered would re-render the
   *  live transcript inside on every pointer move. The style prop carries a
   *  constant 1×1 placeholder and nothing else. */
  const applySize = useCallback(() => {
    const el = frameRef.current;
    const box = sizeRef.current;
    if (!el || !box) return;
    el.style.width = `${box.width}px`;
    el.style.height = `${box.height}px`;
  }, []);

  /** Both halves at once, for the callers that change both (placement, and the
   *  `sw` grip, which moves the origin as it resizes). */
  const applyGeometry = useCallback(() => {
    applySize();
    applyPosition();
  }, [applySize, applyPosition]);

  // ── What the composer inside is allowed to take ───────────────────────
  //
  // THE BUG THIS FIXES. `composerHeight` caps the textarea at a fraction of its
  // column so the transcript keeps the majority of it — and the composer used to
  // measure that fraction against `window.innerHeight`. In a full-height tab the
  // window IS the column and the rule worked; in this popup it is a ~320px box
  // inside a large window, so the protection evaporated in the one place a
  // column is genuinely short, and the composer ate the little conversation
  // there was.
  //
  // WHY A READER AND A SIGNAL RATHER THAN A PROP. The box lives in `sizeRef` and
  // is written straight to the element precisely so a resize does not re-render
  // the streaming transcript (see the header). Handing the height down as a
  // number would force it into state and undo exactly that. So the composer
  // PULLS the current value when told the box moved: it measures one element and
  // restyles one textarea, rendering nothing.
  const viewportListenersRef = useRef(new Set<() => void>());
  /** Called after the box changes — the resize gesture and every `place()`,
   *  which covers the first placement, a window resize and the seeded size. */
  const notifyComposerViewport = useCallback(() => {
    for (const listener of viewportListenersRef.current) listener();
  }, []);
  /** Created once and never replaced: the chat inside is `memo`'d, and a fresh
   *  object per render would defeat that on every streamed delta. */
  const composerViewport = useMemo<ComposerViewport>(
    () => ({
      // Read live, never cached. `clientHeight` is 0 before the first layout
      // (and always, in jsdom), which composerHeight reads as "unknown" and
      // answers with the absolute cap — the same thing a plain tab gets.
      getAvailableHeight: () => columnRef.current?.clientHeight ?? 0,
      subscribe: (listener: () => void) => {
        const listeners = viewportListenersRef.current;
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    }),
    [],
  );

  const place = useCallback(() => {
    if (typeof window === 'undefined') return;
    const frame = readFrame();
    // The remembered size wins over the preferred box — but only as far as this
    // frame allows it to. A size stored in a big window and reopened in a small
    // one is trimmed to fit, never honoured into a popup hanging off the panel.
    const { width, height } = resolvePopupSize(desiredSizeRef.current, frame.width, frame.height);

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
    applyGeometry();
    // The column just changed height, and the composer's ceiling is a fraction
    // of it. This covers the FIRST placement too: the frame is 1×1 off-screen
    // until now, so the composer's own mount measured an unmeasurable column.
    notifyComposerViewport();
  }, [anchor.x, anchor.y, readFrame, applyGeometry, notifyComposerViewport]);

  useLayoutEffect(() => {
    place();
  }, [place]);

  // AFTER EVERY RENDER, on purpose (no dependency array). The popup re-renders
  // on every streamed delta of its own conversation; this is what guarantees the
  // dragged position and the resized box survive all of them instead of
  // snapping back to whatever the last render's props described.
  useLayoutEffect(applyPosition);
  useLayoutEffect(applySize);

  useEffect(() => {
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [place]);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  // SEED FROM THE DURABLE COPY, and only when the fast path had nothing.
  //
  // `localStorage` dies with this origin's port, so the first popup after a
  // restart finds it empty; `settings.json` outlives the process. The read is
  // asynchronous and the PLACEMENT NEVER WAITS ON IT — the popup is already on
  // screen at the default box by the time this resolves, and adopting the
  // remembered size mirrors it into `localStorage` so this costs one request per
  // app launch rather than one per popup.
  //
  // A `localStorage` value, when there is one, WINS: within a run it is the
  // newer of the two (the same precedence ThemeProvider states).
  useEffect(() => {
    if (seedRequestedRef.current || desiredSizeRef.current) return;
    seedRequestedRef.current = true;
    void (async () => {
      const stored = await loadPersistedPopupSize();
      if (!mountedRef.current || !stored) return;
      // THE USER GOT THERE FIRST. A box they chose in the few milliseconds this
      // took outranks the one on disk, and a popup that resized itself under a
      // live gesture would be worse than not remembering at all.
      if (desiredSizeRef.current || movedRef.current || resizeRef.current) return;
      desiredSizeRef.current = stored;
      writeStoredPopupSize(stored);
      // Re-place, which re-clamps the seeded size against the CURRENT frame
      // exactly as a localStorage one is clamped — a size stored on a big
      // monitor is trimmed, not honoured — and re-anchors to the selection,
      // because the popup has not been moved.
      place();
    })();
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

  // ── Resizing ──────────────────────────────────────────────────────────
  //
  // THE SAME DISCIPLINE AS THE DRAG, for the same reason. The box lives in
  // `sizeRef` and is written straight to the element; a `setState` per pointer
  // move would re-render a streaming transcript sixty times a second, which is
  // precisely what this design exists to avoid (React Performance Conventions).
  // The maths — floor, frame ceiling, and the origin-moving `sw` grip — is in
  // selectionChatOps.
  //
  // ONE HANDLER FOR THREE GRIPS. The direction rides on the element as a data
  // attribute rather than in a closure, so the three handles share one stable
  // callback identity instead of allocating three arrow functions on every
  // streamed delta.
  const handleResizeDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const pos = posRef.current;
    const box = sizeRef.current;
    const direction = e.currentTarget.dataset.resizeDir as PopupResizeDirection | undefined;
    if (!pos || !box || !direction) return;

    resizeRef.current = {
      pointerId: e.pointerId,
      direction,
      // The box AT PRESS, held for the whole gesture: every move is computed
      // from it and the pointer delta, so a clamped move cannot accumulate
      // drift the way per-move increments would.
      start: { ...pos, ...box },
      startPointer: { x: e.clientX, y: e.clientY },
      element: e.currentTarget,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    // A resize that also selects the transcript behind the grip is neither.
    e.preventDefault();
  }, []);

  const handleResizeMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const resize = resizeRef.current;
      if (!resize || resize.pointerId !== e.pointerId) return;
      const next = popupResizeBox({
        direction: resize.direction,
        start: resize.start,
        startPointer: resize.startPointer,
        pointer: { x: e.clientX, y: e.clientY },
        // Re-read per move, exactly as the drag does: the panel can change size
        // mid-gesture and the ceiling has to follow it.
        frame: readFrame(),
      });
      posRef.current = { x: next.x, y: next.y };
      sizeRef.current = { width: next.width, height: next.height };
      desiredSizeRef.current = { width: next.width, height: next.height };
      // This box, here, is now the user's choice — the anchored placement must
      // never run again and undo it.
      movedRef.current = true;
      // NO setState. Resize the frame, not the content.
      applyGeometry();
      // …and tell the composer the column moved, or it would keep the height it
      // was given for the old box — the same "sized for a window it is not in"
      // bug, one gesture later. Still no setState: the listener measures and
      // restyles a textarea (composerHeight.ts).
      notifyComposerViewport();
    },
    [readFrame, applyGeometry, notifyComposerViewport],
  );

  const handleResizeEnd = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== e.pointerId) return;
    resizeRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    // REMEMBERED AT THE END OF THE GESTURE, not during it: one write per resize
    // rather than one per pixel. Size only — the position is anchored to the
    // selection on every open, so remembering it would reopen the popup
    // somewhere the user is not looking.
    //
    // BOTH STORES, in that order: `localStorage` is what the next popup of this
    // run is placed from, and `settings.json` is what survives the restart that
    // takes this origin's port with it.
    const box = sizeRef.current;
    if (box) {
      writeStoredPopupSize(box);
      persistPopupSize(box);
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
      // Same for a resize in flight, on whichever grip captured the pointer.
      const resize = resizeRef.current;
      resizeRef.current = null;
      if (resize?.element.hasPointerCapture(resize.pointerId)) {
        resize.element.releasePointerCapture(resize.pointerId);
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
      composerViewport,
    }),
    [selectedText, handleSessionId, handleLoading, handleTitle, handleStopHandle, composerViewport],
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

          DRAGGABLE BY ITS HEADER, RESIZABLE FROM ITS BOTTOM. The header reads as
          a title bar, so it behaves like one; the grips along the bottom edge
          change the box, which is remembered for the next popup. */}
      <div
        ref={frameRef}
        data-testid="selection-chat-popup"
        className="fixed z-[200] flex flex-col rounded-lg border border-border bg-card shadow-2xl overflow-hidden"
        style={{
          // NO GEOMETRY HERE AT ALL. `left`/`top` are written by `applyPosition`
          // and `width`/`height` by `applySize`, so a re-render can never
          // re-commit a stale box over a dragged or resized one; this constant
          // is only what keeps the popup off-screen and unmeasured on the very
          // first render, instead of flashing at 0,0.
          left: -9999,
          top: -9999,
          width: 1,
          height: 1,
        }}
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

        {/* THE CONVERSATION COLUMN, and the thing the composer inside is capped
            against. `columnRef` is measured rather than computed, so adding or
            removing chrome around it (the quote block, the hint row) cannot
            leave the composer sizing itself against a stale idea of the box. */}
        <div ref={columnRef} className="min-h-0 flex-1">{children(wiring)}</div>

        {/* `pr-6` keeps the hint from running under the corner grip below. */}
        <div className="shrink-0 border-t border-border px-3 py-1 pr-6 text-[0.65rem] text-muted-foreground/70">
          {t('selectionChat.throwawayHint')}
        </div>

        {/* RESIZE GRIPS — the bottom band only, and the omissions are the
            design (see PopupResizeDirection): the top edge is the drag handle
            and would fight it for the same pixels, and a full-height side strip
            would sit on top of the transcript's scrollbar.

            SIBLINGS OF THE HEADER, not children of it, so a press on one never
            reaches the drag handle's pointerdown and the two gestures can never
            both be live. The corners come LAST in DOM order so they hit-test
            above the edge strip they overlap. */}
        <div
          data-testid="selection-chat-resize-s"
          data-resize-dir="s"
          onPointerDown={handleResizeDown}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
          title={t('selectionChat.resizeHint')}
          className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize touch-none select-none"
        />
        <div
          data-testid="selection-chat-resize-sw"
          data-resize-dir="sw"
          onPointerDown={handleResizeDown}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
          title={t('selectionChat.resizeHint')}
          className="absolute bottom-0 left-0 h-3.5 w-3.5 cursor-nesw-resize touch-none select-none"
        />
        {/* THE VISIBLE ONE. The drag handle had to be given `cursor-move` before
            anyone knew the header could be grabbed; a resize that is only a
            cursor change is the same problem, so the corner is drawn. */}
        <div
          data-testid="selection-chat-resize-se"
          data-resize-dir="se"
          onPointerDown={handleResizeDown}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
          title={t('selectionChat.resizeHint')}
          className="absolute bottom-0 right-0 flex h-3.5 w-3.5 cursor-nwse-resize touch-none select-none items-end justify-end p-0.5 text-muted-foreground/60"
        >
          <svg className="h-2.5 w-2.5" viewBox="0 0 10 10" aria-hidden="true">
            <path
              d="M9 2 L2 9 M9 6 L6 9"
              stroke="currentColor"
              strokeWidth={1.2}
              strokeLinecap="round"
              fill="none"
            />
          </svg>
        </div>
      </div>
    </Portal>
  );
}

/** Memoized: the HOST chat re-renders on every streamed delta of the main
 *  conversation, and each of those would otherwise re-render the popup's whole
 *  transcript. Every prop above is passed with a stable identity from Chat. */
export const SelectionChatPopup = memo(SelectionChatPopupInner);
