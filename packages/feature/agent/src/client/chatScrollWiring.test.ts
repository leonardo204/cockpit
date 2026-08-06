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
const chatInput = read(`${AGENT}/ChatInput.tsx`);
const checkinPrompt = read(`${AGENT}/CheckinPrompt.tsx`);
const contextLimitBanner = read(`${AGENT}/ContextLimitBanner.tsx`);
const toolApprovalPrompt = read(`${AGENT}/ToolApprovalPrompt.tsx`);

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

describe('the composer takes room FROM the transcript, it does not cover it', () => {
  /**
   * THE REPORT. "엔터로 여러 줄을 입력하면 입력창이 커지면서 질문/답변 영역을
   * 덮어버린다" — typing a second line grows the input and the last messages
   * disappear behind it.
   *
   * WHAT IT ACTUALLY WAS. Nothing was drawn on top of anything; the column is
   * already flex. The composer's extra lines came off the BOTTOM of the list's
   * viewport, `scrollTop` did not move on its own, and nothing re-pinned —
   * because the growth observer watches the CONTENT box, whose height is
   * exactly what does not change when the composer grows. The newest message
   * slid under the taller input, which is indistinguishable from an overlay.
   *
   * Both halves are asserted here: the layout must stay a flex column (so
   * growth SHRINKS the list rather than covering it) and the re-pin must exist
   * (so the shrink does not hide the answer). jsdom has no layout, so — like
   * `sidebarPopoverClipping.test.ts` — the source is the only witness.
   */

  it('one flex column owns header, transcript, banners and composer', () => {
    expect(chat).toMatch(/id="chat-screen"/);
    expect(chat).toMatch(/className="flex-1 flex flex-col min-w-0 relative"/);
  });

  it('the transcript is the item that flexes, and it is ALLOWED to shrink', () => {
    // `flex-1` hands it the leftover space; `min-h-0` is what lets the leftover
    // get smaller. Without min-h-0 a flex item refuses to go below its content
    // height, the column overflows, and the composer is pushed off the window
    // instead of the list giving way.
    expect(chat).toMatch(/className="flex-1 flex flex-col min-h-0 overflow-hidden"/);
    expect(messageList).toMatch(/relative flex-1 min-h-0 overflow-y-auto/);
  });

  it('NOT AN OVERLAY: nothing in the column is positioned over the list', () => {
    expect(chat).not.toMatch(/absolute[^"'`]*bottom-0/);
    expect(chatInput).not.toMatch(/className=\{`\s*(absolute|fixed)/);
    // The composer's root is an ordinary in-flow block. `relative` is for the
    // drag overlay and the "/" palette INSIDE it, not for the composer itself.
    expect(chatInput).toMatch(/className=\{`border-t bg-card relative/);
  });

  it('NO MAGIC PADDING stands in for the composer height', () => {
    // The overlay design this rules out reserves room with a constant
    // padding-bottom sized for a one-line input; every extra line the user
    // types then lands on top of the transcript. There is no constant here to
    // get wrong — the flex column measures it for free.
    for (const src of [chat, messageList]) {
      expect(src).not.toMatch(/pb-\[\d/);
      expect(src).not.toMatch(/paddingBottom/);
    }
  });

  it('the banners sit BETWEEN the transcript and the composer, in flow', () => {
    const order = ['<MessageList', '<ToolApprovalPrompt', '<CheckinPrompt', '<ContextLimitBanner', '<ChatInput']
      .map((tag) => chat.indexOf(tag));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // …and each is an ordinary block, so it PUSHES the list up rather than
    // covering it — the screenshot showed two of them stacked above the input.
    for (const src of [toolApprovalPrompt, checkinPrompt, contextLimitBanner]) {
      expect(src).not.toMatch(/className="(absolute|fixed)/);
    }
  });

  it('THE FIX: a viewport shrink re-pins a list that was at the bottom', () => {
    expect(messageList).toMatch(/kind:\s*'viewport'/);
    // Observed on the SCROLL CONTAINER. The content observer cannot stand in
    // for it: when the composer grows, the content box is untouched.
    expect(messageList).toMatch(
      /const el = containerRef\.current;\s*\n\s*if \(!el \|\| typeof ResizeObserver === 'undefined'\) return;/,
    );
    const observers = messageList.match(/new ResizeObserver/g) ?? [];
    expect(observers.length).toBeGreaterThanOrEqual(2); // content box + scroll box
  });
});

describe('ChatInput — a bounded composer', () => {
  it('the height rule is the tested one, not a magic number inline', () => {
    expect(chatInput).toMatch(/from '\.\/composerHeight'/);
    expect(chatInput).toMatch(/composerHeight\(textarea\.scrollHeight/);
    expect(chatInput).not.toMatch(/const maxHeight = \d/);
  });

  it('re-measures on window resize, because the cap is partly a share of it', () => {
    expect(chatInput).toMatch(/addEventListener\('resize', adjustTextareaHeight\)/);
    expect(chatInput).toMatch(/removeEventListener\('resize', adjustTextareaHeight\)/);
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
