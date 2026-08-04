// Regression net for sessionRunHub (#10). Run with `npm test` (vitest) or
// `npx vitest run <this file>`.
//
// The registry is a globalThis-pinned singleton, so these cases are STATEFUL and build on
// each other — they must run in order. vitest runs it() blocks in definition order within a
// file, and runs files in isolated workers, so the shared state stays self-contained here.
import { describe, it, expect, vi } from 'vitest';
import {
  startRun,
  appendRun,
  rekeyRun,
  markRunIdle,
  isRunActive,
  getRunSnapshot,
  addRunListener,
  reserveRun,
  releaseRun,
  isRunPending,
  getAttachAnnouncement,
  PENDING_TTL_MS,
} from './sessionRunHub';

describe('sessionRunHub (#10 run registry)', () => {
  const got: Array<{ seq: number; message: unknown }> = [];
  let off: () => void;

  it('active after startRun', () => {
    startRun('S', '/cwd');
    expect(isRunActive('S')).toBe(true);
  });

  it('listener receives events with monotonic seq', () => {
    off = addRunListener('S', (ev) => got.push(ev));
    appendRun('S', { type: 'assistant', uuid: 'u1' });
    appendRun('S', { type: 'assistant', uuid: 'u2' });
    expect(got.length).toBe(2);
    expect(got[1].seq).toBe(2);
  });

  it('snapshot carries seq + events', () => {
    expect(getRunSnapshot('S')?.seq).toBe(2);
    expect(getRunSnapshot('S')?.events.length).toBe(2);
  });

  it('rekey ADDS an alias: both keys resolve to the same run (race-safe)', () => {
    rekeyRun('S', 'S2');
    expect(getRunSnapshot('S')?.seq).toBe(2);
    expect(getRunSnapshot('S2')?.seq).toBe(2);
  });

  it('a listener on the OLD key keeps receiving after rekey (fanout covers aliases)', () => {
    appendRun('S2', { type: 'assistant', uuid: 'u3' });
    expect(got.length).toBe(3);
    expect(got[2].seq).toBe(3);
    expect(getRunSnapshot('S2')?.events.length).toBe(3);
  });

  it('markRunIdle: not active, snapshot kept within grace', () => {
    markRunIdle('S2', 'idle');
    expect(isRunActive('S2')).toBe(false);
    expect(getRunSnapshot('S2')?.status).toBe('idle');
  });

  it('markRunIdle fans out a one-time run-ended (seq bumped 3→4 for snapshot dedupe)', () => {
    expect(got.length).toBe(4);
    expect((got[3].message as { type?: string }).type).toBe('run-ended');
    expect(got[3].seq).toBe(4);
  });

  it('new turn keeps seq monotonic (4, never resets) and clears events', () => {
    startRun('S2', '/cwd');
    expect(getRunSnapshot('S2')?.seq).toBe(4);
    expect(getRunSnapshot('S2')?.events.length).toBe(0);
  });

  it('unsubscribe is robust to the prior rekey', () => {
    off();
    const before = got.length;
    appendRun('S2', { type: 'assistant', uuid: 'u5' });
    expect(got.length).toBe(before);
  });

  it('startRun(promptText) seeds a synthetic human-user event (snapshot + live fan-out)', () => {
    const pgot: Array<{ seq: number; message: unknown }> = [];
    const poff = addRunListener('P', (ev) => pgot.push(ev));
    startRun('P', '/cwd', 'hello world');
    const psnap = getRunSnapshot('P');
    const pmsg = psnap?.events[0] as
      | { type?: string; _human?: boolean; message?: { content?: unknown } }
      | undefined;
    expect(psnap?.events.length).toBe(1);
    expect(pmsg?.type).toBe('user');
    expect(pmsg?._human).toBe(true);
    expect(pmsg?.message?.content).toBe('hello world');
    expect(pgot.length).toBe(1);
    expect(pgot[0].seq).toBe(1);
    poff();
  });

  // R1 terminal-precedence: an engine's error path marks 'error', then its process-close
  // handler marks 'idle'. The second call must NOT downgrade — else a failed turn reads as
  // success (scheduled tasks poll getRunSnapshot().status).
  it('markRunIdle: error is sticky, a later idle does not downgrade it', () => {
    startRun('E', '/cwd');
    markRunIdle('E', 'error');
    expect(getRunSnapshot('E')?.status).toBe('error');
    markRunIdle('E', 'idle'); // close handler, must be ignored
    expect(getRunSnapshot('E')?.status).toBe('error');
  });

  it('markRunIdle: a late error upgrades an idle run (fail closed)', () => {
    startRun('U', '/cwd');
    markRunIdle('U', 'idle');
    expect(getRunSnapshot('U')?.status).toBe('idle');
    markRunIdle('U', 'error');
    expect(getRunSnapshot('U')?.status).toBe('error');
  });

  it('markRunIdle fires run-ended exactly once (second call is a no-op)', () => {
    const evs: Array<{ seq: number; message: unknown }> = [];
    startRun('O', '/cwd');
    const off2 = addRunListener('O', (ev) => evs.push(ev));
    markRunIdle('O', 'idle');
    markRunIdle('O', 'idle');
    markRunIdle('O', 'error');
    const ended = evs.filter(
      (e) => (e.message as { type?: string })?.type === 'run-ended'
    );
    expect(ended.length).toBe(1);
    off2();
  });

  // R1 appendRun guard: a late engine event after the run reached a terminal state must not
  // fan out (the viewer already finalized its bubble on run-ended).
  it('appendRun is a no-op once the run is terminal', () => {
    const evs: Array<{ seq: number; message: unknown }> = [];
    startRun('L', '/cwd');
    const off3 = addRunListener('L', (ev) => evs.push(ev));
    appendRun('L', { type: 'assistant', uuid: 'live' }); // running → delivered
    markRunIdle('L', 'idle');
    const before = getRunSnapshot('L')?.events.length ?? 0;
    appendRun('L', { type: 'assistant', uuid: 'late' }); // terminal → dropped
    expect(getRunSnapshot('L')?.events.length).toBe(before);
    const lateDelivered = evs.some(
      (e) => (e.message as { uuid?: string })?.uuid === 'late'
    );
    expect(lateDelivered).toBe(false);
    off3();
  });

  // R2: seq must survive eviction. A viewer that joined mid-prior-turn has a high snapshotSeq;
  // if the next turn's seq reset to 0 after the grace window, `seq > snapshotSeq` would filter
  // the whole turn out and the viewer would silently miss it. (The old test never advanced the
  // 60s evict timer, so it couldn't catch this.)
  it('seq does not reset across eviction (the grace-window viewer keeps receiving)', () => {
    vi.useFakeTimers();
    try {
      startRun('EV', '/cwd');
      appendRun('EV', { type: 'assistant', uuid: 'a' });
      markRunIdle('EV', 'idle'); // bumps seq (run-ended) + schedules the 60s evict
      const seqAtIdle = getRunSnapshot('EV')!.seq;
      expect(seqAtIdle).toBeGreaterThan(0);

      vi.advanceTimersByTime(60_001); // evict fires → registry drops 'EV'
      expect(getRunSnapshot('EV')).toBeNull();

      startRun('EV', '/cwd'); // next turn under the SAME key, AFTER eviction
      expect(getRunSnapshot('EV')!.seq).toBe(seqAtIdle); // resumed, NOT reset to 0
      appendRun('EV', { type: 'assistant', uuid: 'b' });
      expect(getRunSnapshot('EV')!.seq).toBe(seqAtIdle + 1); // strictly increasing across eviction
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * A TURN THAT IS COMING, BUT HAS NOT STARTED YET.
 *
 * THE REPORT. The fast-growth button mints a session, opens it, and fires that
 * session's opening turn headlessly on the way out. The tab therefore attaches
 * to /ws/session-stream while the turn is still being started — and won that
 * race, because a dynamic import and a preflight sit between the HTTP response
 * and `startRun`. The attach found no run, was told `run-idle`, and the user
 * stared at an empty conversation while naby was already working.
 *
 * Each case below is one way the fill for that window could go wrong in a user's
 * hands: no indicator, an indicator that never stops, or an indicator that ends
 * a live turn.
 */
describe('a reserved run (the attach-before-the-turn-starts window)', () => {
  it('an attach during the window is told a turn is coming, not that the session is idle', () => {
    expect(getAttachAnnouncement('R1')).toEqual({ type: 'run-idle' });
    reserveRun('R1');
    expect(isRunPending('R1')).toBe(true);
    expect(getAttachAnnouncement('R1')).toEqual({ type: 'run-pending' });
  });

  it('startRun converts the reservation SILENTLY — the run itself takes over', () => {
    const evs: Array<{ seq: number; message: unknown }> = [];
    const off = addRunListener('R1', (ev) => evs.push(ev));
    startRun('R1', '/cwd', 'hello');
    expect(isRunPending('R1')).toBe(false);
    // No end signal was fanned out by the conversion: the only event is the
    // turn's own seeded prompt. A `run-ended` here would take the indicator down
    // in the same instant the turn actually began.
    expect(evs.map((e) => (e.message as { type?: string }).type)).toEqual(['user']);
    const announced = getAttachAnnouncement('R1');
    expect(announced.type).toBe('run-snapshot');
    expect(announced.type === 'run-snapshot' && announced.status).toBe('running');
    off();
    markRunIdle('R1', 'idle');
  });

  it('a dispatch that never starts drops the reservation and ENDS the wait', () => {
    // The ordinary shape of "this machine has no engine configured": preflight
    // refuses, so no run is ever created. Without the release, the tab would spin
    // forever with nothing on the way.
    const evs: Array<{ seq: number; message: unknown }> = [];
    const off = addRunListener('R2', (ev) => evs.push(ev));
    reserveRun('R2');
    releaseRun('R2');
    expect(isRunPending('R2')).toBe(false);
    expect(getAttachAnnouncement('R2')).toEqual({ type: 'run-idle' });
    // The SAME `run-ended` a real turn finishes with, so every client clears the
    // indicator through the path it already has.
    expect(evs).toHaveLength(1);
    expect((evs[0]!.message as { type?: string }).type).toBe('run-ended');
    expect(evs[0]!.seq).toBeGreaterThan(0);
    off();
  });

  it('release is silent while a run is live: it can never end a real turn early', () => {
    const evs: Array<{ seq: number; message: unknown }> = [];
    reserveRun('R3');
    startRun('R3', '/cwd');
    const off = addRunListener('R3', (ev) => evs.push(ev));
    // The loser of a concurrent dispatch releases after the winner started.
    reserveRun('R3'); // no-op: a run is live under this key
    releaseRun('R3');
    expect(isRunActive('R3')).toBe(true);
    expect(evs).toHaveLength(0);
    off();
    markRunIdle('R3', 'idle');
  });

  it('releasing what was never reserved says nothing at all', () => {
    const evs: Array<{ seq: number; message: unknown }> = [];
    const off = addRunListener('R4', (ev) => evs.push(ev));
    releaseRun('R4');
    expect(evs).toHaveLength(0);
    off();
  });

  it('a reservation nobody converts or drops expires on its own', () => {
    // The backstop for a caller that dies between reserving and dispatching. The
    // failure it prevents — an indicator that never stops — is one the user
    // cannot clear either.
    vi.useFakeTimers();
    try {
      const evs: Array<{ seq: number; message: unknown }> = [];
      const off = addRunListener('R5', (ev) => evs.push(ev));
      reserveRun('R5');
      expect(isRunPending('R5')).toBe(true);
      vi.advanceTimersByTime(PENDING_TTL_MS + 1);
      expect(isRunPending('R5')).toBe(false);
      expect((evs[0]?.message as { type?: string })?.type).toBe('run-ended');
      off();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a COMING turn outranks a FINISHED one still inside the grace window', () => {
    // The Telegram / scheduled-task shape: the session answered a minute ago (so
    // an idle snapshot is still in the registry) and is about to answer again. An
    // idle snapshot would tell the tab there is nothing to wait for.
    startRun('R6', '/cwd');
    markRunIdle('R6', 'idle');
    expect(getAttachAnnouncement('R6').type).toBe('run-snapshot');
    reserveRun('R6');
    expect(getAttachAnnouncement('R6')).toEqual({ type: 'run-pending' });
    releaseRun('R6');
  });

  it('the release event keeps seq monotonic, so the server-side filter cannot swallow it', () => {
    // A viewer that connected during an earlier turn holds that turn's seq and
    // only accepts strictly greater ones. A release stamped below it would be
    // filtered out — and the indicator would never come down for that tab.
    startRun('R7', '/cwd');
    appendRun('R7', { type: 'assistant', uuid: 'x' });
    markRunIdle('R7', 'idle');
    const seqAtIdle = getRunSnapshot('R7')!.seq;
    const evs: Array<{ seq: number; message: unknown }> = [];
    const off = addRunListener('R7', (ev) => evs.push(ev));
    reserveRun('R7');
    releaseRun('R7');
    expect(evs).toHaveLength(1);
    expect(evs[0]!.seq).toBeGreaterThan(seqAtIdle);
    off();
  });
});
