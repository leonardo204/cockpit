import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE HOOK ACTUALLY GOES THROUGH `projectOpenPlan`.
 *
 * Source assertions, the discipline this directory already uses (`titleLock`,
 * `untitledTabTitle`, `recentSessionDeleteWiring`): the decision runs inside an
 * iframe, against a fetch, in a component jsdom cannot lay out. What is at risk
 * is the WIRING — the plan computed and then not applied, or the old
 * discard-everything branch growing back — and that is readable in the file.
 *
 * The decision itself is not tested here; it is pure, and projectOpenPlan.test.ts
 * owns it.
 */

const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');
const HOOK = read('useTabState.ts');

describe('a project with sessions opens on one', () => {
  it('asks the plan rather than deciding inline', () => {
    expect(HOOK).toContain("import { projectOpenPlan } from './projectOpenPlan'");
    expect(HOOK).toContain('const plan = projectOpenPlan(');
  });

  it('passes what the plan needs — the link, the state, and what is already open', () => {
    // The third argument is the pinned-restore race fix; dropping it would make
    // the plan blind to a tab TabManager had already opened.
    expect(HOOK).toContain('        initialSessionId,\n        data,\n');
    expect(HOOK).toContain('tabsRef.current.map((t) => t.sessionId)');
  });

  it('adopts the resumed session into the seed tab, not a second one', () => {
    // Opening beside the blank tab would leave the blank one active — precisely
    // the failure this feature exists to remove.
    expect(HOOK).toContain("plan.kind === 'resume'");
    expect(HOOK).toContain('sessionId: resumeId,');
    expect(HOOK).not.toMatch(/plan\.kind === 'resume'[\s\S]{0,400}?addTab\(/);
  });

  it('names the adopted tab after the session, not after the blank it was', () => {
    expect(HOOK).toContain('title: untitledTabTitle(t.id, resumeId, Date.now()),');
  });

  it('carries the session’s saved plan-mode across', () => {
    expect(HOOK).toContain('planMode: savedPlanModes[resumeId] ?? t.planMode,');
  });
});

describe('the discarded rule does not grow back', () => {
  it('no longer claims a project open starts a new session', () => {
    // The old comment asserted the opposite behaviour. It is rewritten, not
    // deleted — but the CLAIM must be gone, or the file argues with itself.
    expect(HOOK).not.toContain('PRODUCT RULE: opening a project starts a NEW session');
    expect(read('TabManager.tsx')).not.toContain('This is the ONE exception to the rule');
  });

  it('still refuses to rebuild the multi-tab layout', () => {
    // The complaint the old rule protected against was the LAYOUT being
    // reconstructed and reconnected. One tab resuming one session is not that,
    // and the distinction is the whole design — so the file has to keep saying
    // which half it still refuses.
    expect(HOOK).toContain('The layout is STILL not rebuilt');
    // The persisted union is still never re-added wholesale.
    expect(HOOK).not.toMatch(/data\.sessions\.map\([\s\S]{0,200}?addTab/);
  });
});

describe('a project with nothing in it is untouched', () => {
  it('leaves the blank seed tab alone and unblocks init immediately', () => {
    // `fresh` writes no tabs, so there is nothing to wait for — the deferred
    // unblock exists only to let a setTabs land before the save effect runs.
    expect(HOOK).toContain("if (plan.kind === 'resume' || plan.kind === 'explicit') {");
    expect(HOOK).toContain('isInitializingRef.current = false;');
  });
});

describe('an explicit open is still explicit', () => {
  it('carries only the plan-mode, because the id is already seeded', () => {
    expect(HOOK).toContain("plan.kind === 'explicit'");
    expect(HOOK).toContain('planMode: savedPlanModes[explicitId] ?? t.planMode');
  });
});

describe('the pinned race resolves to one tab', () => {
  it('focuses the tab that already holds the session', () => {
    expect(HOOK).toContain("plan.kind === 'focus'");
    expect(HOOK).toContain('setActiveTabId(openTab.id)');
  });

  it('is documented where the other half of the race lives', () => {
    // A reader who finds the pinned restore first must be told the race is
    // handled, and where.
    expect(read('TabManager.tsx')).toContain('projectOpenPlan');
  });

  it('closes the OTHER ordering too — the pinned loop reads live tabs', () => {
    // The half the plan alone cannot see. When adoption lands first, its
    // `setTabs` may not have reached the render this effect closed over; reading
    // the stale snapshot would find the session absent and open a second tab
    // holding it. `handleOpenSession` cannot dedupe on its own — forking
    // deliberately stacks a second tab on an open session — so the guard is here.
    const mgr = read('TabManager.tsx');
    const effect =
      /const restoredRef = useRef\(false\);[\s\S]*?handleOpenSession\(p\.sessionId, p\.customTitle\);/.exec(
        mgr,
      )?.[0];
    expect(effect, 'the pinned restore effect is gone — did TabManager change?').toBeDefined();
    expect(effect).toContain('tabsRef.current.map((t) => t.sessionId)');
    expect(effect).not.toContain('new Set(tabs.map(');
    // ONE ref, not a second one beside the keyboard listener's: two copies of
    // "what is open right now" is how an effect ends up trusting the wrong one.
    expect(mgr.match(/const \w*[tT]absRef = useRef\(tabs\)/g)?.length).toBe(1);
  });
});
