'use client';

/**
 * Phase 3 (P3-M5) — the in-conversation CHECK-IN prompt.
 *
 * When the agent calls `naby_checkin` the turn PAUSES and the server emits a
 * `checkin_request` RunEvent; the stream hooks re-dispatch it as a
 * `naby:checkin_request` DOM event. This component shows the question, and POSTs
 * the pick to `/api/naby {checkin.resolve}` to resume the paused turn.
 *
 * Built alongside <ToolApprovalPrompt> rather than inside it: an approval is a
 * yes/no about a TOOL, a check-in is a choice among ways to do the WORK, and the
 * answer to a check-in is the trust meter's label. Sharing one component would
 * mean a mode flag threaded through every branch.
 *
 * WHY THE RECOMMENDATION IS HIDDEN UNTIL AFTER THE ANSWER. The whole meter rests
 * on the pick being an honest read of whether naby guessed right. Marking its
 * recommendation in the list would make clicking that option the path of least
 * resistance, and the meter would then be measuring how agreeable the UI is. So
 * the user chooses blind; the recommendation is REVEALED once they have. They
 * still see how well naby knows them — more convincingly, in fact, because they
 * know the guess was made before they answered.
 *
 * HOW LONG THE REVEAL LASTS. It used to last until someone clicked its ✕, which
 * meant a banner about a question answered twenty minutes ago went on commenting
 * on a conversation that had moved on. It now belongs to the exchange that
 * earned it and retires when the next turn starts (`runNonce`). The rule is
 * `checkinReveal.ts`; the ✕ still works for anyone who wants it gone sooner.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { reduceReveal, type RevealBanner } from './checkinReveal';

type Pending = {
  checkinId: string;
  question: string;
  options: string[];
  recommended: number;
};

async function postResolve(body: Record<string, unknown>): Promise<void> {
  try {
    await fetch('/api/naby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'checkin.resolve', ...body }),
    });
  } catch {
    /* the turn's own TTL expires the prompt if this never lands */
  }
}

