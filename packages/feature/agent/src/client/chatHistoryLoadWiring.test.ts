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

describe('the load that actually renders the conversation', () => {
  const HOOK = readFileSync(join(__dirname, 'useChatHistory.ts'), 'utf8');
  const PANEL = readFileSync(join(__dirname, 'ChatPanel.tsx'), 'utf8');

  it('reacts to the session ARRIVING, not only to mount', () => {
    // This was the empty chat. The effect was `[]` — it read `initialSessionId`
    // on the one render it ever looked at, and a tab does not know its session
    // then: the one a project opens on is adopted a moment later, when the saved
    // project state comes back.
    const effect = /const loadedForRef = useRef<string \| null>\(null\);[\s\S]*?\}, \[[^\]]*\]\);/.exec(
      HOOK,
    )?.[0];
    expect(effect, 'the initial-load effect is gone — did the hook change?').toBeDefined();
    expect(effect).toContain('initialSessionId');
    expect(effect).toMatch(/\}, \[cwd, initialSessionId, loadHistoryByCwdAndSessionId\]\);$/);
  });

  it('still loads a session only ONCE', () => {
    // What the empty array was there for. Re-fetching belongs to the activation
    // effect and the explicit-jump path, which know when the disk may have moved.
    const effect = /const loadedForRef = useRef<string \| null>\(null\);[\s\S]*?\}, \[[^\]]*\]\);/.exec(
      HOOK,
    )![0];
    expect(effect).toContain('if (loadedForRef.current === initialSessionId) return;');
    expect(effect).toContain('loadedForRef.current = initialSessionId;');
  });

  it('does a FULL load, not an incremental one', () => {
    // There is nothing on screen to merge into, and the incremental path is
    // throttled — the first sight of a conversation must not be.
    const effect = /const loadedForRef = useRef<string \| null>\(null\);[\s\S]*?\}, \[[^\]]*\]\);/.exec(
      HOOK,
    )![0];
    expect(effect).toContain('false, TURNS_PER_PAGE');
  });

  it('the tab’s session actually reaches the hook', () => {
    // The chain the fix depends on: without it the effect would react to an id
    // that never changes.
    expect(PANEL).toContain('initialSessionId={sessionId}');
    expect(readFileSync(join(__dirname, '../../../workspace/src/client/TabManager.tsx'), 'utf8'))
      .toContain('sessionId={tab.sessionId}');
  });
});

describe('why the two effects are both needed', () => {
  it('the activation fetch cannot cover the initial load', () => {
    // It is guarded on `sessionId`, which is Chat's OWN state — and that state is
    // set by the RESPONSE to the initial load. With no load there is no id, and
    // with no id the activation fetch skips: a loop nothing broke until the user
    // sent a message, which is why the history appeared only after starting a
    // new conversation.
    const CHAT = readFileSync(join(__dirname, 'Chat.tsx'), 'utf8');
    expect(CHAT).toContain('const [sessionId, setSessionId] = useState<string | null>(null);');
    expect(CHAT).toContain('onSessionId: setSessionId');
    expect(effect).toContain('!sessionId');
  });
});
