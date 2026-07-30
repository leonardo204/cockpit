import { describe, it, expect } from 'vitest';
import {
  AUTONOMY_STEP_CAP,
  DONE_MARKER,
  resolveMaxSteps,
  isAutonomous,
  sawDoneMarker,
  autonomyInstruction,
  continuationPrompt,
  decideAutonomyStep,
  stepMarker,
  sawVerifiedMarker,
  verificationNudgePrompt,
  VERIFIED_MARKER_PREFIX,
} from './autonomy';

describe('autonomy — step budget (P3-M3c)', () => {
  it('treats no/absurd config as a single turn (autonomy off)', () => {
    expect(resolveMaxSteps(undefined)).toBe(1);
    expect(resolveMaxSteps(0)).toBe(1);
    expect(resolveMaxSteps(-5)).toBe(1);
    expect(resolveMaxSteps(1)).toBe(1);
    expect(resolveMaxSteps(Number.NaN)).toBe(1);
    expect(resolveMaxSteps(Number.POSITIVE_INFINITY)).toBe(1);
    expect(isAutonomous(1)).toBe(false);
  });

  it('clamps to the hard cap whatever the store says', () => {
    expect(resolveMaxSteps(5)).toBe(5);
    expect(resolveMaxSteps(5.9)).toBe(5);
    expect(resolveMaxSteps(AUTONOMY_STEP_CAP + 100)).toBe(AUTONOMY_STEP_CAP);
    expect(isAutonomous(resolveMaxSteps(2))).toBe(true);
  });
});

describe('autonomy — completion marker', () => {
  it('believes the agent when it declares done, in any case', () => {
    expect(sawDoneMarker(`all set\n${DONE_MARKER}`)).toBe(true);
    expect(sawDoneMarker('finished [[done]]')).toBe(true);
    expect(sawDoneMarker('still working on it')).toBe(false);
    expect(sawDoneMarker('')).toBe(false);
  });
});

describe('autonomy — prompts', () => {
  it('the injected instruction states the budget, the marker and the no-tool rule', () => {
    const text = autonomyInstruction(4);
    expect(text).toContain('up to 4 steps');
    expect(text).toContain(DONE_MARKER);
    expect(text).toMatch(/NO tool ends the run/i);
    expect(text).toMatch(/approval|approved/i);
  });

  it('the continuation prompt says where in the budget the agent is', () => {
    const p = continuationPrompt(3, 5);
    expect(p).toContain('step 3 of 5');
    expect(p).toContain(DONE_MARKER);
    expect(p).toContain('[naby autonomy]');
  });
});

describe('autonomy — the step decision', () => {
  const base = { step: 1, maxSteps: 5, usedTools: true, text: 'working', ok: true, aborted: false };

  it('continues a working step inside the budget', () => {
    expect(decideAutonomyStep(base)).toEqual({ proceed: true, reason: 'continue' });
  });

  it('never continues when autonomy is off', () => {
    expect(decideAutonomyStep({ ...base, maxSteps: 1 })).toEqual({
      proceed: false,
      reason: 'not-autonomous',
    });
  });

  it('stops on the last step of the budget', () => {
    expect(decideAutonomyStep({ ...base, step: 5 })).toEqual({ proceed: false, reason: 'max-steps' });
  });

  it("stops when the agent says it is done, even mid-budget", () => {
    expect(decideAutonomyStep({ ...base, text: `done here ${DONE_MARKER}` })).toEqual({
      proceed: false,
      reason: 'done-marker',
    });
  });

  it('stops a step that only talked — the anti-chatter rule', () => {
    expect(decideAutonomyStep({ ...base, usedTools: false })).toEqual({
      proceed: false,
      reason: 'no-tool-use',
    });
  });

  it('an abort or an error outranks everything else', () => {
    expect(decideAutonomyStep({ ...base, aborted: true }).reason).toBe('aborted');
    expect(decideAutonomyStep({ ...base, ok: false }).reason).toBe('error');
    // Even a done-marker + no tools cannot mask why it really ended.
    expect(
      decideAutonomyStep({ ...base, aborted: true, usedTools: false, text: DONE_MARKER }).reason,
    ).toBe('aborted');
  });

  it('labels the step bar with what happened', () => {
    expect(stepMarker(2, 5, { proceed: true, reason: 'continue' })).toBe('step 2/5 — continuing');
    expect(stepMarker(5, 5, { proceed: false, reason: 'max-steps' })).toBe(
      'step 5/5 — stopped (max-steps)',
    );
  });
});

