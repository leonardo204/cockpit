'use client';

/**
 * A participant's avatar (multi-agent-chat R6.1): the emoji or image on a disc
 * tinted with the participant's identifying colour, ringed in the same colour.
 * Shared by the roster, the speaker card, the palette, the proposal card and the
 * Settings list, so one participant looks the same everywhere it appears.
 *
 * The colour is DATA (the user picked it), so it is applied as an inline style
 * rather than a token — shell-look-and-feel §4 rule 3 leaves identifying data
 * colours alone.
 */

import { memo } from 'react';
import type { ParticipantAvatar as Avatar } from './participants';

const SIZES = {
  xs: 'w-5 h-5 text-[0.714rem]',
  sm: 'w-6 h-6 text-xs',
  md: 'w-8 h-8 text-base',
  lg: 'w-10 h-10 text-xl',
} as const;

export type ParticipantAvatarSize = keyof typeof SIZES;

export const ParticipantAvatar = memo(function ParticipantAvatar({
  avatar,
  color,
  size = 'md',
  title,
  speaking = false,
  className = '',
}: {
  avatar: Avatar;
  color: string;
  size?: ParticipantAvatarSize;
  title?: string;
  /** Pulse the ring: this participant is speaking now (R6.2). */
  speaking?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`relative inline-grid shrink-0 place-items-center rounded-full leading-none select-none ${SIZES[size]} ${
        speaking ? 'participant-speaking' : ''
      } ${className}`}
      style={{
        background: `color-mix(in srgb, ${color} 18%, hsl(var(--card)))`,
        boxShadow: `0 0 0 1px color-mix(in srgb, ${color} 45%, transparent)`,
        ['--participant-color' as string]: color,
      }}
      title={title}
      data-participant-avatar=""
    >
      {avatar.kind === 'image' ? (
        <img src={avatar.dataUrl} alt="" className="h-full w-full rounded-full object-cover" />
      ) : (
        <span aria-hidden="true">{avatar.value}</span>
      )}
    </span>
  );
});

/** naby's own mark in the roster and the strip: the butterfly, brand-tinted. */
export const NabyAvatar = memo(function NabyAvatar({
  size = 'md',
  speaking = false,
  title,
}: {
  size?: ParticipantAvatarSize;
  speaking?: boolean;
  title?: string;
}) {
  return (
    <span
      className={`relative inline-grid shrink-0 place-items-center rounded-full bg-accent leading-none ring-1 ring-brand/40 select-none ${SIZES[size]} ${
        speaking ? 'participant-speaking' : ''
      }`}
      style={{ ['--participant-color' as string]: 'hsl(var(--brand))' }}
      title={title}
      data-naby-avatar=""
    >
      <span aria-hidden="true">🦋</span>
    </span>
  );
});
