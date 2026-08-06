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

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Pending = { approvalId: string; toolName: string; inputPreview: string };

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

  useEffect(() => {
    const onRequest = (e: Event) => {
      const d = (e as CustomEvent).detail as Record<string, unknown> | undefined;
      if (!d || typeof d.approvalId !== 'string') return;
      // Only handle prompts for THIS conversation (once we know our session id).
      if (sessionId && typeof d.session_id === 'string' && d.session_id !== sessionId) return;
      const item: Pending = {
        approvalId: d.approvalId,
        toolName: typeof d.tool_name === 'string' ? d.tool_name : 'tool',
        inputPreview: previewInput(d.input),
      };
      setQueue((q) => (q.some((p) => p.approvalId === item.approvalId) ? q : [...q, item]));
    };
    const onResolved = (e: Event) => {
      const d = (e as CustomEvent).detail as Record<string, unknown> | undefined;
      if (!d || typeof d.approvalId !== 'string') return;
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

  const act = useCallback(
    async (decision: 'allow' | 'deny', remember: boolean) => {
      if (!current) return;
      setBusy(true);
      // Optimistically drop the prompt; the paused turn resumes on the server.
      setQueue((q) => q.filter((p) => p.approvalId !== current.approvalId));
      const rememberOpts = remember
        ? { remember: true, scope: cwd ? 'project' : 'user', scopeKey: cwd, toolPattern: current.toolName }
        : {};
      await postResolve({ approvalId: current.approvalId, decision, ...rememberOpts });
      setBusy(false);
    },
    [current, cwd],
  );

  if (!current) return null;

  const btn = 'text-xs px-2.5 py-1 rounded border disabled:opacity-50 transition-colors';

  return (
    <div className="mx-4 mb-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3" data-testid="tool-approval">
      <div className="text-xs font-medium text-amber-700 dark:text-amber-300">
        {t('toolApproval.title', { defaultValue: 'Allow the agent to run this tool?' })}
      </div>
      <div className="mt-1 text-sm font-mono text-foreground break-all" data-testid="tool-approval-name">
        {current.toolName}
      </div>
      {current.inputPreview ? (
        <div className="mt-0.5 text-[0.786rem] font-mono text-muted-foreground break-all line-clamp-2">
          {current.inputPreview}
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          onClick={() => void act('allow', false)}
          disabled={busy}
          className={`${btn} border-emerald-500/50 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/15`}
        >
          {t('toolApproval.allowOnce', { defaultValue: 'Allow once' })}
        </button>
        <button
          onClick={() => void act('deny', false)}
          disabled={busy}
          className={`${btn} border-red-500/50 text-red-600 dark:text-red-400 hover:bg-red-500/15`}
        >
          {t('toolApproval.denyOnce', { defaultValue: 'Deny once' })}
        </button>
        <button
          onClick={() => void act('allow', true)}
          disabled={busy}
          className={`${btn} border-border text-muted-foreground hover:text-foreground hover:bg-accent`}
        >
          {t('toolApproval.alwaysAllow', { defaultValue: 'Always allow' })}
        </button>
        <button
          onClick={() => void act('deny', true)}
          disabled={busy}
          className={`${btn} border-border text-muted-foreground hover:text-foreground hover:bg-accent`}
        >
          {t('toolApproval.alwaysBlock', { defaultValue: 'Always block' })}
        </button>
      </div>
      {queue.length > 1 ? (
        <div className="mt-1.5 text-[0.714rem] text-muted-foreground">
          {t('toolApproval.more', { defaultValue: '+{{count}} more waiting', count: queue.length - 1 })}
        </div>
      ) : null}
    </div>
  );
}
