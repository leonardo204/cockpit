import { describe, it, expect } from 'vitest';
import { runSignalFor } from './runSignal';

/**
 * THE TYPING INDICATOR, DECIDED FROM ONE STREAM MESSAGE.
 *
 * THE REPORT. The fast-growth button opens the session it just created, and that
 * session's opening turn is fired headlessly on the way out. The tab attached
 * to /ws/session-stream before the turn had started, was told nothing was
 * happening, and rendered an EMPTY conversation — while naby was already at
 * work. The same hole is open for any session a user opens mid-run: a
 * Telegram-linked one, a scheduled task.
 *
 * What is pinned here is the whole user-visible contract of the indicator:
 *   1. it appears for a turn that is already running when the tab attaches,
 *   2. it appears for a turn that has been RESERVED and not yet started,
 *   3. it does NOT appear for a session with nothing going on,
 *   4. it comes down on the end of the turn — including the end of a turn that
 *      never started — and takes the disk reconcile with it,
 *   5. an unrecognised message changes nothing (an unknown type read as "ended"
 *      would clear an indicator over a turn that is still running).
 */
describe('runSignalFor', () => {
  it('a turn already under way when the tab attaches → indicator on', () => {
    expect(runSignalFor({ type: 'run-snapshot', status: 'running' })).toEqual({
      running: true,
      complete: false,
    });
  });

  it('a turn RESERVED but not yet started → indicator on (the empty-tab bug)', () => {
    expect(runSignalFor({ type: 'run-pending' })).toEqual({ running: true, complete: false });
  });

  it('an idle session → no indicator, and nothing to reconcile', () => {
    expect(runSignalFor({ type: 'run-idle' })).toEqual({ running: false, complete: false });
  });

  it('a snapshot of a FINISHED turn → no indicator', () => {
    // The race the reconcile has to survive: the run ended between the moment the
    // tab decided to attach and the moment it did. A stuck spinner here is the
    // failure — the transcript on disk is already complete.
    expect(runSignalFor({ type: 'run-snapshot', status: 'idle' })).toEqual({
      running: false,
      complete: false,
    });
    expect(runSignalFor({ type: 'run-snapshot', status: 'error' })).toEqual({
      running: false,
      complete: false,
    });
  });

  it('the end of the turn takes the indicator down AND reconciles from disk', () => {
    expect(runSignalFor({ type: 'run-event', message: { type: 'run-ended' } })).toEqual({
      running: false,
      complete: true,
    });
  });

  it('a reserved turn that never started ends the same way (no forever-spinner)', () => {
    // A dropped reservation fans out the same `run-ended`, so the client needs no
    // second code path to stop waiting for a turn that will not arrive.
    const signal = runSignalFor({ type: 'run-event', message: { type: 'run-ended' } });
    expect(signal?.running).toBe(false);
    expect(signal?.complete).toBe(true);
  });

  it('any other live event means the turn is still going', () => {
    expect(runSignalFor({ type: 'run-event', message: { type: 'assistant' } })).toEqual({
      running: true,
      complete: false,
    });
    // Engines emit intermediate results (codex = one per turn); only `run-ended`
    // ends a turn, so a `result` must NOT take the indicator down.
    expect(runSignalFor({ type: 'run-event', message: { type: 'result' } })).toEqual({
      running: true,
      complete: false,
    });
  });

  it('a heartbeat, an empty frame or an unknown type changes nothing', () => {
    expect(runSignalFor({ type: 'ping' })).toBeNull();
    expect(runSignalFor({})).toBeNull();
    expect(runSignalFor(null)).toBeNull();
    expect(runSignalFor({ type: 'something-added-later' })).toBeNull();
  });
});
