'use client';

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { ClipboardList } from 'lucide-react';
import { toast } from '@cockpit/shared-ui';
import { useLiveStream } from './useLiveStream';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import {
  querySessionByPath,
  forkSession,
} from './effect/agentClient';
import { publishTopic } from '@cockpit/effect-react';
import { Topics } from '@cockpit/effect-services';
import { ChatHeader } from './ChatHeader';
import { TokenUsageBar } from './TokenUsageBar';
import { UserMessagesModal } from './UserMessagesModal';
import { useChatContextOptional } from './ChatContext';
import { useChatHistory } from './useChatHistory';
import { useChatStream } from './useChatStream';
import { MessageList, MessageListHandle } from './MessageList';
import { ChatInput } from './ChatInput';
import type { ChatMessage, TokenUsage, ImageInfo, ChatEngine, DeepseekModel, ToolCallInfo } from './types';
// In-package siblings (chat-only)
import { ProjectSessionsModal } from './ProjectSessionsModal';
import { ClaudeLoginStatus } from './ClaudeLoginStatus';
import { OllamaModelPicker } from './OllamaModelPicker';
import { DeepseekConfigPicker } from './DeepseekConfigPicker';
import { useTranslation } from 'react-i18next';

// Migrated from src/components/project/Chat.tsx.

interface ChatProps {
  tabId?: string; // Tab ID, used to register with ChatContext
  initialCwd?: string;
  initialSessionId?: string;
  engine?: ChatEngine;
  ollamaModel?: string;
  onOllamaModelChange?: (model: string) => void;
  deepseekModel?: DeepseekModel;
  onDeepseekModelChange?: (model: DeepseekModel) => void;
  planMode?: boolean;
  onPlanModeChange?: (planMode: boolean) => void;
  hideHeader?: boolean;
  hideSidebar?: boolean;
  isActive?: boolean; // Whether the tab is active (used to handle scroll issues for hidden tabs)
  // Forced history refresh: the host bumps `nonce` when the user explicitly jumps to
  // `sessionId` (scheduled-tasks panel / recent / pinned sessions). Needed because jumping
  // to a tab that is ALREADY active produces no isActive rising edge, so messages appended
  // externally (e.g. a scheduled-task run) would otherwise never be fetched.
  refreshSignal?: { sessionId: string; nonce: number } | null;
  onLoadingChange?: (isLoading: boolean) => void;
  onSessionIdChange?: (sessionId: string) => void;
  onTitleChange?: (title: string) => void;
  onOpenNote?: () => void;
  onCreateScheduledTask?: (params: {
    cwd: string;
    tabId: string;
    sessionId: string;
    engine?: string;
    model?: string;
    message: string;
    type: 'once' | 'interval' | 'cron';
    delayMinutes?: number;
    intervalMinutes?: number;
    activeFrom?: string;
    activeTo?: string;
    cron?: string;
  }) => void;
  onOpenSession?: (sessionId: string, title?: string) => void; // Open a new session (used for Fork)
  onOpenSessionBrowser?: () => void; // Host-handled: open the cross-engine session browser
  onOpenSettings?: () => void; // Host-handled: open the app settings modal
}

