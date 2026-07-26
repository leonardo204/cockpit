/**
 * How long the current turn has been running, as a person reads it.
 *
 * Split out of MessageList so the formatting is testable: the boundaries are
 * exactly where an off-by-one looks broken on screen (59 → 60 must not read
 * "60초", and 3600 must not read "60분").
 *
 * Korean/English-neutral by construction — it emits only digits and unit tokens
 * the caller supplies nothing to, because a duration is the one string where a
 * translation table would add a lookup and no meaning.
 */

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
