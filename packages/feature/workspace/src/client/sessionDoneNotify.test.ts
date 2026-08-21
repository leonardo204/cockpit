import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DONE_STATUS,
  newlyDoneSessions,
  notifiableFinishedSessions,
  notificationLabel,
  notifyLocale,
  notifySessionDone,
  rememberStatuses,
  shouldNotifySessionDone,
  type SessionStatusRow,
} from './sessionDoneNotify';

/**
 * "IT FINISHED" ON THE DESKTOP.
 *
 * THE REPORT. naby now finishes work after the turn that started it — a
 * background job runs on, and when it lands a follow-up turn reports on it. That
 * report ended as a dot in a sidebar the user had walked away from, which was the
 * original silence wearing a badge.
 *
 * An OS banner cannot be verified headlessly (jsdom has no notification centre
 * and no compositor), so what is pinned here is the DECISION — when a banner is
 * owed and when it is noise — plus a source assertion for the wiring, the device
 * `sidebarPopoverClipping.test.ts` established for facts no runtime check can
 * reach.
 */

const row = (over: Partial<SessionStatusRow> = {}): SessionStatusRow => ({
  cwd: '/work/naby',
  sessionId: 'sess-a',
  status: DONE_STATUS,
  ...over,
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('which sessions just finished', () => {
  it('fires on the EDGE into unread', () => {
    const before = new Map([['sess-a', 'loading']]);
    expect(newlyDoneSessions(before, [row()])).toHaveLength(1);
  });

  it('does not fire on the first snapshot — a status is not a transition', () => {
    // The push that arrives on connect carries yesterday's unread sessions. The
    // previous build of this idea would have greeted the user with a stack of
    // banners about work they already know about.
    expect(newlyDoneSessions(new Map(), [row(), row({ sessionId: 'sess-b' })])).toEqual([]);
  });

  it('does not fire twice for one ending', () => {
    const before = new Map([['sess-a', 'loading']]);
    const first = newlyDoneSessions(before, [row()]);
    const after = rememberStatuses(before, [row()]);
    const second = newlyDoneSessions(after, [row()]);
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it('fires again when the session runs and finishes a second time', () => {
    let seen = rememberStatuses(new Map(), [row()]);
    seen = rememberStatuses(seen, [row({ status: 'loading' })]);
    expect(newlyDoneSessions(seen, [row()])).toHaveLength(1);
  });

  it('ignores rows that are still running, and malformed ones', () => {
    const before = new Map([['sess-a', 'idle']]);
    expect(newlyDoneSessions(before, [row({ status: 'loading' })])).toEqual([]);
    expect(newlyDoneSessions(before, [{ ...row(), sessionId: '' }])).toEqual([]);
  });

  it('remembers without mutating what the caller handed it', () => {
    const before = new Map([['sess-a', 'loading']]);
    const after = rememberStatuses(before, [row()]);
    expect(before.get('sess-a')).toBe('loading');
    expect(after.get('sess-a')).toBe(DONE_STATUS);
  });
});

describe('whether that finish is worth interrupting for', () => {
  it('stays quiet about the session the user is looking at, in a focused app', () => {
    expect(
      shouldNotifySessionDone({ sessionId: 'sess-a', appFocused: true, visibleSessionId: 'sess-a' }),
    ).toBe(false);
  });

  it('speaks up when the app is not focused, even about the session on screen', () => {
    // The user cannot see a screen they are not looking at — this is the whole
    // case the feature exists for.
    expect(
      shouldNotifySessionDone({ sessionId: 'sess-a', appFocused: false, visibleSessionId: 'sess-a' }),
    ).toBe(true);
  });

  it('speaks up about another session even in a focused app', () => {
    expect(
      shouldNotifySessionDone({ sessionId: 'sess-a', appFocused: true, visibleSessionId: 'sess-b' }),
    ).toBe(true);
    expect(shouldNotifySessionDone({ sessionId: 'sess-a', appFocused: true })).toBe(true);
  });
});

describe('which of a batch reaches the desktop', () => {
  // THE REPORTED BUG. A Telegram conversation held away from the PC ended ten
  // turns, and the user came back to ten identical banners. The cure is one
  // replaceable banner in main carrying a running count — which only counts
  // correctly if this side reports each finished run exactly once.
  it('reports every finished run, so main can count them', () => {
    const finished = [row(), row({ sessionId: 'sess-b' }), row({ sessionId: 'sess-c' })];
    const out = notifiableFinishedSessions({ finished, appFocused: false });
    expect(out.map((r) => r.sessionId)).toEqual(['sess-a', 'sess-b', 'sess-c']);
  });

  it('does not collapse a batch into one report — that would undercount the banner', () => {
    // Tempting, and wrong: main tallies CALLS. Three endings that arrive in one
    // push must still be three, or the banner says "1 conversation finished"
    // about three.
    const finished = [row(), row({ sessionId: 'sess-b' }), row({ sessionId: 'sess-c' })];
    expect(notifiableFinishedSessions({ finished, appFocused: false })).toHaveLength(3);
  });

  it('counts one session once however many rows in a push describe it', () => {
    // `unread` is written on more than one path, so a single push can carry the
    // same session twice. One ending is one ending.
    const finished = [row(), row({ title: 'again' })];
    const out = notifiableFinishedSessions({ finished, appFocused: false });
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBeUndefined(); // the first sighting is the one reported
  });

  it('still drops the session on screen in a focused app, and keeps the rest', () => {
    const finished = [row(), row({ sessionId: 'sess-b' })];
    const out = notifiableFinishedSessions({
      finished,
      appFocused: true,
      visibleSessionId: 'sess-a',
    });
    expect(out.map((r) => r.sessionId)).toEqual(['sess-b']);
  });

  it('reports nothing from an empty batch, and skips malformed rows', () => {
    expect(notifiableFinishedSessions({ finished: [], appFocused: false })).toEqual([]);
    expect(
      notifiableFinishedSessions({
        finished: [{ ...row(), sessionId: '' }],
        appFocused: false,
      }),
    ).toEqual([]);
  });
});

describe('what the banner says', () => {
  it('prefers the title, then the last thing asked, then the folder', () => {
    expect(notificationLabel(row({ title: 'Deploy prod' }))).toBe('Deploy prod');
    expect(notificationLabel(row({ lastUserMessage: '배포해줘' }))).toBe('배포해줘');
    expect(notificationLabel(row())).toBe('naby');
  });

  it('picks Korean only for a Korean UI', () => {
    expect(notifyLocale('ko')).toBe('ko');
    expect(notifyLocale('ko-KR')).toBe('ko');
    expect(notifyLocale('en-US')).toBe('en');
    expect(notifyLocale(undefined)).toBe('en');
  });
});

describe('the bridge', () => {
  it('sends kind-free data: a locale and a label, never a title or body', async () => {
    const sessionDone = vi.fn().mockResolvedValue({ ok: true });
    (globalThis as { window?: unknown }).window = { naby: { notifications: { sessionDone } } };
    notifySessionDone(row({ title: 'Deploy prod' }), 'ko');
    expect(sessionDone).toHaveBeenCalledWith({ locale: 'ko', label: 'Deploy prod' });
    // The renderer cannot compose what the OS shows — that is the whole point of
    // the channel's shape.
    const payload = sessionDone.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['label', 'locale']);
  });

  it('does nothing at all in a plain browser', () => {
    (globalThis as { window?: unknown }).window = {};
    expect(() => notifySessionDone(row(), 'en')).not.toThrow();
  });

  it('swallows a bridge that rejects', () => {
    const sessionDone = vi.fn().mockRejectedValue(new Error('no notification daemon'));
    (globalThis as { window?: unknown }).window = { naby: { notifications: { sessionDone } } };
    expect(() => notifySessionDone(row(), 'en')).not.toThrow();
  });
});

describe('the wiring, asserted on the source', () => {
  const hook = readFileSync(join(__dirname, 'useSessionDoneNotifications.ts'), 'utf8');
  const workspace = readFileSync(join(__dirname, 'Workspace.tsx'), 'utf8');
  const preload = readFileSync(
    join(__dirname, '..', '..', '..', '..', '..', '..', 'electron', 'preload.ts'),
    'utf8',
  );
  const ipc = readFileSync(
    join(__dirname, '..', '..', '..', '..', '..', '..', 'electron', 'ipc.ts'),
    'utf8',
  );
  const notifications = readFileSync(
    join(__dirname, '..', '..', '..', '..', '..', '..', 'electron', 'notifications.ts'),
    'utf8',
  );
  const main = readFileSync(
    join(__dirname, '..', '..', '..', '..', '..', '..', 'electron', 'main.ts'),
    'utf8',
  );

  it('rides the global-state socket the sidebar already opened', () => {
    // A second socket for this would be a second connection per window, for a
    // signal that is already being pushed.
    expect(hook).toMatch(/url:\s*'\/ws\/global-state'/);
  });

  it('reads the app focus at the moment it decides', () => {
    expect(hook).toContain('document.hasFocus()');
  });

  it('is mounted where the visible session is known', () => {
    expect(workspace).toContain('useSessionDoneNotifications({');
    expect(workspace).toMatch(/getVisibleSessionId:[\s\S]{0,160}projectSessionIdsRef\.current\.get/);
  });

  it('exposes exactly one notification function on the bridge, and no free text', () => {
    expect(preload).toMatch(/sessionDone:\s*\(input:\s*\{\s*locale\?[\s\S]{0,80}label\?/);
    // The guard that matters: the renderer never names a title or a body.
    expect(preload).not.toMatch(/ipcRenderer\.invoke\('notify:show',\s*\{\s*title/);
    expect(ipc).toContain("'notify:show'");
    expect(ipc).toContain('isNotifyKind(kind)');
    expect(ipc).toContain('sanitizeLabel(label)');
  });

  it('sends no count across the bridge — main owns the tally', () => {
    // Requirement, not preference: a number from the page ends up in an OS-drawn
    // box with this app's name on it. The payload stays {kind, locale, label}.
    expect(preload).not.toMatch(/invoke\('notify:show',[\s\S]{0,200}count/);
    expect(ipc).not.toMatch(/const \{[^}]*count[^}]*\} = asObject\(payload\)/);
  });

  it('keeps at most ONE notification instance, and revokes it before replacing it', () => {
    // The pile-up cure. jsdom has no Notification Center, so what is pinned is
    // the shape: one construction site, the instance RETAINED (it used to be
    // dropped on the floor at `show()`), and closed before its successor is
    // posted — they share an id, so the other order would delete the
    // replacement along with the original.
    expect(notifications.match(/new Notification\(/g)).toHaveLength(1);
    expect(notifications).toMatch(/live\s*=\s*notification/);
    const flush = notifications.slice(notifications.indexOf('function flushRunsFinished'));
    expect(flush.indexOf('closeLive()')).toBeLessThan(flush.indexOf('new Notification('));
    expect(flush.indexOf('new Notification(')).toBeLessThan(flush.indexOf('notification.show()'));
  });

  it('posts every banner under one fixed id, so the OS replaces rather than stacks', () => {
    // macOS `UNNotificationRequest.identifier` / Windows toast `Tag`. One line,
    // both platforms — there must be no `process.platform` branch in here.
    expect(notifications).toMatch(/RUNS_FINISHED_ID\s*=\s*'[^']+'/);
    expect(notifications).toMatch(/new Notification\(\{\s*id:\s*RUNS_FINISHED_ID/);
    expect(notifications).not.toContain('process.platform');
  });

  it('resets the count on focus and on click, and NOT on dismissal', () => {
    // `close` fires for a Windows system timeout too; treating that as "seen"
    // would forget runs the user never saw, in exactly the away-from-desk case.
    expect(notifications).toMatch(/app\.on\('browser-window-focus',\s*clearRunsFinished\)/);
    expect(notifications).toMatch(/on\('click',\s*\(\)\s*=>\s*\{\s*clearRunsFinished\(\)/);
    expect(notifications).not.toMatch(/on\('close'/);
    // Armed by the production entry, or the reset never happens at all.
    expect(main).toContain('installRunsFinishedReset()');
  });
});