export function Chat({ tabId, initialCwd, initialSessionId, engine, ollamaModel, onOllamaModelChange, deepseekModel, onDeepseekModelChange, planMode: planModeProp, onPlanModeChange, hideHeader, hideSidebar, isActive = true, refreshSignal, onLoadingChange, onSessionIdChange, onTitleChange, onOpenNote, onCreateScheduledTask, onOpenSession, onOpenSessionBrowser, onOpenSettings }: ChatProps) {
  const { t } = useTranslation();
  const chatContext = useChatContextOptional();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [isProjectSessionsOpen, setIsProjectSessionsOpen] = useState(false);
  const [isUserMessagesOpen, setIsUserMessagesOpen] = useState(false);
  const [historyTokenUsage, setHistoryTokenUsage] = useState<TokenUsage | null>(null);
  // The engine's RESOLVED model, captured live from each turn's system/init
  // (server already ships it as event.model). Null until the first init of the
  // session arrives; the status line falls back to the static engineLabel until
  // then. Read-only display only.
  const [liveModel, setLiveModel] = useState<string | null>(null);
  // Plan mode (per-tab): controlled by TabInfo.planMode (persisted); falls back to
  // local state when no prop (standalone use). Read-only exploration that produces a
  // plan without editing — only meaningful on a claude engine.
  const [localPlanMode, setLocalPlanMode] = useState(false);
  const planMode = planModeProp ?? localPlanMode;
  const setPlanMode = useCallback((p: boolean) => {
    setLocalPlanMode(p);
    onPlanModeChange?.(p);
  }, [onPlanModeChange]);
  const isClaudeEngine = !engine || engine === 'claude' || engine === 'claude2';
  // Read-only engine identity for the status line, used as the FALLBACK before a
  // turn has started. Derived from what the client already knows (the `engine`
  // prop + the per-engine model the pickers own). Once a turn begins, the
  // server's `system/init` carries the RESOLVED model label as `event.model`,
  // which useChatStream now captures into `liveModel` and the status line
  // displays in preference to this static string.
  const engineLabel = useMemo(() => {
    switch (engine) {
      case 'claude2': return 'Claude Agent SDK (claude2)';
      case 'codex': return 'Codex';
      case 'kimi': return 'Kimi';
      case 'ollama': return ollamaModel ? `Ollama · ${ollamaModel.replace(/:latest$/, '')}` : 'Ollama';
      case 'deepseek': return deepseekModel ? `DeepSeek · ${deepseekModel}` : 'DeepSeek';
      default: return 'Claude Agent SDK';
    }
  }, [engine, ollamaModel, deepseekModel]);
  const messageListRef = useRef<MessageListHandle>(null);
  const handleSendRef = useRef<((message: string) => void) | null>(null);

  // Fetch session title
  const fetchSessionTitle = useCallback(async (sid: string) => {
    if (!initialCwd) return;
    const exit = await BrowserRuntime.runPromiseExit(
      querySessionByPath({ cwd: initialCwd, sessionId: sid })
    );
    if (exit._tag === 'Success' && exit.value && typeof exit.value.title === 'string') {
      onTitleChange?.(exit.value.title);
    } else if (exit._tag === 'Failure') {
      console.error('Failed to fetch session title:', exit.cause);
    }
  }, [initialCwd, onTitleChange]);

  // Reconcile-on-run-end: useChatStream is constructed before useChatHistory / liveSessionId
  // exist, so the actual disk-reload closure is injected into this ref below (effect) and
  // invoked via a stable thunk. Lets the originator converge its live bubbles to canonical
  // UUIDs when a run ends — symmetric with the viewer's onComplete reconcile.
  const reconcileFromDiskRef = useRef<(() => void) | null>(null);

  // Stream hook
  const {
    isLoading,
    tokenUsage: streamTokenUsage,
    rateLimitInfo,
    apiRetryInfo,
    handleSend,
    handleStop,
  } = useChatStream(messages, setMessages, {
    sessionId,
    cwd: initialCwd,
    engine,
    planMode,
    ollamaModel,
    deepseekModel,
    onSessionId: setSessionId,
    onFetchTitle: fetchSessionTitle,
    onRunComplete: () => reconcileFromDiskRef.current?.(),
    onEngineModel: setLiveModel,
  });

  // ! prefix: first line is command, subsequent lines are user notes, supports images
  const wrappedHandleSend = useCallback(async (content: string, images?: ImageInfo[]) => {
    const firstLine = content.split('\n')[0];

    // /plan [task] — client-side plan-mode control (mirrors Claude Code's /plan).
    // Consumed locally; never sent to the agent as literal text. Only meaningful on a
    // claude engine (where the plan checkbox lives).
    //   /plan        → enable plan mode (no send)
    //   /plan off    → disable plan mode (no send; cockpit convenience — Claude Code uses Shift+Tab)
    //   /plan <task> → enable plan mode AND send <task> (runs in plan mode)
    if (isClaudeEngine) {
      const planCmd = /^\/plan(?:\s+([\s\S]*))?$/.exec(content.trim());
      if (planCmd) {
        const rest = (planCmd[1] ?? '').trim();
        if (rest.toLowerCase() === 'off') {
          setPlanMode(false);
          toast(t('chat.planModeOff', { defaultValue: 'Plan mode off' }), 'info');
        } else if (rest === '') {
          setPlanMode(true);
          toast(t('chat.planModeOn', { defaultValue: 'Plan mode on' }), 'success');
        } else {
          setPlanMode(true);
          // Explicit override: setPlanMode(true) above won't be reflected in handleSend's
          // closure this tick (React state is async), so force plan mode for this send.
          handleSend(rest, images, { permissionMode: 'plan' });
        }
        return;
      }
    }

    handleSend(content, images);
  }, [handleSend, initialCwd, t, isClaudeEngine, setPlanMode]);

  // Plan-card "approve & run": the user's approval for the presented plan. Persistent off —
  // the Plan toggle visibly turns off and stays off for subsequent turns (mirrors native
  // Claude Code's ExitPlanMode, and the documented "uncheck and resend" flow). The override
  // forces a non-plan execution THIS turn regardless of the async toggle update.
  const handleApprovePlan = useCallback(() => {
    setPlanMode(false);
    handleSend(
      t('chat.approvePlanPrompt', { defaultValue: '已批准，按上述计划开始执行。' }),
      undefined,
      { permissionMode: null }
    );
  }, [handleSend, setPlanMode, t]);

  // History hook
  // #10: whether useLiveStream is actively rendering a live run for this tab. Declared
  // before useChatHistory so the initial history load can DEFER to the live stream — a viewer
  // that joins mid-run (auto-created tab for a new session) must not also disk-load the
  // in-flight turn, or it renders twice.
  const [liveRunning, setLiveRunning] = useState(false);
  const liveRunningRef = useRef(false);
  useEffect(() => { liveRunningRef.current = liveRunning; }, [liveRunning]);

  const {
    isLoadingHistory,
    isLoadingMore,
    hasMoreHistory,
    loadMoreHistory,
    loadHistoryByCwdAndSessionId,
    loadedSessionId,
  } = useChatHistory(messages, setMessages, sessionId, {
    cwd: initialCwd,
    initialSessionId,
    onSessionId: setSessionId,
    onTitleChange,
    onTokenUsage: setHistoryTokenUsage,
    liveRunningRef,
  });

  // #10: live session sync.
  const liveSessionId = loadedSessionId || sessionId;
  // #10: connect the live tail whenever this tab is VIEWING the session (active, not the
  // originator currently sending). The session-stream snapshot's `status` — not the racy
  // global-state broadcast — decides whether a run is live. This is what lets a refreshed
  // originator (or any tab) reliably resume an in-flight run.
  const liveViewerEnabled = isActive && !isLoading && !!liveSessionId;
  useLiveStream(liveSessionId, setMessages, liveViewerEnabled, engine, {
    // Update the ref synchronously (not just via the effect on liveRunning) so the initial
    // history load, resolving moments later, reliably sees that the live stream owns this run.
    onRunningChange: (r) => { liveRunningRef.current = r; setLiveRunning(r); },
    onComplete: () => {
      // Turn finished → reconcile from disk (replaces temp `live-…` bubbles with canonical
      // real-uuid messages).
      if (initialCwd && liveSessionId) loadHistoryByCwdAndSessionId(initialCwd, liveSessionId, true);
    },
  });
  // When not viewing live, clear the running flag.
  useEffect(() => {
    if (!liveViewerEnabled) setLiveRunning(false);
  }, [liveViewerEnabled]);

  // Keep the originator's reconcile-on-run-end closure current (same disk reload the viewer's
  // onComplete uses). Injected into useChatStream via reconcileFromDiskRef so a finished run
  // converges its live bubbles to canonical UUIDs.
  useEffect(() => {
    reconcileFromDiskRef.current = () => {
      if (initialCwd && liveSessionId) loadHistoryByCwdAndSessionId(initialCwd, liveSessionId, true);
    };
  }, [initialCwd, liveSessionId, loadHistoryByCwdAndSessionId]);

  // Incrementally fetch messages when becoming active (handles external writes like scheduled tasks)
  // With limit to fetch only the last N rounds + fingerprint check + time throttle (inside useChatHistory)
  const prevActiveRef = useRef(isActive);
  useEffect(() => {
    // Skip while a live run is in progress — the live stream owns the tail; a lagging
    // disk fetch would momentarily regress it. Reconcile happens on completion instead.
    if (isActive && !prevActiveRef.current && sessionId && initialCwd && !isLoading && !liveRunning) {
      loadHistoryByCwdAndSessionId(initialCwd, sessionId, true, 10);
    }
    prevActiveRef.current = isActive;
  }, [isActive, sessionId, initialCwd, isLoading, liveRunning, loadHistoryByCwdAndSessionId]);

  // Forced refresh on explicit jump (SWITCH_SESSION → scheduled tasks / recent / pinned).
  // The rising-edge fetch above never fires when the target tab is ALREADY active on the
  // agent view — the common case for a scheduled-task session — so the host bumps
  // `refreshSignal` and we fetch unconditionally, bypassing the incremental throttle.
  const refreshNonceRef = useRef(0);
  useEffect(() => {
    if (!refreshSignal || refreshSignal.nonce === refreshNonceRef.current) return;
    // Record the nonce even when this tab doesn't match, so a later unrelated
    // dependency change can't replay a stale signal.
    refreshNonceRef.current = refreshSignal.nonce;
    const sid = sessionId || loadedSessionId;
    if (!initialCwd || !sid) return;
    if (refreshSignal.sessionId !== sessionId && refreshSignal.sessionId !== loadedSessionId) return;
    // A live-streaming or in-flight run owns the tail; onComplete reconciles from disk.
    if (isLoading || liveRunning) return;
    loadHistoryByCwdAndSessionId(initialCwd, sid, true, 10, undefined, true);
  }, [refreshSignal, sessionId, loadedSessionId, initialCwd, isLoading, liveRunning, loadHistoryByCwdAndSessionId]);

  // Merge token usage: stream takes priority, fallback to history
  const tokenUsage = streamTokenUsage || historyTokenUsage;

  // Notify parent when sessionId changes
  useEffect(() => {
    if (sessionId) {
      onSessionIdChange?.(sessionId);
    }
  }, [sessionId, onSessionIdChange]);

  // Notify parent when isLoading changes
  const prevIsLoadingRef = useRef(false);
  useEffect(() => {
    onLoadingChange?.(isLoading);

    // When session completes (loading → not loading), notify parent Workspace to show toast
    if (prevIsLoadingRef.current && !isLoading && initialCwd && sessionId) {
      // Extract the last user message as toast preview
      let lastUserMessage: string | undefined;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user' && messages[i].content) {
          lastUserMessage = messages[i].content.slice(0, 100);
          break;
        }
      }
      publishTopic(Topics.SessionComplete, {
        cwd: initialCwd,
        sessionId,
        lastUserMessage,
      });
    }
    prevIsLoadingRef.current = isLoading;
  }, [isLoading, onLoadingChange, initialCwd]);

  // Sync loading state to ChatContext: only sync for the active tab
  // isActive change on tab switch also triggers this, ensuring the new active tab overrides the old value
  useEffect(() => {
    if (isActive) {
      chatContext?.setIsLoading(isLoading);
    }
  }, [isLoading, isActive, chatContext]);

  // Register with ChatContext (used to send messages from CodeViewer)
  useEffect(() => {
    if (!tabId || !chatContext) return;

    chatContext.registerChat((message: string) => {
      handleSendRef.current?.(message);
    }, tabId);

    return () => {
      chatContext.unregisterChat(tabId);
    };
  }, [tabId, chatContext]);

  // Notify ChatContext when tab becomes active
  useEffect(() => {
    if (tabId && isActive && chatContext) {
      chatContext.setActiveTab(tabId);
    }
  }, [tabId, isActive, chatContext]);

  // Update handleSendRef for ChatContext to call
  useEffect(() => {
    handleSendRef.current = wrappedHandleSend;
  }, [wrappedHandleSend]);

  // ESC key listener: stop generation when hovering the chat area. Tabs are symmetric —
  // works whether THIS tab is the originator (isLoading) or a viewer of a run that's live
  // elsewhere (liveRunning). handleStop hits /api/chat/stop, which aborts the detached run
  // and emits a terminal event so every tab finalizes.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isHovered && (isLoading || liveRunning)) {
        handleStop();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isHovered, isLoading, liveRunning, handleStop]);

  // Fork session from a specified message point.
  //
  // IMPORTANT: route the fork through `loadedSessionId` (the sessionId of
  // the JSONL file the user is currently looking at), NOT through
  // `sessionId` (which the SDK overwrites on every `system.init` event).
  // The bubble id passed in is a uuid taken from the loaded file; using a
  // drifted sessionId would point the server at a different file where
  // that uuid may not exist, causing fork.ts to silently degrade to a
  // full-file copy. Fall back to `sessionId` only when no file has been
  // loaded yet (fresh tab with no history).
  const handleForkImpl = useCallback(async (messageId: string) => {
    const forkSid = loadedSessionId ?? sessionId;
    if (!initialCwd || !forkSid) return;

    const exit = await BrowserRuntime.runPromiseExit(
      forkSession<{ newSessionId?: string }>(forkSid, {
        cwd: initialCwd,
        fromMessageUuid: messageId,
      })
    );
    if (exit._tag === 'Success' && exit.value.newSessionId) {
      const newSessionId = exit.value.newSessionId;
      if (onOpenSession) {
        onOpenSession(newSessionId, 'Fork');
      } else {
        publishTopic(Topics.OpenProject, {
          cwd: initialCwd,
          sessionId: newSessionId,
        });
      }
    } else if (exit._tag === 'Failure') {
      console.error('Fork failed:', exit.cause);
    }
  }, [initialCwd, loadedSessionId, sessionId, onOpenSession]);

  // Stabilize the fork callback passed down to every (memoized) MessageBubble.
  // handleForkImpl's identity changes whenever loadedSessionId / sessionId churn
  // (each of the many re-renders a session switch fans out), which would break
  // MessageBubble's React.memo and re-parse react-markdown for the whole list on
  // every switch. A ref indirection keeps the passed-down identity constant while
  // still calling the latest implementation.
  const handleForkRef = useRef(handleForkImpl);
  handleForkRef.current = handleForkImpl;
  const handleFork = useRef((messageId: string) => handleForkRef.current(messageId)).current;

  // Stabilize ChatInput callback props, combined with React.memo to avoid unnecessary re-renders
  const handleShowUserMessages = useCallback(() => {
    setIsUserMessagesOpen(true);
  }, []);

  const handleCreateScheduledTask = useMemo(() => {
    if (!onCreateScheduledTask || !initialCwd || !tabId || !sessionId) return undefined;
    return (params: { message: string; type: 'once' | 'interval' | 'cron'; delayMinutes?: number; intervalMinutes?: number; activeFrom?: string; activeTo?: string; cron?: string }) => {
      onCreateScheduledTask({
        ...params,
        cwd: initialCwd,
        tabId,
        sessionId,
        engine,
        ...(engine === 'ollama' && ollamaModel && { model: ollamaModel }),
        ...(engine === 'deepseek' && deepseekModel && { model: deepseekModel }),
      });
    };
  }, [onCreateScheduledTask, initialCwd, tabId, sessionId, engine, ollamaModel, deepseekModel]);

  return (
    <div className={`flex ${hideHeader && hideSidebar ? 'h-full' : 'h-screen'} bg-card`}>
      {/* Main Content */}
      <div
        id="chat-screen"
        className="flex-1 flex flex-col min-w-0 relative"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Header - optionally hidden. Session-browser/settings opens are
            delegated to the host (app layer) via callbacks; Chat itself
            does not own those modals. */}
        {!hideHeader && (
          <ChatHeader
            cwd={initialCwd}
            sessionId={sessionId}
            onOpenProjectSessions={() => setIsProjectSessionsOpen(true)}
            onOpenSessionBrowser={onOpenSessionBrowser}
            onOpenSettings={onOpenSettings}
          />
        )}

        {/* Engine status (claude/claude2 only). This slot used to hold an "Execution mode"
            SDK ↔ PTY picker. The PTY option spawned `claude --dangerously-skip-permissions`,
            a second execution path that bypassed the approval gate, so it was removed rather
            than repaired — there is now exactly one path and therefore nothing to pick. What
            remains is READ-ONLY status: which engine is answering. */}
        {isClaudeEngine && (
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-card/50">
            <span
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground select-none"
              data-testid="engine-status"
            >
              {t('chat.engineStatus', { defaultValue: 'Engine' })}
              <span className="text-foreground/70">{liveModel ?? engineLabel}</span>
            </span>
            {/* Whether the local Claude sign-in this engine depends on actually
                exists. Placed immediately after the status because that is where
                the user is looking — and because a logged-out machine otherwise
                fails only at send time, with an error that does not say what to do. */}
            <ClaudeLoginStatus />
            {/* Plan mode: read-only exploration → produces a plan without editing.
                Plan-only — uncheck and resend to actually implement. */}
            <label
              className="flex items-center gap-1.5 ml-2 pl-3 border-l border-border text-xs cursor-pointer select-none"
              title={t('chat.planModeHint', { defaultValue: 'Plan mode: read-only exploration that produces a plan without editing. Uncheck and resend to implement.' })}
            >
              <input
                type="checkbox"
                data-testid="planmode-toggle"
                checked={planMode}
                onChange={(e) => setPlanMode(e.target.checked)}
                className="accent-brand"
              />
              <span className="flex items-center gap-1 text-foreground">
                <ClipboardList className="w-3.5 h-3.5" />
                {t('chat.planMode', { defaultValue: 'Plan mode' })}
              </span>
              <span className="text-muted-foreground">{t('chat.planModeDesc', { defaultValue: 'read-only · plan first, no edits' })}</span>
            </label>
          </div>
        )}

        {/* Ollama model picker */}
        {engine === 'ollama' && onOllamaModelChange && (
          <div className="flex items-center px-3 py-1.5 border-b border-border bg-card/50">
            <OllamaModelPicker currentModel={ollamaModel} onModelChange={onOllamaModelChange} />
          </div>
        )}

        {/* DeepSeek API key + model picker */}
        {engine === 'deepseek' && onDeepseekModelChange && (
          <div className="flex items-center px-3 py-1.5 border-b border-border bg-card/50">
            <DeepseekConfigPicker currentModel={deepseekModel} onModelChange={onDeepseekModelChange} />
          </div>
        )}

        {/* Messages */}
        {isLoadingHistory ? (
          <div className="flex-1 flex items-center justify-center">
            <span className="text-muted-foreground">{t('sessions.loadingHistory')}</span>
          </div>
        ) : (
          <MessageList
            // #10: as a viewer, drive the "thinking" bubble from the live run status too.
            ref={messageListRef}
            messages={messages}
            isLoading={isLoading || liveRunning}
            cwd={initialCwd}
            sessionId={sessionId}
            engine={engine}
            apiRetryInfo={apiRetryInfo}
            hasMoreHistory={hasMoreHistory}
            isLoadingMore={isLoadingMore}
            onLoadMore={loadMoreHistory}
            onFork={handleFork}
            isActive={isActive}
            onApprovePlan={handleApprovePlan}
          />
        )}

        {/* Token Usage Display */}
        {tokenUsage && <TokenUsageBar tokenUsage={tokenUsage} rateLimitInfo={rateLimitInfo} />}

        {/* Input */}
        <ChatInput
          onSend={wrappedHandleSend}
          // #10: disable while THIS tab streams, or while the session is running elsewhere
          // (viewer) — one active run per session; a concurrent send would 409.
          disabled={isLoading || liveRunning}
          cwd={initialCwd}
          engine={engine}
          onShowUserMessages={handleShowUserMessages}
          onOpenNote={onOpenNote}
          onCreateScheduledTask={handleCreateScheduledTask}
        />
      </div>

      {/* Project Sessions Modal — chat-domain modal (per-cwd session list).
          Session-browser (cross-engine) and Settings modals live in the host
          (app layer); Chat just emits onOpenSessionBrowser / onOpenSettings. */}
      {!hideHeader && initialCwd && (
        <ProjectSessionsModal
          isOpen={isProjectSessionsOpen}
          onClose={() => setIsProjectSessionsOpen(false)}
          cwd={initialCwd}
        />
      )}

      {/* User Messages Modal */}
      <UserMessagesModal
        isOpen={isUserMessagesOpen}
        onClose={() => setIsUserMessagesOpen(false)}
        messages={messages}
        onSelectMessage={(messageId) => {
          messageListRef.current?.scrollToMessage(messageId);
        }}
      />
    </div>
  );
}
