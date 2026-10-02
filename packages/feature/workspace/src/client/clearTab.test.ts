import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clearTabInPlace } from './clearTab';
import type { TabInfo } from './useTabState';

const tabs: TabInfo[] = [
  { id: 'tab-1', cwd: '/p', sessionId: 's-1', title: 'First' },
  { id: 'tab-2', cwd: '/p', sessionId: 's-2', title: 'Second', planMode: true, titleLocked: true },
  { id: 'tab-3', cwd: '/p', title: 'Blank' },
  { id: 'tab-4', kind: 'markdown', cwd: '/p', rel: 'README.md', title: 'README.md' },
];

describe('clear context (/clear) on a tab', () => {
  it('replaces the tab IN PLACE with a blank chat on a new id, keeping project and plan mode', () => {
    const out = clearTabInPlace(tabs, 'tab-2', 1_000);
    expect(out).not.toBeNull();
    expect(out!.tabs.map((t) => t.id)).toEqual(['tab-1', 'tab-1000', 'tab-3', 'tab-4']);
    const blank = out!.tabs[1]!;
    expect(blank.sessionId).toBeUndefined();
    expect(blank.cwd).toBe('/p');
    expect(blank.planMode).toBe(true);
    // A rename belonged to the old conversation, not to the seat.
    expect(blank.titleLocked).toBeUndefined();
    expect(blank.title).not.toBe('Second');
    expect(out!.newTabId).toBe('tab-1000');
  });

  it('reports the old session as closed, so it leaves the open-tab union but stays in history', () => {
    expect(clearTabInPlace(tabs, 'tab-1', 1)?.closedSessionId).toBe('s-1');
  });

  it('does nothing for a tab with no conversation, a document tab, or an unknown tab', () => {
    expect(clearTabInPlace(tabs, 'tab-3', 1)).toBeNull();
    expect(clearTabInPlace(tabs, 'tab-4', 1)).toBeNull();
    expect(clearTabInPlace(tabs, 'nope', 1)).toBeNull();
  });

  it('the menu item is disabled while a turn is running, like /clear mid-turn', () => {
    const menu = readFileSync(join(__dirname, 'TabContextMenu.tsx'), 'utf8');
    expect(menu).toContain('data-testid="tab-menu-clear"');
    expect(menu).toMatch(/disabled=\{!state\.hasSession \|\| state\.isBusy === true\}/);
  });
});