/**
 * THE VERIFICATION STEP (P3-M9, G4).
 *
 * The loop's stop conditions were all about the agent's INTENT (it said done) or
 * its behaviour (it used no tool); none of them asked whether the claim had been
 * checked. This wedges one question in front of the stop — once per run, never
 * past the budget — and it is opt-in BY SHAPE, so every pre-M9 call above is
 * unaffected. That last property is the one worth guarding: a default-on rule
 * here would have silently changed every existing caller.
 */
describe('autonomy — verification before done (P3-M9)', () => {
  const base = { step: 2, maxSteps: 5, usedTools: true, text: 'working', ok: true, aborted: false };

  it('reads the verification marker in any case, and only as a prefix', () => {
    expect(sawVerifiedMarker(`${VERIFIED_MARKER_PREFIX} ran the suite]]`)).toBe(true);
    expect(sawVerifiedMarker('done [[verified: checked the output]]')).toBe(true);
    expect(sawVerifiedMarker('I verified it, honestly')).toBe(false);
    expect(sawVerifiedMarker('')).toBe(false);
  });

  it('is a NO-OP when the caller does not opt in — every pre-M9 decision stands', () => {
    expect(decideAutonomyStep({ ...base, text: DONE_MARKER })).toEqual({
      proceed: false,
      reason: 'done-marker',
    });
    expect(decideAutonomyStep({ ...base, usedTools: false })).toEqual({
      proceed: false,
      reason: 'no-tool-use',
    });
  });

  it('converts an UNVERIFIED stop into one more step — both ways of stopping', () => {
    expect(
      decideAutonomyStep({ ...base, text: DONE_MARKER, verification: { nudgeSent: false } }),
    ).toEqual({ proceed: true, reason: 'verify-nudge' });
    expect(
      decideAutonomyStep({ ...base, usedTools: false, verification: { nudgeSent: false } }),
    ).toEqual({ proceed: true, reason: 'verify-nudge' });
  });

  it('does not nudge an agent that said what it checked', () => {
    expect(
      decideAutonomyStep({
        ...base,
        text: `${VERIFIED_MARKER_PREFIX} suite is green]]\n${DONE_MARKER}`,
        verification: { nudgeSent: false },
      }),
    ).toEqual({ proceed: false, reason: 'done-marker' });
  });

  it('nudges at most ONCE per run — the second stop always stops', () => {
    expect(
      decideAutonomyStep({ ...base, text: DONE_MARKER, verification: { nudgeSent: true } }),
    ).toEqual({ proceed: false, reason: 'done-marker' });
  });

  it('never spends a step the budget does not have', () => {
    // The nudge continuation IS a step, so the cap outranks the protocol.
    expect(
      decideAutonomyStep({
        ...base,
        step: 5,
        maxSteps: 5,
        text: DONE_MARKER,
        verification: { nudgeSent: false },
      }),
    ).toEqual({ proceed: false, reason: 'done-marker' });
  });

  it('leaves the single-turn invariant untouched', () => {
    // maxSteps 1 short-circuits before anything else is consulted, so a turn
    // that was never autonomous cannot be nudged into a second one.
    expect(
      decideAutonomyStep({
        ...base,
        step: 1,
        maxSteps: 1,
        text: DONE_MARKER,
        verification: { nudgeSent: false },
      }),
    ).toEqual({ proceed: false, reason: 'not-autonomous' });
  });

  it('an abort or an error still outranks the verification gate', () => {
    expect(
      decideAutonomyStep({
        ...base,
        text: DONE_MARKER,
        aborted: true,
        verification: { nudgeSent: false },
      }).reason,
    ).toBe('aborted');
    expect(
      decideAutonomyStep({ ...base, text: DONE_MARKER, ok: false, verification: { nudgeSent: false } })
        .reason,
    ).toBe('error');
  });

  it('says "verifying" on the step bar, not "continuing"', () => {
    expect(stepMarker(2, 5, { proceed: true, reason: 'verify-nudge' })).toBe(
      'step 2/5 — verifying before it stops',
    );
  });

  it('the nudge prompt asks for a CHECK and names both exits', () => {
    const text = verificationNudgePrompt(3, 5);
    expect(text).toContain('step 3 of 5');
    expect(text).toMatch(/not said what you checked/i);
    expect(text).toContain(VERIFIED_MARKER_PREFIX);
    expect(text).toContain(DONE_MARKER);
  });

  it('the injected protocol tells the agent the marker is required before done', () => {
    const text = autonomyInstruction(4);
    expect(text).toContain(VERIFIED_MARKER_PREFIX);
    expect(text).toMatch(/CHECK THE RESULT/i);
  });
});
