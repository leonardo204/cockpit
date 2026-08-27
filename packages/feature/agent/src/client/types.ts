// Agent / Chat feature types
//
// Single source of truth for chat-specific types. Image types
// (ImageMediaType, ImageInfo, MessageImage) live in @cockpit/shared-utils
// since they're used by shared-ui's ImagePreview as well — re-exported
// here for callers that already import them from this package.

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ToolCallInfo {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  /** The STRUCTURED half of the tool's answer (`ToolOutput.data`), when it had
   *  one. `result` is the prose the model saw; this is the payload written for
   *  our own use — the transcript reads it to offer a proposed memory's confirm
   *  (pendingMemory.ts). Absent on a LIVE turn: the stream carries only the text,
   *  so the offer appears when the turn settles and the transcript reconciles. */
  resultData?: unknown;
  isLoading?: boolean;
  // Skill body loaded by this call (e.g. the Skill tool). Folded into the tool
  // call's expanded view instead of appearing as a separate user bubble.
  skillContent?: string;
  // WHO made this call, when the backend ran it inside a SUBAGENT (the Claude
  // Agent SDK's Task tool). Reported by the backend on the call itself — never
  // inferred from timing — and persisted with it, so a reloaded transcript can
  // still tell one delegated run's work from another's. Absent = main thread,
  // which is the common case and keeps the existing batch UI untouched.
  agentId?: string;
  /** The subagent's type, e.g. `general-purpose`. */
  agentType?: string;
  /** The `Task` call that spawned the subagent, when the backend correlates it. */
  parentToolCallId?: string;
}

// Re-export image types from shared-utils (single source of truth).
import type { ImageMediaType, ImageInfo, MessageImage } from '@cockpit/shared-utils';
export type { ImageMediaType, ImageInfo, MessageImage };

import type { SubagentTask } from './subagentGroups';
import type { TurnSegment } from '../shared/turnSegments';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  /** EVERYTHING the assistant said this turn, concatenated. Still the single
   *  string the rest of the app treats as "the message": copy, search, the
   *  "has the answer started" test, the live/disk reconcile. `segments` says
   *  WHERE the splits in it are; it does not replace it. */
  content: string;
  images?: MessageImage[];  // Images in the message
  toolCalls?: ToolCallInfo[];
  isStreaming?: boolean;
  /** The model's REASONING for this message, shown in a collapsed block.
   *  Deliberately separate from `content`: it is the working-out, not the reply,
   *  and it is never part of what gets stored as the answer. */
  thinking?: string;
  timestamp?: string;  // Message creation time (ISO format)
  /** HOW LONG THE TURN TOOK (ms), as the ENGINE measured it — never recomputed
   *  here. The client's clock and the engine's are different clocks, and the
   *  stream can arrive late (a viewer joining mid-run, a snapshot replay), so a
   *  client-side subtraction would time the delivery rather than the turn.
   *
   *  ASSISTANT turns only, and only once the turn has ENDED: a number that ticks
   *  and then settles is noise. Absent on turns recorded before this existed —
   *  the view draws nothing at all then, separator included. */
  durationMs?: number;
  /** WHEN THE TURN ENDED (ISO). Deliberately NOT `timestamp`, which is when the
   *  bubble was CREATED: on a four-minute turn the two are four minutes apart,
   *  and "when did the answer arrive" is the question being asked. Set from the
   *  engine's own reading at the same instant as `durationMs`, so the pair can
   *  never disagree. */
  completedAt?: string;
  // Set on role:'system' rows — a harness event rendered as a muted one-line bar
  // (not a conversation bubble). `task-notification` shows the <summary> line;
  // `meta` covers skill image annotations / compact-summary notices.
  // `detail` is the full raw text (e.g. the complete <task-notification> block) —
  // shown in a modal when the one-line bar is clicked. `content` stays the summary.
  /** `job-report` is a background job announcing itself. It arrives as a turn's
   *  PROMPT and is therefore stored as a `user` row, which is how it came to be
   *  drawn in the reader's own bubble — see toChatMessages for why it is not
   *  moved to the assistant side either. */
  systemEvent?: { kind: 'task-notification' | 'meta' | 'job-report'; status?: string; detail?: string };
  // The RUNS this turn launched, as the backend reported their lifecycle:
  // delegated subagents (`Task`) and background shell jobs (`Bash` with
  // `run_in_background`), which arrive on the same four edges and are told apart
  // by `taskType`. LIVE ONLY: these events are observational and never
  // persisted, so a reloaded transcript has none — the blocks are then rebuilt
  // from the tool calls themselves (a subagent's calls carry its attribution, a
  // background launch carries the flag), without a running/completed state to
  // show. See subagentGroups.ts and backgroundJobs.ts.
  subagents?: SubagentTask[];
  // WHAT HAPPENED IN WHAT ORDER. The turn as an ordered list of text runs and
  // tool-call runs (see shared/turnSegments.ts), so the view can draw the
  // sequence the model actually produced — say, act, say again — instead of one
  // ever-growing bubble with all the machinery pooled underneath it. Built by
  // the live reducer from the stream and by `toChatMessages` from the persisted
  // rows, which record the same order.
  //
  // ABSENT on turns recorded before this existed. The split points of an old
  // transcript are not recoverable and are never guessed: with no segments the
  // turn renders exactly as it used to, as one bubble.
  segments?: TurnSegment[];
  // #bg ephemeral ownership: which run created this LIVE `auto-*` bubble. The snapshot
  // replay is scoped to the current run, so the reconnect filter must only drop the current
  // run's own live bubbles — matching on this stops it from wiping a PRIOR run's continuation
  // bubbles (which the new run's snapshot will never rebuild). Absent on persisted/reloaded
  // messages (they carry real UUIDs and must never be filtered).
  runKey?: string;
}

