import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE WIRING BEHIND stickToBottom.ts AND checkinReveal.ts.
 *
 * The two state machines are unit-tested to the last case, and both would go on
 * passing if nobody called them. What cannot be tested by rendering is exactly
 * what breaks here: this suite has NO jsdom (see vitest.config.ts), and even
 * with one, jsdom has no layout — every scroll metric reads 0, which is
 * indistinguishable from a hidden tab. So the connections are asserted from the
 * source, the same way `sidebarPopoverClipping.test.ts` guards a CSS rule that
 * neither tests nor typecheck can see.
 *
 * Each assertion below stands for a way the two fixes have already been broken
 * once, or would silently regress.
 */

/** The `packages/` root — this file sits at packages/feature/agent/src/client. */
const ROOT = join(__dirname, '../../../..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const AGENT = 'feature/agent/src/client';
const messageList = read(`${AGENT}/MessageList.tsx`);
const chat = read(`${AGENT}/Chat.tsx`);
const checkinPrompt = read(`${AGENT}/CheckinPrompt.tsx`);

describe('MessageList — the transcript follows the answer', () => {
  it('THE BUG IS GONE: nothing scrolls on a message-COUNT change any more', () => {
    // The original rule. A streamed answer rewrites the last message rather
    // than appending one, so this comparison was false for the entire reply and
    // the view froze partway through it.
    expect(messageList).not.toMatch(/currentCount\s*>\s*prevCount/);
    expect(messageList).not.toMatch(/prevMessageCountRef/);
    // The `shouldAutoScroll` piece of state went with it — the stick now lives
    // in a ref driven by the reducer, so it cannot drift from what was measured.
    // (The name survives in the comment that explains the bug; the setter is
    // what would mean the old rule is back.)
    expect(messageList).not.toMatch(/setShouldAutoScroll/);
  });

  it('growth of the content box is what drives it now', () => {
    // A ResizeObserver on the scrolled content sees EVERY source of growth:
    // streamed deltas, appended segments, a subagent block filling in, tool
    // results expanding, the thinking bubble coming and going, the reconcile
    // after a run ends. No per-source scroll call to forget.
    expect(messageList).toMatch(/new ResizeObserver/);
    expect(messageList).toMatch(/ro\.observe\(el\)/);
    expect(messageList).toMatch(/ro\.disconnect\(\)/);
    expect(messageList).toMatch(/kind:\s*'content'/);
  });

  it('the decisions come from the tested state machine, not from the component', () => {
    expect(messageList).toMatch(/from '\.\/stickToBottom'/);
    expect(messageList).toMatch(/reduceStick\(/);
    expect(messageList).toMatch(/shouldShowJumpChip\(/);
  });

  it('scroll writes are throttled to one per frame, and cleaned up', () => {
    // Deltas flush every 50ms and a growing block can resize several times
    // between frames; without coalescing, each one forces a layout for a
    // position nobody ever sees.
    expect(messageList).toMatch(/requestAnimationFrame/);
    expect(messageList).toMatch(/cancelAnimationFrame/);
  });

  it('a queued write never overrules a user who grabbed the wheel', () => {
    // The frame between "content grew" and "write the scroll" is exactly long
    // enough for the user to scroll up. The write re-checks before landing.
    expect(messageList).toMatch(/if \(!stickRef\.current\.stuck/);
  });

  it('a background tab is never measured', () => {
    // Inactive chat tabs stay MOUNTED and are hidden with `display:none`
    // (TabManager), where every box metric reads 0 — and 0/0/0 satisfies "at
    // bottom", so measuring one would re-pin a conversation the user had
    // scrolled up in.
    expect(messageList).toMatch(/isActiveRef\.current/);
    expect(messageList).toMatch(/el\.clientHeight === 0/);
  });

  it('the chip is a labelled control, not another bare arrow', () => {
    // The report is "I cannot tell whether a new response arrived". A circle
    // with an arrow does not answer that; a word does.
    expect(messageList).toMatch(/data-testid="jump-to-latest-chip"/);
    expect(messageList).toMatch(/t\('chat\.newResponse'/);
  });

  it('a send re-pins, through a counter that survives repeats', () => {
    expect(messageList).toMatch(/sendNonce/);
    expect(messageList).toMatch(/kind:\s*'send'/);
  });
});

describe('Chat — the two signals it owns', () => {
  it('passes the send counter to the transcript', () => {
    expect(chat).toMatch(/sendNonce=\{sendNonce\}/);
    // Bumped from every path that actually dispatches a turn.
    const bumps = chat.match(/bumpSend\(\)/g) ?? [];
    expect(bumps.length).toBeGreaterThanOrEqual(3); // input send, /plan <task>, approve-plan
  });

  it('bumps the run counter on the RISING edge of a turn, from either source', () => {
    // `isLoading` = this tab sent; `liveRunning` = a turn arrived (Telegram, a
    // scheduled task, the fast-growth kickoff). Both move the conversation on.
    expect(chat).toMatch(/const running = isLoading \|\| liveRunning/);
    expect(chat).toMatch(/if \(running && !prevRunningRef\.current\) setRunNonce/);
  });

  it('hands the run counter to the check-in banner', () => {
    expect(chat).toMatch(/<CheckinPrompt[\s\S]*?runNonce=\{runNonce\}/);
  });
});

describe('CheckinPrompt — the reveal banner retires itself', () => {
  it('THE FIX: the next turn takes it down', () => {
    expect(checkinPrompt).toMatch(/from '\.\/checkinReveal'/);
    expect(checkinPrompt).toMatch(/kind:\s*'run-start'/);
  });

  it('the manual ✕ still works', () => {
    expect(checkinPrompt).toMatch(/kind:\s*'dismiss'/);
    expect(checkinPrompt).toMatch(/data-testid="checkin-reveal-close"/);
  });

  it('NO TIMER dismisses it', () => {
    // Content must not vanish while a user might be mid-read; progression, not
    // a clock, is what makes the banner stale.
    expect(checkinPrompt).not.toMatch(/setTimeout|setInterval/);
  });
});

describe('the chip copy exists in both locales', () => {
  // i18next falls back to the English `defaultValue` on a missing key, so a
  // Korean user would read an English word in the middle of a Korean UI and
  // nothing would error.
  for (const locale of ['en', 'ko'] as const) {
    it(`${locale}: chat.newResponse`, () => {
      const dict = JSON.parse(read(`shared/i18n/locales/${locale}.json`));
      expect(typeof dict.chat?.newResponse).toBe('string');
      expect(dict.chat.newResponse.length).toBeGreaterThan(0);
    });
  }
});
