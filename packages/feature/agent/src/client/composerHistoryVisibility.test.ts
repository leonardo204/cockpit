import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The selected row in the history list has to be visible, and the list has to
 * scroll to it without moving anything else.
 *
 * Both of these broke in the same edit, and both were invisible to the test
 * suite. The rows were flipped to paint oldest-first — so that Up moves the
 * highlight up AND further back in time — while two things kept assuming array
 * order: the scroll effect indexed `children[historyIndex + 1]`, and nothing
 * told the reader which row was current except a `bg-brand/10` tint. On a list
 * of bare sentences that tint is close to invisible, and a selection nobody can
 * see is indistinguishable from arrow keys that do nothing. That is exactly how
 * it was reported: "only the mouse works".
 *
 * `scrollIntoView` is banned here for the reason the model switcher bans it —
 * it walks every scrollable ancestor, and in the three-panel layout those are
 * the chat panel and the swipe container, so it can slide the whole panel to
 * reveal a popover that is already on screen.
 *
 * Source assertions rather than rendering ones, deliberately: this repo has no
 * jsdom, and jsdom computes every height as 0 anyway, so a mounted test would
 * pass whether or not any of this holds.
 */

const SRC = readFileSync(join(__dirname, 'ChatInput.tsx'), 'utf8');

/** The history list's JSX row, from its `key` to the end of its class list. */
function historyRow(): string {
  const row = /key=\{`\$\{index\}-\$\{entry\.slice\(0, 32\)\}`\}[\s\S]*?className=\{`([^`]*)`/.exec(SRC);
  expect(row, 'the history row moved or was renamed').not.toBeNull();
  return row![1];
}

describe('composer history — the selected row can be seen and reached', () => {
  it('marks the active row with an attribute, not only a colour', () => {
    // The scroll effect finds the row by this marker. A test can too, and so
    // can a screen reader via the aria-selected beside it.
    expect(SRC).toContain(`data-active={index === historyIndex ? 'true' : 'false'}`);
    expect(SRC).toContain('aria-selected={index === historyIndex}');
  });

  it('gives the active row more than a faint tint', () => {
    const classes = historyRow();
    expect(classes, `the active row's styling:\n${classes}`).toContain('border-l-2');
    expect(classes).toContain('border-brand');
    // The tint that shipped was /10 and could not be seen against white.
    expect(/bg-brand\/(1[5-9]|[2-9]\d)/.test(classes), `too faint: ${classes}`).toBe(true);
  });

  it('scrolls the list itself, never an ancestor', () => {
    const effect = /if \(!showHistory\) return;[\s\S]*?\}, \[historyIndex, showHistory\]\);/.exec(SRC);
    expect(effect, 'the history scroll effect moved').not.toBeNull();
    const body = effect![0];

    expect(body).toContain(`querySelector<HTMLElement>('[data-active="true"]')`);
    expect(body).toContain('list.scrollTop =');
    // Positional indexing is what broke when the paint order flipped.
    expect(/children\[/.test(body), `indexes children by position:\n${body}`).toBe(false);
    expect(/scrollIntoView/.test(body), `uses scrollIntoView:\n${body}`).toBe(false);
  });

  it('still paints oldest-first, which is the premise the marker replaces', () => {
    // If this ever goes back to array order the scroll effect keeps working —
    // it looks the row up — but the reversal comment above it would be a lie.
    expect(SRC).toContain('.reverse()');
  });

  it('tells the reader the arrow keys do something', () => {
    // The hint lost its arrows while the direction was being sorted out; the
    // report that followed was partly "I did not know they moved".
    const en = readFileSync(
      join(__dirname, '../../../../shared/i18n/locales/en.json'),
      'utf8',
    );
    const hint = /"historyHint": "([^"]*)"/.exec(en);
    expect(hint, 'chatInput.historyHint is gone').not.toBeNull();
    expect(hint![1]).toContain('↑↓');
  });
});
