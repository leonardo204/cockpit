import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  canDeleteRecentSession,
  recentDeleteBlock,
  withoutRecentSession,
  type RecentDeleteTarget,
} from './recentSessionDelete';

/**
 * The × at the right of a "Recent sessions" row.
 *
 * Split the way the sidebar-tree guard next door is split, and for the same
 * reason: the decisions are pure functions and are exercised as such, while the
 * rendering is asserted against the SOURCE — this repo has no jsdom or
 * testing-library, and hover reveal is layout, which jsdom computes as nothing
 * even where it is installed.
 */

const CLIENT = __dirname;
const read = (name: string) => readFileSync(join(CLIENT, name), 'utf8');
/**
 * Source with the prose taken out. The comments here NAME the things these
 * guards forbid ("no confirmation", "not a second call"), so a naive negative
 * assertion would fail on the explanation of why it holds.
 */
const code = (name: string) =>
  read(name)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
const LOCALES = join(CLIENT, '..', '..', '..', '..', 'shared', 'i18n', 'locales');

const CWD = '/Users/me/work/naby';

const target = (over: Partial<RecentDeleteTarget> = {}): RecentDeleteTarget => ({
  cwd: CWD,
  sessionId: 's1',
  ...over,
});

describe('recent × — what a click means', () => {
  it('an ordinary row deletes, with nothing in the way', () => {
    expect(recentDeleteBlock(target())).toBeNull();
    expect(canDeleteRecentSession(target())).toBe(true);
  });

  it('a projectless row cannot be deleted at all', () => {
    // /api/project-state rejects an empty cwd, so the ONE removal channel
    // cannot address these legacy rows. They stay listed (recentFilter keeps
    // them on purpose) with an inert, explained control.
    expect(recentDeleteBlock(target({ cwd: '' }))).toBe('no-project');
    expect(recentDeleteBlock(target({ cwd: '   ' }))).toBe('no-project');
    expect(canDeleteRecentSession(target({ cwd: '' }))).toBe(false);
  });
});

describe('recent × — optimistic removal', () => {
  const row = (cwd: string, sessionId: string) => ({ cwd, sessionId });

  it('removes exactly the deleted row', () => {
    const list = [row(CWD, 's1'), row(CWD, 's2')];
    expect(withoutRecentSession(list, CWD, 's1')).toEqual([row(CWD, 's2')]);
  });

  it('identity is (cwd, sessionId) — the list is cross-project', () => {
    const list = [row(CWD, 's1'), row('/other', 's1')];
    expect(withoutRecentSession(list, CWD, 's1')).toEqual([row('/other', 's1')]);
  });

  it('an unknown row removes nothing', () => {
    const list = [row(CWD, 's1')];
    expect(withoutRecentSession(list, CWD, 'gone')).toEqual(list);
  });
});

