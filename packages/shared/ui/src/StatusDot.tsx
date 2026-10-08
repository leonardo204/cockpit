'use client';

/**
 * StatusDot — a small filled circle that says "how is this doing" at a glance.
 *
 * Lifted out of RunningJobsIndicator so the jobs list and the chat status bar
 * (Atlassian / Skill Hub) speak the same color language:
 *
 *   success  green  — connected, finished, fine
 *   warning  amber  — needs attention soon (sign in again, grace period, unknown)
 *   danger   red    — blocking or failed
 *   neutral  gray   — not set up, switched off
 *   active   brand  — running now (pair with `pulse`)
 *
 * The colors are the semantic tokens in globals.css (`--success`, `--warning`,
 * `--destructive`), defined for both themes, rather than raw palette steps.
 * Decorative by default (`aria-hidden`); pass `label` when the dot is the only
 * carrier of the state.
 */

export type StatusTone = 'success' | 'warning' | 'danger' | 'neutral' | 'active';

const TONE_CLASS: Record<StatusTone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-destructive',
  neutral: 'bg-muted-foreground/50',
  active: 'bg-brand',
};

/** The fill class for a tone. Pure, for tests and for callers that draw their own shape. */
export function statusToneClass(tone: StatusTone): string {
  return TONE_CLASS[tone];
}

export function StatusDot({
  tone,
  pulse = false,
  size = 'sm',
  label,
  className = '',
}: {
  tone: StatusTone;
  pulse?: boolean;
  /** sm = 6px (lists), md = 8px (status bar). */
  size?: 'sm' | 'md';
  /** Accessible name; omit when adjacent text already says it. */
  label?: string;
  className?: string;
}) {
  const dim = size === 'md' ? 'w-2 h-2' : 'w-1.5 h-1.5';
  const cls = `${dim} rounded-full shrink-0 ${TONE_CLASS[tone]}${pulse ? ' animate-pulse' : ''}${className ? ` ${className}` : ''}`;
  return label ? (
    <span className={cls} role="img" aria-label={label} data-tone={tone} />
  ) : (
    <span className={cls} aria-hidden="true" data-tone={tone} />
  );
}
