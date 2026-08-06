'use client';

import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle, useMemo } from 'react';
import { useChatContextOptional } from './ChatContext';
import { formatElapsed } from './elapsed';
import type { ChatMessage, ApiRetryInfo, ChatEngine, ToolCallInfo } from './types';
import { MessageBubble } from './MessageBubble';
import { GENERIC_ENGINE_NAME } from './engineName';
import { useChatSearch } from './useChatSearch';
import {
  initialStickState,
  reduceStick,
  shouldShowJumpChip,
  type ScrollMetrics,
  type ScrollWrite,
  type StickEvent,
} from './stickToBottom';
import { ToolbarRenderer, ToolbarData } from '@cockpit/shared-ui';
import { SendToAIInput } from '@cockpit/shared-ui';
import { useTranslation } from 'react-i18next';

/**
 * Quote-reply formatter — inlined from the removed `@cockpit/feature-comments`
 * `buildAIMessage()` (F1-03 chat-first trim). The persistent code-annotation
 * store is gone; the only surviving path is "select text in a reply, ask a
 * question about it", which needs nothing more than markdown blockquoting.
 */
function buildQuotedMessage(selectedText: string, question: string): string {
  const quoted = selectedText.split('\n').map(l => `> ${l}`).join('\n');
  const q = question.trim();
  return q ? `${quoted}\n\n${q}` : quoted;
}

// Migrated from src/components/project/MessageList.tsx.

interface MessageListProps {
  messages: ChatMessage[];
  isLoading?: boolean;
  cwd?: string;
  sessionId?: string | null;
  engine?: ChatEngine;
  apiRetryInfo?: ApiRetryInfo | null;
  /** PTY notice (stuck / timed-out) shown in the loading bubble */
  hasMoreHistory?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  isActive?: boolean; // Whether the tab is active (handles scroll issues for hidden tabs)
  /** Plan mode: approve the presented plan → turn off plan mode and resend to execute */
  onApprovePlan?: () => void;
  /** WHO the "… is thinking" bubble names: the AGENT answering this turn — ko 나비
   *  / en naby for the built-in persona, an imported agent's own handle for a turn
   *  addressed to one — falling back to the engine brand ("Claude" / "GPT" /
   *  "Gemini") only where no agent identity exists. Chat resolves it (actingAgent.ts)
   *  and passes a plain string, so it never threatens the memoized rows below. */
  thinkingName?: string | null;
  /** True when the turn on screen was started SOMEWHERE ELSE and this tab is only
   *  watching it: the fast-growth session's opening turn, a Telegram message, a
   *  scheduled task. The user did not press send, so "naby is thinking" — the
   *  label for a turn they just asked for — reads as an answer to a question they
   *  never asked. They are being spoken TO, and the bubble says so. */
  viewerRun?: boolean;
  /** Stops the running turn. The machinery already existed (ESC over the chat
   *  area, `/api/chat/stop`) but had no visible control, so a long turn looked
   *  indistinguishable from a hung one. */
  onStop?: () => void;
  /** Bumped by the host every time THE USER sends. A send is an unambiguous
   *  statement of intent — "show me what happens next" — so it re-pins the
   *  transcript to the bottom no matter where they had scrolled to. A counter
   *  rather than a callback because two sends in a row must both register. */
  sendNonce?: number;
}

