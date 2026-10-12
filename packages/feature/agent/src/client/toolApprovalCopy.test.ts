import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  approvalAskerFrom,
  approvalOffersRemember,
  approvalReasonLines,
  approvalRememberNote,
  type ApprovalCopyLine,
} from './toolApprovalCopy';

/**
 * The approval prompt's copy when an org harness hook and/or a policy rule ask
 * (org-harness-sync §3.5, §7.10): who is asking, why, and whether "always" is
 * offered. The engine side (how many prompts) is nabyOrgHarnessM3.test.ts.
 */

const keys = (lines: ApprovalCopyLine[]) => lines.map((l) => ('key' in l ? l.key : `text:${l.text}`));

describe('approval prompt copy (§7.10)', () => {
  it('reads the asker fields off the event', () => {
    expect(
      approvalAskerFrom({
        source: 'hook+policy',
        reason: 'commit check',
        hook_script: 'task/pre-commit.py',
        rewritten_by: '',
      }),
    ).toEqual({ source: 'hook+policy', reason: 'commit check', hookScript: 'task/pre-commit.py' });
    expect(approvalAskerFrom({ source: 'something-else' })).toEqual({});
  });

  it('merged prompt: the hook line, then the policy line; "always" offered with a policy-only note', () => {
    const a = { source: 'hook+policy' as const, reason: 'commit check', hookScript: 'task/pre-commit.py' };
    expect(keys(approvalReasonLines(a))).toEqual(['toolApproval.hookReasonScript', 'toolApproval.policyReason']);
    expect(approvalReasonLines(a)[0]).toMatchObject({ params: { script: 'task/pre-commit.py', reason: 'commit check' } });
    expect(approvalOffersRemember(a)).toBe(true);
    expect(approvalRememberNote(a)).toMatchObject({ key: 'toolApproval.rememberPolicyOnly' });
  });

  it('hook-only prompt: no "always", no note; a hook with no reason still names itself', () => {
    const a = { source: 'hook' as const, hookScript: 'task/pre-commit.py' };
    expect(keys(approvalReasonLines(a))).toEqual(['toolApproval.hookAsksScript']);
    expect(approvalOffersRemember(a)).toBe(false);
    expect(approvalRememberNote(a)).toBeUndefined();
  });

  it('policy-only prompt: unchanged — no reason lines, "always" offered, no note', () => {
    expect(approvalReasonLines({})).toEqual([]);
    expect(approvalOffersRemember({})).toBe(true);
    expect(approvalRememberNote({})).toBeUndefined();
  });

  it('a policy prompt about a rewritten input says which hook rewrote it', () => {
    expect(keys(approvalReasonLines({ rewrittenBy: 'task/pre-commit.py' }))).toEqual(['toolApproval.rewrittenBy']);
  });

  it('every key has en and ko copy', () => {
    const all = [
      ...approvalReasonLines({ source: 'hook+policy', reason: 'r', hookScript: 's', rewrittenBy: 's' }),
      ...approvalReasonLines({ source: 'hook', hookScript: 's' }),
      ...approvalReasonLines({ source: 'hook', reason: 'r' }),
      approvalRememberNote({ source: 'hook+policy' })!,
    ];
    for (const locale of ['en', 'ko']) {
      const dict = JSON.parse(
        readFileSync(join(__dirname, '../../../../shared/i18n/locales', `${locale}.json`), 'utf8'),
      ) as Record<string, Record<string, unknown>>;
      for (const line of all) {
        if (!('key' in line)) continue;
        const [ns, k] = line.key.split('.') as [string, string];
        expect(typeof dict[ns]?.[k], `${locale}: ${line.key}`).toBe('string');
      }
    }
  });

  it('the prompt component uses these rules, not its own', () => {
    const src = readFileSync(join(__dirname, 'ToolApprovalPrompt.tsx'), 'utf8');
    expect(src).toContain('approvalReasonLines(current)');
    expect(src).toContain('approvalOffersRemember(current)');
    expect(src).not.toContain("current.source === 'hook'");
  });
});
