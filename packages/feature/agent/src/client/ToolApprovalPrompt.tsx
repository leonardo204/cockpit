'use client';

/**
 * Phase 2 (M2) — the in-conversation tool-approval prompt.
 *
 * When the gate hits an 'ask' rule it PAUSES the turn and the server emits an
 * `approval_request` RunEvent; the stream hooks (useChatStream / useLiveStream)
 * re-dispatch it as a `naby:approval_request` DOM event. This self-contained
 * component listens for those, shows an Allow/Deny prompt above the input, and
 * POSTs the decision to `/api/naby {approval.resolve}` to resume the paused turn.
 * "Always" additionally remembers a policy rule so that tool stops prompting.
 *
 * Kept out of the message reducer on purpose: a transient prompt is not chat
 * history, and a banner keyed by approvalId is far simpler (and snapshot-safe)
 * than a new message kind. Filters by session so a hidden tab never steals a
 * prompt meant for the active conversation.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NabyAvatar } from '@cockpit/shared-ui';
import { ParticipantAvatar } from './ParticipantAvatar';
import { useParticipants } from './ParticipantsContext';
import {
  approvalSpeakerName,
  proposalFromApproval,
  type ParticipantProposal,
} from './participants';
import { ParticipantDraftCard } from './ParticipantDraftCard';
import {
  draftFromApproval,
  draftResolveBody,
  type DraftChoice,
  type DraftForm,
  type ParticipantDraftCard as DraftCardData,
} from './participantDraft';
import {
  approvalAskerFrom,
  approvalOffersRemember,
  approvalReasonLines,
  approvalRememberNote,
  type ApprovalAsker,
  type ApprovalCopyLine,
} from './toolApprovalCopy';

/** Who is asking and why (`ApprovalAsker`, org-harness-sync §3.5, §7.10): a
 *  hook-only prompt offers no "always" buttons; a merged hook+policy prompt
 *  shows both reasons and keeps them, for the policy part only. */
type Pending = ApprovalAsker & {
  approvalId: string;
  toolName: string;
  inputPreview: string;
  /** multi-agent-chat R6.7: naby proposes adding a participant. Drawn as the
   *  proposal card (approve / decline only) instead of the tool card. */
  proposal?: ParticipantProposal;
  /** multi-agent-chat §8.12 (R8.3): naby's participant draft — the draft card. */
  draft?: DraftCardData;
  /** §8.9: a participant's own tool call names the participant. */
  speakerName?: string;
};

/** What the proposal (or draft) card leaves behind once answered (R6.7). */
type ProposalOutcome = {
  approvalId: string;
  displayName: string;
  decision: 'allow' | 'deny';
  /** A draft's line reads differently from a proposal's (§8.12). */
  draft?: 'create' | 'update';
};

/** How long the answered-proposal line stays before it folds away. */
const OUTCOME_MS = 8000;

const BTN = 'text-xs font-semibold px-3 py-1.5 rounded-md border disabled:opacity-50 transition-colors';

/**
 * NABY'S PROPOSAL TO ADD A PARTICIPANT (multi-agent-chat R3.9, R6.7).
 *
 * The same place and the same brand-edged card as a tool approval, and shown
 * whatever "show routing" says. It carries the participant (avatar, name,
 * description) and naby's one-line reason, and offers exactly two answers: there
 * is no "always" — adding a participant is a decision about this conversation,
 * not a policy rule.
 */
