'use client';

/**
 * WHAT THE LAST RUN SAID WHEN IT FAILED — and kept saying until the user moves on.
 *
 * A failed turn used to appear as a `⚠️ …` line inside the assistant bubble and
 * then vanish a second later, because the post-run reconcile re-syncs the
 * transcript to disk and an error is never written to disk (see runFailure.ts
 * for the full mechanism). Reported as "the answer shows up and immediately
 * disappears" — there had never been an answer.
 *
 * So this is NOT a message. It is one banner about the last run, rendered
 * beside the other things that live in this slot (<CheckinPrompt/>,
 * <ContextLimitBanner/>) and outside the message array entirely, which is what
 * makes it survive the reconcile.
 *
 * IT DOES NOT SUMMARISE THE PROVIDER. The verbatim text is the actionable part:
 * "Quota exceeded … limit: 0, model: gemini-2.5-pro" says that this model can
 * never answer on this plan, which no paraphrase of "something went wrong"
 * would ever tell the user. The first line is the headline, and the whole
 * message sits underneath in a bounded, scrollable block so a paragraph-long
 * provider error cannot push the composer off the screen.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runFailureHeadline, runFailureOrigin, type RunFailure } from './runFailure';

interface RunFailureNoticeProps {
  /** The last run's failure, or null when the last run did not fail. */
  failure: RunFailure | null;
  /** The user closed it. Clearing is the host's (Chat's) reducer call. */
  onDismiss: () => void;
}

export function RunFailureNotice({ failure, onDismiss }: RunFailureNoticeProps) {
  const { t } = useTranslation();
  // Open by default: the detail is the reason this exists, and a user who has
  // just watched a turn do nothing should not have to find a disclosure
  // triangle to learn why. Bounded height keeps that from costing the layout.
  const [expanded, setExpanded] = useState(true);
  const at = failure?.at ?? null;
  // A NEW failure re-opens: a collapse applies to the report it was made on,
  // not to every future one.
  useEffect(() => {
    setExpanded(true);
  }, [at]);

  if (!failure) return null;
  const origin = runFailureOrigin(failure);
  const message = failure.message;
  const headline = runFailureHeadline(message);
  // Only offer the toggle when there is something the headline is not already
  // showing in full.
  const hasDetail = message.trim() !== headline;

  return (
    <div
      role="alert"
      data-testid="run-failure-notice"
      className="mx-4 mb-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2"
    >
      <div className="flex items-start gap-2">
        <span className="self-start text-sm leading-5">⚠️</span>
        <div className="min-w-0 flex-1">
          <div className="text-[0.786rem] leading-5 text-foreground">
            <span className="font-medium">
              {t('chat.runFailedTitle', { defaultValue: 'This turn failed' })}
            </span>
            {origin && (
              <span className="text-muted-foreground">
                {' · '}
                {t('chat.runFailedOn', { origin, defaultValue: 'on {{origin}}' })}
              </span>
            )}
          </div>
          <p
            className="mt-0.5 break-words text-[0.786rem] leading-5 text-foreground/90"
            data-testid="run-failure-headline"
          >
            {headline}
          </p>
        </div>
        {hasDetail && (
          // `self-start`, like the dismiss button: a flex child with no `self-*`
          // stretches to the tallest item in the row (CLAUDE.md, UI Layout), and
          // the text column beside these is two lines tall.
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            data-testid="run-failure-toggle"
            aria-expanded={expanded}
            className="self-start rounded border border-border px-2 py-1 text-[0.786rem] text-foreground hover:bg-accent"
          >
            {expanded
              ? t('chat.runFailedHide', { defaultValue: 'Hide details' })
              : t('chat.runFailedDetails', { defaultValue: 'Details' })}
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('chat.runFailedDismiss', { defaultValue: 'Dismiss' })}
          data-testid="run-failure-dismiss"
          className="self-start text-muted-foreground hover:text-foreground"
        >
          ✕
        </button>
      </div>

      {expanded && hasDetail && (
        // The provider's own words, unedited and selectable. Bounded to ~10rem
        // and scrolled from here, so a long error scrolls inside its own box
        // instead of pushing the composer off screen.
        <pre
          data-testid="run-failure-detail"
          className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded border border-border/60 bg-card/60 p-2 text-[0.75rem] leading-5 text-muted-foreground"
        >
          {message}
        </pre>
      )}

      <p className="mt-1 text-[0.72rem] leading-4 text-muted-foreground">
        {t('chat.runFailedHint', {
          defaultValue: 'This is what the provider replied, unedited. Your next message clears it.',
        })}
      </p>
    </div>
  );
}
