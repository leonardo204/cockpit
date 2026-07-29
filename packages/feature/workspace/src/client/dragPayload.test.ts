import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every draggable list must put something in `dataTransfer`.
 *
 * Chromium refuses to fire `drop` for a drag whose dataTransfer is empty. The
 * failure is unusually deceptive: `dragstart` and `dragover` both fire, so the
 * row dims and the insert line appears exactly as if it worked — and then the
 * item springs back. It reads as "reordering is broken", not as a missing API
 * call, and it shipped in all three of the reorderable lists.
 *
 * A source assertion, like sidebarPopoverClipping: there is no DOM in this test
 * environment, and even with one, jsdom does not implement the drag-and-drop
 * data store faithfully enough to reproduce Chromium's refusal. Checking that
 * the call is present is the honest check for this particular mistake.
 */

const FILES = [
  ['workspace tab bar', join(__dirname, 'TabBar.tsx')],
  ['pinned sessions', join(__dirname, '..', '..', '..', 'agent', 'src', 'client', 'PinnedSessionsPanel.tsx')],
  ['scheduled tasks', join(__dirname, '..', '..', '..', 'agent', 'src', 'client', 'ScheduledTasksPanel.tsx')],
] as const;

describe('draggable rows carry a dataTransfer payload', () => {
  for (const [label, path] of FILES) {
    it(`${label} sets data on dragstart`, () => {
      const src = readFileSync(path, 'utf8');
      // Premise: this file still has a draggable row. If that ever stops being
      // true the rule is free to go, but the test should not quietly pass.
      expect(src, `${label} no longer has a draggable row`).toContain('draggable');
      expect(src, `${label} drag would never produce a drop`).toContain(
        'dataTransfer.setData(',
      );
    });

    it(`${label} calls preventDefault on drop`, () => {
      // Without it the browser handles the drop itself and the handler never
      // runs — the same invisible failure from the other direction.
      const src = readFileSync(path, 'utf8');
      const onDrop = /onDrop=\{\(e\) => \{[\s\S]{0,200}?e\.preventDefault\(\)/.test(src);
      expect(onDrop, `${label} onDrop does not preventDefault`).toBe(true);
    });
  }
});