export const ParticipantProposalCard = memo(function ParticipantProposalCard({
  proposal,
  busy,
  more,
  onApprove,
  onDecline,
}: {
  proposal: ParticipantProposal;
  busy: boolean;
  more: number;
  onApprove: () => void;
  onDecline: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="mx-4 mb-2 rounded-xl border-[1.5px] border-brand/40 bg-card p-3.5 shadow-card"
      data-testid="participant-proposal"
    >
      <div className="inline-flex items-center gap-1.5 rounded-sm bg-accent py-0.5 pl-1 pr-2 text-xs font-semibold text-accent-foreground">
        <NabyAvatar size={20} bare />
        {t('participants.proposal.title', { defaultValue: 'naby’s proposal · needs your OK' })}
      </div>
      <div className="mt-2 text-sm font-semibold text-foreground">
        {t('participants.proposal.question', {
          defaultValue: '{{name}} looks right for this. Add it as a participant and hand it over?',
          name: proposal.displayName,
        })}
      </div>
      <div className="mt-2 flex items-start gap-2.5 rounded-lg bg-muted px-2.5 py-2">
        <ParticipantAvatar avatar={proposal.avatar} color={proposal.color} size="md" className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="text-[0.929rem] font-bold text-foreground">
            {proposal.displayName}{' '}
            <span className="text-xs font-medium text-muted-foreground">@{proposal.name}</span>
          </div>
          {proposal.description ? (
            <div className="mt-0.5 text-xs leading-snug text-muted-foreground" data-testid="proposal-description">
              {proposal.description}
            </div>
          ) : null}
        </div>
      </div>
      {proposal.reason ? (
        <div className="mt-2 text-xs text-foreground" data-testid="proposal-reason">
          <b>{t('participants.proposal.reason', { defaultValue: 'naby’s reason' })}</b> · {proposal.reason}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap justify-end gap-1.5">
        <button
          onClick={onDecline}
          disabled={busy}
          className={`${BTN} border-border bg-card text-muted-foreground hover:text-foreground hover:bg-accent`}
          data-testid="proposal-decline"
        >
          {t('participants.proposal.decline', { defaultValue: 'Decline' })}
        </button>
        <button
          onClick={onApprove}
          disabled={busy}
          className={`${BTN} border-transparent bg-primary text-primary-foreground hover:bg-primary/90`}
          data-testid="proposal-approve"
        >
          {t('participants.proposal.approve', { defaultValue: 'Approve' })}
        </button>
      </div>
      {more > 0 ? (
        <div className="mt-1.5 text-[0.714rem] text-muted-foreground">
          {t('toolApproval.more', { defaultValue: '+{{count}} more waiting', count: more })}
        </div>
      ) : null}
    </div>
  );
});

/** The line an answered proposal leaves (R6.7, R3.9 "같은 세션에서 다시 제안하지 않는다"). */
export const ProposalOutcomeLine = memo(function ProposalOutcomeLine({
  outcome,
  onDismiss,
}: {
  outcome: ProposalOutcome;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const ok = outcome.decision === 'allow';
  return (
    <div
      className={`mx-4 mb-2 flex items-center gap-2 rounded-xl border bg-card px-3.5 py-2 text-xs font-semibold ${
        ok ? 'border-success/50 text-success' : 'border-border text-muted-foreground'
      }`}
      data-testid="proposal-outcome"
      data-decision={outcome.decision}
    >
      <span className="flex-1">
        {outcome.draft
          ? ok
            ? t(outcome.draft === 'create' ? 'participants.draft.created' : 'participants.draft.updated', {
                defaultValue: outcome.draft === 'create' ? '✓ Approved · creating {{name}}' : '✓ Approved · updating {{name}}',
                name: outcome.displayName,
              })
            : t('participants.draft.declined', {
                defaultValue: '✕ Declined · naby will ask you what to change',
              })
          : ok
          ? t('participants.proposal.approved', {
              defaultValue: '✓ Approved · {{name}} joined as a participant',
              name: outcome.displayName,
            })
          : t('participants.proposal.declined', {
              defaultValue: '✕ Declined · naby won’t propose {{name}} again in this session',
              name: outcome.displayName,
            })}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        className="rounded px-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label={t('participants.proposal.dismiss', { defaultValue: 'Dismiss' })}
      >
        ✕
      </button>
    </div>
  );
});

function previewInput(input: unknown): string {
  try {
    const s = typeof input === 'string' ? input : JSON.stringify(input);
    if (!s) return '';
    return s.length > 160 ? `${s.slice(0, 160)}…` : s;
  } catch {
    return '';
  }
}

async function postResolve(body: Record<string, unknown>): Promise<void> {
  try {
    await fetch('/api/naby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approval.resolve', ...body }),
    });
  } catch {
    /* the turn's own TTL will deny if this never lands */
  }
}

