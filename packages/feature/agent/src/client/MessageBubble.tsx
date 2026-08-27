'use client';

import { useState, useEffect, useMemo, memo, useCallback, type ReactNode } from 'react';
import { Portal, toast } from '@cockpit/shared-ui';
import { MessageCircleQuestion, Circle, Loader, CheckCircle2, ChevronDown, ChevronRight, RotateCw, Pencil } from 'lucide-react';
import { setComposerText } from './fileRefBus';
import { ToolCallModal } from './ToolCallModal';
import { SubagentBlock } from './SubagentBlock';
import { BackgroundJobBlock } from './BackgroundJobBlock';
import { groupSubagentCalls } from './subagentGroups';
import { partitionBackgroundJobs } from './backgroundJobs';
import { buildRenderSegments, lastTextSegmentId } from './turnSegments';
import { formatTurnEndTime, formatTurnMeta } from './elapsed';
import { filterDisplayToolCalls, shouldGroupUnderHeader } from './toolCallDisplay';
import { AskQuestionViewerModal } from './AskQuestionViewerModal';
import type { ChatMessage, MessageImage, ToolCallInfo } from './types';
import { MarkdownRenderer, docTabTarget } from '@cockpit/shared-ui';
import { openDocumentInTab } from './docOpenBus';
import { useTranslation } from 'react-i18next';

// Migrated from src/components/project/MessageBubble.tsx.

interface ImageModalProps {
  image: MessageImage;
  onClose: () => void;
}

function ImageModal({ image, onClose }: ImageModalProps) {
  const { t } = useTranslation();

  const modalContent = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
      onClick={onClose}
    >
      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 w-10 h-10 flex items-center justify-center text-white/80 hover:text-white bg-black/40 hover:bg-black/60 rounded-full transition-colors"
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      {/* Image */}
      <img
        src={`data:${image.media_type};base64,${image.data}`}
        alt={t('chat.imagePreview')}
        className="max-w-[90vw] max-h-[90vh] object-contain"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );

  return <Portal>{modalContent}</Portal>;
}

/** The hover copy control. Same markup wherever it appears. */
function CopyButton({ onCopy, title }: { onCopy: () => void; title: string }) {
  return (
    <button
      onClick={onCopy}
      className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
      title={title}
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
      </svg>
    </button>
  );
}

/** The other hover controls (resend / edit), same footprint as CopyButton so
 *  the column reads as one set. */
function ActionButton({
  onClick,
  title,
  disabled,
  testId,
  children,
}: {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-muted-foreground disabled:hover:bg-transparent"
      title={title}
    >
      {children}
    </button>
  );
}

interface MessageBalloonProps {
  text: string;
  isUser: boolean;
  /** Draw the caret and hand `isStreaming` to the markdown renderer. Only ever
   *  true for the turn's FINAL segment while it is still running — a caret on a
   *  bubble that tools have already been run after it would claim the model is
   *  still writing there. */
  isStreaming?: boolean;
  /** Copies the WHOLE turn (see the note on `handleCopy`). Given only to the
   *  bubble the turn ends on, and to a user message. */
  onCopy?: () => void;
  copyTitle?: string;
  /** USER bubbles only: send this message again, verbatim. Disabled while a
   *  run streams — one active run per session, a concurrent send would 409. */
  onResend?: () => void;
  resendTitle?: string;
  resendDisabled?: boolean;
  /** USER bubbles only: load this message into the composer to revise and
   *  send as a NEW message. (Naby history is append-only — there is no
   *  rewrite-in-place; see the no-fork note below.) */
  onEdit?: () => void;
  editTitle?: string;
  /** Attachments, drawn ABOVE the text as they always were. Given to the FIRST
   *  bubble of a turn — they arrived with the message, not with its ending. */
  leading?: ReactNode;
  /** The tool-derived panels (todo list, plan card, thought table), which belong
   *  to the turn rather than to one of its sentences and so hang off its last
   *  bubble. */
  extras?: ReactNode;
  /** A file path in this bubble's text was clicked. Passed down rather than
   *  reached for here because the balloon has no `cwd` — and it must be a STABLE
   *  callback, like every other one on this interface: the markdown renderer
   *  memoises its component table against this identity, so a fresh closure per
   *  render would tear down and rebuild the message's whole DOM on every stream
   *  delta. */
  onFilePathClick?: (path: string) => boolean;
}

/**
 * ONE THING THE ASSISTANT SAID, as one balloon.
 *
 * `memo`'d and fed only strings, booleans and stable callbacks: a turn that is
 * still streaming re-renders its LAST bubble on every delta, and the ones above
 * it — which are finished and will never change again — must not come with it.
 */
