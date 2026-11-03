'use client';

/**
 * THE RE-LOGIN GUIDE — what a turn that failed on an expired Claude sign-in
 * shows instead of a plain error (specs/claude-relogin-guide.md §1.2).
 *
 * The plain report told the user to "press Log in on the Claude chip". But a
 * refresh that failed still reads "signed in" to `claude auth status`, so the
 * chip offered only Log out, and the user had to work out log out → log in on
 * their own. This card spells the steps out:
 *
 *   1. click the Claude chip   2. Log out   3. Log in, finish in the browser
 *   4. Send again
 *
 * GUIDANCE, NOT AUTOMATION. naby never signs the user out or in from here: the
 * user presses the chip's own buttons. The card only FOLLOWS the status the chip
 * reads (claudeLoginFlow.ts — the chip publishes, the card subscribes; no poll
 * and no action of its own) and ticks the steps off: signed out → step 2 ✓,
 * signed in after that → step 3 ✓ and "Send again" is emphasised. "Send again"
 * is clickable throughout — a status read can lag the real sign-in.
 *
 * The SDK's original words are folded under "Details", closed by default: on
 * this card they do not help anyone decide what to do (R8).
 */

import { Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  LOGIN_COMMAND,
  RELOGIN_START,
  getClaudeLoginStatus,
  reloginProgress,
  subscribeClaudeLoginStatus,
  type ReloginGuide,
  type ReloginProgress,
} from './claudeLoginFlow';

interface ClaudeReloginCardProps {
  /** The SDK's own message, shown folded under "Details". */
  detail?: string;
  /** Resend the failed turn's message. Absent when there is none to resend —
   *  the card then asks the user to send it again themselves (R5). */
  onResend?: () => void;
  /** Start from this progress. For static rendering in tests; the app omits it. */
  initialProgress?: ReloginProgress;
  /** This conversation's chip highlight (R3a): the card reports progress into
   *  it, and step 1's "Claude chip" opens / flashes the chip through it. */
  guide?: ReloginGuide;
}

/** "**bold**" in a translated step → <strong>, or whatever `bold` renders. The
 *  steps name the controls to press, and those names are what the eye looks for. */
function emphasis(text: string, bold: (part: string, key: number) => ReactNode = (part, key) => <strong key={key}>{part}</strong>): ReactNode {
  return text.split('**').map((part, i) => (i % 2 === 1 ? bold(part, i) : <Fragment key={i}>{part}</Fragment>));
}

