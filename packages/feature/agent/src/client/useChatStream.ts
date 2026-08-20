'use client';

import { useState, useCallback, useRef } from 'react';
import { applyStreamEvent, withAssistantText, type StreamEvent } from './applyStreamEvent';
import { actingAgentFromInit, type ActingAgent } from './actingAgent';
import type {
  ChatMessage,
  ImageInfo,
  MessageImage,
  TokenUsage,
  RateLimitInfo,
  ApiRetryInfo,
  ChatEngine,
} from './types';
import i18n from '@cockpit/shared-i18n';
import { useWebSocket } from '@cockpit/shared-ui';

// Provisional run id the client generates per send so it can subscribe to the run's
// /ws/session-stream immediately — before the engine reveals its real sessionId.
function genRunId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `run-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
}

// Migrated from src/components/project/useChatStream.ts.

// ============================================
// Types
// ============================================

interface UseChatStreamOptions {
  sessionId: string | null;
  cwd?: string;
  engine?: ChatEngine;
  /** Plan mode (claude engine only): read-only exploration that produces a plan without editing */
  planMode?: boolean;
  onSessionId: (sid: string) => void;
  onFetchTitle: (sid: string) => void;
  /**
   * A run (launch turn + any #bg follow-up turns) just ended. The originator should reconcile
   * from disk here so its live `user-*` / `assistant-*` / `auto-*` bubbles converge to the
   * canonical persisted UUID messages — mirroring what the viewer path already does on
   * completion, and what a page reload produces. Kept symmetric so in-session state never
   * lingers as ephemeral ids until the next refresh.
   */
  onRunComplete?: () => void;
  /**
   * The engine's RESOLVED model label, delivered on each turn's `system/init`
   * (the server computes it in naby.ts as `modelLabel` and already puts it on
   * the wire as `event.model`). Lets the status indicator show the real model
   * answering — the Claude model id in dev, the provider's model id in prod —
   * instead of only the static engine name. Read-only; may fire every turn.
   */
  onEngineModel?: (model: string) => void;
  /**
   * WHO is answering this turn — the agent, not the engine — as the naby engine
   * reports it on the same `system/init` event (`acting_agent`). `null` when the
   * event carries none: a legacy engine, or a turn with no agent identity at all.
   * The loading bubble names it; see actingAgent.ts for why it is the agent and
   * not the brand.
   */
  onActingAgent?: (agent: ActingAgent | null) => void;
  /**
   * THIS RUN FAILED, and what the engine/provider said about it — reported as a
   * RUN-LEVEL artifact rather than as a message.
   *
   * An error is never persisted (`RuntimeMessage` has no system role, by
   * design), so anything about it that lives in `messages` is erased moments
   * later by the post-run `onRunComplete` reconcile. That is the "the answer
   * appeared and instantly disappeared" report: it was the error, wiped by the
   * re-sync. The host keeps what arrives here outside the transcript, where the
   * reconcile cannot reach it (see runFailure.ts).
   *
   * Fires with the provider's verbatim text on failure, and with `null` at the
   * START of every send — every send path goes through handleSend, so that is
   * the one place "a new question supersedes the failed one" can be stated once.
   */
  onRunError?: (message: string | null) => void;
  /**
   * The model the user picked in the bottom-bar ModelSwitcher for the active
   * engine, read fresh at send time. Returns '' (or undefined) when no override
   * is chosen → the turn omits `model` and the engine's own default answers.
   * A GETTER (not a value) so a mid-session model switch takes effect on the
   * next send without re-creating handleSend.
   */
  getModel?: () => string | undefined;
}

interface UseChatStreamReturn {
  isLoading: boolean;
  tokenUsage: TokenUsage | null;
  rateLimitInfo: RateLimitInfo | null;
  apiRetryInfo: ApiRetryInfo | null;
  handleSend: (
    content: string,
    images?: ImageInfo[],
    overrides?: { permissionMode?: 'plan' | null }
  ) => Promise<void>;
  /**
   * Stop the current turn. RESOLVES WHEN THE SERVER HAS BEEN TOLD, which is
   * what lets a caller order something after it — the selection popup must not
   * delete its session until the detached run it is stopping has been reached.
   * Every other caller (Esc, the Stop button) ignores the promise.
   */
  handleStop: () => Promise<void>;
  abortControllerRef: React.RefObject<AbortController | null>;
}

// ============================================
// Hook
// ============================================

export function useChatStream(
  messages: ChatMessage[],
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  { sessionId, cwd, engine, planMode, onSessionId, onFetchTitle, onRunComplete, onEngineModel, onActingAgent, onRunError, getModel }: UseChatStreamOptions
): UseChatStreamReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [rateLimitInfo, setRateLimitInfo] = useState<RateLimitInfo | null>(null);
  const [apiRetryInfo, setApiRetryInfo] = useState<ApiRetryInfo | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // #10 ws-converge: the active detached run the originator is tailing over
  // /ws/session-stream (runKey to subscribe by + the assistant bubble its events fill).
  const [activeRun, setActiveRun] = useState<{ runKey: string; assistantId: string } | null>(null);
  const activeRunRef = useRef(activeRun);
  activeRunRef.current = activeRun;

  // Latest onRunComplete via ref so endRun can fire it without taking it as a dependency
  // (the callback identity changes each render; threading it through endRun's deps would churn
  // handleSend too). endRun runs long after mount, so the ref is always populated by then.
  const onRunCompleteRef = useRef(onRunComplete);
  onRunCompleteRef.current = onRunComplete;

  // Same ref indirection for the resolved-model callback: it can be an inline
  // closure from the parent (new identity each render), and handleStreamEvent is
  // a stable useCallback — threading the callback through its deps would churn
  // the whole stream handler every render.
  const onEngineModelRef = useRef(onEngineModel);
  onEngineModelRef.current = onEngineModel;
  // The acting agent rides the same event and the same indirection.
  const onActingAgentRef = useRef(onActingAgent);
  onActingAgentRef.current = onActingAgent;
  // Same indirection for the run-failure report: handleStreamEvent and handleSend
  // are stable useCallbacks, and the host hands a fresh closure every render.
  const onRunErrorRef = useRef(onRunError);
  onRunErrorRef.current = onRunError;
  // Same indirection for the model getter: read the CURRENT pick at send time
  // without listing it in handleSend's deps (a switch mid-session must not
  // re-create the send closure, and the ModelSwitcher may hand a fresh getter).
  const getModelRef = useRef(getModel);
  getModelRef.current = getModel;

  // #10 R5/#7: connection watchdog. The detached run is driven entirely by /ws/session-stream;
  // if that socket never connects (ws server down, upgrade rejected), no event ever arrives and
  // the originator would hang with isLoading=true forever (the old SSE finally that reset it is
  // gone). A connected socket sends its snapshot within ms, so "no message at all for 15s" ⇒
  // the connection failed → unstick.
  const wsAliveRef = useRef(false);
  const wsWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Used to get latest sessionId in handleStreamEvent
  const sessionIdRef = useRef<string | null>(sessionId);
  sessionIdRef.current = sessionId;

  // Streaming text buffer - used to throttle setState
  const streamBufferRef = useRef<{ messageId: string; text: string } | null>(null);
  // Reasoning has its own buffer and its own timer: it arrives interleaved with the
  // answer, and sharing a buffer would splice the two together.
  const thinkingBufferRef = useRef<{ messageId: string; text: string } | null>(null);
  const thinkingFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // #bg multi-turn (background persistence): a single resident run can now span the launch turn
  // plus follow-up turns the SDK auto-runs when a background task reports back. `curAsstIdRef` is
  // the assistant bubble live events fill (updated per turn so a follow-up turn gets its own
  // bubble); `sawResultRef` marks that this run already produced a result (so the next init is a
  // follow-up); `turnActiveRef` distinguishes a background notification (arrives while idle) from
  // a foreground subagent's (mid-turn).
  const curAsstIdRef = useRef<string | null>(null);
  const sawResultRef = useRef(false);
  const turnActiveRef = useRef(false);
  const bgSeqRef = useRef(0);

  // Flush buffer to state (batched text delta → shared reducer)
  const flushStreamBuffer = useCallback(() => {
    const buffer = streamBufferRef.current;
    if (buffer && buffer.text) {
      const { messageId, text } = buffer;
      setMessages((prev) =>
        applyStreamEvent(
          prev,
          { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } },
          { engine, assistantId: messageId }
        )
      );
      streamBufferRef.current = { messageId, text: '' };
    }
    streamFlushTimerRef.current = null;
  }, [setMessages, engine]);

  const flushThinkingBuffer = useCallback(() => {
    const buffer = thinkingBufferRef.current;
    if (buffer && buffer.text) {
      const { messageId, text } = buffer;
      setMessages((prev) => {
        // Append to the target bubble if it exists; a thinking delta can arrive
        // before the assistant bubble has been created, in which case it is dropped
        // rather than conjuring a bubble with no answer in it.
        const idx = prev.findIndex((m) => m.id === messageId);
        if (idx === -1) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx]!, thinking: (next[idx]!.thinking ?? '') + text };
        return next;
      });
      thinkingBufferRef.current = { messageId, text: '' };
    }
    thinkingFlushTimerRef.current = null;
  }, [setMessages]);

  // End the originator's view of the current run (turn finished / stopped / failed).
  const endRun = useCallback(() => {
    if (thinkingFlushTimerRef.current) {
      clearTimeout(thinkingFlushTimerRef.current);
      thinkingFlushTimerRef.current = null;
      flushThinkingBuffer();
    }
    if (streamFlushTimerRef.current) {
      clearTimeout(streamFlushTimerRef.current);
      streamFlushTimerRef.current = null;
    }
    if (wsWatchdogRef.current) {
      clearTimeout(wsWatchdogRef.current);
      wsWatchdogRef.current = null;
    }
    flushStreamBuffer();
    setIsLoading(false);
    const ar = activeRunRef.current;
    const curId = curAsstIdRef.current;
    if (ar) {
      setMessages((prev) =>
        prev.map((m) => (m.id === ar.assistantId || m.id === curId ? { ...m, isStreaming: false } : m))
      );
    }
    setActiveRun(null);
    // Converge the just-finished run's live bubbles to canonical persisted UUIDs (incremental +
    // fingerprint-guarded on the callee, so a no-op when disk is unchanged / the viewer already
    // reconciled). This closes the ephemeral-id lifecycle within the run and keeps in-session
    // state identical to a page reload.
    onRunCompleteRef.current?.();
  }, [flushStreamBuffer, flushThinkingBuffer, setMessages]);

  // Stop generation: the run is detached server-side, so closing a socket won't stop it —
  // hit the explicit stop endpoint. Send both keys (sessionId once known, else runId).
  const handleStop = useCallback((): Promise<void> => {
    const ar = activeRunRef.current;
    // The POST is RETURNED, not just fired: a caller that has to act after the
    // run is actually stopped (the selection popup, which then deletes the
    // session) cannot get that ordering from a fire-and-forget call — two
    // un-awaited fetches can reach the server in either order. Local UI state is
    // still torn down synchronously below, so nothing waits on the network to
    // look stopped.
    const posted = fetch('/api/chat/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionIdRef.current, runId: ar?.runKey }),
    }).then(
      () => undefined,
      () => undefined,
    );
    endRun();
    return posted;
  }, [endRun]);

  // SSE event handling
  const handleStreamEvent = useCallback((event: Record<string, unknown>, messageId: string) => {
    const eventType = event.type as string;

    // Phase 2 (M2): a paused turn's tool-approval prompt. Re-dispatch as a DOM
    // event so the self-contained <ToolApprovalPrompt> can render the prompt and
    // POST the decision, without threading approval state through this reducer.
    // Phase 3 (P3-M5): a paused CHECK-IN takes the same route to <CheckinPrompt>.
    // Both are transient prompts rather than chat history, so neither belongs in
    // the message reducer.
    if (
      eventType === 'approval_request' ||
      eventType === 'approval_resolved' ||
      eventType === 'checkin_request' ||
      eventType === 'checkin_resolved'
    ) {
      window.dispatchEvent(new CustomEvent(`naby:${eventType}`, { detail: event }));
      return;
    }

    // Handle session_id + turn boundary. Each turn (including a follow-up turn the SDK auto-runs
    // after a background task completes) starts with a system.init.
    if (eventType === 'system' && event.subtype === 'init') {
      const newSessionId = event.session_id as string;
      onSessionId(newSessionId);
      sessionIdRef.current = newSessionId;
      // The resolved model label the server put on the init event. Surface it so
      // the status indicator can show the actual model answering this turn.
      const initModel = event.model;
      if (typeof initModel === 'string' && initModel) onEngineModelRef.current?.(initModel);
      // WHO is answering, from the same event. Reported on EVERY init, including
      // when it is absent (→ null): a turn that switched to an engine with no agent
      // identity must fall back to the engine brand rather than keep naming the
      // agent from the previous turn.
      onActingAgentRef.current?.(actingAgentFromInit(event));
      setApiRetryInfo(null); // successful init means any prior retry chain resolved
      // #bg: a turn that starts AFTER this run already produced a result is a follow-up (e.g. the
      // auto-run when a background task reports back) → give it its own assistant bubble instead
      // of merging into the launcher's.
      if (sawResultRef.current) {
        const autoId = `auto-asst-${++bgSeqRef.current}`;
        curAsstIdRef.current = autoId;
        setMessages((prev) => [
          ...prev,
          { id: autoId, role: 'assistant', content: '', toolCalls: [], isStreaming: true, runKey: activeRunRef.current?.runKey } as ChatMessage,
        ]);
      }
      turnActiveRef.current = true;
      return;
    }

    // #bg: a background task reporting back while idle (after a result, before the next turn) →
    // render a muted system-event bar live, matching the disk-reload view. A notification during
    // an active turn is a foreground subagent (already shown as its tool call) → skip.
    if (eventType === 'system' && event.subtype === 'task_notification') {
      if (!turnActiveRef.current) {
        const status = event.status as 'completed' | 'failed' | 'stopped' | undefined;
        const summary = (event.summary as string) || '';
        const taskId = event.task_id as string | undefined;
        const detail =
          `<task-notification>\n` +
          (taskId ? `<task-id>${taskId}</task-id>\n` : '') +
          (status ? `<status>${status}</status>\n` : '') +
          (summary ? `<summary>${summary}</summary>\n` : '') +
          (event.output_file ? `<output-file>${event.output_file as string}</output-file>\n` : '') +
          `</task-notification>`;
        const id = `auto-tasknotif-${taskId || ++bgSeqRef.current}`;
        setMessages((prev) => [
          ...prev,
          {
            id,
            role: 'system',
            content: summary,
            systemEvent: { kind: 'task-notification', ...(status ? { status } : {}), detail },
            runKey: activeRunRef.current?.runKey,
          } as ChatMessage,
        ]);
      }
      return;
    }

    // Backend harness activity (naby engine): background task lifecycle, context
    // compaction, injected hook output. Routed through the shared reducer so the
    // originator renders the SAME muted one-line bar the viewer (useLiveStream) does.
    // Needed explicitly here because this handler only dispatches to applyStreamEvent for
    // assistant/user/result — an unmatched `system` subtype would otherwise fall through
    // every branch and be dropped, which is the silence this whole change is undoing.
    if (eventType === 'system' && event.subtype === 'harness') {
      setMessages((prev) => applyStreamEvent(prev, event as unknown as StreamEvent, { engine, assistantId: messageId }));
      return;
    }

    // Handle SDK api_retry event (e.g. transient 401/5xx). Show in loading bubble.
    if (eventType === 'system' && event.subtype === 'api_retry') {
      setApiRetryInfo({
        attempt: (event.attempt as number) ?? 0,
        maxRetries: (event.max_retries as number) ?? 0,
        delayMs: (event.retry_delay_ms as number) ?? 0,
        errorStatus: event.error_status as number | undefined,
        error: event.error as string | undefined,
      });
      return;
    }

    // Handle rate limit event (claude.ai subscription users only)
    if (eventType === 'rate_limit_event') {
      const info = event.rate_limit_info as Record<string, unknown> | undefined;
      if (info) {
        setRateLimitInfo({
          status: (info.status as RateLimitInfo['status']) || 'allowed',
          resetsAt: info.resetsAt as number | undefined,
          rateLimitType: info.rateLimitType as string | undefined,
          utilization: info.utilization as number | undefined,
          overageStatus: info.overageStatus as string | undefined,
          overageDisabledReason: info.overageDisabledReason as string | undefined,
          isUsingOverage: info.isUsingOverage as boolean | undefined,
          surpassedThreshold: info.surpassedThreshold as number | undefined,
        });
      }
      return;
    }

    // Handle in-stream error events ({type:'error', error}) emitted by the
    // codex/kimi/ollama/deepseek routes. Without this branch they are silently
    // dropped and the turn ends as an empty bubble.
    if (eventType === 'error') {
      const errText = (event.error as string) || i18n.t('chat.errorRetry', { defaultValue: 'An error occurred. Please try again.' });
      setApiRetryInfo(null);
      // OUT OF THE TRANSCRIPT AS WELL AS INTO IT. The bubble copy below is the
      // in-turn rendering and is correct while the turn is on screen, but it
      // cannot survive `onRunComplete → reconcile` — the error is not on disk
      // and re-syncing to disk removes it. This report is the copy that lasts.
      onRunErrorRef.current?.(errText);
      // Flush any buffered text first so the error appears after streamed content.
      if (streamFlushTimerRef.current) {
        clearTimeout(streamFlushTimerRef.current);
        streamFlushTimerRef.current = null;
      }
      flushStreamBuffer();
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === messageId
            ? {
                // Through `withAssistantText` so the notice joins the turn's
                // ORDER as well as its text — after a tool batch it is its own
                // bubble, not a tail on prose from before the tools.
                ...withAssistantText(msg, msg.content ? `\n\n⚠️ ${errText}` : `⚠️ ${errText}`),
                isStreaming: false,
              }
            : msg
        )
      );
      return;
    }

    // The model's reasoning. Appended to the CURRENT assistant bubble's own
    // `thinking` field, so it renders in a collapsed block beside the answer and
    // never inside it — reasoning presented as the reply would be worse than not
    // showing it at all. Throttled the same way text is: thinking arrives token by
    // token and a setState per token would thrash the list.
    if (eventType === 'thinking') {
      const text = typeof event.text === 'string' ? event.text : '';
      if (!text) return;
      if (!thinkingBufferRef.current || thinkingBufferRef.current.messageId !== messageId) {
        thinkingBufferRef.current = { messageId, text };
      } else {
        thinkingBufferRef.current.text += text;
      }
      if (!thinkingFlushTimerRef.current) {
        thinkingFlushTimerRef.current = setTimeout(flushThinkingBuffer, 120);
      }
      return;
    }

    // Handle streaming text chunk (typewriter effect) - use buffer throttle
    if (eventType === 'stream_event') {
      // Any actual stream content means the retry state (if any) has cleared
      setApiRetryInfo(prev => prev ? null : prev);
      const streamEvent = event.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
      if (streamEvent?.type === 'content_block_delta' && streamEvent.delta?.type === 'text_delta') {
        const deltaText = streamEvent.delta.text || '';

        // Accumulate to buffer
        if (!streamBufferRef.current || streamBufferRef.current.messageId !== messageId) {
          streamBufferRef.current = { messageId, text: deltaText };
        } else {
          streamBufferRef.current.text += deltaText;
        }

        // Throttle: flush every 50ms
        if (!streamFlushTimerRef.current) {
          streamFlushTimerRef.current = setTimeout(flushStreamBuffer, 50);
        }
      }
      return;
    }

    // Handle text content (complete message)
    // Complete assistant message (codex/kimi/ollama/synthetic text + tool_use blocks)
    if (eventType === 'assistant') {
      setMessages((prev) => applyStreamEvent(prev, event as unknown as StreamEvent, { engine, assistantId: messageId }));
    }

    // Tool result (user turn) → merge into the matching toolCall
    if (eventType === 'user') {
      setMessages((prev) => applyStreamEvent(prev, event as unknown as StreamEvent, { engine, assistantId: messageId }));
    }

    // Handle final result
    if (eventType === 'result') {
      // #bg: a result ends the active turn — after it a task_notification is a background one, and
      // the next init is a follow-up turn that needs its own bubble.
      turnActiveRef.current = false;
      sawResultRef.current = true;
      // Stream ended → drop any retry indicator
      setApiRetryInfo(null);
      // Stream ended, flush buffer immediately
      if (streamFlushTimerRef.current) {
        clearTimeout(streamFlushTimerRef.current);
        streamFlushTimerRef.current = null;
      }
      flushStreamBuffer();

      // After first message in new session completes, fetch title
      const currentSessionId = sessionIdRef.current;
      if (currentSessionId && cwd) {
        setMessages((prev) => {
          if (prev.length === 2) {
            onFetchTitle(currentSessionId);
          }
          return prev;
        });
      }

      // Capture token usage info
      const usage = event.usage as { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | undefined;
      const totalCostUsd = event.total_cost_usd as number | undefined;

      // The WINDOW gauge's fields (session-context-management §2.1). They ride
      // the same result event but are NOT part of `usage` — see the TokenUsage
      // doc: one is a per-turn total, the other a single step's prompt size, and
      // conflating them is the bug this feature exists to fix. Absent stays
      // absent; each absence selects a different branch in contextGauge.
      const contextTokens = event.context_tokens as number | undefined;
      const contextWindow = event.context_window as number | undefined;
      // The model that actually answered, so the gauge can estimate a denominator
      // by family when the registry knew no exact one.
      const contextModel = event.context_model as string | undefined;

      if (usage) {
        setTokenUsage({
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
          cacheCreationInputTokens: usage.cache_creation_input_tokens || 0,
          cacheReadInputTokens: usage.cache_read_input_tokens || 0,
          totalCostUsd: totalCostUsd || 0,
          ...(typeof contextTokens === 'number' ? { contextTokens } : {}),
          ...(typeof contextWindow === 'number' ? { contextWindow } : {}),
          ...(typeof contextModel === 'string' && contextModel ? { contextModel } : {}),
        });
      }

      // Fallback: if the bubble is still empty when the turn ends, surface whatever text the
      // result event carries (result.result). Covers synthetic errors that never streamed deltas
      // — note these arrive as subtype:'success'/is_error:false, so we can't gate on the error flag —
      // and result-only turns with no assistant message at all. Without this it renders as an empty bubble.
      // Finalize the assistant bubble (resultText fallback + isStreaming off + toolCalls done)
      setMessages((prev) => applyStreamEvent(prev, event as unknown as StreamEvent, { engine, assistantId: messageId }));
    }
  }, [setMessages, flushStreamBuffer, onSessionId, onFetchTitle, cwd, engine]);

  // #10 ws-converge: tail the active detached run over /ws/session-stream and feed every
  // event through the SAME handleStreamEvent the SSE path used — so token usage, title,
  // retry indicators, deltas, tools, result and errors are all reused unchanged.
  // At most one socket per hook (enabled only while a run is active).
  useWebSocket({
    url: activeRun
      ? `/ws/session-stream?sessionId=${encodeURIComponent(activeRun.runKey)}`
      : '/ws/session-stream',
    enabled: !!activeRun,
    onMessage: (data) => {
      // Any message (snapshot / event / ping) proves the socket connected → cancel the watchdog.
      wsAliveRef.current = true;
      if (wsWatchdogRef.current) {
        clearTimeout(wsWatchdogRef.current);
        wsWatchdogRef.current = null;
      }
      const ar = activeRunRef.current;
      if (!ar) return;
      const msg = data as {
        type?: string;
        status?: string;
        events?: unknown[];
        message?: Record<string, unknown>;
      };
      if (msg.type === 'run-snapshot' && Array.isArray(msg.events)) {
        // A snapshot is an authoritative replay of the ENTIRE in-flight turn. On a mid-turn
        // ws reconnect (HMR / network blip / server restart) the server re-sends the whole
        // turn, so reset this assistant bubble before replaying — handleStreamEvent APPENDS
        // text, and replaying onto an already-populated bubble would duplicate it. Also drop
        // any buffered delta that belongs to the pre-reconnect content.
        if (streamFlushTimerRef.current) {
          clearTimeout(streamFlushTimerRef.current);
          streamFlushTimerRef.current = null;
        }
        streamBufferRef.current = null;
        // #bg: reset per-run turn tracking and drop any live-created follow-up bubbles / event
        // bars (id `auto-*`) so this authoritative replay rebuilds them cleanly. Scope the drop
        // to THIS run's own bubbles (runKey === ar.runKey): the snapshot replays only the current
        // run's turns, so wiping a PRIOR run's `auto-*` bubbles here would delete continuation
        // bubbles the replay never rebuilds — they'd vanish until a page reload restored them.
        curAsstIdRef.current = ar.assistantId;
        sawResultRef.current = false;
        turnActiveRef.current = false;
        setMessages((prev) =>
          prev
            .filter((m) => !(typeof m.id === 'string' && m.id.startsWith('auto-') && m.runKey === ar.runKey))
            // `subagents` is reset with the calls it labels: the snapshot is the
            // whole run (the hub buffers every event, uncapped), so the replay
            // rebuilds each delegated run's block from its own lifecycle events
            // rather than leaving a half-updated one behind.
            // `segments` is reset with the content and calls it orders: the
            // replay rebuilds the turn's sequence from scratch, and a leftover
            // skeleton would place the replayed text against tool ids that are
            // being re-added behind it.
            .map((m) =>
              m.id === ar.assistantId
                ? { ...m, content: '', toolCalls: [], subagents: [], segments: [] }
                : m
            )
        );
        for (const ev of msg.events) handleStreamEvent(ev as Record<string, unknown>, curAsstIdRef.current ?? ar.assistantId);
        // Run already finished before we connected (status idle/error in the snapshot).
        if (msg.status && msg.status !== 'running') endRun();
      } else if (msg.type === 'run-event' && msg.message) {
        // 'run-ended' is the single definitive end signal (engines may emit several
        // intermediate 'result's — codex = one per turn — so we must NOT end on result).
        if (msg.message.type === 'run-ended') { endRun(); return; }
        handleStreamEvent(msg.message, curAsstIdRef.current ?? ar.assistantId);
      } else if (msg.type === 'run-idle') {
        endRun();
      }
      // 'ping': ignore
    },
  });

  // Send message
  const handleSend = useCallback(
    async (
      content: string,
      images?: ImageInfo[],
      overrides?: { permissionMode?: 'plan' | null }
    ) => {
      // Per-send permission override. `overrides` is an ARGUMENT (not closure state),
      // so it is always current — unlike `planMode`, which a same-tick setPlanMode(false)
      // does not yet reflect (React state is async). The plan-card "approve & run" button
      // relies on this to force a non-plan resend in the same event that turns the toggle
      // off. When no override is passed, fall back to the live planMode toggle.
      const usePlanMode =
        overrides && 'permissionMode' in overrides
          ? overrides.permissionMode === 'plan'
          : planMode;
      // Convert image format
      const messageImages: MessageImage[] | undefined = images?.map((img) => ({
        type: 'base64' as const,
        media_type: img.media_type,
        data: img.data,
      }));

      // Add user message
      const userMessage: ChatMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content,
        images: messageImages,
      };
      setMessages((prev) => [...prev, userMessage]);
      setIsLoading(true);
      // Fresh send: clear a stale retry notice from a previous turn
      setApiRetryInfo(null);
      // …and the previous run's failure notice. A new question supersedes the
      // one that failed, and every send path (composer, plan-card resend,
      // ChatContext injection) reaches this line — which is why the rule lives
      // here rather than in each caller.
      onRunErrorRef.current?.(null);

      // Create assistant message placeholder
      const assistantMessageId = `assistant-${Date.now()}`;
      const assistantMessage: ChatMessage = {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        toolCalls: [],
        isStreaming: true,
      };
      setMessages((prev) => [...prev, assistantMessage]);
      // #bg: bind live rendering to this launching bubble and reset per-run turn tracking.
      curAsstIdRef.current = assistantMessageId;
      sawResultRef.current = false;
      turnActiveRef.current = false;

      const runId = genRunId();

      try {
        // Naby is single-engine: every run posts to /api/chat (the Naby engine).
        const apiUrl = '/api/chat';
        // POST only STARTS the detached run and returns its runKey — no SSE body to read.
        // The ws consumer (above) tails /ws/session-stream and drives the UI from here.
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: content,
            sessionId: sessionIdRef.current,
            runId,
            images: messageImages,
            cwd,
            language: i18n.language,
            // The bottom-bar ModelSwitcher's pick for the active engine, read
            // fresh here. Empty/undefined → omit so the engine's own default
            // answers (DispatchParams.model → requestedModel on the server).
            ...(() => {
              const m = getModelRef.current?.();
              return m ? { model: m } : {};
            })(),
            // Plan mode. Sent for EVERY engine now: it used to be gated on the
            // claude engine, which meant the checkbox was visible on the Naby
            // engine — the only one this app actually runs — and did nothing.
            // The Naby engine now honours it by withholding the writing tools
            // and forcing the read-only gate floor.
            ...(usePlanMode && { permissionMode: 'plan' }),
          }),
        });

        if (!response.ok) {
          throw new Error(i18n.t('chat.requestFailed', { defaultValue: 'Request failed' }));
        }

        const startBody = (await response.json().catch(() => ({}))) as { runKey?: string };
        // Hand off to the ws consumer; it ends the run on result / run-idle.
        setActiveRun({ runKey: startBody.runKey || runId, assistantId: assistantMessageId });
        // Arm the connection watchdog: if /ws/session-stream never delivers a message (it sends
        // a snapshot immediately on connect), the socket failed to connect → unstick the turn.
        wsAliveRef.current = false;
        if (wsWatchdogRef.current) clearTimeout(wsWatchdogRef.current);
        wsWatchdogRef.current = setTimeout(() => {
          if (activeRunRef.current && !wsAliveRef.current) {
            onRunErrorRef.current?.(
              i18n.t('chat.errorRetry', { defaultValue: 'An error occurred. Please try again.' })
            );
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMessageId && !m.content
                  ? withAssistantText(m, i18n.t('chat.errorRetry', { defaultValue: 'An error occurred. Please try again.' }))
                  : m
              )
            );
            endRun();
          }
        }, 15000);
      } catch (error) {
        // POST failed to even start the run → surface in the bubble and end the turn.
        // (Once the run has started, completion/stop/errors all arrive over the ws stream.)
        console.error('Chat error:', error);
        const errorMsg = error instanceof Error ? error.message : i18n.t('chat.errorRetry', { defaultValue: 'An error occurred. Please try again.' });
        onRunErrorRef.current?.(errorMsg);
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMessageId
              ? { ...withAssistantText(msg, errorMsg), isStreaming: false }
              : msg
          )
        );
        setIsLoading(false);
        setActiveRun(null);
      }
    },
    [cwd, engine, planMode, setMessages, endRun]
  );

  return {
    isLoading,
    tokenUsage,
    rateLimitInfo,
    apiRetryInfo,
    handleSend,
    handleStop,
    abortControllerRef,
  };
}
