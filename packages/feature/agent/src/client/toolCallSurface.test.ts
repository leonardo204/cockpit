import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * TOOL CALLS MUST NOT LOOK LIKE SPEECH.
 *
 * The transcript has exactly one bubble vocabulary — `bg-accent`, `rounded-2xl`,
 * and for the panels inside a bubble, `border border-border rounded-lg
 * bg-secondary`. Tool calls used to be drawn in it: a bordered secondary card,
 * one per call, nested inside the assistant's balloon. The result was that a
 * turn which read three files looked like four utterances and the one thing the
 * assistant actually SAID was the hardest element on screen to find. A single
 * call rendered as a full-width panel headed "1 tool call".
 *
 * A source assertion, for the same reason as `sidebarPopoverClipping.test.ts`:
 * this is a question about appearance, and jsdom has no layout or CSS cascade,
 * so a mounted render test cannot see the difference between a muted log row and
 * a filled card. Reading the class list is the honest check. The behavioural
 * halves — which calls are listed, when a header appears — are unit-tested in
 * `toolCallDisplay.test.ts`.
 */

const DIR = __dirname;
const read = (f: string) => readFileSync(join(DIR, f), 'utf8');

/** Every class list in the file, so the prose above it (which necessarily
 *  NAMES the tokens it is banning) cannot fail the assertion. */
const classNames = (src: string): string =>
  [...src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)]
    .map((m) => m[1] ?? m[2] ?? '')
    .join(' | ');

describe('a tool call renders as machinery, not as a bubble', () => {
  it('wears none of the bubble tokens', () => {
    const classes = classNames(read('ToolCallModal.tsx'));
    for (const token of ['bg-accent', 'rounded-2xl', 'bg-secondary', 'rounded-lg']) {
      expect(classes, `ToolCallModal reintroduced "${token}"`).not.toContain(token);
    }
  });

  it('stays in the muted house style', () => {
    const classes = classNames(read('ToolCallModal.tsx'));
    // A row: small, muted, tinted on hover — no filled block of its own.
    expect(classes).toContain('text-muted-foreground');
    expect(classes).toContain('hover:bg-muted/30');
  });

  it('opens its detail with the reasoning block\'s lighter recipe', () => {
    // Same treatment as the thinking summary body in MessageBubble, so an
    // expanded call reads as an aside rather than as another card.
    expect(classNames(read('ToolCallModal.tsx'))).toContain(
      'rounded-md border border-border bg-muted/30'
    );
  });
});

describe('tool calls render OUTSIDE the assistant bubble', () => {
  it('places every ToolCallModal after the bubble markup', () => {
    const src = read('MessageBubble.tsx');
    const group = src.indexOf('data-testid="tool-call-group"');
    expect(group, 'the tool-call group block is gone').toBeGreaterThan(-1);

    const rendered = [...src.matchAll(/<ToolCallModal/g)].map((m) => m.index ?? -1);
    expect(rendered.length).toBeGreaterThan(0);
    for (const at of rendered) {
      // Inside the balloon it inherits `bg-accent rounded-2xl` and reads as
      // something the assistant said.
      expect(at, 'a ToolCallModal is back inside the bubble').toBeGreaterThan(group);
    }
  });

  it('does not leave an empty balloon behind for a tool-only turn', () => {
    // An assistant row that only ran tools has nothing to say; without this the
    // bubble still renders as an empty `bg-accent` pill above the rows.
    const src = read('MessageBubble.tsx');
    expect(src).toContain('const showBubble = isUser || hasBubbleContent;');
    expect(src).toContain('{showBubble && (');
  });
});
