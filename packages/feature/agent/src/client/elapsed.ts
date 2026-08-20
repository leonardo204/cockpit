/**
 * Turn time, as a person reads it: how long one has been running, how long a
 * finished one took, and when it finished.
 *
 * Split out of MessageList so the formatting is testable: the boundaries are
 * exactly where an off-by-one looks broken on screen (59 → 60 must not read
 * "60초", and 3600 must not read "60분").
 *
 * `formatElapsed` is Korean/English-neutral by construction — it emits only
 * digits and unit tokens the caller supplies nothing to, because a TICKING
 * clock is the one string where a translation table would add a lookup and no
 * meaning. `formatTurnDuration` below is the settled counterpart and does
 * translate; the note on it says why the two are not one function.
 */
import i18n from '@cockpit/shared-i18n';

/** `45s` · `3m 20s` · `1h 04m`. Seconds are dropped past an hour: at that scale
 *  they are noise, and the number would jitter in a place the eye is not reading. */
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes}m ${String(s % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** Whether a turn has run long enough that the UI should say something stronger
 *  than a spinner. Not a timeout — nothing is cancelled — just the point where
 *  "still working" stops being reassuring on its own. */
export const LONG_TURN_SECONDS = 120;

export function isLongTurn(totalSeconds: number): boolean {
  return totalSeconds >= LONG_TURN_SECONDS;
}

/**
 * How long a FINISHED turn took: `0.4초` · `12.3초` · `1분 5초` · `1시간 3분`.
 *
 * WHY THIS IS NOT `formatElapsed`. That one is the clock that ticks while a turn
 * runs, and the two have opposite requirements. A ticking clock must not show
 * tenths (they would strobe) and must not go through a translation lookup on
 * every animation frame, so it is coarse and language-neutral. A settled
 * measurement is read once, is final, and is the number a user quotes — so a
 * turn that took 400ms has to say so instead of rounding to "0초", and the units
 * belong in the user's language like every other word on the screen. Squeezing
 * both into one function would mean a flag that changes what it means, which is
 * how the app ends up with a clock that strobes in one place and rounds a real
 * measurement away in another. They live in the same module so the boundaries
 * below and the boundaries above stay side by side.
 *
 * The thresholds, and why they sit where they do:
 *   < 1분   one decimal. This is where most turns land, it is the range where a
 *           tenth still changes the impression ("0.4초" and "12.3초" are
 *           different experiences), and the number is final so it cannot jitter.
 *   < 1시간 whole seconds. Next to a minute, a tenth of a second is noise.
 *   ≥ 1시간 minutes only. Seconds at that scale are noise in a place the eye is
 *           not reading, the same rule `formatElapsed` applies.
 *
 * Rounding is done ONCE per branch and the branch is chosen from the rounded
 * value, so no carry can print an impossible clock: 59.97s becomes `1분 0초` and
 * never `60.0초`, and 3599.7s becomes `1시간 0분` and never `59분 60초`.
 */
export function formatTurnDuration(ms: number): string {
  // A negative duration means two clocks disagreed, not that time ran backwards.
  const total = Math.max(0, ms);

  const tenths = Math.round(total / 100);
  if (tenths < 600) {
    return i18n.t('chat.turnDuration.seconds', {
      defaultValue: '{{value}}s',
      value: (tenths / 10).toFixed(1),
    });
  }

  const seconds = Math.round(total / 1000);
  if (seconds < 3600) {
    return i18n.t('chat.turnDuration.minutes', {
      defaultValue: '{{minutes}}m {{seconds}}s',
      minutes: Math.floor(seconds / 60),
      seconds: seconds % 60,
    });
  }

  const minutes = Math.round(total / 60_000);
  return i18n.t('chat.turnDuration.hours', {
    defaultValue: '{{hours}}h {{minutes}}m',
    hours: Math.floor(minutes / 60),
    minutes: minutes % 60,
  });
}

/**
 * WHEN a turn finished, on the wall clock: `오후 2:15` in Korean, `2:15 PM` in
 * English.
 *
 * Follows the ACTIVE UI language rather than a fixed locale. The nearby
 * `UserMessagesModal.formatTime` hardcodes `'zh-CN'`, inherited from upstream
 * cockpit; this app ships Korean and English, so that literal is a bug and is
 * deliberately not copied here.
 *
 * Returns '' for a missing or unparseable value, so a caller can test the string
 * itself instead of carrying a second "is there a time" flag.
 */
export function formatTurnEndTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  // `hour: 'numeric'` and not '2-digit': a leading zero on the hour is a
  // machine's way of writing a time, and every locale here reads better without
  // one. The minute keeps its zero, because "2:5" is not a time.
  return d.toLocaleTimeString(i18n.language, { hour: 'numeric', minute: '2-digit' });
}

/**
 * The closing line of a finished turn: `12.3초 · 오후 2:15`.
 *
 * A FUNCTION AND NOT A TEMPLATE IN JSX, because the interesting part is what it
 * declines to draw. `null` means the turn has nothing to say — no measurement
 * was recorded (every turn from before this existed), and the caller renders no
 * element at all rather than an empty one. The separator is joined here for the
 * same reason: written inline it would survive a missing end time and leave a
 * dangling `12.3초 · ` on screen, which looks like a bug because it is one.
 *
 * The caller still decides WHOSE line this is — a user message has no turn to
 * measure, and a turn still streaming has a number that would tick and settle.
 */
export function formatTurnMeta(
  durationMs: number | undefined,
  completedAt: string | undefined,
): string | null {
  if (typeof durationMs !== 'number' || !isFinite(durationMs)) return null;
  const duration = formatTurnDuration(durationMs);
  const endTime = formatTurnEndTime(completedAt);
  return endTime ? `${duration} · ${endTime}` : duration;
}
