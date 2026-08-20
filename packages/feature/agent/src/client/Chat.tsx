'use client';

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { ClipboardList } from 'lucide-react';
import { toast } from '@cockpit/shared-ui';
import { useLiveStream } from './useLiveStream';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { querySessionByPath } from './effect/agentClient';
import { publishTopic } from '@cockpit/effect-react';
import { Topics } from '@cockpit/effect-services';
import { ChatHeader } from './ChatHeader';
import { TokenUsageBar } from './TokenUsageBar';
import { UserMessagesModal } from './UserMessagesModal';
import { useChatContextOptional } from './ChatContext';
import { useChatHistory } from './useChatHistory';
import { useChatStream } from './useChatStream';
import { MessageList, MessageListHandle } from './MessageList';
import { FILE_REF_MIME, insertFileRef, osFilePath, quotePath } from './fileRefBus';
import { ToolApprovalPrompt } from './ToolApprovalPrompt';
import { CheckinPrompt } from './CheckinPrompt';
import { ContextLimitBanner } from './ContextLimitBanner';
import { RunFailureNotice } from './RunFailureNotice';
import { runFailureReducer, type RunFailure, type RunFailureEvent } from './runFailure';
import { contextGauge } from './contextGauge';
import { ChatInput } from './ChatInput';
import type { ComposerViewport } from './composerHeight';
import { buildComposerHistory, sameComposerHistory } from './composerHistory';
import type { ChatMessage, TokenUsage, ImageInfo, ChatEngine, ToolCallInfo } from './types';
// In-package siblings (chat-only)
import { ProjectSessionsModal } from './ProjectSessionsModal';
import { ClaudeLoginStatus } from './ClaudeLoginStatus';
import { ChatgptLoginStatus } from './ChatgptLoginStatus';
import { EngineSwitcher } from './EngineSwitcher';
import { ModelSwitcher } from './ModelSwitcher';
import { modelScopeFor, modelLabel } from './modelCatalog';
import { AllowChangesToggle } from './AllowChangesToggle';
import { deriveEngineName, accountChipForEngine } from './engineName';
import { ASSUMED_ACTING_AGENT, thinkingDisplayName, type ActingAgent } from './actingAgent';
import { SelectionChatPopup, type SelectionChatPopupWiring } from './SelectionChatPopup';
import { attachQuotedContext } from './selectionChatOps';
import { useTranslation } from 'react-i18next';

// Migrated from src/components/project/Chat.tsx.

interface ChatProps {
  tabId?: string; // Tab ID, used to register with ChatContext
  initialCwd?: string;
  initialSessionId?: string;
  engine?: ChatEngine;
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
  /** Host hook to open a session in a new tab. Used by the selection popup's
   *  "promote to session" control — the popup's own session, handed to a real tab. */
  onOpenSession?: (sessionId: string, title?: string) => void;
  /** Host hook to DELETE a session, through the same `closedSessionIds` route a
   *  tab close takes. Used only by the selection popup's discard-on-close. The
   *  Effect that performs it lives in feature-workspace, which feature-agent
   *  must not depend on — hence a callback rather than an import. */
  onDiscardSession?: (sessionId: string) => void;
  onOpenSessionBrowser?: () => void; // Host-handled: open the cross-engine session browser
  onOpenSettings?: () => void; // Host-handled: open the app settings modal
  /**
   * THIS CHAT IS THE THROWAWAY SELECTION POPUP, not a tab.
   *
   * It changes exactly two things, and both are about a registry it must not
   * capture: the popup NEVER marks itself the active tab and never publishes its
   * loading state app-wide. `ChatContext` is a tab-keyed map of senders plus an
   * `activeTabIdRef` with last-writer-wins semantics; anything reaching
   * `chatCtx.sendMessage` (or `useAIBridge`, which is the same value) sends to
   * whichever tab wrote that ref last. A popup that marked itself active would
   * hijack every one of those call sites app-wide — and would keep doing so
   * after it was closed and discarded. It still REGISTERS under its own id,
   * which is harmless: nothing looks a sender up except through the active id.
   *
   * It also suppresses the selection toolbar inside its own transcript: one
   * throwaway conversation at a time, no popups out of popups.
   */
  ephemeral?: boolean;
  /**
   * The selected text this conversation is ABOUT. Quoted into the FIRST send and
   * never again — re-quoting every turn would reproduce, one level down, the
   * exact fault the popup exists to fix. See selectionChatOps.attachQuotedContext.
   */
  quotedContext?: string;
  /**
   * Hands the host a way to stop THIS chat's in-flight run (null on unmount).
   *
   * The run is DETACHED server-side: unmounting the component or closing the
   * socket does not stop it. A popup closed mid-answer must therefore stop the
   * turn explicitly before it deletes the session, or the machine keeps working
   * on a conversation nobody will ever read and the delete races the run.
   *
   * The handed-out function RESOLVES once the stop has reached the server, so
   * the caller can order a delete after it.
   */
  onStopHandle?: (stop: (() => Promise<void>) | null) => void;
  /**
   * THIS CHAT DOES NOT FILL THE WINDOW — here is the box it fills instead.
   *
   * The composer's ceiling is a fraction of the column it shares with the
   * transcript (composerHeight.ts). A chat in a tab fills the window, so the
   * window is that column and this prop is left off; a chat inside the selection
   * popup is a ~320px box, and without this its composer would size itself
   * against a window it is not in and eat the conversation.
   *
   * Passed straight through to ChatInput, and it is a reader plus a change
   * signal rather than a number so the popup can keep its box in a ref — see
   * SelectionChatPopup's header for why that matters.
   */
  composerViewport?: ComposerViewport;
}

