import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A message balloon must size to its own text, not to the buttons beside it.
 *
 * `MessageBalloon` lays the action column and the balloon out as siblings in a
 * `flex` row with no `items-*`, so `align-items` is `stretch`. The column marks
 * itself `self-start`, which places it — but its height still sets the line's
 * cross size. While the column held one copy button (~32px) it stayed under a
 * one-line balloon (~40px) and nothing showed. Adding resend and edit made it
 * three buttons (~84px), and the balloon, having no `self-*` of its own,
 * stretched to match: the text sat at the top of a box with ~40px of empty
 * space beneath it.
 *
 * That shipped, and it was reported as "pressing Enter sends the newline too" —
 * the dead space reads as a blank second line. It is worth noticing how far the
 * symptom is from the cause: the reporter, and the first guess at the cause,
 * both went looking at IME composition and the send path. The transcript on
 * disk had no newline in it at all.
 *
 * This is a source assertion rather than a rendering one, and deliberately so:
 * jsdom has no layout engine, so a mounted test computes every height as 0 and
 * would pass whether or not the class is there. Reading the class list is the
 * honest check for this particular mistake.
 */

const SRC = join(__dirname, 'MessageBubble.tsx');

describe('message balloon layout — the balloon does not stretch to the action column', () => {
  it('gives the balloon its own cross-axis alignment', () => {
    const src = readFileSync(SRC, 'utf8');

    // The balloon is the element carrying the width cap and the bubble radius.
    const balloon = /className=\{`([^`]*max-w-\[80%\][^`]*)`/.exec(src);
    expect(balloon, 'the max-w-[80%] balloon element moved or was renamed').not.toBeNull();

    const classes = balloon![1];
    expect(
      /\bself-(start|end|center|baseline)\b/.test(classes),
      `the balloon has no self-* class, so it stretches to the action column:\n${classes}`,
    ).toBe(true);
  });

  it('still stacks more than one action button, which is what makes the column tall', () => {
    const src = readFileSync(SRC, 'utf8');

    // If this ever drops back to a single button the stretch would stop showing
    // on its own — and the assertion above would start passing for the wrong
    // reason. Pin the premise so the pair stays honest.
    const column = /\{isUser && \(onCopy \|\| onResend \|\| onEdit\)/.test(src);
    expect(column, 'the user action column changed shape; re-check the premise above').toBe(true);
  });
});
