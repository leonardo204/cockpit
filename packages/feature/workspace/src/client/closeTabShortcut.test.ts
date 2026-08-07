import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Cmd/Ctrl+W closes the ACTIVE session tab, not the window.
 *
 * The other half of this contract lives in the Electron main process
 * (electron/menu.ts in the naby repo): the application menu deliberately does
 * not bind Cmd+W to "close window", which is the only reason the key event
 * ever reaches the DOM handler asserted here. jsdom can't see any of that —
 * these are source guards, like the sidebar-clipping and background-job ones.
 */

const CLIENT = __dirname;
const read = (name: string) => readFileSync(join(CLIENT, name), 'utf8');

describe('Cmd/Ctrl+W — close the active tab', () => {
  it('the tab host handles the key and closes the active tab', () => {
    const src = read('TabManager.tsx');
    const branch = /if \(e\.key === 'w'\) \{[\s\S]*?\}/.exec(src)?.[0];
    expect(branch, "the 'w' branch was removed — Cmd+W would close nothing").toBeDefined();
    // Swallow the browser default; close through the same ref indirection the
    // other shortcuts use, so the single stable listener never goes stale.
    expect(branch).toContain('e.preventDefault()');
    expect(branch).toContain('closeTabRef.current(activeId)');
    expect(src).toContain('activeTabIdRef.current = activeTabId');
    expect(src).toContain('closeTabRef.current = closeTab');
    // And the branch sits inside the modifier-guarded listener (meta/ctrl only).
    expect(src).toMatch(/if \(!\(e\.metaKey \|\| e\.ctrlKey\) \|\| e\.shiftKey \|\| e\.altKey\) return;/);
  });

  it('closing the last tab goes home instead of leaving a dead window', () => {
    // The behaviour Cmd+W leans on for its "last tab → home screen" half:
    // closeTab leaves a fresh blank tab and tells the parent to show home.
    const src = read('useTabState.ts');
    const closer = /const closeTab = useCallback[\s\S]*?\n  \}, \[/.exec(src)?.[0];
    expect(closer, 'closeTab was reshaped — re-point this guard').toBeDefined();
    expect(closer).toContain('newTabs.length === 0');
    expect(closer).toContain('publishTopic(Topics.GoHome');
  });
});
