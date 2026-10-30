// A read-only turn names the switch that made it read-only (2026-10-30 VOC):
// the refusal and the system-prompt line must tell naby what the user can do.
import { describe, expect, it } from 'vitest';
import {
  phase1HarnessFloor,
  readOnlyCause,
  readOnlyTurnNotice,
} from '../../../../../../../dist/naby-runtime.mjs';

const call = (toolName: string) => ({ toolName, input: {} }) as Parameters<ReturnType<typeof phase1HarnessFloor>>[0];

describe('readOnlyCause', () => {
  it('plan mode wins over the Allow changes switch', () => {
    expect(readOnlyCause({ planMode: true, allowChanges: false })).toBe('plan-mode');
    expect(readOnlyCause({ planMode: true, allowChanges: true })).toBe('plan-mode');
    expect(readOnlyCause({ planMode: false, allowChanges: false })).toBe('allow-changes-off');
    expect(readOnlyCause({ planMode: false, allowChanges: true })).toBeUndefined();
  });
});

describe('the floor refusal names the switch', () => {
  it('plan mode → uncheck "Plan mode"', async () => {
    const d = await phase1HarnessFloor([], { cause: 'plan-mode' })(call('Write'));
    expect(d.behavior).toBe('deny');
    expect(d.reason).toContain('Plan mode');
    expect(d.reason).toContain('플랜 모드');
    expect(d.reason).not.toMatch(/Phase [12]/);
  });

  it('Allow changes off → turn "Allow changes" on', async () => {
    const d = await phase1HarnessFloor([], { cause: 'allow-changes-off' })(call('Bash'));
    expect(d.behavior).toBe('deny');
    expect(d.reason).toContain('Allow changes');
    expect(d.reason).toContain('변경 허용');
    expect(d.reason).not.toMatch(/Phase [12]/);
  });

  it('no cause still refuses, without the old Phase jargon', async () => {
    const d = await phase1HarnessFloor()(call('Edit'));
    expect(d.behavior).toBe('deny');
    expect(d.reason).not.toMatch(/observation mode|Phase [12]/);
  });

  it('read-only tools still pass', async () => {
    expect((await phase1HarnessFloor([], { cause: 'plan-mode' })(call('Read'))).behavior).toBe('allow');
  });
});

describe('readOnlyTurnNotice', () => {
  it('tells naby which switch to name, and not to work around it', () => {
    const plan = readOnlyTurnNotice('plan-mode');
    expect(plan).toContain('read-only');
    expect(plan).toContain('Plan mode');
    expect(plan).toMatch(/do not look for a way around/);
    expect(readOnlyTurnNotice('allow-changes-off')).toContain('Allow changes');
  });
});

describe("a participant's own plan mode names the participant's editor setting", () => {
  it('participant-plan → its "Permission mode", with its name', async () => {
    const d = await phase1HarnessFloor([], { cause: 'participant-plan', participant: 'scout' })(call('Write'));
    expect(d.behavior).toBe('deny');
    expect(d.reason).toContain('@scout');
    expect(d.reason).toContain('Plan (read-only)');
    expect(d.reason).toContain('계획 (읽기 전용)');
    expect(d.reason).toContain('Settings → Naby → Participants');
    expect(d.reason).toMatch(/naby itself/);
  });
});

describe('deny-by-default (a tool nobody listed)', () => {
  it('says what to do, without the old allowlist jargon', async () => {
    const plain = await phase1HarnessFloor()(call('mcp__x__y'));
    expect(plain.behavior).toBe('deny');
    expect(plain.reason).toBe('mcp__x__y is not available on this turn. Use the tools you were given.');
    const plan = await phase1HarnessFloor([], { cause: 'plan-mode' })(call('mcp__x__y'));
    expect(plan.reason).toContain('not available while this turn is read-only');
    expect(plan.reason).toContain('Plan mode');
    for (const r of [plain.reason, plan.reason]) expect(r).not.toMatch(/allowlist|Phase [12]/);
  });
});