export interface ChatSession {
  id: string | null;
  messages: ChatMessage[];
}

// Token usage info
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number;
  // -- the WINDOW gauge (specs/session-context-management.md §2.1) -----------
  //
  // SEPARATE FROM THE FOUR COUNTS ABOVE, and deliberately so. Those are what this
  // TURN consumed, summed across its steps; on a multi-step turn their sum can be
  // several times the window and reads as an occupancy when it is not (the "748k
  // context" the spec's problem statement is about).
  //
  // `contextTokens` is the LAST step's input size — what the model actually held —
  // and `contextWindow` is the model's window, when the runtime registry knows it.
  // Never defaulted to 0: a zero is a number, and an absence is what the gauge's
  // branches key on.
  //
  // An absent `contextTokens` still hides the gauge (nothing was measured). An
  // absent `contextWindow` no longer drops the ratio — the gauge estimates a
  // denominator from `contextModel`'s family and marks the result `~`
  // (contextGauge.ts, spec §2.1 v0.3.0).
  /** Last step's input tokens (cache reads included) = current window occupancy. */
  contextTokens?: number;
  /** The model's context window, when it is a model the registry knows. */
  contextWindow?: number;
  /**
   * The CONCRETE model the provider reported it served — `claude-opus-5[1m]`, not
   * the `default` we asked for. It is what makes the window resolvable at all on
   * the app's most common path, and the family fallback's only input when it is
   * not.
   */
  contextModel?: string;
}

// Retry info (from SDK system/api_retry event)
export interface ApiRetryInfo {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  errorStatus?: number;
  error?: string;
}

// -- the plan windows (5-hour / 7-day), from `usage.limits` ------------------
//
// A DIFFERENT THING FROM `RateLimitInfo` BELOW, kept separate on purpose. That
// one is the mid-turn PUSH and its subject is `status` — "you are being
// throttled". This is a POLL and its subject is utilization — "you are 39% into
// the window". They answer different questions, arrive by different routes, and
// the bar shows both; neither replaces the other.
//
// ⚠️ `utilizationPercent` HERE IS 0-100 ALREADY, and `RateLimitInfo.utilization`
// below is not (the client multiplies that one by 100). The names differ so the
// two can never be handed to the same formatter by accident — see the note above
// the usage helpers in contextGauge.ts.

/** One window as the runtime reports it. Mirrors `SubscriptionUsageWindow` in
 *  src/runtime/subscription-usage.ts; declared again here rather than imported
 *  because the runtime bundle is server-only (it pulls in `node:sqlite`). */
export interface UsageWindow {
  /** 0-100, already a percentage. May exceed 100 on overage. */
  utilizationPercent?: number;
  /** UNIX **SECONDS**, the same unit `RateLimitInfo.resetsAt` uses, so the one
   *  existing conversion (`rateLimitResetsAtMs`) serves both. */
  resetsAt?: number;
  /** Which source this particular window's reading won from. */
  source: 'sdk' | 'cli';
}

export interface SubscriptionUsage {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  /** The model/app sub-windows (`seven_day_opus`, …), keyed by the vendor's own
   *  name. Tooltip material — see TokenUsageBar for why they are not chips. */
  extra?: Record<string, UsageWindow>;
}

/** What `usage.limits` returns, or null before the first answer has arrived.
 *  `limits: null` inside a non-null snapshot is meaningful and distinct: it says
 *  we asked and there is nothing to report (no plan, no SDK, both sources
 *  failed) — as opposed to "we have not asked yet". Both render as no chip. */
export type UsageLimitsSnapshot = {
  limits: SubscriptionUsage | null;
  fetchedAt: number;
  cached: boolean;
  sources: ('sdk' | 'cli')[];
  cliReason: 'same-account' | 'different-account' | 'no-cache' | 'stale-cache';
} | null;

// Rate limit info (from SDK rate_limit_event)
export interface RateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  overageStatus?: string;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
  surpassedThreshold?: number;
}

// Chat engine / model selection types — used by useChatStream, ChatPanel,
// MessageList, etc. Migrated here from useTabState so the types live with
// the agent feature instead of a generic tab-state hook.
// Naby is single-engine: every tab runs the one Naby engine (nabySpec via
// /api/chat). The alternate engines (codex/kimi/ollama/deepseek) and the
// upstream `claude2` leftover were removed with the engine picker, so this
// collapses to a single value. `engine` on a tab is effectively always
// undefined/'claude'; the type is kept (not deleted) so the residual read
// sites — engine-status label, isClaudeEngine, session `engine` echo — still
// compile. NOTE: dev-claude (ClaudeAgentSdkEngine) is a SEPARATE selectEngine
// concept, NOT a ChatEngine value.
export type ChatEngine = 'claude';
// `ChatMode` ('sdk' | 'pty') used to live here. The PTY mode spawned the interactive
// `claude` CLI with --dangerously-skip-permissions, bypassing the approval gate; it was
// removed rather than repaired, so there is no longer a mode to select — the SDK path is
// the only one.