// Methods exposed to parent component
export interface MessageListHandle {
  scrollToMessage: (messageId: string) => void;
}

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(function MessageList(
  { messages, isLoading, cwd, sessionId, apiRetryInfo, hasMoreHistory, isLoadingMore, onLoadMore, isActive = true, onApprovePlan, thinkingName, viewerRun, onStop, sendNonce },
  ref
) {
  const { t } = useTranslation();
  const bottomRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  /** The block that wraps everything inside the scroll container. Observing it
   *  is how a STREAMED answer is noticed: its box grows with every delta, and
   *  the message array — which the old scroll rule watched — does not. */
  const contentRef = useRef<HTMLDivElement>(null);
  const outerRef = useRef<HTMLDivElement>(null);
  const [outerEl, setOuterEl] = useState<HTMLDivElement | null>(null);
  const [showTopButton, setShowTopButton] = useState(false);
  const [showBottomButton, setShowBottomButton] = useState(false);
  /** The "↓ new response" chip: something arrived while the user was reading
   *  further up. Shown INSTEAD of the plain jump-to-latest control, which stays
   *  for "I scrolled up and nothing new has happened". */
  const [showNewChip, setShowNewChip] = useState(false);

  // Sync outerRef to state so we can read it during render without violating ref rules
  useEffect(() => {
    setOuterEl(outerRef.current);
  }, []);

  const {
    isSearchVisible,
    searchQuery,
    setSearchQuery,
    matches,
    currentMatchIndex,
    goToNextMatch,
    goToPrevMatch,
    closeSearch,
    searchInputRef,
    handleSearchKeyDown,
  } = useChatSearch(outerRef);
  const chatCtx = useChatContextOptional();

  // --- Selection toolbar (quote-reply / search) ---
  const floatingToolbarRef = useRef<ToolbarData | null>(null);
  const bumpToolbarRef = useRef<() => void>(() => {});
  const [sendAIInput, setSendAIInput] = useState<{ x: number; y: number; text: string } | null>(null);

  // Selection detection — text selection within the message area
  const handleSelectionMouseUp = useCallback((e: React.MouseEvent) => {
    if (sendAIInput) return;

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      floatingToolbarRef.current = null;
      bumpToolbarRef.current();
      return;
    }
    const text = sel.toString().trim();
    if (!text) {
      floatingToolbarRef.current = null;
      bumpToolbarRef.current();
      return;
    }
    // Only show the toolbar for AI reply bubbles
    const anchor = sel.anchorNode instanceof HTMLElement ? sel.anchorNode : sel.anchorNode?.parentElement;
    if (anchor?.closest('[data-role="user"]')) {
      floatingToolbarRef.current = null;
      bumpToolbarRef.current();
      return;
    }
    // Chat selections aren't line-structured — there's no "whole line
    // expansion" concept, so `lineSnapshot` just mirrors `selectedText`.
    // The required-field shape on ToolbarData is what enforces this.
    floatingToolbarRef.current = {
      x: e.clientX,
      y: e.clientY,
      range: { start: 0, end: 0 },
      selectedText: text,
      lineSnapshot: text,
    };
    bumpToolbarRef.current();
  }, [sendAIInput]);

  // Clear the toolbar on mousedown (unless clicking the toolbar/card itself)
  const handleSelectionMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.floating-toolbar') || target.closest('[class*="z-[200]"]')) return;
    if (floatingToolbarRef.current) {
      floatingToolbarRef.current = null;
      bumpToolbarRef.current();
    }
  }, []);

  // Toolbar button callbacks
  const handleSendToAI = useCallback(() => {
    const tb = floatingToolbarRef.current;
    if (!tb) return;
    setSendAIInput({ x: tb.x, y: tb.y, text: tb.selectedText });
    floatingToolbarRef.current = null;
    bumpToolbarRef.current();
    window.getSelection()?.removeAllRanges();
  }, []);

  // Quote-reply: send the selected text back into the chat as a blockquote
  // plus the user's question. Purely local formatting — no persistence.
  const sendSelectionToAI = useCallback((selectedText: string, question: string) => {
    if (!chatCtx) return;
    chatCtx.sendMessage(buildQuotedMessage(selectedText, question));
  }, [chatCtx]);

  // The card closes itself on submit — deliberately NO trailing state reset
  // after the send (a late set(null) could clobber a card the user opened in
  // the meantime).
  const handleSendAISubmit = useCallback((question: string) => {
    if (!sendAIInput) return;
    sendSelectionToAI(sendAIInput.text, question);
  }, [sendAIInput, sendSelectionToAI]);

  // Deduplicate messages (prevent duplicate key warnings)
  const uniqueMessages = useMemo(() => {
    const seen = new Set<string>();
    return messages.filter((msg) => {
      if (seen.has(msg.id)) return false;
      seen.add(msg.id);
      return true;
    });
  }, [messages]);

  // Record scroll position before loading more, to restore it afterward
  const scrollHeightBeforeLoadRef = useRef(0);
  const shouldRestoreScrollRef = useRef(false);

  // -- STICK TO BOTTOM -----------------------------------------------------
  //
  // THE REPORT: "스크롤이 중간에 멈춰 있어서 새로운 응답이 온지 아닌지 헷갈림."
  //
  // The rule that used to live here was `if (shouldAutoScroll && messages.length
  // > prevLength) scrollIntoView()`. A streamed answer never grows that array —
  // every delta, every appended segment, every subagent block REWRITES THE LAST
  // MESSAGE — so the list scrolled once, when the empty assistant bubble was
  // pushed, and then sat still for the rest of the answer while the text it was
  // meant to be showing grew off the bottom of the viewport.
  //
  // What replaces it: a ResizeObserver on the content box (which sees growth
  // however it was produced) feeding the pure state machine in stickToBottom.ts.
  // The decisions — pinned or not, chip or not — are pinned by unit tests there;
  // everything below is measure, obey, and never fight the user's wheel.
  const stickRef = useRef(initialStickState);
  const rafRef = useRef<number | null>(null);
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  /** A scroll that fell due while this tab was hidden, owed on activation. */
  const owedScrollRef = useRef(false);

  /** The container's metrics, or null when they cannot be trusted. */
  const readMetrics = useCallback((): ScrollMetrics | null => {
    const el = containerRef.current;
    if (!el) return null;
    // TabManager keeps every chat tab mounted and hides the inactive ones with
    // `display:none`, where every box metric reads 0 — and 0/0/0 satisfies "at
    // bottom", so measuring a hidden tab would re-pin a conversation the user
    // had scrolled up in. Both guards: the flag for correctness, the metric for
    // the frame between them.
    if (!isActiveRef.current || el.clientHeight === 0) return null;
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  }, []);

  /** Perform a scroll write, at most one per frame while streaming. */
  const applyWrite = useCallback((write: ScrollWrite) => {
    if (write === 'none') return;
    if (!isActiveRef.current) {
      owedScrollRef.current = true;
      return;
    }
    if (write === 'smooth') {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
      return;
    }
    // rAF-throttled: deltas flush every 50ms and a subagent block can grow
    // several times between two frames; coalescing them into one write per
    // frame keeps the browser from laying out for scroll positions nobody sees.
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      // Re-check: the user may have grabbed the wheel between the growth and
      // this frame, and a queued write must never overrule that.
      if (!stickRef.current.stuck || !isActiveRef.current) return;
      const el = containerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  /** Feed one event to the state machine and reflect the result. */
  const dispatchStick = useCallback((ev: StickEvent) => {
    const d = reduceStick(stickRef.current, ev);
    stickRef.current = d.state;
    setShowNewChip(shouldShowJumpChip(d.state));
    setShowBottomButton(!d.state.stuck);
    applyWrite(d.write);
  }, [applyWrite]);

  /** The content box changed size — a delta, a segment, a reconcile, a resize. */
  const handleContentGrowth = useCallback(() => {
    const metrics = readMetrics();
    if (!metrics) return;
    dispatchStick({ kind: 'content', metrics });
  }, [readMetrics, dispatchStick]);

  /** The SCROLL BOX changed size, with the transcript untouched: the composer
   *  grew a line, a banner appeared above it, the window was resized. */
  const handleViewportResize = useCallback(() => {
    const metrics = readMetrics();
    if (!metrics) return;
    dispatchStick({ kind: 'viewport', metrics });
  }, [readMetrics, dispatchStick]);

  // Listen to scroll events
  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const metrics = readMetrics();
    if (metrics) dispatchStick({ kind: 'scroll', metrics });

    // Show the scroll-to-top button when not at the top (unchanged, 50px).
    const atTop = container.scrollTop < 50;
    setShowTopButton(!atTop);

    // When scrolled to the top with more history available, trigger load-more
    if (atTop && hasMoreHistory && !isLoadingMore && onLoadMore) {
      // Record current scroll height to restore position after loading
      scrollHeightBeforeLoadRef.current = container.scrollHeight;
      shouldRestoreScrollRef.current = true;
      onLoadMore();
    }
  }, [readMetrics, dispatchStick, hasMoreHistory, isLoadingMore, onLoadMore]); // hasMoreHistory still needed for loading more logic

  // Scroll to top
  const scrollToTop = useCallback(() => {
    topRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Scroll to bottom — the chip and the plain jump control. A deliberate click,
  // so it also RE-ENGAGES the stick: from here the answer is followed again.
  const scrollToBottom = useCallback(() => {
    dispatchStick({ kind: 'jump' });
  }, [dispatchStick]);

  // Growth of the content box is the signal the old rule was missing. One
  // observer covers every source of it: streamed text deltas, appended turn
  // segments, a subagent block filling in, tool results expanding, the thinking
  // bubble appearing and going, and the reconcile after a run ends.
  useEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => handleContentGrowth());
    ro.observe(el);
    return () => ro.disconnect();
  }, [handleContentGrowth]);

  // THE OTHER HALF OF THE SAME QUESTION. The observer above watches the CONTENT
  // grow; this one watches the VIEWPORT shrink. The transcript and the composer
  // are one flex column (Chat.tsx), so every line the user adds to the input
  // takes a strip off the bottom of this box — the content is untouched,
  // `scrollHeight` never moves, and the observer above stays silent while the
  // newest message slides out of sight behind the taller input. To the user
  // that is indistinguishable from the composer being drawn ON TOP of the
  // conversation, which is how it was reported. Same for the banners that
  // appear above the input (context limit, check-in, tool approval) and for a
  // window resize: one observer on the scroll box covers every one of them.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => handleViewportResize());
    ro.observe(el);
    return () => ro.disconnect();
  }, [handleViewportResize]);

  // Belt and braces for a render that changes content without changing the box
  // height in a way the observer reports first (and for any environment with no
  // ResizeObserver). Idempotent: unchanged height decides `write: 'none'`.
  useEffect(() => {
    handleContentGrowth();
  }, [messages, isLoading, handleContentGrowth]);

  // A send is an unambiguous statement of intent, so it pins unconditionally.
  const prevSendNonceRef = useRef(sendNonce ?? 0);
  useEffect(() => {
    const n = sendNonce ?? 0;
    if (n === prevSendNonceRef.current) return;
    prevSendNonceRef.current = n;
    dispatchStick({ kind: 'send' });
  }, [sendNonce, dispatchStick]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Scroll to a specific message
  const scrollToMessage = useCallback((messageId: string) => {
    const container = containerRef.current;
    if (!container) return;

    // Find the DOM element for the message
    const messageElement = container.querySelector(`[data-message-id="${messageId}"]`);
    if (messageElement) {
      messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Add highlight effect
      messageElement.classList.add('ring-2', 'ring-brand', 'ring-offset-2');
      setTimeout(() => {
        messageElement.classList.remove('ring-2', 'ring-brand', 'ring-offset-2');
      }, 2000);
    }
  }, []);

  // Expose methods to parent component
  useImperativeHandle(ref, () => ({
    scrollToMessage,
  }), [scrollToMessage]);

  // Flag for whether this is the initial load
  const isInitialLoadRef = useRef(true);

  // NO MESSAGE-COUNT SCROLL RULE HERE ANY MORE. It is the bug: a streamed
  // answer rewrites the last message instead of appending one, so the count
  // never moved and the list never followed. Growth is watched directly, by the
  // ResizeObserver above.

  // Once the answer has words in it, the "thinking" bubble is a lie sitting under
  // the thing it claims has not happened yet. It goes; the elapsed clock and Stop
  // go with it, which is right — the visible answer is now the progress indicator,
  // and Stop is still on Esc.
  const answerStarted = useMemo(() => {
    // The LAST assistant message, not the last message: a system event bar can sit
    // after it and would otherwise hide the fact that an answer is already there.
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]!;
      if (m.role !== 'assistant') continue;
      // TEXT only. Tool calls alone are not an answer — the model can sit inside a
      // tool for a long time, and there the elapsed clock is the only evidence it
      // is still alive, which is the whole reason it was added.
      return m.content.trim().length > 0;
    }
    return false;
  }, [messages]);

  // -- HOW LONG IT HAS BEEN THINKING ---------------------------------------
  //
  // Without this, a turn that is legitimately working through a large project is
  // indistinguishable from one that has hung, and the only thing a user can do is
  // guess. The clock starts when the spinner appears and is dropped when it goes,
  // so it never survives into the next turn.
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    if (!isLoading) {
      setElapsedSec(0);
      return;
    }
    const startedAt = Date.now();
    setElapsedSec(0);
    // One second is the right resolution: finer would flicker, coarser would look
    // frozen for the first stretch — which is the very thing being fixed.
    const id = setInterval(() => setElapsedSec(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [isLoading]);

  // (The "thinking" indicator appearing/disappearing changes the content box
  // height, so the growth observer already carries it — no separate effect.)

  // Restore scroll position after loading more history
  useEffect(() => {
    if (shouldRestoreScrollRef.current && !isLoadingMore) {
      const container = containerRef.current;
      if (container) {
        // Calculate the height delta of newly added content to preserve visual position
        const heightDiff = container.scrollHeight - scrollHeightBeforeLoadRef.current;
        container.scrollTop = heightDiff;
        shouldRestoreScrollRef.current = false;
        // Older history was prepended ABOVE the viewport, so the user has not
        // moved and neither has the bottom. Re-baseline the machine's height so
        // that growth is not mistaken for new content arriving below.
        stickRef.current = { ...stickRef.current, height: container.scrollHeight };
      }
    }
  }, [messages, isLoadingMore]);

  // When the tab activates, pay any scroll that fell due while it was hidden.
  // A hidden tab is `display:none`: nothing could be measured, no observer
  // fired, and the browser does not reliably preserve scrollTop across the
  // toggle — so a tab that was pinned is re-pinned on the way back in.
  useEffect(() => {
    if (!isActive) return;
    if (!owedScrollRef.current && !stickRef.current.stuck) return;
    owedScrollRef.current = false;
    if (messages.length === 0) return;
    // After layout, so scrollHeight reflects the now-visible content.
    const id = requestAnimationFrame(() => {
      if (!stickRef.current.stuck) return;
      const container = containerRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [isActive, messages.length]);

  // Initial load: land on the newest message.
  useEffect(() => {
    if (!isInitialLoadRef.current || messages.length === 0) return;
    isInitialLoadRef.current = false;
    const d = reduceStick(stickRef.current, { kind: 'reset' });
    stickRef.current = d.state;
    setShowNewChip(false);
    setShowBottomButton(false);
    if (isActive) {
      const container = containerRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    } else {
      // Tab is hidden — mark that scroll should happen on activation
      owedScrollRef.current = true;
    }
  }, [messages.length, isActive]);

  return (
    <div ref={outerRef} className="relative flex-1 min-h-0 overflow-hidden flex flex-col outline-none" tabIndex={-1} onMouseUp={handleSelectionMouseUp} onMouseDown={handleSelectionMouseDown}>
      {/* Search bar */}
      {isSearchVisible && (
        <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 bg-secondary border-b border-border">
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder={t('codeViewer.searchChat')}
            className="flex-1 max-w-xs px-2 py-1 text-sm border border-border rounded bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <span className="text-xs text-muted-foreground">
            {matches.length > 0 ? `${currentMatchIndex + 1}/${matches.length}` : t('common.noMatch')}
          </span>
          <button onClick={goToPrevMatch} disabled={matches.length === 0} className="p-1 rounded hover:bg-accent disabled:opacity-50" title={t('codeViewer.prevShiftEnter')}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          </button>
          <button onClick={goToNextMatch} disabled={matches.length === 0} className="p-1 rounded hover:bg-accent disabled:opacity-50" title={t('codeViewer.nextEnter')}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <button onClick={closeSearch} className="p-1 rounded hover:bg-accent" title={t('codeViewer.closeEsc')}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="relative flex-1 min-h-0 overflow-y-auto p-4"
      >
        {/* One block wrapping everything that scrolls. It exists so the growth
            observer has a box to watch: its height IS the transcript's height,
            and it changes on every streamed delta — which the message array
            does not. `h-full` only in the empty state, so the placeholder keeps
            centring against the container exactly as before. */}
        <div ref={contentRef} className={messages.length === 0 && !isLoading ? 'flex h-full items-center justify-center text-slate-9' : undefined}>
        {messages.length === 0 && !isLoading ? (
          <div className="text-center">
            <div className="text-4xl mb-4">💬</div>
            <div>{t('chat.startConversation')}</div>
          </div>
        ) : (
          <>
            <div ref={topRef} />
            {/* Load-more history indicator */}
            {hasMoreHistory && (
              <div className="flex justify-center py-3">
                {isLoadingMore ? (
                  <div className="flex items-center gap-2 text-muted-foreground text-sm">
                    <span className="inline-block w-4 h-4 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                    <span>{t('chat.loadMoreHistory')}</span>
                  </div>
                ) : (
                  <button
                    onClick={onLoadMore}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {t('chat.scrollUpForMore')}
                  </button>
                )}
              </div>
            )}
            {uniqueMessages.map((message) => (
              <div key={message.id} data-message-id={message.id} className="transition-[box-shadow] duration-300">
                <MessageBubble
                  message={message}
                  cwd={cwd}
                  sessionId={sessionId}
                  onApprovePlan={onApprovePlan}
                  isLoading={isLoading}
                  // A hidden tab is `display:none` but still mounted, so the
                  // per-second clocks inside a turn are told to stand down.
                  isActive={isActive}
                />
              </div>
            ))}
            {isLoading && !answerStarted && (
              <div className="flex justify-start mb-4">
                <div className="bg-accent rounded-2xl rounded-bl-md px-4 py-3 max-w-[90%]">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <span className="inline-block w-5 h-5 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                    {/* Same bubble, same spinner, same clock, same Stop — only the
                        sentence changes, because a turn nobody on this screen asked
                        for is naby speaking first, not an engine answering. Both
                        sentences name the AGENT: `thinkingName` is resolved from the
                        turn's acting agent, and only an engine-brand fallback (no
                        agent identity at all) puts a vendor name in this bubble. */}
                    <span className="text-sm">
                      {viewerRun
                        ? t('chat.typing', { defaultValue: 'naby is typing…' })
                        : t('chat.thinking', { name: thinkingName || GENERIC_ENGINE_NAME })}
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground/70" data-testid="thinking-elapsed">
                      {formatElapsed(elapsedSec)}
                    </span>
                    {onStop && (
                      // Shown from the first second, not after a threshold: a
                      // control that appears only once the user is already worried
                      // teaches them the app freezes.
                      <button
                        onClick={onStop}
                        className="ml-1 rounded border border-border px-1.5 py-0.5 text-[0.786rem] text-muted-foreground hover:border-red-500/50 hover:text-red-600 dark:hover:text-red-400"
                        title={t('chat.stopHint', { defaultValue: 'Stop this turn (or press Esc)' })}
                      >
                        {t('chat.stop', { defaultValue: 'Stop' })}
                      </button>
                    )}
                  </div>
                  {apiRetryInfo && (
                    <div className="mt-2 flex items-start gap-2 text-xs text-amber-400 border-t border-border/50 pt-2">
                      <svg className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      <div className="flex-1 min-w-0">
                        <div>
                          Retrying API call (attempt {apiRetryInfo.attempt}
                          {apiRetryInfo.maxRetries > 0 ? `/${apiRetryInfo.maxRetries}` : ''}
                          {apiRetryInfo.delayMs > 0 ? `, delay ${(apiRetryInfo.delayMs / 1000).toFixed(1)}s` : ''}
                          )
                        </div>
                        {(apiRetryInfo.errorStatus || apiRetryInfo.error) && (
                          <div className="text-muted-foreground/80 break-words">
                            {apiRetryInfo.errorStatus ? `${apiRetryInfo.errorStatus}` : ''}
                            {apiRetryInfo.errorStatus && apiRetryInfo.error ? ' · ' : ''}
                            {apiRetryInfo.error || ''}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </>
        )}
        </div>
      </div>

      {/* Scroll to top button */}
      {showTopButton && messages.length > 0 && (
        <button
          onClick={scrollToTop}
          className="absolute top-2 left-1/2 -translate-x-1/2 p-2 bg-card text-muted-foreground hover:text-foreground shadow-md rounded-full transition-all hover:shadow-lg active:scale-95"
          title={t('chat.jumpToStart')}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
          </svg>
        </button>
      )}

      {/* The bottom control, in two strengths and one slot.
            • Something ARRIVED while the user was reading further up → the
              labelled "↓ new response" chip. It is the answer to the report
              ("새로운 응답이 온지 아닌지 헷갈림"): the one thing a user who has
              scrolled away needs to know is that there is something new, and
              the transcript must tell them instead of dragging them to it.
            • Merely scrolled up, nothing new → the plain circle, unchanged.
          Clicking either re-engages the stick, so the answer is followed again
          from there. */}
      {showNewChip && messages.length > 0 ? (
        <button
          onClick={scrollToBottom}
          data-testid="jump-to-latest-chip"
          className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground shadow-md transition-all hover:shadow-lg active:scale-95"
          title={t('chat.jumpToLatest')}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
          {t('chat.newResponse', { defaultValue: 'New response' })}
        </button>
      ) : showBottomButton && messages.length > 0 ? (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-2 left-1/2 -translate-x-1/2 p-2 bg-card text-muted-foreground hover:text-foreground shadow-md rounded-full transition-all hover:shadow-lg active:scale-95"
          title={t('chat.jumpToLatest')}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      ) : null}

      {/* Selection toolbar */}
      {outerEl && (
        <ToolbarRenderer
          floatingToolbarRef={floatingToolbarRef}
          bumpRef={bumpToolbarRef}
          container={outerEl}
          onSendToAI={handleSendToAI}
          isChatLoading={chatCtx?.isLoading}
        />
      )}

      {/* Send to AI card (standalone, from toolbar) */}
      {sendAIInput && outerEl && (
        <SendToAIInput
          x={sendAIInput.x}
          y={sendAIInput.y}
          range={{ start: 0, end: 0 }}
          lineSnapshot={sendAIInput.text}
          container={outerEl}
          onSubmit={handleSendAISubmit}
          onClose={() => setSendAIInput(null)}
          isChatLoading={chatCtx?.isLoading}
        />
      )}
    </div>
  );
});
