import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A NEW TAB HAS NO SESSION until its first message mints one. Two things a user
 * reaches for before typing anything were quietly refused there:
 *
 *   - renaming the tab: `commitRename` returned early without a `sessionId`, so
 *     the label snapped back to the generated name;
 *   - adding a participant: the roster disabled every "Add" button and said
 *     "send a first message first".
 *
 * Source assertions, because there is no hook/DOM test rig here and the bug was
 * one early return plus one missing callback. The server half (`session.
 * participants.add` minting a session) has a real test in participantsApi.test.
 */

const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');

describe('actions before the first message', () => {
  it('a rename without a session keeps the name on the tab and writes it once the session exists', () => {
    const src = read('TabManager.tsx');
    const commit = src.slice(src.indexOf('const commitRename = useCallback'), src.indexOf('useEffect(() => {\n    const pending = pendingRenamesRef.current;'));
    expect(commit).not.toMatch(/if \(!tab\?\.sessionId\) return;/);
    // The tab title is updated before the "no session" branch.
    expect(commit.indexOf('updateTabState(tabId')).toBeGreaterThan(-1);
    expect(commit.indexOf('updateTabState(tabId')).toBeLessThan(commit.indexOf('if (!tab.sessionId)'));
    expect(commit).toMatch(/pendingRenamesRef\.current\.set\(tabId, title\)/);
    // And the effect that flushes it when the tab gets its session.
    expect(src).toMatch(/if \(!tab\.sessionId\) continue;\s*pending\.delete\(tabId\);\s*persistRename\(tab\.sessionId/);
  });

  it('the chat lets add mint the session and adopts it', () => {
    const chat = read('../../../agent/src/client/Chat.tsx');
    expect(chat).toMatch(/useParticipantsState\(liveSessionId \?\? null, \{[\s\S]*?onSessionMinted: setSessionId,/);
    const roster = read('../../../agent/src/client/ParticipantRoster.tsx');
    expect(roster).toMatch(/hasSession=\{!!ctx\.sessionId \|\| ctx\.canAddWithoutSession\}/);
    const ctx = read('../../../agent/src/client/ParticipantsContext.tsx');
    expect(ctx).toMatch(/onSessionMinted\?\.\(res\.sessionId\)/);
  });
});