export function ToolApprovalPrompt({ sessionId, cwd }: { sessionId?: string; cwd?: string }) {
  const { t } = useTranslation();
  const [queue, setQueue] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ProposalOutcome | null>(null);
  // The registry fills a proposal's colour (not on the wire). Through a ref so a
  // registry refresh does not re-subscribe the window listeners.
  const { lookup } = useParticipants();
  const lookupRef = useRef(lookup);
  lookupRef.current = lookup;
  const queueRef = useRef(queue);
  queueRef.current = queue;

  useEffect(() => {
    const onRequest = (e: Event) => {
      const d = (e as CustomEvent).detail as Record<string, unknown> | undefined;
      if (!d || typeof d.approvalId !== 'string') return;
      // Only handle prompts for THIS conversation (once we know our session id).
      if (sessionId && typeof d.session_id === 'string' && d.session_id !== sessionId) return;
      const proposal = proposalFromApproval(d, lookupRef.current) ?? undefined;
      const draft = proposal ? undefined : (draftFromApproval(d) ?? undefined);
      const speakerName = approvalSpeakerName(d);
      const item: Pending = {
        approvalId: d.approvalId,
        toolName: typeof d.tool_name === 'string' ? d.tool_name : 'tool',
        inputPreview: previewInput(d.input),
        // A proposal's / draft's `reason`/`source` are naby's, not an org hook's:
        // they are drawn by their own card and must not reach the hook-copy rules.
        ...(proposal ? { proposal } : draft ? { draft } : approvalAskerFrom(d)),
        ...(speakerName && !proposal && !draft ? { speakerName } : {}),
      };
      if (proposal || draft) setOutcome(null);
      setQueue((q) => (q.some((p) => p.approvalId === item.approvalId) ? q : [...q, item]));
    };
    const onResolved = (e: Event) => {
      const d = (e as CustomEvent).detail as Record<string, unknown> | undefined;
      if (!d || typeof d.approvalId !== 'string') return;
      // A proposal answered ELSEWHERE (Telegram) still leaves its line here.
      const pending = queueRef.current.find((p) => p.approvalId === d.approvalId);
      if (pending?.proposal && (d.decision === 'allow' || d.decision === 'deny')) {
        setOutcome({ approvalId: pending.approvalId, displayName: pending.proposal.displayName, decision: d.decision });
      }
      if (pending?.draft && (d.decision === 'allow' || d.decision === 'deny')) {
        setOutcome({
          approvalId: pending.approvalId,
          displayName: pending.draft.draft.displayName,
          decision: d.decision,
          draft: pending.draft.action,
        });
      }
      setQueue((q) => q.filter((p) => p.approvalId !== d.approvalId));
    };
    window.addEventListener('naby:approval_request', onRequest);
    window.addEventListener('naby:approval_resolved', onResolved);
    return () => {
      window.removeEventListener('naby:approval_request', onRequest);
      window.removeEventListener('naby:approval_resolved', onResolved);
    };
  }, [sessionId]);

  const current = queue[0];

  // The answered-proposal line folds away on its own.
  useEffect(() => {
    if (!outcome) return;
    const timer = setTimeout(() => setOutcome(null), OUTCOME_MS);
    return () => clearTimeout(timer);
  }, [outcome]);

  const act = useCallback(
    async (decision: 'allow' | 'deny', remember: boolean) => {
      if (!current) return;
      setBusy(true);
      // Optimistically drop the prompt; the paused turn resumes on the server.
      setQueue((q) => q.filter((p) => p.approvalId !== current.approvalId));
      if (current.proposal) {
        setOutcome({ approvalId: current.approvalId, displayName: current.proposal.displayName, decision });
      }
      // `remember` is never offered for a proposal (it is not a policy rule).
      const rememberOpts = remember && !current.proposal
        ? { remember: true, scope: cwd ? 'project' : 'user', scopeKey: cwd, toolPattern: current.toolName }
        : {};
      await postResolve({ approvalId: current.approvalId, decision, ...rememberOpts });
      setBusy(false);
    },
    [current, cwd],
  );

  // naby's participant draft (§8.12): edits and the session choice ride along;
  // never "remember" (R8.2).
  const answerDraft = async (choice: DraftChoice, form: DraftForm) => {
    if (!current?.draft) return;
    const card = current.draft;
    setBusy(true);
    setQueue((q) => q.filter((p) => p.approvalId !== current.approvalId));
    setOutcome({
      approvalId: current.approvalId,
      displayName: form.displayName.trim() || card.draft.displayName,
      decision: choice === 'decline' ? 'deny' : 'allow',
      draft: card.action,
    });
    await postResolve(draftResolveBody(current.approvalId, card, form, choice));
    setBusy(false);
  };

  if (!current) {
    return outcome ? <ProposalOutcomeLine outcome={outcome} onDismiss={() => setOutcome(null)} /> : null;
  }

  if (current.draft) {
    return (
      <ParticipantDraftCard
        // A fresh form per draft: the next queued draft must not inherit edits.
        key={current.approvalId}
        card={current.draft}
        busy={busy}
        more={queue.length - 1}
        onAnswer={(choice, form) => void answerDraft(choice, form)}
      />
    );
  }

  if (current.proposal) {
    return (
      <ParticipantProposalCard
        proposal={current.proposal}
        busy={busy}
        more={queue.length - 1}
        onApprove={() => void act('allow', false)}
        onDecline={() => void act('deny', false)}
      />
    );
  }

  const say = (line: ApprovalCopyLine): string =>
    'text' in line ? line.text : t(line.key, { ...line.params, defaultValue: line.defaultValue });
  const reasonLines = approvalReasonLines(current);
  const rememberNote = approvalRememberNote(current);

  const btn = BTN;

  return (
    // The approval card (shell-look-and-feel section 5): a brand-edged card,
    // the question as a chip, and the one primary action filled.
    <div className="mx-4 mb-2 rounded-xl border-[1.5px] border-brand/40 bg-card p-3.5 shadow-card" data-testid="tool-approval">
      <div className="inline-flex items-center rounded-sm bg-accent px-2 py-0.5 text-xs font-semibold text-accent-foreground">
        {t('toolApproval.title', { defaultValue: 'Allow the agent to run this tool?' })}
      </div>
      <div className="mt-2 text-sm font-mono text-foreground break-all" data-testid="tool-approval-name">
        {current.toolName}
      </div>
      {current.speakerName ? (
        <div className="mt-1 text-xs font-semibold text-foreground" data-testid="tool-approval-speaker">
          {t('toolApproval.askedBy', { defaultValue: 'Requested by {{name}}', name: current.speakerName })}
        </div>
      ) : null}
      {reasonLines.map((line, i) => (
        <div
          key={i}
          className="mt-1 text-xs text-foreground whitespace-pre-wrap break-words"
          data-testid="tool-approval-reason"
        >
          {say(line)}
        </div>
      ))}
      {current.inputPreview ? (
        <div className="mt-0.5 text-[0.786rem] font-mono text-muted-foreground break-all line-clamp-2">
          {current.inputPreview}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-1.5">
        <button
          onClick={() => void act('allow', false)}
          disabled={busy}
          className={`${btn} border-transparent bg-primary text-primary-foreground hover:bg-primary/90`}
        >
          {t('toolApproval.allowOnce', { defaultValue: 'Allow once' })}
        </button>
        <button
          onClick={() => void act('deny', false)}
          disabled={busy}
          className={`${btn} border-border bg-card text-destructive hover:border-destructive/50 hover:bg-destructive/10`}
        >
          {t('toolApproval.denyOnce', { defaultValue: 'Deny once' })}
        </button>
        {!approvalOffersRemember(current) ? null : (
          <>
            <button
              onClick={() => void act('allow', true)}
              disabled={busy}
              className={`${btn} border-transparent bg-secondary text-muted-foreground hover:text-foreground hover:bg-accent`}
            >
              {t('toolApproval.alwaysAllow', { defaultValue: 'Always allow' })}
            </button>
            <button
              onClick={() => void act('deny', true)}
              disabled={busy}
              className={`${btn} border-transparent bg-secondary text-muted-foreground hover:text-foreground hover:bg-accent`}
            >
              {t('toolApproval.alwaysBlock', { defaultValue: 'Always block' })}
            </button>
          </>
        )}
      </div>
      {rememberNote ? (
        <div className="mt-1.5 text-[0.714rem] text-muted-foreground" data-testid="tool-approval-remember-note">
          {say(rememberNote)}
        </div>
      ) : null}
      {queue.length > 1 ? (
        <div className="mt-1.5 text-[0.714rem] text-muted-foreground">
          {t('toolApproval.more', { defaultValue: '+{{count}} more waiting', count: queue.length - 1 })}
        </div>
      ) : null}
    </div>
  );
}
