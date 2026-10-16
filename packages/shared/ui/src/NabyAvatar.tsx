'use client';

/**
 * NABY'S OWN FACE (multi-agent-chat §8.5, MAC-M3b).
 *
 * A small, round, friendly butterfly drawn inline: two pairs of soft wings in the
 * brand gradient (`--brand` → `--brand-2`), a round head and a small body, two
 * dot eyes, a smile, a blush, and antennae with round tips. Everywhere naby is
 * represented — the roster, its bubble, the thinking bubble, the routing chips,
 * the proposal card, Settings — draws this one mark, so naby reads as the same
 * someone wherever it appears. Participants keep `ParticipantAvatar`.
 *
 * THEMING. The wings, the disc and the antennae follow the theme: the wings are
 * the brand gradient, the disc is `--accent`, and the antennae are
 * `currentColor`, which defaults to `--violet-12` (the darkest violet on light,
 * the lightest on dark) so they stay visible on either page. The face itself is
 * a constant — a white head with dark dot eyes and a pink blush — because that
 * is what reads as one friendly character on both themes. Every variable carries
 * a light-theme fallback, so the mark still draws outside the app's stylesheet
 * (an exported HTML page, a test).
 *
 * SIZES. Drawn on a 40-unit grid and checked at 20, 28 and 40 px: the features
 * are deliberately large for the grid (eyes 2.6 units, a head a third of the
 * width) so the face survives at 20 px.
 */

import { memo, useId, type CSSProperties } from 'react';

export interface NabyAvatarProps {
  /** Rendered size in px (square). Designed for 20, 28 and 40. */
  size?: number;
  /** Pulse the ring: naby is speaking now (same animation as a participant). */
  speaking?: boolean;
  /** No soft disc behind the butterfly — for inline use (nav rows, chips). */
  bare?: boolean;
  /** Accessible name. Always 나비 unless a caller has a reason to say more. */
  label?: string;
  title?: string;
  className?: string;
}

const BRAND = 'hsl(var(--brand, 252 100% 65%))';
const BRAND_2 = 'hsl(var(--brand-2, 255 100% 74%))';
// The face stays light on both themes: a pale face with dark dot eyes is what
// reads as "cute"; a dark face read as a bug in the dark-theme review.
const FACE = '#FFFFFF';
const FACE_INK = '#2A1F5C';
const DISC = 'hsl(var(--accent, 254 100% 96%))';
const INK = 'hsl(var(--violet-12, 254 60% 20%))';
const BLUSH = '#FF8FB1';

export const NabyAvatar = memo(function NabyAvatar({
  size = 28,
  speaking = false,
  bare = false,
  label = '나비',
  title,
  className = '',
}: NabyAvatarProps) {
  // `useId` yields `_r_0_`-style ids; keep only what is safe inside `url(#…)`.
  const gid = `naby-wing-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const fill = `url(#${gid})`;
  const style: CSSProperties = {
    width: size,
    height: size,
    color: INK,
    ['--participant-color' as string]: BRAND,
  };
  return (
    <svg
      viewBox="0 0 40 40"
      width={size}
      height={size}
      role="img"
      aria-label={label}
      className={`inline-block shrink-0 rounded-full align-middle select-none ${speaking ? 'participant-speaking' : ''} ${className}`}
      style={style}
      data-naby-avatar=""
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: BRAND }} />
          <stop offset="1" style={{ stopColor: BRAND_2 }} />
        </linearGradient>
      </defs>
      {bare ? null : <circle cx="20" cy="20" r="20" fill={DISC} />}
      {/* Wings: two round upper wings, two smaller lower ones. */}
      <ellipse cx="11.5" cy="15.5" rx="8" ry="7" transform="rotate(-25 11.5 15.5)" fill={fill} />
      <ellipse cx="28.5" cy="15.5" rx="8" ry="7" transform="rotate(25 28.5 15.5)" fill={fill} />
      <ellipse cx="13" cy="26.5" rx="5.6" ry="5" transform="rotate(30 13 26.5)" fill={fill} opacity="0.85" />
      <ellipse cx="27" cy="26.5" rx="5.6" ry="5" transform="rotate(-30 27 26.5)" fill={fill} opacity="0.85" />
      {/* Soft highlights on the wings. */}
      <circle cx="9.3" cy="13.6" r="1.9" fill="#fff" opacity="0.55" />
      <circle cx="30.7" cy="13.6" r="1.9" fill="#fff" opacity="0.55" />
      <circle cx="12.6" cy="27.2" r="1.1" fill="#fff" opacity="0.45" />
      <circle cx="27.4" cy="27.2" r="1.1" fill="#fff" opacity="0.45" />
      {/* Antennae with round tips. */}
      <path d="M18 11.4 Q16.6 7.2 13.6 6.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M22 11.4 Q23.4 7.2 26.4 6.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="13.2" cy="6.1" r="1.8" fill={fill} stroke="currentColor" strokeWidth="0.6" />
      <circle cx="26.8" cy="6.1" r="1.8" fill={fill} stroke="currentColor" strokeWidth="0.6" />
      {/* Body, then the round head over it. */}
      <ellipse cx="20" cy="26.4" rx="2.9" ry="6" fill={FACE} stroke={BRAND} strokeWidth="1" />
      <circle cx="20" cy="17" r="6.3" fill={FACE} stroke={BRAND} strokeWidth="1" />
      {/* The face: dot eyes, blush, a little smile. */}
      <circle cx="17.7" cy="16.5" r="1.3" fill={FACE_INK} />
      <circle cx="22.3" cy="16.5" r="1.3" fill={FACE_INK} />
      <circle cx="18.1" cy="16.05" r="0.4" fill={FACE} />
      <circle cx="22.7" cy="16.05" r="0.4" fill={FACE} />
      <ellipse cx="16" cy="19.1" rx="1.4" ry="0.9" fill={BLUSH} opacity="0.75" />
      <ellipse cx="24" cy="19.1" rx="1.4" ry="0.9" fill={BLUSH} opacity="0.75" />
      <path d="M18.7 19.3 Q20 20.6 21.3 19.3" fill="none" stroke={FACE_INK} strokeWidth="0.9" strokeLinecap="round" />
    </svg>
  );
});