export function CheckinPrompt({
  sessionId,
  runNonce = 0,
}: {
  sessionId?: string;
  /** Bumped by <Chat/> each time a turn STARTS on this session — the user
   *  sending, or a turn arriving from Telegram / a scheduled task. It is what
   *  retires the reveal banner: the conversation has moved past the exchange
   *  the banner is about. */
  runNonce?: number;
}) {
  const { t } = useTranslation();
  const [queue, setQueue] = useState<Pending[]>([]);
  const [revealed, setRevealed] = useState<RevealBanner | null>(null);
  const [writing, setWriting] = useState(false);
  const [correction, setCorrection] = useState('');
  const [busy, setBusy] = useState(false);

  // Read at answer time so the banner records the turn it was earned in,
  // without `answer` taking runNonce as a dependency (a bump mid-question would
  // otherwise rebuild the callback under the user's fingers).
  const runNonceRef = useRef(runNonce);
  runNonceRef.current = runNonce;

  // The conversation moved on → the banner goes, with no click and no timer.
  // Guarded inside the reducer: the reveal is created WHILE its own turn is
  // still in flight (a check-in pauses the turn and the answer resumes it), so
  // only a STRICTLY newer turn retires it.
  useEffect(() => {
    setRevealed((b) => reduceReveal(b, { kind: 'run-start', run: runNonce }));
  }, [runNonce]);

  useEffect(() => {
    const onRequest = (e: Event) => {
      const d = (e as CustomEvent).detail as Record<string, unknown> | undefined;
      if (!d || typeof d.checkinId !== 'string') return;
      // Only handle prompts for THIS conversation, so a hidden tab never steals
      // a question meant for the visible one.
      if (sessionId && typeof d.session_id === 'string' && d.session_id !== sessionId) return;
      const options = Array.isArray(d.options) ? d.options.map((o) => String(o)) : [];
      if (options.length < 2) return; // a malformed request is not answerable
      const item: Pending = {
        checkinId: d.checkinId,
        question: typeof d.question === 'string' ? d.question : '',
        options,
        recommended: typeof d.recommended === 'number' ? d.recommended : -1,
      };
      setQueue((q) => (q.some((p) => p.checkinId === item.checkinId) ? q : [...q, item]));
      // A new question supersedes the last reveal.
      setRevealed((b) => reduceReveal(b, { kind: 'question' }));
    };
    const onResolved = (e: Event) => {
      const d = (e as CustomEvent).detail as Record<string, unknown> | undefined;
      if (!d || typeof d.checkinId !== 'string') return;
      setQueue((q) => q.filter((p) => p.checkinId !== d.checkinId));
    };
    window.addEventListener('naby:checkin_request', onRequest);
    window.addEventListener('naby:checkin_resolved', onResolved);
    return () => {
      window.removeEventListener('naby:checkin_request', onRequest);
      window.removeEventListener('naby:checkin_resolved', onResolved);
    };
  }, [sessionId]);

  const current = queue[0];

  const answer = useCallback(
    async (chosen: number, text?: string) => {
      if (!current) return;
      setBusy(true);
      // Drop the prompt optimistically — the paused turn resumes server-side, and
      // the `checkin_resolved` event that follows would remove it anyway.
      setQueue((q) => q.filter((p) => p.checkinId !== current.checkinId));
      setWriting(false);
      setCorrection('');
      setRevealed((b) =>
        reduceReveal(b, {
          kind: 'answered',
          question: current.question,
          recommendedOption: current.options[current.recommended] ?? '',
          hit: chosen >= 0 && chosen === current.recommended,
          run: runNonceRef.current,
        }),
      );
      await postResolve({
        checkinId: current.checkinId,
        chosen,
        ...(text ? { correction: text } : {}),
      });
      setBusy(false);
    },
    [current],
  );

  if (!current) {
    // A check-in with no recorded recommendation produces no banner at all —
    // the reducer already refused to build one, so this is just "nothing to
    // show".
    if (!revealed) return null;
    return (
      <div
        className="mx-4 mb-2 flex items-start gap-2 rounded-lg border border-border bg-accent/40 px-3 py-2"
        data-testid="checkin-reveal"
      >
        <span className="text-sm leading-5">{revealed.hit ? '🦋' : '🐛'}</span>
        <div className="flex-1 text-[0.786rem] leading-5 text-muted-foreground">
          {revealed.hit
            ? t('checkin.revealHit', {
                defaultValue: 'naby had recommended the same thing: {{option}}',
                option: revealed.recommendedOption,
              })
            : t('checkin.revealMiss', {
                defaultValue: 'naby had recommended: {{option}} — noted for next time',
                option: revealed.recommendedOption,
              })}
        </div>
        <button
          onClick={() => setRevealed((b) => reduceReveal(b, { kind: 'dismiss' }))}
          data-testid="checkin-reveal-close"
          className="text-[0.786rem] text-muted-foreground hover:text-foreground"
          aria-label={t('common.close', { defaultValue: 'Close' })}
        >
          ✕
        </button>
      </div>
    );
  }

  const btn =
    'w-full text-left text-xs px-2.5 py-1.5 rounded border border-border hover:bg-accent hover:border-foreground/30 disabled:opacity-50 transition-colors';

  return (
    <div
      className="mx-4 mb-2 rounded-lg border border-sky-500/50 bg-sky-500/10 p-3"
      data-testid="checkin-prompt"
    >
      <div className="text-xs font-medium text-sky-700 dark:text-sky-300">
        {t('checkin.title', { defaultValue: 'naby is asking how to proceed' })}
      </div>
      <div className="mt-1 text-sm text-foreground" data-testid="checkin-question">
        {current.question}
      </div>
      <div className="mt-2 flex flex-col gap-1">
        {current.options.map((o, i) => (
          <button
            key={`${current.checkinId}:${i}`}
            onClick={() => void answer(i)}
            disabled={busy}
            className={btn}
            data-testid={`checkin-option-${i}`}
          >
            <span className="mr-1.5 text-muted-foreground">{i + 1}</span>
            {o}
          </button>
        ))}
      </div>
      {writing ? (
        <div className="mt-2 flex gap-1.5">
          <input
            autoFocus
            value={correction}
            onChange={(e) => setCorrection(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && correction.trim()) void answer(-1, correction.trim());
              if (e.key === 'Escape') setWriting(false);
            }}
            placeholder={t('checkin.otherPlaceholder', { defaultValue: 'Say how you want it done' })}
            className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:border-foreground/40"
            data-testid="checkin-correction"
          />
          <button
            onClick={() => correction.trim() && void answer(-1, correction.trim())}
            disabled={busy || !correction.trim()}
            className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50 hover:bg-accent"
          >
            {t('checkin.send', { defaultValue: 'Send' })}
          </button>
        </div>
      ) : (
        <button
          onClick={() => setWriting(true)}
          disabled={busy}
          className="mt-1.5 text-[0.786rem] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          data-testid="checkin-other"
        >
          {t('checkin.other', { defaultValue: 'Neither — I will explain' })}
        </button>
      )}
      {queue.length > 1 ? (
        <div className="mt-1.5 text-[0.714rem] text-muted-foreground">
          {t('checkin.more', { defaultValue: '+{{count}} more waiting', count: queue.length - 1 })}
        </div>
      ) : null}
    </div>
  );
}
