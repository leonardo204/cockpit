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
    expect(menu).toMatch(
      /disabled=\{!state\.hasSession \|\| state\.isBusy === true \|\| state\.isContinuing === true\}/,
    );
  });
});

describe('keep a summary and clear (§2.2c) — the seat takes a carried session', () => {
  const carry = { sessionId: 's-new', title: 'Continued — Second' };

  it('replaces the tab in place on a new id, holding the continued session and its title', () => {
    const out = clearTabInPlace(tabs, 'tab-2', 2_000, carry);
    expect(out).not.toBeNull();
    expect(out!.tabs.map((t) => t.id)).toEqual(['tab-1', 'tab-2000', 'tab-3', 'tab-4']);
    const seat = out!.tabs[1]!;
    expect(seat.sessionId).toBe('s-new');
    expect(seat.title).toBe('Continued — Second');
    expect(seat.cwd).toBe('/p');
    expect(seat.planMode).toBe(true);
    // The continued title is derived, not a user rename — it is not locked.
    expect(seat.titleLocked).toBeUndefined();
    expect(out!.newTabId).toBe('tab-2000');
  });

  it('closes the old session through the same path as a plain clear', () => {
    expect(clearTabInPlace(tabs, 'tab-1', 1, carry)?.closedSessionId).toBe('s-1');
  });

  it('refuses the same tabs a plain clear refuses', () => {
    expect(clearTabInPlace(tabs, 'tab-3', 1, carry)).toBeNull();
    expect(clearTabInPlace(tabs, 'tab-4', 1, carry)).toBeNull();
    expect(clearTabInPlace(tabs, 'nope', 1, carry)).toBeNull();
  });

  it('refuses a tab that started a turn while the summary was written', () => {
    const busy: TabInfo[] = [{ id: 'tab-1', cwd: '/p', sessionId: 's-1', title: 'First', isLoading: true }];
    expect(clearTabInPlace(busy, 'tab-1', 1, carry)).toBeNull();
  });

  it('does not touch the input array (pure)', () => {
    const before = JSON.stringify(tabs);
    clearTabInPlace(tabs, 'tab-2', 3, carry);
    expect(JSON.stringify(tabs)).toBe(before);
  });
});
