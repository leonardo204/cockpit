'use client';

/**
 * WHO IS SPEAKING, AND WHO IS NEXT (multi-agent-chat R6.5).
 *
 * While a round with participants runs, one strip above the composer says who
 * holds the turn ("Translator is speaking"), which speech of the round it is,
 * and — once naby has handed the turn on but the next speaker has not started —
 * "next: @b". Its Stop button is the same `requestStop` as everywhere else and
 * ends the WHOLE round (§8.2: an abort is END from any state). An ordinary
 * turn (no routing marker, no participant bubble) shows no strip at all.
 */

import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { NabyAvatar } from '@cockpit/shared-ui';
import { ParticipantAvatar } from './ParticipantAvatar';
import type { ActingAgent } from './actingAgent';
import type { ParticipantInfo, RoundProgress } from './participants';

export const RoundProgressStrip = memo(function RoundProgressStrip({
  progress,
  acting,
  speakerName,
  next,
  onStop,
}: {
  progress: RoundProgress;
  acting: ActingAgent | null;
  /** The localized name of whoever is speaking now. */
  speakerName: string;
  /** The participant `next` points at, when the registry knows it. */
  next?: ParticipantInfo;
  onStop?: () => void;
}) {
  const { t } = useTranslation();
  const nextName = progress.next ? (next?.displayName ?? progress.next.name) : null;
  return (
    <div
      className="round-progress-bar mx-4 mb-2 flex items-center gap-2 rounded-lg bg-muted py-1.5 pl-3 pr-2 text-xs font-bold text-foreground"
      data-testid="round-progress"
    >
      {acting?.participant && acting.avatar ? (
        <ParticipantAvatar avatar={acting.avatar} color={acting.color ?? '#8B8FA3'} size="xs" speaking />
      ) : (
        <NabyAvatar size={20} speaking />
      )}
      <span>{t('participants.progress.speaking', { defaultValue: '{{name}} is speaking', name: speakerName })}</span>
      <span className="font-semibold text-muted-foreground">
        {nextName ? (
          <>
            · {t('participants.progress.next', { defaultValue: 'next' })}:{' '}
            <span
              className="rounded-sm px-1 font-extrabold"
              style={
                next
                  ? { color: next.color, background: `color-mix(in srgb, ${next.color} 12%, transparent)` }
                  : undefined
              }
              data-testid="round-next"
            >
              @{nextName}
            </span>{' '}
          </>
        ) : null}
        ·{' '}
        {/* No "/max": the round has no fixed speech limit (§8.15 R11.1). */}
        {t('participants.progress.speech', {
          defaultValue: 'speech {{n}}',
          n: progress.speech,
        })}
      </span>
      <span className="flex-1" />
      {onStop ? (
        <button
          type="button"
          onClick={onStop}
          className="rounded border border-border bg-card px-1.5 py-0.5 text-[0.786rem] font-medium text-muted-foreground hover:border-destructive/50 hover:text-destructive"
          title={t('chat.stopHint', { defaultValue: 'Stop this turn (or press Esc)' })}
          data-testid="round-stop"
        >
          {t('chat.stop', { defaultValue: 'Stop' })}
        </button>
      ) : null}
    </div>
  );
});