const MessageBalloon = memo(function MessageBalloon({
  text,
  isUser,
  isStreaming,
  onCopy,
  copyTitle,
  onResend,
  resendTitle,
  resendDisabled,
  onEdit,
  editTitle,
  leading,
  extras,
  onFilePathClick,
}: MessageBalloonProps) {
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} w-full`}>
      {/* Action buttons for user messages — on the left */}
      {isUser && (onCopy || onResend || onEdit) && (
        <div className="self-start mt-2 mr-1 flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {onCopy && <CopyButton onCopy={onCopy} title={copyTitle ?? ''} />}
          {onResend && (
            <ActionButton onClick={onResend} title={resendTitle ?? ''} disabled={resendDisabled} testId="resend-message">
              <RotateCw className="w-4 h-4" />
            </ActionButton>
          )}
          {onEdit && (
            <ActionButton onClick={onEdit} title={editTitle ?? ''} testId="edit-message">
              <Pencil className="w-4 h-4" />
            </ActionButton>
          )}
        </div>
      )}
      {/* `self-start` IS LOAD-BEARING. The row has no `items-*`, so a flex child
          without `self-*` stretches to the line's cross size — and the action
          column beside it is three 24px buttons tall (~84px) while a one-line
          balloon is ~40px. `self-start` on the column alone does not help: it
          places that item but still contributes its height to the line. Without
          this the balloon grows to ~84px and the text sits at the top of a box
          with 40px of dead space under it, which reads as "the Enter key got
          sent too". */}
      <div
        className={`self-start max-w-[80%] ${
          isUser
            ? 'bg-accent text-foreground border border-brand rounded-2xl rounded-br-md'
            : 'bg-accent text-foreground dark:text-slate-11 rounded-2xl rounded-bl-md'
        } px-4 py-2`}
      >
        {leading}
        {text && (
          /* `chat-content` is the CHAT TEXT SIZE knob's only mounting point
             (globals.css): `font-size: calc(1em * var(--chat-text-scale))`. It
             wraps BOTH branches of MarkdownRenderer — the markdown one, the
             plain-text user one and the streamed tail — so one class covers
             everything a message says, and nothing outside a bubble (tool rows,
             timestamps, the composer) moves with it. It scales in `em`, so it
             composes with the global size scale instead of replacing it. */
          <div className="break-words chat-content">
            <MarkdownRenderer
              content={text}
              isUser={isUser}
              isStreaming={isStreaming}
              enableMath={false}
              enableFileLinks
              onFilePathClick={onFilePathClick}
            />
            {isStreaming && <span className="inline-block w-2 h-4 ml-1 bg-current animate-pulse" />}
          </div>
        )}
        {extras}
      </div>
      {/* Action buttons for AI messages — on the right */}
      {!isUser && onCopy && (
        <div className="self-start mt-2 ml-1 flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <CopyButton onCopy={onCopy} title={copyTitle ?? ''} />
        </div>
      )}
    </div>
  );
});

interface ToolSegmentRowProps {
  calls: ToolCallInfo[];
  cwd?: string;
  sessionId?: string | null;
}

/**
 * ONE CONTIGUOUS RUN OF TOOL CALLS, at the point in the turn it happened.
 *
 * The batch UI is the old one, unchanged — muted rows, folded behind a header
 * once there is a wall of them. What changed is the SCOPE: the count is this
 * run's, not the whole turn's, because a turn that read three files, said
 * something, and then edited two did not make one batch of five.
 *
 * Each row owns its own expand/collapse, so opening the batch under the first
 * paragraph does not also open the one under the third.
 */
const ToolSegmentRow = memo(
  function ToolSegmentRow({ calls, cwd, sessionId }: ToolSegmentRowProps) {
    const { t } = useTranslation();
    // A long run of calls starts folded; a short one has no header to fold at all
    // (see toolCallDisplay).
    const [expanded, setExpanded] = useState(false);
    const useHeader = shouldGroupUnderHeader(calls.length);
    return (
      <div className="w-full max-w-[90%] mt-1" data-testid="tool-call-group">
        {useHeader ? (
          <>
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
              data-testid="tool-calls-toggle"
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[0.786rem] text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
            >
              {expanded ? (
                <ChevronDown className="w-3 h-3 opacity-60" />
              ) : (
                <ChevronRight className="w-3 h-3 opacity-60" />
              )}
              <span>{t('chat.toolCalls', { count: calls.length })}</span>
            </button>
            {expanded && (
              <div className="mt-0.5">
                {calls.map((toolCall, index) => (
                  <ToolCallModal key={`${toolCall.id}-${index}`} toolCall={toolCall} cwd={cwd} sessionId={sessionId} />
                ))}
              </div>
            )}
          </>
        ) : (
          calls.map((toolCall, index) => (
            <ToolCallModal key={`${toolCall.id}-${index}`} toolCall={toolCall} cwd={cwd} sessionId={sessionId} />
          ))
        )}
      </div>
    );
  },
  // The `calls` array is rebuilt every time the turn's segment list is resolved
  // (i.e. on every text delta), but the CALLS in it keep their identity until
  // one of them actually changes — a result arriving, a call finishing. Comparing
  // element by element is what makes the memo above hold during streaming;
  // React's default shallow compare would see a new array and re-render every
  // batch in the turn on every token.
  (prev, next) =>
    prev.cwd === next.cwd &&
    prev.sessionId === next.sessionId &&
    prev.calls.length === next.calls.length &&
    prev.calls.every((c, i) => c === next.calls[i])
);

interface MessageBubbleProps {
  message: ChatMessage;
  cwd?: string;
  sessionId?: string | null;
  /** Plan mode: approve the plan card → turn off plan mode and resend to execute */
  onApprovePlan?: () => void;
  /** Disable the approve button while a run is streaming (no concurrent send) */
  isLoading?: boolean;
  /** Whether this tab is the one on screen. Every chat tab stays mounted, so the
   *  live clocks inside a turn (a background job's elapsed count) must not tick
   *  in a tab that is `display:none`. Defaults to true — every existing caller
   *  and every test renders a visible turn. */
  isActive?: boolean;
  /** USER messages only: send this message again, verbatim (content + images).
   *  Wired by Chat down through MessageList; absent in read-only surfaces
   *  (subagent transcript modal), where the button simply does not render. */
  onResendMessage?: (message: ChatMessage) => void;
}

// Use memo optimization — only re-render when message or cwd changes
export const MessageBubble = memo(function MessageBubble({ message, cwd, sessionId, onApprovePlan, isLoading, isActive = true, onResendMessage }: MessageBubbleProps) {
  const { t, i18n } = useTranslation();
  const [previewImage, setPreviewImage] = useState<MessageImage | null>(null);
  const [showAskQuestionViewer, setShowAskQuestionViewer] = useState(false);
  const [showEventDetail, setShowEventDetail] = useState(false);
  const isUser = message.role === 'user';
  const hasImages = message.images && message.images.length > 0;

  // Last TodoWrite call
  const lastTodoWrite = useMemo(() => {
    if (!message.toolCalls) return null;
    for (let i = message.toolCalls.length - 1; i >= 0; i--) {
      if (message.toolCalls[i].name === 'TodoWrite') return message.toolCalls[i];
    }
    return null;
  }, [message.toolCalls]);

  // All AskUserQuestion calls
  const askQuestionCalls = useMemo(() => {
    if (!message.toolCalls) return [];
    return message.toolCalls.filter(tc => tc.name === 'AskUserQuestion');
  }, [message.toolCalls]);

  // Last ExitPlanMode call → render its plan as a card (plan mode). The plan markdown
  // lives in the tool-use input (`input.plan`); the tool result is an auto-deny in
  // plan-only mode, so we surface the plan here instead of as a failed tool entry.
  const planCard = useMemo(() => {
    if (!message.toolCalls) return null;
    for (let i = message.toolCalls.length - 1; i >= 0; i--) {
      if (message.toolCalls[i].name === 'ExitPlanMode') {
        const plan = (message.toolCalls[i].input as { plan?: string })?.plan;
        return typeof plan === 'string' && plan ? plan : null;
      }
    }
    return null;
  }, [message.toolCalls]);

  // Tool calls shown in the generic list — ExitPlanMode is surfaced as a plan card
  // above instead of a (failed-looking) tool entry.
  const displayToolCalls = useMemo(
    () => filterDisplayToolCalls(message.toolCalls),
    [message.toolCalls]
  );
  // A DELEGATED RUN LEAVES THE BATCH. Calls the backend attributed to a subagent
  // are pulled out into their own blocks (subagentGroups.ts) — otherwise a turn
  // that ran four agents showed one anonymous "133 tool calls" line and no way
  // to tell whose work was whose. The main thread's calls keep the batch exactly
  // as it was, which is why the header threshold now counts `topLevel`.
  // A JOB THAT OUTLIVES ITS CALL LEAVES THE BATCH FIRST. A backgrounded `Bash`
  // returns the instant it is launched, so its row said "done" while the deploy
  // was still running and nothing else on screen mentioned it again. The launch
  // is folded into a block that keeps reporting (backgroundJobs.ts), and what is
  // left goes on to the subagent grouping exactly as before.
  const background = useMemo(
    () =>
      partitionBackgroundJobs(displayToolCalls, message.subagents, {
        // Once the turn is over, nothing is listening for the job's ending edge
        // — the backend process winds down with the turn — so a block that had
        // not heard back stops claiming the job is live (backgroundJobs.ts).
        turnEnded: !message.isStreaming,
      }),
    [displayToolCalls, message.subagents, message.isStreaming]
  );
  const partition = useMemo(
    () => groupSubagentCalls(background.calls, background.tasks),
    [background]
  );
  // THE TURN, IN THE ORDER IT HAPPENED. Text runs, tool batches and delegated
  // runs as one ordered list, so what the model said after a tool ran is drawn
  // after that tool and not merged into the sentence before it. Turns recorded
  // before segments existed have none, and `buildRenderSegments` renders those
  // exactly as it always did — one bubble, one batch, the blocks.
  //
  // Kept in a SECOND memo, downstream of the partition: text deltas change
  // `content` but not the calls, so the partition (and with it every subagent
  // group's identity) survives a token, and only the list around it is rebuilt.
  const renderSegments = useMemo(
    () => buildRenderSegments(message.segments, message.content, partition, background.jobs),
    [message.segments, message.content, partition, background.jobs]
  );
  // Where the turn ENDS talking — the bubble that carries the turn's actions and
  // the only one that may show a streaming caret.
  const lastTextId = useMemo(() => lastTextSegmentId(renderSegments), [renderSegments]);
  const lastSegmentId = renderSegments[renderSegments.length - 1]?.id ?? null;
  // Where it STARTS talking — attachments belong at the top of the turn, since
  // that is when they arrived, and the first thing drawn need not be a bubble.
  const firstTextId = useMemo(
    () => renderSegments.find((s) => s.kind === 'text')?.id ?? null,
    [renderSegments]
  );

  // Extract and parse thoughts from tool call inputs
  const thoughts = useMemo(() => {
    if (!message.toolCalls) return [];
    const result: Array<{ previous: string; current: string; expect: string; raw: string; toolName: string }> = [];
    for (const tc of message.toolCalls) {
      const thought = tc.input?.thought;
      if (thought && typeof thought === 'string') {
        // Parse "PREVIOUS: ... → THIS: ... → EXPECT: ..." format
        const match = thought.match(/PREVIOUS:\s*(.*?)\s*→\s*THIS:\s*(.*?)\s*→\s*EXPECT:\s*(.*)/i);
        if (match) {
          result.push({ previous: match[1].trim(), current: match[2].trim(), expect: match[3].trim(), raw: thought, toolName: tc.name });
        } else {
          result.push({ previous: '', current: thought, expect: '', raw: thought, toolName: tc.name });
        }
      }
    }
    return result;
  }, [message.toolCalls]);

  // Is there anything the assistant SAID (or drew) to put in a bubble? Tool
  // calls no longer count: they render outside the bubble as machinery, so a
  // turn that only ran tools must not leave an empty speech balloon behind.
  const hasBubbleContent =
    !!message.content ||
    !!hasImages ||
    !!lastTodoWrite ||
    !!planCard ||
    thoughts.length > 0;
  const showBubble = isUser || hasBubbleContent;
  // The one balloon a turn with NO text still needs: a tool-only turn that
  // nevertheless produced a todo list, a plan card or a thought table. When the
  // turn did speak, those panels ride its last text bubble instead.
  const showLegacyBubble = showBubble && (isUser || lastTextId === null);

  // COPY IS PER-TURN, and copies the turn — `message.content`, every bubble's
  // text joined, exactly what it always copied. The turn is now drawn as several
  // balloons, so the button has to pick one: it sits on the LAST text bubble,
  // where the turn finishes and where the eye already is. Putting a copy control
  // on every bubble would offer three ways to copy a third of an answer and no
  // way to copy the answer.
  /**
   * OPEN A PATH THE ASSISTANT WROTE OUT, in a document tab beside this
   * conversation.
   *
   * Only a link this renderer MINTED out of visible text reaches here — an
   * authored `[열기](/Users/you/.ssh/id_rsa)` has no route to this callback at
   * all (MarkdownRenderer's `onFilePathClick` vs `onLinkClick`). So the path
   * being opened is always the one the reader can see.
   *
   * `docTabTarget` decides which root it is read against: inside the project,
   * the project; outside it, the document's own folder — which is what lets a
   * report in `~/Downloads` open WITHOUT loosening the server guard that the
   * write and delete routes share.
   *
   * Returns true unconditionally, including when no tab host is mounted. The
   * href is a filesystem path, so an unconsumed click would let the anchor
   * navigate the shell to `http://localhost:PORT/Users/…` and lose the live
   * session — a click that does nothing is the better failure.
   */
  const handleFilePathClick = useCallback(
    (path: string): boolean => {
      openDocumentInTab(docTabTarget(path, cwd));
      return true;
    },
    [cwd],
  );

  const handleCopy = useCallback(() => {
    if (message.content) {
      navigator.clipboard.writeText(message.content);
      toast(t('toast.copiedMessage'));
    }
  }, [message.content, t]);

  // RESEND sends the message AGAIN, verbatim — a new turn with the same text
  // (and images), not a rewrite of history. The common case it serves: the run
  // errored out or was stopped, and the user wants the same ask retried.
  const handleResend = useCallback(() => {
    onResendMessage?.(message);
  }, [onResendMessage, message]);

  // EDIT loads the message into the composer (fileRefBus: only the active
  // tab's input is registered, and a bubble can only be hovered on the active
  // tab). Revise and send as a NEW message — history is append-only in naby,
  // so there is no rewrite-in-place; see the no-fork note below for why.
  const handleEdit = useCallback(() => {
    if (message.content) setComposerText(message.content);
  }, [message.content]);

  // NO FORK BUTTON. Cockpit upstream puts a branch-from-here button next to Copy,
  // and it CANNOT work in naby: /api/session/[id]/fork forks by copying the Claude
  // Code CLI transcript at ~/.claude/projects/<cwd>/<sessionId>.jsonl, but a naby
  // session id is our own SQLite key (`s-ms1e2gah-2-6xg7a0ha`) and never a filename
  // there — so the very first existsSync fails, the route 404s, and Chat only
  // console.error'd it. The user saw a button that did nothing at all.
  //
  // Forking is still POSSIBLE — the conversation lives in app.db, so a real
  // implementation would copy messages up to this point into a new session (a
  // `session.fork` action on /api/naby) and the bubble would have to carry the DB
  // message id, not the client-side `assistant-<ts>` placeholder. Until that
  // exists, no button: a control that silently does nothing is worse than none.
  // Format time as: 01-15 14:30
  const formatTime = (ts?: string) => {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${month}-${day} ${hours}:${minutes}`;
  };

  const timeStr = formatTime(message.timestamp);

  // WHAT A FINISHED TURN COST, AND WHEN IT LANDED — `12.3초 · 오후 2:15`.
  //
  // NOT HOVER-ONLY, unlike the creation timestamp above it: this is the thing
  // the user came back to the tab to read, and information you have to go
  // looking for with the mouse is information the app has decided you do not
  // need.
  //
  // FOUR REASONS IT DRAWS NOTHING, each deliberate: a user message (which has no
  // duration to report), a turn still streaming (a number that ticks and then
  // settles is noise — the running clock lives in MessageList), a turn recorded
  // before this existed, and a turn whose end time never arrived. The last one
  // is why the separator is built here rather than written into JSX: `· ` with
  // nothing after it is the tell that a field was missing.
  //
  // MEMOISED because this component is `memo`'d and every open tab stays
  // mounted (shell/CLAUDE.md): `toLocaleTimeString` on every bubble on every
  // render of the list is exactly the O(list) per-render work those conventions
  // are about. `i18n.language` is a dep because both halves are localised.
  const turnMeta = useMemo(() => {
    if (isUser || message.isStreaming) return null;
    const text = formatTurnMeta(message.durationMs, message.completedAt);
    if (!text) return null;
    const endTime = formatTurnEndTime(message.completedAt);
    return {
      text,
      title: endTime
        ? t('chat.turnFinishedAt', { defaultValue: 'Finished at {{time}}', time: endTime })
        : undefined,
    };
  }, [isUser, message.isStreaming, message.durationMs, message.completedAt, i18n.language, t]);

  // Attachments. Drawn at the TOP of the turn's first balloon, where they always
  // were — they came with the message, not with whatever it ended on.
  const imagesBlock = hasImages ? (
    <div className={`flex flex-wrap gap-2 ${message.content ? 'mb-2' : ''}`}>
      {message.images!.map((image, index) => (
        <div
          key={index}
          className="relative w-16 h-16 rounded-lg overflow-hidden border border-white/20 cursor-pointer hover:opacity-90 transition-opacity"
          onClick={() => setPreviewImage(image)}
        >
          <img
            src={`data:${image.media_type};base64,${image.data}`}
            alt={t('chat.imageN', { index: index + 1 })}
            className="w-full h-full object-cover"
          />
        </div>
      ))}
    </div>
  ) : undefined;

  // THE PANELS A TURN LEAVES BEHIND: the todo list as it now stands, the plan
  // awaiting review, the thought table. Each is a summary of the WHOLE turn
  // (the last TodoWrite, the last ExitPlanMode), not of one of its sentences,
  // so they hang off the bubble the turn ends on rather than being interleaved.
  // A turn that never spoke gets them in a balloon of their own.
  const bubbleExtras =
    lastTodoWrite || planCard || thoughts.length > 0 ? (
      <>
          {/* Inline Todo display */}
          {lastTodoWrite && (() => {
            const rawTodos = lastTodoWrite.input?.todos;
            const todos = (Array.isArray(rawTodos) ? rawTodos : []) as Array<{ content: string; status: string; activeForm?: string }>;
            const completed = todos.filter(t => t.status === 'completed').length;
            const total = todos.length;
            return (
              <div
                className={`${message.content || hasImages ? 'mt-2' : ''}`}
              >
                <div className="border border-border rounded-lg overflow-hidden bg-secondary/50 px-3 py-2 space-y-1">
                  {/* Progress header */}
                  <div className="flex items-center gap-2 mb-1.5">
                    <div className="flex-1 h-1 bg-secondary rounded-full overflow-hidden">
                      <div
                        className="h-full bg-green-500 rounded-full transition-all duration-300"
                        style={{ width: `${total > 0 ? (completed / total) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="text-[0.714rem] text-muted-foreground flex-shrink-0">{completed}/{total}</span>
                  </div>
                  {/* Todo items */}
                  {todos.map((todo, i) => (
                    <div
                      key={i}
                      className={`flex items-center gap-1.5 ${
                        todo.status === 'completed' ? 'opacity-50' : ''
                      }`}
                    >
                      {todo.status === 'completed' ? (
                        <CheckCircle2 className="w-3 h-3 text-green-500 flex-shrink-0" />
                      ) : todo.status === 'in_progress' ? (
                        <Loader className="w-3 h-3 text-brand flex-shrink-0 animate-spin" />
                      ) : (
                        <Circle className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                      )}
                      <span className={`text-xs truncate ${
                        todo.status === 'completed' ? 'text-muted-foreground' : 'text-foreground'
                      }`}>
                        {todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* Inline plan card (plan mode — ExitPlanMode). Plan-only: read this, then
              uncheck Plan mode and resend to implement. */}
          {planCard && (
            <div className={`${message.content || hasImages || lastTodoWrite ? 'mt-2' : ''}`}>
              <div className="border border-brand/40 rounded-lg overflow-hidden bg-secondary/50">
                <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border bg-brand/10">
                  <span className="text-sm">📋</span>
                  <span className="text-xs font-medium text-foreground">
                    {t('chat.planTitle', { defaultValue: 'Plan (awaiting your review)' })}
                  </span>
                </div>
                {/* The plan is prose the agent wrote, so it follows the chat
                    text size like every other thing the agent says. The card's
                    own chrome (title bar, approve row) does not — it is UI. */}
                <div className="px-3 py-2 chat-content">
                  <MarkdownRenderer content={planCard} isUser={false} enableMath={false} />
                </div>
                {/* Approve & run: the in-UI replacement for the (non-existent) "Exit plan
                    mode?" approval dialog. Turns off plan mode and resends to execute.
                    Disabled while a run streams (one active run per session). */}
                {onApprovePlan && (
                  <div className="px-3 py-2 border-t border-border flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      {t('chat.planApproveHint', { defaultValue: '本环境无审批弹窗，点此退出 Plan 并执行' })}
                    </span>
                    <button
                      onClick={() => onApprovePlan()}
                      disabled={isLoading}
                      className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-brand text-white text-xs font-medium hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex-shrink-0"
                    >
                      <span>✓</span>
                      <span>{t('chat.approvePlan', { defaultValue: '批准并执行' })}</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Thoughts — extracted from tool call inputs, displayed as table */}
          {thoughts.length > 0 && (
            <div className={`${message.content || hasImages || lastTodoWrite ? 'mt-2' : ''}`}>
              <div className="border border-border rounded-lg overflow-hidden bg-secondary/50">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      <th className="px-2 py-1.5 text-left font-medium w-[60px]">Tool</th>
                      <th className="px-2 py-1.5 text-left font-medium">Previous</th>
                      <th className="px-2 py-1.5 text-left font-medium">Action</th>
                      <th className="px-2 py-1.5 text-left font-medium">Expect</th>
                    </tr>
                  </thead>
                  <tbody>
                    {thoughts.map((t, i) => (
                      <tr key={i} className={i < thoughts.length - 1 ? 'border-b border-border/50' : ''}>
                        <td className="px-2 py-1 text-muted-foreground font-mono">{t.toolName}</td>
                        <td className="px-2 py-1 text-muted-foreground">{t.previous || '—'}</td>
                        <td className="px-2 py-1 text-foreground">{t.current}</td>
                        <td className="px-2 py-1 text-muted-foreground">{t.expect || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
      </>
    ) : undefined;

  // System-event row (task-notification / meta): a muted one-line bar, not a
  // conversation bubble. Kept after all hooks so hook order stays stable.
  if (message.role === 'system') {
    const ev = message.systemEvent;
    const icon =
      ev?.kind === 'task-notification'
        ? ev.status === 'failed'
          ? '⚠️'
          : ev.status === 'stopped'
            ? '⏹️'
            : '🔔'
        : ev?.kind === 'job-report'
          ? '⚙️'
          : 'ℹ️';
    // WHAT THE PILL SAYS FOR A JOB REPORT. Its `content` is the prompt naby was
    // given — English, and addressed to naby ("tell the user how it went"),
    // which is not a sentence to show a reader in their own transcript. So the
    // pill carries a short localized line and the ORIGINAL stays one click
    // away in the detail modal below, exactly as it does for every other
    // system row. Nothing is hidden; it is only no longer mistaken for
    // something the user said.
    const pillText =
      ev?.kind === 'job-report'
        ? t('chat.jobReportNotice', { defaultValue: 'A background job finished' })
        : message.content;
    // Full text for the detail modal — the raw <task-notification> block, or the
    // message content itself (image annotation / compact-summary notice).
    const detail = ev?.detail || message.content;
    return (
      <>
        <div className="flex justify-center my-2 px-2" data-role="system">
          <button
            type="button"
            onClick={() => setShowEventDetail(true)}
            className="flex items-center gap-1.5 max-w-[85%] text-[0.786rem] text-muted-foreground bg-secondary/40 border border-border/50 rounded-full px-3 py-1 hover:bg-secondary hover:text-foreground transition-colors cursor-pointer"
            title={t('chat.viewDetails', { defaultValue: 'Click for details' })}
          >
            <span className="flex-shrink-0">{icon}</span>
            <span className="truncate">{pillText}</span>
          </button>
        </div>
        {showEventDetail && (
          <Portal>
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
              onClick={() => setShowEventDetail(false)}
            >
              <div
                className="bg-card shadow-xl w-full max-w-4xl max-h-[80vh] rounded-lg flex flex-col overflow-hidden"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between px-4 py-2 border-b border-border flex-shrink-0">
                  <span className="text-sm text-foreground flex items-center gap-1.5">
                    <span>{icon}</span>
                    {ev?.kind === 'task-notification'
                      ? t('chat.taskNotification', { defaultValue: 'Task notification' })
                      : t('chat.systemNotice', { defaultValue: 'Notice' })}
                  </span>
                  <button
                    onClick={() => setShowEventDetail(false)}
                    className="text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-accent transition-colors"
                  >
                    ✕
                  </button>
                </div>
                <pre className="flex-1 overflow-auto px-4 py-3 text-xs text-foreground whitespace-pre-wrap break-words">
                  {detail}
                </pre>
              </div>
            </div>
          </Portal>
        )}
      </>
    );
  }

  return (
    <>
      <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} mb-4 group`} data-role={message.role}>
        {/* Message timestamp — shown on hover */}
        {timeStr && (
          <span className="text-[0.786rem] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity mb-0.5 px-1">
            {timeStr}
          </span>
        )}
        {/* THE MODEL'S REASONING, collapsed.
            Above the answer because that is the order it happened in, and closed by
            default because it is working-out: available when you want to know why,
            never in the way when you do not. It is not part of `content`, so
            copying the message copies the reply alone. */}
        {!isUser && message.thinking && (
          <details className="mb-1 w-full max-w-[90%]" data-testid="thinking-block">
            <summary className="cursor-pointer select-none text-[0.786rem] text-muted-foreground hover:text-foreground">
              {t('chat.thinkingBlock', { defaultValue: 'Reasoning' })}
              <span className="ml-1 opacity-60">
                {t('chat.thinkingChars', { defaultValue: '({{count}} chars)', count: message.thinking.length })}
              </span>
            </summary>
            <div className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 px-3 py-2 text-[0.786rem] leading-relaxed text-muted-foreground">
              {message.thinking}
            </div>
          </details>
        )}
        {/* The one balloon the sequence below cannot draw: a user message (which
            is never a sequence) and a turn that said NOTHING but still produced
            a panel — a tool-only turn whose todo list or plan card has to live
            somewhere. Above the machinery, exactly where it always sat. */}
        {showLegacyBubble && (
          <MessageBalloon
            text={message.content}
            isUser={isUser}
            isStreaming={!isUser && !!message.isStreaming}
            onCopy={message.content ? handleCopy : undefined}
            copyTitle={t('chat.copyMessage')}
            onResend={isUser && onResendMessage && message.content ? handleResend : undefined}
            resendTitle={t('chat.resendMessage', { defaultValue: 'Resend message' })}
            resendDisabled={isLoading}
            onEdit={isUser && onResendMessage && message.content ? handleEdit : undefined}
            editTitle={t('chat.editMessage', { defaultValue: 'Edit message' })}
            leading={imagesBlock}
            extras={bubbleExtras}
            onFilePathClick={handleFilePathClick}
          />
        )}
        {/* THE TURN, IN ORDER.
            A turn is drawn as the sequence it happened in — a bubble for each
            run of prose, the tool batch that followed it, the next bubble, the
            block for a delegated run at the point it was launched. It used to be
            one bubble that kept growing plus every tool call pooled underneath,
            so "let me look", "now I will fix it" and the explanation all arrived
            as one merged paragraph with the work hidden below it. */}
        {!isUser &&
          renderSegments.map((seg) => {
            if (seg.kind === 'text') {
              return (
                <MessageBalloon
                  key={seg.id}
                  text={seg.text}
                  isUser={false}
                  // Only where the turn is CURRENTLY writing: the last segment
                  // of a running turn. A caret under a bubble that tools have
                  // since run after would claim the model is still typing there.
                  isStreaming={!!message.isStreaming && seg.id === lastSegmentId}
                  onCopy={seg.id === lastTextId ? handleCopy : undefined}
                  copyTitle={t('chat.copyMessage')}
                  leading={seg.id === firstTextId ? imagesBlock : undefined}
                  extras={seg.id === lastTextId ? bubbleExtras : undefined}
                  onFilePathClick={handleFilePathClick}
                />
              );
            }
            if (seg.kind === 'tools') {
              return <ToolSegmentRow key={seg.id} calls={seg.calls} cwd={cwd} sessionId={sessionId} />;
            }
            // One block per BACKGROUND JOB, at the call that launched it: the
            // row that reports for as long as the job runs.
            if (seg.kind === 'background') {
              return (
                <div key={seg.id} className="w-full max-w-[90%] mt-1">
                  <BackgroundJobBlock
                    job={seg.job}
                    cwd={cwd}
                    sessionId={sessionId}
                    isActive={isActive}
                  />
                </div>
              );
            }
            // One block per delegated run, anchored at the `Task` call that
            // launched it — so four subagents running in parallel are four rows
            // sitting where they were spawned, not one merged batch at the end.
            return (
              <div key={seg.id} className="w-full max-w-[90%] mt-1">
                <SubagentBlock group={seg.group} cwd={cwd} sessionId={sessionId} />
              </div>
            );
          })}
        {/* Questions the run asked, for the turn as a whole. */}
        {!isUser && askQuestionCalls.length > 0 && (
          <div className="w-full max-w-[90%] mt-1">
            <button
              type="button"
              onClick={() => setShowAskQuestionViewer(true)}
              className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
              title={t('chat.viewQuestions')}
            >
              <MessageCircleQuestion className="w-3.5 h-3.5" />
              <span>{t('chat.viewQuestions')}</span>
            </button>
          </div>
        )}
        {/* The turn's closing line: how long it took and when it finished.
            Last, because it is the one thing that is only true once everything
            above it has happened. */}
        {turnMeta && (
          <span
            data-testid="turn-meta"
            title={turnMeta.title}
            className="text-[0.786rem] text-muted-foreground mt-0.5 px-1"
          >
            {turnMeta.text}
          </span>
        )}
      </div>

      {/* Image preview modal */}
      {previewImage && (
        <ImageModal image={previewImage} onClose={() => setPreviewImage(null)} />
      )}

      {/* AskQuestion viewer */}
      {showAskQuestionViewer && askQuestionCalls.length > 0 && (
        <AskQuestionViewerModal toolCalls={askQuestionCalls} onClose={() => setShowAskQuestionViewer(false)} />
      )}

    </>
  );
});