describe('recent × — the control', () => {
  it('one shared control serves both recent lists', () => {
    // The popover and its expanded modal show the same sessions; two × with
    // two behaviours is the drift recentFilter.ts was written to end.
    expect(read('GlobalSessionMonitor.tsx')).toContain('<RecentSessionDeleteButton');
    expect(read('RecentSessionsModal.tsx')).toContain('<RecentSessionDeleteButton');
  });

  it('the click never falls through to the row underneath', () => {
    const src = read('RecentSessionDeleteButton.tsx');
    const handler = /const handleClick = \([\s\S]*?\n  \};/.exec(src)?.[0];
    expect(handler, 'handleClick was reshaped — re-point this guard').toBeDefined();
    // Enter/Space on a <button> dispatch a click, so this one guard covers the
    // keyboard activation too.
    expect(handler).toContain('e.stopPropagation()');
    expect(handler).toContain('e.preventDefault()');
    expect(handler).toContain('onDelete(session.cwd, session.sessionId)');
    // A refused row swallows its click as well, or it would open the session.
    expect(handler).toContain('if (blocked) return;');
    expect(src).toContain('onClick={handleClick}');
  });

  it('one click, no confirmation step of any kind', () => {
    const src = code('RecentSessionDeleteButton.tsx');
    // Same as a tab close and the sidebar tree row: the click IS the action.
    expect(src).not.toMatch(/\bconfirm\(/);
    expect(src).not.toMatch(/armed|useState|deleteSessionConfirm/);
    // ...and neither list wraps it in one either.
    expect(code('GlobalSessionMonitor.tsx')).not.toMatch(/armed/);
    expect(code('RecentSessionsModal.tsx')).not.toMatch(/armedDeleteId/);
    for (const file of ['RecentSessionDeleteButton.tsx', 'GlobalSessionMonitor.tsx', 'RecentSessionsModal.tsx']) {
      expect(code(file), `${file} must not reach for confirm()`).not.toMatch(/\bconfirm\(/);
      expect(code(file)).not.toContain('dangerouslySetInnerHTML');
    }
  });

  it('hover-revealed at the right of the row, focusable, and visible on touch', () => {
    const src = read('RecentSessionDeleteButton.tsx');
    // The established sidebar pattern, plus focus so it is not mouse-only.
    expect(src).toContain('opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100');
    // A real focusable button, and never a submit inside a form.
    expect(src).toContain('type="button"');
    // Same × glyph as the tab close and the sidebar tree row.
    expect(src).toContain('M6 18L18 6M6 6l12 12');
    // Both hosts provide the `group` the reveal hangs off, with the control
    // last in the row so it sits on the right.
    const monitor = read('GlobalSessionMonitor.tsx');
    expect(monitor).toMatch(/className=\{`group flex items-start/);
    expect(monitor).toMatch(/<\/button>\s*\{\/\*[\s\S]*?\*\/\}\s*<span className="flex items-center self-stretch py-2">\s*<RecentSessionDeleteButton/);
    expect(read('RecentSessionsModal.tsx')).toContain('className="group p-3 bg-secondary');
    expect(read('RecentSessionsModal.tsx')).toContain('className="ml-auto -my-1 -mr-1"');
  });

  it('it reads as a delete, not as a dismissal', () => {
    // The only guard left once the confirmation went: the control must say
    // what it does. Destructive treatment + a tooltip naming the consequence.
    const src = read('RecentSessionDeleteButton.tsx');
    expect(src).toContain('hover:bg-red-500/20');
    expect(src).toContain('hover:text-red-500');
    expect(src).toContain('focus:text-red-500');
    expect(src).toContain("title={t('sessions.deleteSessionFromRecent')}");
    expect(src).toContain("aria-label={t('sessions.deleteSessionFromRecent')}");
  });

  it('a refused row is shown, disabled, and explains why', () => {
    const src = read('RecentSessionDeleteButton.tsx');
    const blocked = /if \(blocked\) \{[\s\S]*?\n  \}/.exec(src)?.[0];
    expect(blocked, 'the blocked branch was reshaped — re-point this guard').toBeDefined();
    expect(blocked).toContain("t('sessions.deleteSessionNoProject')");
    expect(blocked).toContain('disabled');
    expect(blocked).toContain('title={reason}');
    expect(blocked).toContain('aria-label={reason}');
  });
});

describe('recent × — the popover list', () => {
  it('the delete button is a SIBLING of the open target, not nested in it', () => {
    const src = read('GlobalSessionMonitor.tsx');
    // A <button> inside a <button> is invalid HTML that React will not
    // hydrate; the row became a flex container holding both controls.
    const row = /sessions\.map\(\(session, index\) => \([\s\S]*?\n              \)\)/.exec(src)?.[0];
    expect(row, 'the popover row was reshaped — re-point this guard').toBeDefined();
    expect(row).toContain('onClick={() => handleSessionClick(session)}');
    expect(row).toContain('<RecentSessionDeleteButton');
    const openTarget = /<button\s+onClick=\{\(\) => handleSessionClick\(session\)\}[\s\S]*?<\/button>/.exec(row!)?.[0];
    expect(openTarget, 'the open target was reshaped — re-point this guard').toBeDefined();
    expect(openTarget).not.toContain('RecentSessionDeleteButton');
  });

  it('deleting goes out through the list owner, and drops the hover tooltip', () => {
    const src = read('GlobalSessionMonitor.tsx');
    const handler = /const handleDeleteSession = useCallback\([\s\S]*?\}, \[onDeleteSession\]\);/.exec(src)?.[0];
    expect(handler, 'handleDeleteSession was reshaped — re-point this guard').toBeDefined();
    // `sessions` is a prop here, so the owner performs the removal; this panel
    // adds no second client call of its own.
    expect(handler).toContain('onDeleteSession(cwd, sessionId)');
    expect(handler).toContain('setTooltip(null)');
    expect(code('GlobalSessionMonitor.tsx')).not.toContain('saveProjectState');
    expect(code('GlobalSessionMonitor.tsx')).not.toMatch(/[^a-zA-Z]fetch\(/);
  });

  it('the expanded modal is handed the very same deletion channel', () => {
    const src = read('GlobalSessionMonitor.tsx');
    expect(src).toMatch(/<RecentSessionsModal[\s\S]{0,300}onDeleteSession=\{onDeleteSession\}/);
  });
});

describe('recent × — the expanded modal', () => {
  it('removes the card optimistically, and only when the server accepted', () => {
    const src = read('RecentSessionsModal.tsx');
    const handler =
      /const handleDeleteSession = useCallback\(async \(cwd: string, sessionId: string\) => \{[\s\S]*?\}, \[onDeleteSession\]\);/.exec(src)?.[0];
    expect(handler, 'handleDeleteSession was reshaped — re-point this guard').toBeDefined();
    expect(handler).toContain('await onDeleteSession(cwd, sessionId)');
    expect(handler).toContain('if (deleted) setSessions((prev) => withoutRecentSession(prev, cwd, sessionId));');
    // The modal owns its own list, but not a second way to delete.
    expect(code('RecentSessionsModal.tsx')).not.toContain('saveProjectState');
    expect(code('RecentSessionsModal.tsx')).not.toContain('closedSessionIds');
  });

  it('the per-session × is not the list-wide "clear recents" control', () => {
    // Clearing hides everything behind a watermark and is undoable; this ×
    // deletes one session and is not. They keep their separate copy, and only
    // the reversible one keeps its two-click confirm.
    const src = read('RecentSessionsModal.tsx');
    expect(src).toContain("t('sessions.clearRecents')");
    expect(src).toContain("t('sessions.clearRecentsConfirm')");
    expect(src).toContain("t('sessions.restoreCleared')");
    expect(read('RecentSessionDeleteButton.tsx')).toContain("t('sessions.deleteSessionFromRecent')");
  });
});

describe('recent × — i18n', () => {
  it('every string of the control ships in both locales', () => {
    const en = JSON.parse(readFileSync(join(LOCALES, 'en.json'), 'utf8'));
    const ko = JSON.parse(readFileSync(join(LOCALES, 'ko.json'), 'utf8'));
    for (const key of ['deleteSessionFromRecent', 'deleteSessionNoProject']) {
      expect(typeof en.sessions[key], `en.sessions.${key}`).toBe('string');
      expect(typeof ko.sessions[key], `ko.sessions.${key}`).toBe('string');
      expect(en.sessions[key].length).toBeGreaterThan(0);
      expect(ko.sessions[key].length).toBeGreaterThan(0);
    }
    // The words have to name the consequence: this deletes, it does not hide.
    expect(en.sessions.deleteSessionFromRecent).toContain('deleted');
    expect(ko.sessions.deleteSessionFromRecent).toContain('삭제됩니다');
    // The tree row's own tooltip is untouched.
    expect(en.sessions.deleteSession).toBe('Delete session');
    expect(ko.sessions.deleteSession).toBe('세션 삭제');
  });

  it('no string is interpolated into the control, so nothing needs escaping', () => {
    // shared/ui's confirm() builds its body with innerHTML while i18n runs with
    // escapeValue:false; this control neither uses that dialog nor formats a
    // session title into its copy, so there is nothing to escape.
    const src = read('RecentSessionDeleteButton.tsx');
    expect(src).not.toMatch(/t\('sessions\.delete[^']*',\s*\{/);
  });
});
