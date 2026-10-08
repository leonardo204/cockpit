import { describe, it, expect, beforeEach } from 'vitest';
import i18n from '@cockpit/shared-i18n';
import { renderHarnessPill } from './harnessPill';

/**
 * THE ATLASSIAN PILLS (org-harness-sync M3: §3.6 the gate, §4.4 the switch to
 * OAuth, §4.6 the grace period).
 *
 * The engine emits codes; this renders them in the user's language. Each one must
 * tell the user WHERE to go (Settings → Harness → Org harness), because the pill
 * is the only thing they see when a prompt is blocked.
 */
describe('atlassian pills', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('a blocked prompt says it was not sent and where to log in', () => {
    const { label, detail } = renderHarnessPill('org-harness', 'atlassian-required:none');
    expect(label).toBe('org harness');
    expect(detail).toMatch(/not sent/);
    expect(detail).toMatch(/Settings → Harness → Org harness/);
    // The bare code renders the same.
    expect(renderHarnessPill('org-harness', 'atlassian-required').detail).toBe(detail);
  });

  it('the grace notice counts the days', () => {
    expect(renderHarnessPill('org-harness', 'atlassian-grace:5').detail).toMatch(/5 day/);
  });

  it('the migration and re-login notices point at the log-in', () => {
    expect(renderHarnessPill('org-harness', 'atlassian-migrate').detail).toMatch(/browser/);
    expect(renderHarnessPill('org-harness', 'atlassian-relogin').detail).toMatch(/again/);
  });

  it('has real Korean copy for all four', async () => {
    await i18n.changeLanguage('ko');
    expect(renderHarnessPill('org-harness', 'atlassian-required:relogin').detail).toContain('보내지 않았습니다');
    expect(renderHarnessPill('org-harness', 'atlassian-grace:3').detail).toContain('3일');
    expect(renderHarnessPill('org-harness', 'atlassian-migrate').detail).toContain('브라우저');
    expect(renderHarnessPill('org-harness', 'atlassian-relogin').detail).toContain('다시 로그인');
  });
});
