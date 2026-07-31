import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Topics } from '@cockpit/effect-services';
import { broadcastTopicToFrames } from '@cockpit/effect-react';
import { isHarnessChangedMessage } from './harnessSignal';

/**
 * "I enabled the skill and '/' still does not list it."
 *
 * THE BUG. The composer fetches `/api/commands` once per mount. Its iframe is
 * never unmounted — Workspace keeps every open project alive — so that once was
 * once per app lifetime. Enabling a skill happens in the Settings modal, which
 * renders in the TOP window. Nothing crossed between them, so the palette served
 * a list that had been correct only at the moment the project was opened, and the
 * user had no way to tell it was stale.
 *
 * WHAT IS ASSERTED HERE, AND WHY IN THIS SHAPE. The failure is a broken chain of
 * four links, each of which looks fine on its own:
 *
 *   1. the broadcast reaches CHILD frames (the bus's own publish does not — it
 *      posts to window.parent, which from the top window is itself),
 *   2. the payload it sends is recognised by the listener,
 *   3. the composer registers that listener and calls the loader from it,
 *   4. the refetch is not served from the HTTP cache.
 *
 * Links 1 and 2 are executed here as a round trip — a fake frame collects what
 * was posted and the real predicate is asked about it, so a change to either half
 * alone fails. Links 3 and 4 are source assertions, because there is no jsdom in
 * this suite: the composer cannot be mounted, and a test that only checked the
 * predicate would still pass with the listener deleted.
 */

const CLIENT_DIR = __dirname;

const read = (f: string) => readFileSync(join(CLIENT_DIR, f), 'utf8');

/** Install a document whose `querySelectorAll('iframe')` yields `n` fake frames,
 *  each recording what was posted into it. */
function fakeFrames(n: number): { posted: unknown[][]; restore: () => void } {
  const posted: unknown[][] = Array.from({ length: n }, () => []);
  const frames = posted.map((sink) => ({
    contentWindow: { postMessage: (payload: unknown) => sink.push(payload) },
  }));
  const g = globalThis as { document?: unknown };
  const had = 'document' in g;
  const previous = g.document;
  g.document = { querySelectorAll: (sel: string) => (sel === 'iframe' ? frames : []) };
  return {
    posted,
    restore: () => {
      if (had) g.document = previous;
      else delete g.document;
    },
  };
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe('the harness-changed topic', () => {
  it('is registered with both routing keys the bus uses', () => {
    // A topic carries a kebab-case id (v2 envelope) and a SCREAMING_SNAKE legacy
    // type (v1 envelope). Both are on the wire, so both are load-bearing.
    expect(Topics.HarnessChanged.id).toBe('harness-changed');
    expect(Topics.HarnessChanged.legacyType).toBe('HARNESS_CHANGED');
  });

  it('does not collide with another topic id', () => {
    const ids = Object.values(Topics).map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the predicate recognises either envelope shape', () => {
  it('matches the v1 shape', () => {
    expect(isHarnessChangedMessage({ type: 'HARNESS_CHANGED' })).toBe(true);
  });

  it('matches the v2 shape', () => {
    expect(isHarnessChangedMessage({ topic: 'harness-changed', msg: {} })).toBe(true);
  });

  it('ignores every other topic, and non-objects', () => {
    // A composer that reloaded on ANY message would refetch on every session
    // change, theme change and tab add — dozens of times a minute.
    expect(isHarnessChangedMessage({ type: 'THEME_CHANGE', theme: 'dark' })).toBe(false);
    expect(isHarnessChangedMessage({ topic: 'pinned-sessions-changed' })).toBe(false);
    expect(isHarnessChangedMessage(null)).toBe(false);
    expect(isHarnessChangedMessage(undefined)).toBe(false);
    expect(isHarnessChangedMessage('HARNESS_CHANGED')).toBe(false);
  });
});

describe('a parent-window broadcast reaches the composer', () => {
  it('posts into every child frame, and the payload is recognised', () => {
    // The round trip. This is the assertion the bug would have failed: before
    // the fix nothing was posted downward at all.
    const frames = fakeFrames(3);
    cleanup = frames.restore;

    broadcastTopicToFrames(Topics.HarnessChanged, {});

    for (const sink of frames.posted) {
      expect(sink).toHaveLength(1);
      expect(isHarnessChangedMessage(sink[0])).toBe(true);
    }
  });

  it('sends the bus envelope, not an ad-hoc object', () => {
    // So a later unification of the two publish paths does not have to revisit
    // every subscriber: the shape is already the one IframeBusLive emits.
    const frames = fakeFrames(1);
    cleanup = frames.restore;

    broadcastTopicToFrames(Topics.HarnessChanged, {});

    expect(frames.posted[0]![0]).toMatchObject({
      type: 'HARNESS_CHANGED',
      topic: 'harness-changed',
      msg: {},
    });
  });

  it('is a no-op without a document, rather than throwing', () => {
    // It is called from a handler that also does the real work (toast, reload);
    // a throw here would abort those.
    const g = globalThis as { document?: unknown };
    const had = 'document' in g;
    const previous = g.document;
    delete g.document;
    try {
      expect(() => broadcastTopicToFrames(Topics.HarnessChanged, {})).not.toThrow();
    } finally {
      if (had) g.document = previous;
    }
  });
});

describe('the composer acts on the signal', () => {
  const CHAT_INPUT = read('ChatInput.tsx');

  it('loads commands through one reusable loader', () => {
    // The fetch used to be written inline in a `[cwd]` effect, which is why
    // nothing else could trigger it. A named callback is what makes a second
    // trigger possible at all.
    expect(CHAT_INPUT).toMatch(/const reloadCommands = useCallback\(/);
    expect(CHAT_INPUT).toContain('loadSlashCommands<CommandInfo>(cwd)');
  });

  it('still reloads when the active project changes', () => {
    // The original trigger must survive the refactor: project-scope commands
    // differ per cwd.
    expect(CHAT_INPUT).toMatch(/useEffect\(\(\) => \{\s*reloadCommands\(\);\s*\}, \[reloadCommands\]\)/);
  });

  it('reloads on the harness signal', () => {
    expect(CHAT_INPUT).toContain('isHarnessChangedMessage');
    expect(CHAT_INPUT).toMatch(/addEventListener\('message', onMessage\)/);
    expect(CHAT_INPUT).toMatch(/if \(isHarnessChangedMessage\(e\.data\)\) reloadCommands\(\)/);
  });

  it('also reloads on window focus, as the belt-and-braces trigger', () => {
    // A missed signal is invisible to the user, so there is nothing for them to
    // retry. Focus catches the frame that did not exist when the broadcast went
    // out.
    expect(CHAT_INPUT).toMatch(/addEventListener\('focus', onFocus\)/);
    expect(CHAT_INPUT).toMatch(/const onFocus = \(\) => reloadCommands\(\)/);
  });

  it('detaches both listeners on unmount', () => {
    expect(CHAT_INPUT).toMatch(/removeEventListener\('message', onMessage\)/);
    expect(CHAT_INPUT).toMatch(/removeEventListener\('focus', onFocus\)/);
  });
});

describe('the refetch is not served from cache', () => {
  it('asks for the command list with no-store', () => {
    // A byte-identical repeat request is exactly what a heuristic cache is
    // happiest to answer, and answering it would reproduce the bug with all the
    // signalling in place.
    const client = read(join('effect', 'agentClient.ts'));
    const call = client.slice(client.indexOf('export const loadSlashCommands'));
    const body = call.slice(0, call.indexOf('export const', 1));
    expect(body).toContain('/api/commands');
    expect(body).toContain('cache: "no-store"');
  });
});