export function Chat({ tabId, initialCwd, initialSessionId, engine, planMode: planModeProp, onPlanModeChange, hideHeader, hideSidebar, isActive = true, refreshSignal, onLoadingChange, onSessionIdChange, onTitleChange, onOpenNote, onCreateScheduledTask, onOpenSession, onDiscardSession, onOpenSessionBrowser, onOpenSettings, ephemeral, quotedContext, onStopHandle, composerViewport }: ChatProps) {
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
  // session arrives; until then <EngineSwitcher/> shows the SELECTED engine's
  // label instead. Passed to the switcher, which prefers this once present.
  const [liveModel, setLiveModel] = useState<string | null>(null);
  // Short name of the engine that answers (Claude / GPT / Gemini / ChatGPT / AI).
  // It labels the ENGINE — the toolbar chip — and is now only the FALLBACK for the
  // "… is thinking" bubble, which names the acting agent (see `actingAgent` just
  // below). <EngineSwitcher/> is the single owner of the /api/naby engine read, so
  // it reports the provider-kind-precise name here; when the switcher is not
  // mounted (header hidden / non-claude engine) we fall back to sniffing the
  // live-resolved model, and finally to a generic "AI".
  const [reportedEngineName, setReportedEngineName] = useState<string | null>(null);
  // WHO is answering this turn. Starts as the persona because an unaddressed turn
  // IS the persona's turn (the engine's `growthSubject` falls back to it), so the
  // bubble does not flip name a second into every send; each turn's `system/init`
  // then reports the truth, which differs only for an `@other-agent` turn.
  const [actingAgent, setActingAgent] = useState<ActingAgent | null>(ASSUMED_ACTING_AGENT);
  const handleActingAgent = useCallback((agent: ActingAgent | null) => setActingAgent(agent), []);
  // Stable identity: <EngineSwitcher/> reports on every engine-name change, and a
  // fresh callback each render would re-fire its report effect needlessly.
  const handleEngineName = useCallback((name: string) => setReportedEngineName(name), []);
  // Which account chip the bottom bar shows is decided by the RESOLVED engine,
  // reported by <EngineSwitcher/> (the single owner of the /api/naby read). The
  // two sign-ins never sit side by side — the bar shows the ONE that matches the
  // engine that will answer: Claude for the dev-claude subscription, ChatGPT for
  // the ai-sdk + openai-chatgpt-oauth subscription, and no chip for a plain
  // API-key provider (a key is not an account login). Null until the first read;
  // we default to the Claude chip then (it self-hides when not relevant).
  const [activeEngine, setActiveEngine] = useState<{ engineId: string | null; selectedProvider: string | null } | null>(null);
  const handleActiveEngine = useCallback(
    (active: { engineId: string | null; selectedProvider: string | null }) => setActiveEngine(active),
    [],
  );
  // The model the bottom-bar <ModelSwitcher/> has picked for the active engine.
  // Kept in a ref (read at send time via getModel — no per-send re-render, and the
  // switch-notice effect reads the current label from it too). '' = no override
  // (the engine's own default answers).
  const selectedModelRef = useRef<string>('');
  const handleModelChange = useCallback((model: string) => {
    selectedModelRef.current = model;
  }, []);
  const getModel = useCallback(() => selectedModelRef.current, []);

  // — Mid-conversation switch notice (IDE-style). When the user PICKS a different
  // engine or model while a conversation is underway, drop a muted one-line
  // "Switched · <engine> · <model>" chip into the transcript. Fires only on an
  // explicit user pick (EngineSwitcher/ModelSwitcher call onUserSelect), never on
  // passive state reconciliation, and only once a conversation has started.
  // Debounced because an engine switch updates the engine AND then the model in
  // two ticks — the debounce collapses them into a single notice with final
  // values, read from refs at fire time.
  const switchNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reportedEngineNameRef = useRef<string | null>(reportedEngineName);
  reportedEngineNameRef.current = reportedEngineName;
  const activeEngineRef = useRef(activeEngine);
  activeEngineRef.current = activeEngine;
  const hasMessagesRef = useRef(false);
  hasMessagesRef.current = messages.length > 0;
  const handleUserSwitch = useCallback(() => {
    if (switchNoticeTimerRef.current) clearTimeout(switchNoticeTimerRef.current);
    switchNoticeTimerRef.current = setTimeout(() => {
      switchNoticeTimerRef.current = null;
      if (!hasMessagesRef.current) return; // only mid-conversation
      const engineName = reportedEngineNameRef.current ?? deriveEngineName({ liveModel: null });
      const scope = modelScopeFor(
        activeEngineRef.current?.engineId ?? null,
        activeEngineRef.current?.selectedProvider ?? null,
      );
      const modelLbl = scope ? modelLabel(scope, selectedModelRef.current) : '';
      const target = modelLbl ? `${engineName} · ${modelLbl}` : engineName;
      setMessages((prev) => [
        ...prev,
        {
          id: `notice-${Date.now()}`,
          role: 'system',
          content: t('chat.engineSwitched', { target, defaultValue: `Switched · ${target}` }),
          systemEvent: { kind: 'meta' },
        },
      ]);
    }, 140);
  }, [t, setMessages]);
  useEffect(() => {
    return () => {
      if (switchNoticeTimerRef.current) clearTimeout(switchNoticeTimerRef.current);
    };
  }, []);
  // Which sign-in chip the bottom bar shows, from the resolved engine identity.
  // Pure + unit-tested in engineName.ts so the three engine-name call sites agree.
  const accountChip = accountChipForEngine(
    activeEngine ?? { engineId: null, selectedProvider: null },
  );
  // The engine brand, kept as what it is: the FALLBACK for the thinking bubble,
  // and the only thing shown when a turn has no agent identity at all.
  const engineBrand = useMemo(
    () => reportedEngineName ?? deriveEngineName({ liveModel }),
    [reportedEngineName, liveModel],
  );
  // What the loading bubble says is thinking. The AGENT — ko 나비 / en naby for the
  // built-in persona, an imported agent's own handle when the turn was addressed to
  // one — because the engine brand answers a question the user did not ask and is
  // already on the toolbar. The rule itself lives in actingAgent.ts.
  const thinkingName = useMemo(
    () => thinkingDisplayName({
      acting: actingAgent,
      personaLabel: t('chat.personaName', { defaultValue: 'naby' }),
      engineName: engineBrand,
    }),
    [actingAgent, engineBrand, t],
  );
  // — THE LAST RUN'S FAILURE, HELD OUTSIDE THE TRANSCRIPT ————————————————
  //
  // A turn that fails says so in a `{type:'error'}` stream event, which is
  // rendered into the assistant bubble and then wiped moments later by
  // `onRunComplete → reconcileFromDiskRef` — the re-sync to disk, where an error
  // never gets written (RuntimeMessage has no system role, deliberately). That
  // is the reported "the answer appears and instantly disappears": there was no
  // answer, only an error, erased by the reconcile.
  //
  // So it is kept HERE, as one record about the last run rather than as a
  // message. The reconcile rewrites `messages`; it cannot touch this. The rules
  // for what ends it (the next send, another session, a dismiss — never a
  // reconcile) live in runFailure.ts and are tested there.
  const [runFailure, setRunFailure] = useState<RunFailure | null>(null);
  const dispatchRunFailure = useCallback(
    (ev: RunFailureEvent) => setRunFailure((prev) => runFailureReducer(prev, ev)),
    [],
  );
  // WHO was asked, read at failure time. A ref, not deps: this is a snapshot for
  // one report, and threading engine/model/session through useChatStream's
  // callbacks would churn a stable useCallback on every streamed chunk.
  const failureContextRef = useRef<{ engine: string; model: string; sessionId: string | null }>({
    engine: '',
    model: '',
    sessionId: null,
  });
  // `null` is the SEND edge (useChatStream reports it at the start of every
  // send, the one place every send path passes through); text is a failure.
  const handleRunError = useCallback(
    (message: string | null) => {
      if (message === null) {
        dispatchRunFailure({ type: 'send' });
        return;
      }
      const ctx = failureContextRef.current;
      dispatchRunFailure({
        type: 'run-failed',
        message,
        ...(ctx.engine ? { engine: ctx.engine } : {}),
        ...(ctx.model ? { model: ctx.model } : {}),
        sessionId: ctx.sessionId,
        at: Date.now(),
      });
    },
    [dispatchRunFailure],
  );
  const dismissRunFailure = useCallback(() => dispatchRunFailure({ type: 'dismiss' }), [dispatchRunFailure]);

  // Plan mode (per-tab): controlled by TabInfo.planMode (persisted); falls back to
  // local state when no prop (standalone use). Read-only exploration that produces a
  // plan without editing — only meaningful on a claude engine.
  const [localPlanMode, setLocalPlanMode] = useState(false);
  const planMode = planModeProp ?? localPlanMode;
  const setPlanMode = useCallback((p: boolean) => {
    setLocalPlanMode(p);
    onPlanModeChange?.(p);
  }, [onPlanModeChange]);

  // Dropping files onto the CONVERSATION area inserts their reference into the
  // input (via the active-input channel): OS files (Finder/Explorer) → absolute
  // path; an in-app file-browser row → its cwd-relative path. Unlike the input
  // itself, the messages area never attaches images — a drop here always becomes
  // a path, matching "drop on the conversation → path".
  const handleConversationDragOver = useCallback((e: React.DragEvent) => {
    const types = Array.from(e.dataTransfer?.types ?? []);
    if (types.includes('Files') || types.includes(FILE_REF_MIME)) e.preventDefault();
  }, []);
  const handleConversationDrop = useCallback((e: React.DragEvent) => {
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      const paths: string[] = [];
      for (const f of Array.from(files)) {
        const p = osFilePath(f);
        if (p) paths.push(quotePath(p));
      }
      if (paths.length > 0) insertFileRef(`${paths.join(' ')} `);
      return;
    }
    const ref = e.dataTransfer?.getData(FILE_REF_MIME) ?? '';
    if (ref) {
      e.preventDefault();
      insertFileRef(ref.endsWith(' ') ? ref : `${ref} `);
    }
  }, []);
  const isClaudeEngine = !engine || engine === 'claude';
  // The engine identity for this row is now owned by <EngineSwitcher/>: it reads
  // the same /api/naby the settings modal uses (engine.id + selected provider
  // label) so the header and the settings can never disagree, prefers the
  // RESOLVED `liveModel` once a turn has started, AND makes the label a clickable
  // quick-switch. Chat no longer runs its own /api/naby label effect — one owner
  // for the engine read in this row.
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
    onSessionId: setSessionId,
    onFetchTitle: fetchSessionTitle,
    onRunComplete: () => reconcileFromDiskRef.current?.(),
    onEngineModel: setLiveModel,
    onActingAgent: handleActingAgent,
    onRunError: handleRunError,
    getModel,
  });

  // A SEND RE-PINS THE TRANSCRIPT. Reading history is otherwise sacred — new
  // content never moves a user who has scrolled up — but pressing send states
  // the intent outright ("show me what happens next"), so <MessageList/> jumps
  // to the bottom on every bump of this counter. A counter, not a callback, so
  // two sends in a row both register. Bumped from every path that actually
  // dispatches a turn: the input, the plan card's approve & run, and a message
  // injected through ChatContext.
  const [sendNonce, setSendNonce] = useState(0);
  const bumpSend = useCallback(() => setSendNonce((n) => n + 1), []);

  // THE SELECTION THIS CONVERSATION IS ABOUT, attached to the FIRST dispatched
  // turn and never again. A latch rather than a message count: `/plan` and
  // `/plan off` are consumed locally and dispatch nothing, so counting sends
  // would burn the quote on a turn that never happened.
  const quoteAttachedRef = useRef(false);
  const withQuotedContext = useCallback((content: string) => {
    const out = attachQuotedContext(quotedContext, content, quoteAttachedRef.current);
    if (quotedContext) quoteAttachedRef.current = true;
    return out;
  }, [quotedContext]);

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
          bumpSend();
          handleSend(withQuotedContext(rest), images, { permissionMode: 'plan' });
        }
        // `/plan` and `/plan off` are consumed locally and dispatch NO turn, so
        // they are not sends and must not move the viewport.
        return;
      }
    }

    bumpSend();
    handleSend(withQuotedContext(content), images);
  }, [handleSend, initialCwd, t, isClaudeEngine, setPlanMode, bumpSend, withQuotedContext]);

  // Plan-card "approve & run": the user's approval for the presented plan. Persistent off —
  // the Plan toggle visibly turns off and stays off for subsequent turns (mirrors native
  // Claude Code's ExitPlanMode, and the documented "uncheck and resend" flow). The override
  // forces a non-plan execution THIS turn regardless of the async toggle update.
  const handleApprovePlan = useCallback(() => {
    setPlanMode(false);
    bumpSend();
    handleSend(
      t('chat.approvePlanPrompt', { defaultValue: '已批准，按上述计划开始执行。' }),
      undefined,
      { permissionMode: null }
    );
  }, [handleSend, setPlanMode, t, bumpSend]);

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
  // WHICH SESSION A FAILURE BELONGS TO — resolved here, where `liveSessionId` is,
  // so the record and the "did the session change?" check read the same id.
  // Assigned during render (not in an effect): the callbacks that read it always
  // run after a render, and an effect would leave the first failure of a freshly
  // loaded session tagged with a stale id.
  failureContextRef.current = {
    // The engine brand and the model that ACTUALLY answered (the resolved
    // `liveModel` from this turn's system/init), falling back to the model the
    // user picked. No "Default" placeholder: naming a model we did not resolve
    // would point the user at the wrong settings page.
    engine: engineBrand,
    model: liveModel || selectedModelRef.current || '',
    sessionId: liveSessionId ?? null,
  };
  // Another session is on screen now → the previous one's failure is not about
  // what the user is reading. (Same-session re-reports are a no-op by identity.)
  useEffect(() => {
    dispatchRunFailure({ type: 'session', sessionId: liveSessionId ?? null });
  }, [liveSessionId, dispatchRunFailure]);

  useLiveStream(liveSessionId, setMessages, liveViewerEnabled, engine, {
    // Update the ref synchronously (not just via the effect on liveRunning) so the initial
    // history load, resolving moments later, reliably sees that the live stream owns this run.
    onRunningChange: (r) => { liveRunningRef.current = r; setLiveRunning(r); },
    onComplete: () => {
      // Turn finished → reconcile from disk (replaces temp `live-…` bubbles with canonical
      // real-uuid messages).
      if (initialCwd && liveSessionId) loadHistoryByCwdAndSessionId(initialCwd, liveSessionId, true);
      // …and that reconcile does NOT clear the failure notice. Stated as an
      // event rather than left implicit, so the invariant is executable.
      dispatchRunFailure({ type: 'history-reconciled' });
    },
    // A turn this tab merely WATCHED can fail too (a Telegram message, a
    // scheduled task); it reconciles from disk the same way, so it needs the
    // same out-of-transcript copy.
    onRunError: handleRunError,
  });
  // When not viewing live, clear the running flag.
  useEffect(() => {
    if (!liveViewerEnabled) setLiveRunning(false);
  }, [liveViewerEnabled]);

  // RESEND a past user message, verbatim. Same dispatch as typing it again —
  // through wrappedHandleSend, so a resent "/plan …" is still consumed as the
  // command it was. Stored MessageImage attachments are rehydrated into the
  // composer's ImageInfo shape (id/preview are display-side fields the DB
  // never kept). Guarded on isLoading/liveRunning besides the button's own
  // disabled state — one active run per session; a concurrent send would 409.
  // Declared BELOW liveRunning's useState: the dep array reads it at render.
  const handleResendMessage = useCallback((message: ChatMessage) => {
    if (isLoading || liveRunning) return;
    if (!message.content) return;
    const images: ImageInfo[] | undefined = message.images?.map((img, i) => ({
      id: `resend-${message.id}-${i}`,
      data: img.data,
      preview: `data:${img.media_type};base64,${img.data}`,
      media_type: img.media_type,
    }));
    wrappedHandleSend(message.content, images);
  }, [isLoading, liveRunning, wrappedHandleSend]);

  // Keep the originator's reconcile-on-run-end closure current (same disk reload the viewer's
  // onComplete uses). Injected into useChatStream via reconcileFromDiskRef so a finished run
  // converges its live bubbles to canonical UUIDs.
  useEffect(() => {
    reconcileFromDiskRef.current = () => {
      if (initialCwd && liveSessionId) loadHistoryByCwdAndSessionId(initialCwd, liveSessionId, true);
      // THE LINE THIS WHOLE FIX IS ABOUT. This reconcile is what used to erase
      // the failed turn's error — it rewrites `messages` from disk, and the
      // error is not on disk. The notice lives outside `messages`, and passing
      // the reconcile through the reducer (which returns the state untouched)
      // says so in code instead of relying on nobody noticing.
      dispatchRunFailure({ type: 'history-reconciled' });
    };
  }, [initialCwd, liveSessionId, loadHistoryByCwdAndSessionId, dispatchRunFailure]);

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

  // HOW FULL THE WINDOW IS (session-context-management §2.1). Derived from the same
  // measurement the status bar shows, so the bar and the banner can never disagree
  // about whether this conversation is nearly full. A reloaded session has no
  // per-step reading until its next turn, and the gauge is absent then — which is
  // the spec's rule (no number beats a wrong one), not an oversight.
  const windowGauge = useMemo(
    () => contextGauge(tokenUsage?.contextTokens, tokenUsage?.contextWindow, tokenUsage?.contextModel),
    [tokenUsage?.contextTokens, tokenUsage?.contextWindow, tokenUsage?.contextModel],
  );

  // HOW THE CONVERSATION KNOWS IT HAS MOVED ON. One counter, bumped on the
  // rising edge of "a turn is in flight for this session" — this tab sending
  // (`isLoading`) or a turn arriving from anywhere else (`liveRunning`: a
  // Telegram message, a scheduled task, the fast-growth kickoff).
  //
  // Its consumer is the check-in reveal banner, which used to sit above the
  // input for the rest of the session unless the user found its ✕. The banner
  // belongs to the exchange it was earned in, so it lives exactly that long and
  // this is the signal that ends it. Deliberately not a timer: content must not
  // vanish while a user might be mid-read, and progression — not a clock — is
  // what makes the banner stale.
  const running = isLoading || liveRunning;
  const [runNonce, setRunNonce] = useState(0);
  const prevRunningRef = useRef(false);
  useEffect(() => {
    if (running && !prevRunningRef.current) setRunNonce((n) => n + 1);
    prevRunningRef.current = running;
  }, [running]);

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
  //
  // NOT FROM THE POPUP. `isLoading` here is the app-wide "the chat is busy"
  // flag; a throwaway conversation streaming in a popup must not make the real
  // tab look busy, and must not still be reported busy after it is discarded.
  useEffect(() => {
    if (isActive && !ephemeral) {
      chatContext?.setIsLoading(isLoading);
    }
  }, [isLoading, isActive, ephemeral, chatContext]);

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

  // Notify ChatContext when tab becomes active.
  //
  // THE ONE LINE THE POPUP MUST NOT RUN. `setActiveTab` writes a
  // last-writer-wins ref that every `chatCtx.sendMessage` / `useAIBridge()`
  // caller in the app resolves through. If the popup claimed it, messages meant
  // for the real tab would land in a throwaway conversation — one that may
  // already have been closed and deleted, in which case they land nowhere at
  // all. The popup's own composer is unaffected: it calls the inner chat's
  // `handleSend` directly and never goes through this registry.
  useEffect(() => {
    if (tabId && isActive && chatContext && !ephemeral) {
      chatContext.setActiveTab(tabId);
    }
  }, [tabId, isActive, ephemeral, chatContext]);

  // Hand the host a stop function for this chat's in-flight run. The run is
  // detached server-side, so the popup that owns this chat cannot rely on
  // unmounting to end it — see ChatProps.onStopHandle.
  useEffect(() => {
    if (!onStopHandle) return;
    onStopHandle(handleStop);
    return () => onStopHandle(null);
  }, [onStopHandle, handleStop]);

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

  // NO FORK HANDLER — see the note in MessageBubble.tsx. Upstream forked a session
  // by copying the Claude Code CLI transcript file, which naby has no equivalent of:
  // our session id is a SQLite key, not a filename under ~/.claude/projects, so every
  // fork 404'd and only reached console.error. The button is gone; the /api/session/
  // [id]/fork route is left in place (unreferenced) for whoever rebuilds this on top
  // of app.db.

  // Stabilize ChatInput callback props, combined with React.memo to avoid unnecessary re-renders
  const handleShowUserMessages = useCallback(() => {
    setIsUserMessagesOpen(true);
  }, []);

  // What the user has already sent this session, for the composer's `↑` list.
  // Derived from `messages` — no request, no second copy to keep in sync.
  //
  // The identity is PINNED to the previous array whenever the list is unchanged.
  // `messages` gets a new identity on every streamed chunk, so without this the
  // `memo`'d ChatInput would be handed a fresh array several times a second for
  // a list that only moves when the user sends something (React Performance
  // Conventions in CLAUDE.md).
  const composerHistoryRef = useRef<readonly string[]>([]);
  const composerHistory = useMemo(() => {
    const next = buildComposerHistory(messages);
    if (sameComposerHistory(composerHistoryRef.current, next)) return composerHistoryRef.current;
    composerHistoryRef.current = next;
    return next;
  }, [messages]);

  const handleCreateScheduledTask = useMemo(() => {
    if (!onCreateScheduledTask || !initialCwd || !tabId || !sessionId) return undefined;
    return (params: { message: string; type: 'once' | 'interval' | 'cron'; delayMinutes?: number; intervalMinutes?: number; activeFrom?: string; activeTo?: string; cron?: string }) => {
      onCreateScheduledTask({
        ...params,
        cwd: initialCwd,
        tabId,
        sessionId,
        engine,
      });
    };
  }, [onCreateScheduledTask, initialCwd, tabId, sessionId, engine]);

  // -- THE SELECTION POPUP ------------------------------------------------
  //
  // Select text in a reply → "Send to AI" → a THROWAWAY conversation with its
  // own session, opened next to the selection. It used to be a one-line card
  // that injected a quoted question into THIS session, where the side question
  // then lived forever and rode along in the context of every later turn.
  //
  // ONE AT A TIME. While a popup is open the host transcript stops offering the
  // selection toolbar (`askOpen` below), so a second selection cannot stack a
  // second throwaway conversation on top of the first: the second popup would
  // have to negotiate the first one's discard confirmation, and two overlapping
  // ephemeral chats is a worse answer than making the user finish one.
  const [selectionAsk, setSelectionAsk] = useState<{ text: string; anchor: { x: number; y: number } } | null>(null);
  const handleAskSelection = useCallback(
    (ask: { text: string; anchor: { x: number; y: number } }) => setSelectionAsk(ask),
    [],
  );
  const closeSelectionAsk = useCallback(() => setSelectionAsk(null), []);

  // The popup's conversation surface. A render prop rather than an import, so
  // SelectionChatPopup never has to import Chat back — this is Chat rendering
  // itself, which is not a module cycle. Stable identity because the popup is
  // memoized and this chat re-renders on every streamed delta.
  const renderPopupChat = useCallback(
    (w: SelectionChatPopupWiring) => (
      <Chat
        tabId={w.tabId}
        // Same project, so tools resolve against the same tree the host is
        // talking about.
        initialCwd={initialCwd}
        engine={engine}
        hideHeader
        hideSidebar
        // `isActive` here means "on screen and measurable" — MessageList refuses
        // to measure a hidden tab (every box metric reads 0 there). A popup is
        // always on screen while it is mounted. It is `ephemeral` that stops it
        // claiming the app-wide active-tab slot; the two are separate questions.
        isActive
        ephemeral
        quotedContext={w.quotedContext}
        onSessionIdChange={w.onSessionIdChange}
        onLoadingChange={w.onLoadingChange}
        onTitleChange={w.onTitleChange}
        onStopHandle={w.onStopHandle}
        // The popup's own box, so the composer in here is capped against THIS
        // column and not the window it happens to float over.
        composerViewport={w.composerViewport}
      />
    ),
    [initialCwd, engine],
  );

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

        {/* Engine row. This slot used to hold an "Execution mode" SDK ↔ PTY
            picker (the PTY path spawned `claude --dangerously-skip-permissions`,
            bypassing the approval gate, so it was removed — there is one path
            now). The engine label became read-only status, and is now a CLICKABLE
            quick-switch: <EngineSwitcher/> lists the configured providers and
            switches the engine in place (selectEngine re-reads settings each turn,
            so a pick takes effect on the next message — no reload). */}
        {/* NOT IN THE POPUP. This row is host-level configuration — the engine
            and model pickers, the account chip, plan mode, and `AllowChangesToggle`,
            which is an APP-WIDE gate policy rather than a per-chat one. A throwaway
            side question is not where any of that is decided, and the row does not
            fit across a popup anyway. The popup inherits whatever the app is set to. */}
        {isClaudeEngine && !ephemeral && (
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-card/50">
            <EngineSwitcher liveModel={liveModel} onOpenSettings={onOpenSettings} onEngineName={handleEngineName} onActiveEngine={handleActiveEngine} onUserSelect={handleUserSwitch} />
            {/* The model chip sits BETWEEN the engine and the account chip — it
                picks WHICH model the selected engine uses (Claude aliases /
                ChatGPT slugs). Self-hides for a metered API-key provider, which
                has no per-turn model choice. */}
            <ModelSwitcher activeEngine={activeEngine} onModelChange={handleModelChange} onUserSelect={handleUserSwitch} />
            {/* The account chip is ENGINE-AWARE: exactly one sign-in shows,
                matching the engine that will answer.
                  • ChatGPT subscription  → the ChatGPT chip (dev-seal gated; it
                    self-hides in a packaged build regardless).
                  • a plain API-key provider (Azure/OpenAI/…) → no chip: a key is
                    not an account login.
                  • otherwise (Claude subscription, or before the first read) →
                    the Claude chip, which self-hides when the dev engine is not
                    part of this build. Placed here because this is where the user
                    is already looking, and a logged-out machine otherwise fails
                    only at send time with an error that does not say what to do. */}
            {accountChip === 'chatgpt' ? (
              <ChatgptLoginStatus />
            ) : accountChip === 'claude' ? (
              <ClaudeLoginStatus />
            ) : null}
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
            {/* Allow changes: the app-wide gate policy. ON = the agent can edit
                files / run commands (still logged); OFF = read-only observation.
                Global (not per-tab), so it owns its own read/write to /api/naby. */}
            <AllowChangesToggle />
          </div>
        )}

        {/* Messages — dropping a file here inserts its path into the input. */}
        <div
          className="flex-1 flex flex-col min-h-0 overflow-hidden"
          onDragOver={handleConversationDragOver}
          onDrop={handleConversationDrop}
        >
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
            isActive={isActive}
            onApprovePlan={handleApprovePlan}
            thinkingName={thinkingName}
            // A turn this tab did NOT send: the fast-growth session's opening
            // question, a Telegram message, a scheduled task — anything the live
            // stream reports (including a turn merely RESERVED and not yet
            // started) while this tab is not the originator.
            viewerRun={liveRunning && !isLoading}
            onStop={handleStop}
            // The user just acted → the transcript goes to the bottom and
            // follows the answer from there, wherever they had scrolled to.
            sendNonce={sendNonce}
            onResendMessage={handleResendMessage}
            // The selection toolbar. Omitted inside a popup — one throwaway
            // conversation at a time, no popups out of popups — and suppressed
            // while one is already open.
            onAskSelection={ephemeral ? undefined : handleAskSelection}
            askOpen={!!selectionAsk}
          />
        )}
        </div>

        {/* WHY THE LAST TURN PRODUCED NOTHING. Rendered here — a sibling of the
            transcript, not a row inside it — because that is what makes it
            outlive the post-run disk reconcile that erases everything not
            persisted. It carries the provider's own words (a quota reply says
            which model, which limit and for how long), and the next send
            clears it. */}
        <RunFailureNotice failure={runFailure} onDismiss={dismissRunFailure} />

        {/* Token Usage Display */}
        {tokenUsage && <TokenUsageBar tokenUsage={tokenUsage} rateLimitInfo={rateLimitInfo} />}

        {/* Phase 2 (M2): a paused tool call awaiting the user's Allow/Deny. */}
        <ToolApprovalPrompt sessionId={sessionId ?? undefined} cwd={initialCwd} />
        {/* The reveal banner it leaves behind is tied to the turn it was earned
            in: `runNonce` is what retires it when the conversation moves on. */}
        <CheckinPrompt sessionId={sessionId ?? undefined} runNonce={runNonce} />
        {/* At 85% of the window: one line offering the new tab (§2.1). An offer,
            not a block — and dismissible for the rest of this session. */}
        <ContextLimitBanner
          atThreshold={windowGauge.show === true && windowGauge.atThreshold}
          sessionId={sessionId ?? undefined}
          cwd={initialCwd}
        />

        {/* Input */}
        <ChatInput
          onSend={wrappedHandleSend}
          // #10: disable while THIS tab streams, or while the session is running elsewhere
          // (viewer) — one active run per session; a concurrent send would 409.
          disabled={isLoading || liveRunning}
          cwd={initialCwd}
          isActive={isActive}
          engine={engine}
          history={composerHistory}
          onShowUserMessages={handleShowUserMessages}
          onOpenNote={onOpenNote}
          onCreateScheduledTask={handleCreateScheduledTask}
          // Undefined in a tab, which means "the window is the column" — the
          // behaviour every chat has always had.
          composerViewport={composerViewport}
          // A POPUP GETS THE SHORT PLACEHOLDER. The full one documents `/`, `@`
          // and mid-sentence skills — three lines in a tab, more in a narrow box
          // — and the composer's floor exists to keep it unclipped, so in a
          // 320px popup that hint alone is what makes the input greedy. The
          // popup is one throwaway question about a selection, not a session
          // that runs commands, so it asks a shorter thing and the floor has
          // less to defend. `ephemeral` IS "this is the popup".
          compactPlaceholder={ephemeral}
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

      {/* The throwaway conversation opened out of a selection. Portaled from
          inside, so where it sits in this tree only decides its lifetime. */}
      {selectionAsk && (
        <SelectionChatPopup
          selectedText={selectionAsk.text}
          anchor={selectionAsk.anchor}
          onClose={closeSelectionAsk}
          onOpenSession={onOpenSession}
          onDiscardSession={onDiscardSession}
        >
          {renderPopupChat}
        </SelectionChatPopup>
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