export function ClaudeReloginCard({ detail, onResend, initialProgress, guide }: ClaudeReloginCardProps) {
  const { t } = useTranslation();
  // The chip's last reading — the same value, never a second fetch (R3–R4).
  const status = useSyncExternalStore(subscribeClaudeLoginStatus, getClaudeLoginStatus, getClaudeLoginStatus);
  const [progress, setProgress] = useState<ReloginProgress>(() =>
    reloginProgress(initialProgress ?? RELOGIN_START, status),
  );
  useEffect(() => {
    setProgress((prev) => reloginProgress(prev, status));
  }, [status]);
  // R3a — the chip pulses while this card is up and the sign-in is not back.
  // Signed in again, dismissed, or superseded by the next send (both unmount
  // this card) → it stops.
  useEffect(() => {
    guide?.report({ active: !progress.signedInAgain, loggedOut: progress.loggedOut });
  }, [guide, progress]);
  useEffect(() => () => guide?.report({ active: false, loggedOut: false }), [guide]);

  const [showDetail, setShowDetail] = useState(false);
  const [copied, setCopied] = useState(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const copyCommand = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(LOGIN_COMMAND);
      if (!aliveRef.current) return;
      setCopied(true);
      setTimeout(() => {
        if (aliveRef.current) setCopied(false);
      }, 1500);
    } catch {
      // Clipboard denied — the command is shown in full beside the button.
    }
  }, []);

  const steps: { key: string; text: string; done: boolean }[] = [
    {
      key: 'step1',
      text: t('chat.relogin.step1', { defaultValue: 'Click the **Claude chip** (your account email) above the chat.' }),
      done: progress.loggedOut,
    },
    { key: 'step2', text: t('chat.relogin.step2', { defaultValue: 'Choose **Log out** in its menu.' }), done: progress.loggedOut },
    {
      key: 'step3',
      text: t('chat.relogin.step3', {
        defaultValue: 'Click **Log in** on the chip, and finish signing in in the browser that opens.',
      }),
      done: progress.signedInAgain,
    },
    { key: 'step4', text: t('chat.relogin.step4', { defaultValue: 'Come back and press **Send again** below.' }), done: false },
  ];
  const doneLabel = t('chat.relogin.stepDone', { defaultValue: 'Done' });
  // The command sits INSIDE the translated sentence, where each language puts it.
  const [beforeCommand, afterCommand = ''] = t('chat.relogin.terminal', {
    command: '%COMMAND%',
    defaultValue: 'If no browser opens, run this in a terminal: {{command}}',
  }).split('%COMMAND%');
  const raw = (detail ?? '').trim();
  const ready = progress.signedInAgain;

  return (
    <div
      data-testid="claude-relogin-card"
      data-logged-out={progress.loggedOut ? 'true' : 'false'}
      data-signed-in-again={ready ? 'true' : 'false'}
      className="mt-0.5 flex flex-col gap-1.5"
    >
      <p className="break-words text-[0.786rem] leading-5 text-foreground/90">
        <span className="font-medium">{t('chat.relogin.title', { defaultValue: 'Your Claude sign-in has expired.' })}</span>{' '}
        {t('chat.relogin.intro', { defaultValue: 'Sign in again with these steps to carry on.' })}
      </p>

      <ol className="flex flex-col gap-0.5 text-[0.786rem] leading-5 text-foreground/90">
        {steps.map((step, i) => (
          <li key={step.key} data-testid={`claude-relogin-${step.key}`} data-done={step.done ? 'true' : 'false'} className="flex gap-1.5">
            <span className={`w-4 shrink-0 text-right ${step.done ? 'text-success' : 'text-muted-foreground'}`}>
              {step.done ? <span aria-label={doneLabel}>✓</span> : `${i + 1}.`}
            </span>
            <span className={`min-w-0 break-words ${step.done ? 'text-muted-foreground' : ''}`}>
              {step.key === 'step1' && guide
                ? // "Claude chip" is a way to the chip, not just its name:
                  // click opens its menu, hover flashes its ring (R3a).
                  emphasis(step.text, (part, key) => (
                    <button
                      key={key}
                      type="button"
                      onClick={guide.requestOpen}
                      onMouseEnter={guide.requestFlash}
                      data-testid="claude-relogin-chip-link"
                      className="font-semibold text-foreground underline decoration-brand decoration-dotted underline-offset-2 hover:decoration-solid"
                    >
                      {part}
                    </button>
                  ))
                : emphasis(step.text)}
            </span>
          </li>
        ))}
      </ol>

      {onResend ? (
        // Clickable at every step: the status this card follows can lag a
        // sign-in that has already landed (R5). Emphasised once it reads back.
        <button
          type="button"
          onClick={onResend}
          data-testid="claude-relogin-resend"
          data-emphasis={ready ? 'true' : 'false'}
          className={
            ready
              ? 'self-start rounded border border-brand bg-brand/15 px-2 py-1 text-[0.786rem] font-medium text-foreground hover:bg-brand/25'
              : 'self-start rounded border border-border px-2 py-1 text-[0.786rem] text-foreground hover:bg-accent'
          }
        >
          {t('chat.relogin.resend', { defaultValue: 'Send again' })}
        </button>
      ) : (
        <p className="text-[0.786rem] leading-5 text-muted-foreground" data-testid="claude-relogin-resend-manually">
          {t('chat.relogin.resendManually', { defaultValue: 'Please send your message again.' })}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1 text-[0.72rem] leading-5 text-muted-foreground" data-testid="claude-relogin-terminal">
        <span>
          {beforeCommand}
          <code className="rounded bg-secondary px-1 py-0.5 text-foreground">{LOGIN_COMMAND}</code>
          {afterCommand}
        </span>
        <button
          type="button"
          onClick={() => void copyCommand()}
          data-testid="claude-relogin-copy"
          className="rounded border border-border px-1.5 py-0.5 hover:bg-accent"
        >
          {copied
            ? t('chat.relogin.copied', { defaultValue: 'Copied' })
            : t('chat.relogin.copy', { defaultValue: 'Copy' })}
        </button>
      </div>

      {raw && (
        <div>
          <button
            type="button"
            onClick={() => setShowDetail((v) => !v)}
            aria-expanded={showDetail}
            data-testid="claude-relogin-detail-toggle"
            className="text-[0.72rem] leading-4 text-muted-foreground underline hover:text-foreground"
          >
            {showDetail
              ? t('chat.runFailedHide', { defaultValue: 'Hide details' })
              : t('chat.runFailedDetails', { defaultValue: 'Details' })}
          </button>
          {showDetail && (
            <pre
              data-testid="claude-relogin-detail"
              className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded border border-border/60 bg-card/60 p-2 text-[0.75rem] leading-5 text-muted-foreground"
            >
              {raw}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
