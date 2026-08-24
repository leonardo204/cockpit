import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RECENT_TOOLTIP_GAP,
  RECENT_TOOLTIP_MARGIN,
  RECENT_TOOLTIP_MAX_HEIGHT,
  RECENT_TOOLTIP_WIDTH,
  recentTooltipPosition,
} from './recentTooltipAnchor';

/**
 * THE HOVER PREVIEW MUST NOT COVER THE ROW'S ×.
 *
 * It did. The panel is anchored to the right of the hovered element, and the
 * hovered element was the row's inner open target — whose right edge is ~24px
 * inside the row, because the × is its sibling. `openTarget.right + 8` put the
 * panel on top of the button, and since the × is only revealed while the pointer
 * is on the row, hovering to reach it was what hid it. Reported as "the × is
 * invisible, covered by the popup".
 *
 * Two guards, because the defect has two halves. The geometry is a pure function
 * and is exercised as one; that the anchor handed to it is the ROW (the element
 * containing the ×) can only be seen in the source — jsdom has no layout, the
 * same reason fileBrowserMenuClipping.test.ts is written the way it is.
 */

const CLIENT = __dirname;
const read = (name: string) => readFileSync(join(CLIENT, name), 'utf8');

/** A row of the sidebar dropdown: 320px wide, 56px tall, on screen. */
const row = { top: 400, left: 260, right: 580 };
const viewport = { width: 1440, height: 900 };

describe('recent hover preview — where it lands', () => {
  it('starts past the ROW\'s right edge, so the × at that edge stays visible', () => {
    const { left } = recentTooltipPosition(row, viewport);
    expect(left).toBe(row.right + RECENT_TOOLTIP_GAP);
    // The × occupies the last ~24px of the row. Nothing of the panel may reach
    // back into the row at all — this is the assertion that fails on the old
    // behaviour, where the anchor was the inner button (right ≈ 556) and the
    // panel started at 564, i.e. 16px INSIDE the row.
    expect(left).toBeGreaterThan(row.right);
  });

  it('keeps the row\'s vertical position when there is room', () => {
    expect(recentTooltipPosition(row, viewport).top).toBe(row.top);
  });

  it('rides up rather than off the bottom of the screen', () => {
    const low = { ...row, top: 860 };
    const { top } = recentTooltipPosition(low, viewport);
    expect(top).toBe(viewport.height - RECENT_TOOLTIP_MAX_HEIGHT - RECENT_TOOLTIP_MARGIN);
    expect(top + RECENT_TOOLTIP_MAX_HEIGHT).toBeLessThanOrEqual(viewport.height);
  });

  it('flips to the LEFT of the row when the right side has no room', () => {
    const wide = { top: 400, left: 600, right: 920 };
    const narrow = { width: 1000, height: 900 };
    const { left } = recentTooltipPosition(wide, narrow);
    // Entirely left of the row, which also clears the × at its right end.
    expect(left).toBe(wide.left - RECENT_TOOLTIP_WIDTH - RECENT_TOOLTIP_GAP);
    expect(left + RECENT_TOOLTIP_WIDTH).toBeLessThanOrEqual(wide.left);
  });

  it('when neither side fits it pins LEFT — never back over the × on the right', () => {
    const tiny = { width: 420, height: 900 };
    const { left } = recentTooltipPosition({ top: 10, left: 40, right: 380 }, tiny);
    expect(left).toBe(RECENT_TOOLTIP_MARGIN);
    expect(left + RECENT_TOOLTIP_WIDTH).toBeLessThanOrEqual(380);
  });

  it('in no placement does the panel land on the row\'s right end', () => {
    // The one property the whole file exists for, stated once over every branch.
    // ~24px of the row's right end is the delete button.
    const X_WIDTH = 24;
    const cases = [
      { rect: row, vp: viewport },
      { rect: { top: 400, left: 600, right: 920 }, vp: { width: 1000, height: 900 } },
      { rect: { top: 10, left: 40, right: 380 }, vp: { width: 420, height: 900 } },
      { rect: { top: 860, left: 260, right: 580 }, vp: viewport },
    ];
    for (const { rect, vp } of cases) {
      const { left } = recentTooltipPosition(rect, vp);
      const coversX = left < rect.right && left + RECENT_TOOLTIP_WIDTH > rect.right - X_WIDTH;
      expect(coversX, `panel at ${left} covers the × of a row ending at ${rect.right}`).toBe(false);
    }
  });
});

describe('recent hover preview — what it is anchored to', () => {
  it('the hover handlers sit on the ROW, which is the element that holds the ×', () => {
    const src = read('GlobalSessionMonitor.tsx');
    const rowEl = /<div\s+key=\{`\$\{session\.cwd\}-\$\{session\.sessionId\}`\}[\s\S]*?\n                >/.exec(src)?.[0];
    expect(rowEl, 'the popover row was reshaped — re-point this guard').toBeDefined();
    expect(rowEl).toContain('onMouseEnter={(e) => showTooltip(session, e)}');
    expect(rowEl).toContain('onMouseLeave={hideTooltip}');

    // ...and NOT on the open target inside it, whose right edge is left of the
    // ×. That is the exact regression: measuring from there re-covers the button.
    const openTarget = /<button\s+onClick=\{\(\) => handleSessionClick\(session\)\}[\s\S]*?>/.exec(src)?.[0];
    expect(openTarget, 'the open target was reshaped — re-point this guard').toBeDefined();
    expect(openTarget).not.toContain('showTooltip');
    expect(openTarget).not.toContain('onMouseLeave');
  });

  it('the panel is measured through the shared geometry, not by hand', () => {
    const src = read('GlobalSessionMonitor.tsx');
    expect(src).toContain("import { recentTooltipPosition } from './recentTooltipAnchor'");
    expect(src).toContain('const { top, left } = recentTooltipPosition(rect, {');
    // No second, drifting copy of the placement arithmetic.
    expect(src).not.toMatch(/rect\.right \+ \d/);
  });

  it('the panel never takes the pointer, so the × under it stays clickable', () => {
    // Belt and braces: the geometry keeps them apart, and even if a future
    // layout brings them close again the panel cannot swallow a click.
    const src = read('GlobalSessionMonitor.tsx');
    const panel = /\{tooltip && \([\s\S]*?style=\{\{ top: tooltip\.top, left: tooltip\.left \}\}/.exec(src)?.[0];
    expect(panel, 'the preview panel was reshaped — re-point this guard').toBeDefined();
    expect(panel).toContain('pointer-events-none');
    expect(panel).toContain('fixed');
  });
});
