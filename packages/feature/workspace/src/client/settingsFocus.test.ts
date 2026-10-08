import { afterEach, describe, expect, it } from 'vitest';
import {
  __pendingSettingsFocusForTest as pending,
  claimSettingsFocus,
  clearSettingsFocus,
  requestSettingsFocus,
} from './settingsFocus';

/**
 * "Open Settings at the Skill Hub key" without a timer (chat-connection-status
 * §4): a request waits until the anchored entry mounts and claims it. No DOM
 * here (node), so the request always waits and the entry is a stand-in.
 */

function fakeEntry() {
  const calls: string[] = [];
  const el = {
    scrollIntoView: () => calls.push('scroll'),
    querySelector: () => ({ focus: () => calls.push('focus') }),
  } as unknown as HTMLElement;
  return { el, calls };
}

afterEach(() => clearSettingsFocus());

describe('settings focus handoff', () => {
  it('the waiting entry takes the focus once, on mount', () => {
    requestSettingsFocus('system-mcp:skill-hub');
    expect(pending()).toBe('system-mcp:skill-hub');
    const e = fakeEntry();
    expect(claimSettingsFocus('system-mcp:skill-hub', e.el)).toBe(true);
    expect(e.calls).toEqual(['scroll', 'focus']);
    expect(pending()).toBeUndefined();
    expect(claimSettingsFocus('system-mcp:skill-hub', fakeEntry().el)).toBe(false);
  });

  it('another entry does not take it; closing Settings drops it', () => {
    requestSettingsFocus('system-mcp:skill-hub');
    expect(claimSettingsFocus('system-mcp:cic', fakeEntry().el)).toBe(false);
    expect(pending()).toBe('system-mcp:skill-hub');
    clearSettingsFocus();
    expect(claimSettingsFocus('system-mcp:skill-hub', fakeEntry().el)).toBe(false);
  });

  it('an unmounted ref claims nothing', () => {
    requestSettingsFocus('system-mcp:skill-hub');
    expect(claimSettingsFocus('system-mcp:skill-hub', null)).toBe(false);
    expect(pending()).toBe('system-mcp:skill-hub');
  });
});
