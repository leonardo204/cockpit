import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A TAB THAT OPENS ON A CONVERSATION SHOWS IT.
 *
 * The bug this pins: the history fetch fired only on a RISING EDGE of
 * `isActive`, and the first tab of a launch is active from its very first
 * render — so it never had an edge to rise on and its conversation never
 * loaded. It looked like it fixed itself later, because switching to another
 * tab and back finally produced the edge.
 *
 * It only became visible when opening a project started RESUMING the last
 * session instead of always starting an empty one: before that there was never
 * any history for the first tab to be missing.
 *
 * Source assertions — this is an effect inside a component with a WebSocket, a
 * live run and a throttle behind it, and there is no harness here that could
 * mount it.
 */

const CHAT = readFileSync(join(__dirname, 'Chat.tsx'), 'utf8');

const effect =
  /const prevActiveRef = useRef\(isActive\);[\s\S]*?loadHistoryByCwdAndSessionId\]\);/.exec(
    CHAT,
  )?.[0];

describe('the two reasons to fetch', () => {
  it('still refreshes when the tab is switched to', () => {
    // The reason the rising edge existed: history may have moved on while the
    // reader was looking at something else.
    expect(effect, 'the activation effect is gone — did Chat change?').toBeDefined();
    expect(effect).toContain('const gainedFocus = isActive && !prevActiveRef.current;');
    expect(effect).toContain('if (gainedFocus || ');
  });

  it('ALSO fetches for a session it has never asked about', () => {
    // The case a rising edge cannot see, and the whole bug.
    expect(effect).toContain('requestedForRef.current !== sessionId');
    expect(effect).toContain('requestedForRef.current = sessionId;');
  });

  it('records the request BEFORE issuing it, so one mount asks once', () => {
    expect(effect!.indexOf('requestedForRef.current = sessionId;')).toBeLessThan(
      effect!.indexOf('loadHistoryByCwdAndSessionId(initialCwd, sessionId, true, 10)'),
    );
  });
});

describe('what it must not do', () => {
  it('still refuses to fetch over a live run', () => {
    // The live stream owns the tail; a lagging disk fetch would visibly regress
    // it mid-answer.
    expect(effect).toContain('isLoading || liveRunning) return;');
  });

  it('updates the edge marker even on the runs that fetch nothing', () => {
    // Leaving it stale would turn a later activation into a phantom edge.
    const guardAt = effect!.indexOf('if (!isActive ||');
    expect(effect!.indexOf('prevActiveRef.current = isActive;')).toBeLessThan(guardAt);
  });

  it('does not key on loadedSessionId, which an empty session never sets', () => {
    // `setLoadedSessionId` is only reached when messages came back, so a
    // conversation with none would be re-fetched on every dependency change.
    const body = /if \(gainedFocus \|\|[\s\S]{0,200}?\}/.exec(effect!)?.[0];
    expect(body).not.toContain('loadedSessionId');
  });
});
