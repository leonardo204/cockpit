/**
 * What the tool-approval prompt says about WHO is asking and WHY
 * (org-harness-sync §3.5, §7.10). Pure, so the rules are testable without a DOM.
 *
 *   source absent        a policy rule asked. The "always" buttons are offered.
 *   source 'hook'        an org harness hook asked alone. No "always" buttons:
 *                        they write a policy rule for the whole tool, which is
 *                        not what the hook asked about.
 *   source 'hook+policy' both asked about the same call, merged into ONE prompt.
 *                        Both reasons are shown, and the "always" buttons are
 *                        offered with a note that they answer the policy part
 *                        only — the hook decides every call afresh.
 *   rewrittenBy          a policy prompt about input an org hook rewrote.
 */

export type ApprovalAsker = {
  source?: 'hook' | 'hook+policy';
  reason?: string;
  hookScript?: string;
  rewrittenBy?: string;
};

/** One line of copy: an i18n key with its English default, or verbatim text. */
export type ApprovalCopyLine =
  | { key: string; defaultValue: string; params?: Record<string, string> }
  | { text: string };

/** Read the asker fields off a raw `approval_request` event detail. */
export function approvalAskerFrom(d: Record<string, unknown>): ApprovalAsker {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const source = d.source === 'hook' || d.source === 'hook+policy' ? d.source : undefined;
  const reason = str(d.reason);
  const hookScript = str(d.hook_script);
  const rewrittenBy = str(d.rewritten_by);
  return {
    ...(source ? { source } : {}),
    ...(reason ? { reason } : {}),
    ...(hookScript ? { hookScript } : {}),
    ...(rewrittenBy ? { rewrittenBy } : {}),
  };
}

/** The reason lines, in display order. */
export function approvalReasonLines(a: ApprovalAsker): ApprovalCopyLine[] {
  const lines: ApprovalCopyLine[] = [];
  if (a.source) {
    if (a.hookScript && a.reason) {
      lines.push({
        key: 'toolApproval.hookReasonScript',
        defaultValue: 'Org harness ({{script}}): {{reason}}',
        params: { script: a.hookScript, reason: a.reason },
      });
    } else if (a.hookScript) {
      lines.push({
        key: 'toolApproval.hookAsksScript',
        defaultValue: 'Org harness ({{script}}) asks you to confirm this call',
        params: { script: a.hookScript },
      });
    } else if (a.reason) {
      lines.push({ key: 'toolApproval.hookReason', defaultValue: 'Org harness: {{reason}}', params: { reason: a.reason } });
    }
  } else if (a.reason) {
    lines.push({ text: a.reason });
  }
  if (a.source === 'hook+policy') {
    lines.push({ key: 'toolApproval.policyReason', defaultValue: 'Your policy rule: ask before this tool' });
  }
  if (a.rewrittenBy) {
    lines.push({
      key: 'toolApproval.rewrittenBy',
      defaultValue: 'Input rewritten by the org harness ({{script}})',
      params: { script: a.rewrittenBy },
    });
  }
  return lines;
}

/** Whether "always allow/block" is offered: only when the policy is asking. */
export function approvalOffersRemember(a: ApprovalAsker): boolean {
  return a.source !== 'hook';
}

/** The note under the "always" buttons of a merged prompt, or undefined. */
export function approvalRememberNote(a: ApprovalAsker): ApprovalCopyLine | undefined {
  return a.source === 'hook+policy'
    ? {
        key: 'toolApproval.rememberPolicyOnly',
        defaultValue: '"Always" applies to your policy rule only. The org harness decides each call on its own.',
      }
    : undefined;
}
