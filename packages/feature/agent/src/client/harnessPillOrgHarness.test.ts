import { describe, it, expect, beforeEach } from 'vitest';
import i18n from '@cockpit/shared-i18n';
import { renderHarnessPill } from './harnessPill';

/**
 * THE ORG HARNESS SESSION-START PILLS (org-harness-sync §4.5, §3.6, M2).
 *
 * The engine emits CODES (`copy-notice:<skill>:<copy>`, `unauthorized`) because
 * the server has no locale; this file turns them into the user's language. Both
 * languages must really exist, and "unmodified"/"edited" must say which.
 */
describe('org harness pills', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('a same-name copy notice names the skill and says whether it was edited', () => {
    const edited = renderHarnessPill('org-harness', 'copy-notice:pdoc:edited');
    expect(edited.label).toBe('org harness');
    expect(edited.detail).toContain('pdoc');
    expect(edited.detail).toContain('edited copy');
    expect(edited.detail).toMatch(/Settings → Harness/);
    const plain = renderHarnessPill('org-harness', 'copy-notice:task:unmodified');
    expect(plain.detail).toContain('unmodified copy');
  });

  it('a rejected key says to enter it again', () => {
    const { detail } = renderHarnessPill('org-harness', 'unauthorized');
    expect(detail).toMatch(/Skill Hub/);
    expect(detail).toMatch(/Connections/);
  });

  it('has real Korean copy, with the spec’s words for the two kinds of copy', async () => {
    await i18n.changeLanguage('ko');
    expect(renderHarnessPill('org-harness', 'copy-notice:task:unmodified').detail).toContain('고치지 않은 사본');
    expect(renderHarnessPill('org-harness', 'copy-notice:pdoc:edited').detail).toContain('직접 고친 사본');
    expect(renderHarnessPill('org-harness', 'unauthorized').label).toBe('조직 하네스');
  });

  it('an org-harness pill with an unknown detail passes through untouched', () => {
    expect(renderHarnessPill('org-harness', 'something-else')).toEqual({ label: 'org-harness', detail: 'something-else' });
  });
});
