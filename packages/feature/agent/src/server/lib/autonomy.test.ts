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
