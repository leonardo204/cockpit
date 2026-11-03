import { describe, it, expect, afterEach } from 'vitest';
import {
  LOGIN_POLL_MAX,
  RELOGIN_GUIDE_IDLE,
  chipHighlight,
  createReloginGuide,
  RELOGIN_START,
  getClaudeLoginStatus,
  pollClaudeSignIn,
  publishClaudeLoginStatus,
  reloginProgress,
  subscribeClaudeLoginStatus,
  type ReloginProgress,
} from './claudeLoginFlow';

/**
 * specs/claude-relogin-guide.md R3–R4 — the guide card's progress is a fold over
 * the status the chip reads, and the chip is the only one reading it.
 */

const fold = (statuses: readonly (string | null)[], from: ReloginProgress = RELOGIN_START): ReloginProgress =>
  statuses.reduce<ReloginProgress>(reloginProgress, from);

describe('reloginProgress — ticking the steps off', () => {
  it('signed-in → signed-out → signed-in: step 2 at the logout, step 3 at the new sign-in', () => {
    // An expired refresh still reads signed in: nothing is done yet.
    expect(fold(['signed-in'])).toEqual({ loggedOut: false, signedInAgain: false });
    expect(fold(['signed-in', 'signed-out'])).toEqual({ loggedOut: true, signedInAgain: false });
    expect(fold(['signed-in', 'signed-out', 'signed-in'])).toEqual({ loggedOut: true, signedInAgain: true });
  });

  it('a card that opens already signed out starts at step 2 done', () => {
    expect(fold(['signed-out'])).toEqual({ loggedOut: true, signedInAgain: false });
    expect(fold(['signed-out', 'signed-in'])).toEqual({ loggedOut: true, signedInAgain: true });
  });

  it('unknown or no reading changes nothing', () => {
    expect(fold([null, 'unknown'])).toBe(RELOGIN_START);
    const out = fold(['signed-out']);
    expect(reloginProgress(out, 'unknown')).toBe(out);
  });

  it('finished steps stay finished, and the same object comes back when nothing changed', () => {
    const done = fold(['signed-out', 'signed-in']);
    expect(reloginProgress(done, 'signed-out')).toBe(done);
    expect(reloginProgress(done, 'signed-in')).toBe(done);
    const out = fold(['signed-out']);
    expect(reloginProgress(out, 'signed-out')).toBe(out);
  });
});

describe('the published status — one source for the chip and the card', () => {
  afterEach(() => publishClaudeLoginStatus(null));

  it('notifies subscribers on a change, and only on a change', () => {
    let calls = 0;
    const off = subscribeClaudeLoginStatus(() => calls++);
    publishClaudeLoginStatus('signed-in');
    publishClaudeLoginStatus('signed-in');
    publishClaudeLoginStatus('signed-out');
    expect(calls).toBe(2);
    expect(getClaudeLoginStatus()).toBe('signed-out');
    off();
    publishClaudeLoginStatus('signed-in');
    expect(calls).toBe(2);
  });
});

describe('pollClaudeSignIn — the chip\'s login poll', () => {
  it('stops at the first yes', async () => {
    let n = 0;
    expect(await pollClaudeSignIn(async () => ++n === 3, () => true, async () => {})).toBe(true);
    expect(n).toBe(3);
  });
  it('gives up after LOGIN_POLL_MAX tries', async () => {
    let n = 0;
    expect(await pollClaudeSignIn(async () => (n++, false), () => true, async () => {})).toBe(false);
    expect(n).toBe(LOGIN_POLL_MAX);
  });
  it('stops when no longer live (cancel / unmount)', async () => {
    let n = 0;
    let live = true;
    const landed = await pollClaudeSignIn(
      async () => {
        if (++n === 2) live = false;
        return false;
      },
      () => live,
      async () => {},
    );
    expect(landed).toBe(false);
    expect(n).toBe(2);
  });
});

describe('the re-login guide — the card tells the chip where to point (R3a)', () => {
  it('report notifies only on a change; requests are edges', () => {
    const g = createReloginGuide();
    let calls = 0;
    g.subscribe(() => calls++);
    expect(g.get()).toBe(RELOGIN_GUIDE_IDLE);
    g.report({ active: true, loggedOut: false });
    g.report({ active: true, loggedOut: false });
    expect(calls).toBe(1);
    g.requestOpen();
    g.requestFlash();
    g.requestFlash();
    expect(g.get()).toMatchObject({ active: true, openRequest: 1, flashRequest: 2 });
    expect(calls).toBe(4);
  });

  it('two conversations have two guides — one tab never lights up another', () => {
    const a = createReloginGuide();
    const b = createReloginGuide();
    a.report({ active: true, loggedOut: false });
    expect(b.get().active).toBe(false);
  });
});

describe('chipHighlight — ring, then the item to press', () => {
  it('nothing while the guide is not up (signed in again, dismissed, next send)', () => {
    expect(chipHighlight({ active: false, loggedOut: true }, false)).toEqual({ ring: false, logout: false, login: false });
    expect(chipHighlight({ active: false, loggedOut: false }, true)).toEqual({ ring: false, logout: false, login: false });
  });
  it('menu closed: the ring pulses', () => {
    expect(chipHighlight({ active: true, loggedOut: false }, false)).toEqual({ ring: true, logout: false, login: false });
  });
  it('menu open: the ring pauses and Log out is outlined', () => {
    expect(chipHighlight({ active: true, loggedOut: false }, true)).toEqual({ ring: false, logout: true, login: false });
  });
  it('after the logout: Log in is outlined (menu or inline)', () => {
    expect(chipHighlight({ active: true, loggedOut: true }, true)).toEqual({ ring: false, logout: false, login: true });
    expect(chipHighlight({ active: true, loggedOut: true }, false)).toEqual({ ring: true, logout: false, login: true });
  });
});
