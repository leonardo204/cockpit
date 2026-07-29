import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The sidebar must not clip the panels that open out of it.
 *
 * Recent sessions, Pinned sessions and Scheduled tasks each render an
 * `absolute left-full` popover — positioned deliberately OUTSIDE the sidebar,
 * to its right. Adding `overflow-hidden` to the sidebar's own root erases all
 * three: the buttons still highlight, and clicking them does nothing visible.
 * It reads as three dead buttons rather than as one CSS property.
 *
 * That shipped. The drag-to-resize handle added the class to stop content
 * spilling mid-drag, no test noticed, and the bug reached a release.
 *
 * This is a source assertion rather than a rendering one, and deliberately so:
 * the failure is a clipping ancestor, which jsdom does not model — it has no
 * layout, so a mounted test would happily "see" a popover the browser hides.
 * Reading the class list is the honest check for this particular mistake.
 */

const SRC = join(__dirname, 'ProjectSidebar.tsx');

describe('sidebar layout — popovers escape the panel', () => {
  it('does not clip overflow on the sidebar root', () => {
    const src = readFileSync(SRC, 'utf8');

    // The root is the first element of the component's return: `h-full bg-card
    // flex flex-col`. Match that class run and assert what is NOT in it.
    const rootClass = /className=\{`h-full bg-card flex flex-col[^`]*`/.exec(src)?.[0];
    expect(rootClass, 'sidebar root className not found — did the markup change?').toBeDefined();
    expect(rootClass).not.toContain('overflow-hidden');
    expect(rootClass).not.toContain('overflow-clip');
  });

  it('still has popovers that depend on it', () => {
    // If these ever stop escaping the sidebar, the rule above is free to relax.
    // Asserting the premise keeps the test honest instead of guarding nothing.
    const panels = ['GlobalSessionMonitor', 'PinnedSessionsPanel', 'ScheduledTasksPanel'];
    const dir = join(__dirname, '..', '..', '..', 'agent', 'src', 'client');
    for (const panel of panels) {
      const src = readFileSync(join(dir, `${panel}.tsx`), 'utf8');
      expect(src, `${panel} no longer opens a left-full popover`).toContain('absolute left-full');
    }
  });
});
