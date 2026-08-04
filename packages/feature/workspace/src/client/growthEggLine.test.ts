import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE EGG LINE HAS TO SHOW THE PRACTICE (fast-evolution §3.4).
 *
 * The bug this pins: after a fast-growth session with three answered drills the
 * egg line read exactly as it had before the session — "answer N more check-ins".
 * The ledger was right (drills never satisfy the minimum sample, and that rule is
 * load-bearing against Goodharting), but the SCREEN was silent about work the
 * user had just done, which reads as the effort having gone nowhere.
 *
 * So the fix is copy, not scoring: when the reading carries drills, the line says
 * both facts at once — the real check-ins still owed AND the practice already
 * answered, with its hits. Two surfaces render it (the settings row and the
 * report overlay) and they must not drift.
 *
 * Scanned from source, like the rest of this folder's tests: there is no DOM
 * here, and the branch is a static piece of JSX.
 */

const CLIENT = __dirname;
const SOURCES = ['GrowthPanel.tsx', 'GrowthReportModal.tsx'] as const;

function read(name: string): string {
  return readFileSync(join(CLIENT, name), 'utf8');
}

/** The egg branch of a source: from `stage === 'egg'` up to the gauge that the
 *  other branch renders — the percentage is the first thing in it. */
function eggBranch(src: string): string {
  const start = src.indexOf("g.stage === 'egg'");
  expect(start, 'the egg branch must exist').toBeGreaterThan(-1);
  const end = src.indexOf('{g.percent}%', start);
  expect(end, 'the gauge half must follow the egg half').toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('the egg line reports the drills that were answered', () => {
  for (const name of SOURCES) {
    it(`${name}: with drills it uses the drill-aware sentence, and its numbers come from the reading`, () => {
      const branch = eggBranch(read(name));
      // Gated on the reading's own count — no new query, no second fetch.
      expect(branch).toContain('g.drillTrials !== undefined && g.drillTrials > 0');
      expect(branch).toContain("t('growth.eggHintWithDrills'");
      expect(branch).toContain('drills: g.drillTrials');
      expect(branch).toContain('drillHits: g.drillHits ?? 0');
      // Both halves of the sentence: what is still owed is still said.
      expect(branch).toContain('needed: Math.max(1, g.needsMoreSamples)');
    });

    it(`${name}: without drills the original sentence is unchanged`, () => {
      const branch = eggBranch(read(name));
      expect(branch).toContain("t('growth.eggHint'");
    });

    it(`${name}: practice does not earn a gauge of its own`, () => {
      // The egg shows NO bar (a bound from three answers would paint a confident
      // one next to "not measured yet"), and a practice bar would be worse: it
      // would move while the stage did not. The words carry the drills; the
      // numbers stay where they were.
      const branch = eggBranch(read(name));
      expect(branch).not.toContain('style={{ width');
      expect(branch).not.toContain('percent');
    });
  }

  it('both surfaces say it the same way', () => {
    const [panel, report] = SOURCES.map((n) => eggBranch(read(n)));
    for (const key of ["t('growth.eggHint'", "t('growth.eggHintWithDrills'"]) {
      expect(panel).toContain(key);
      expect(report).toContain(key);
    }
  });
});
