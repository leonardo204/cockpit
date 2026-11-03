'use client';

/**
 * "Look into other projects" — the app-wide switch for cross-project context
 * (specs/cross-project-context.md R6, setting `sessions.crossProject.enabled`,
 * default ON). Off = naby is not given `naby_list_projects` /
 * `naby_read_project` on the next turn, and the cross-session tools go back to
 * this project's tabs only.
 *
 * The same optimistic-then-confirm shape as the cross-session toggle above it.
 *
 * Under it (R18a): the permanent "always allow" pairs, one row each —
 * "‹proposal› → ‹server›" with the cwds on hover and a delete button. Deleting
 * one makes the next access ask again. A pair with a project no longer in the
 * sidebar is dimmed and still deletable.
 */

import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';

/** One permanent pair as `crossProject.get` returns it. */
export type CrossProjectApprovalRow = {
  from: string;
  to: string;
  fromName: string;
  toName: string;
  fromListed: boolean;
  toListed: boolean;
};

type NabyReply = {
  ok: boolean;
  error?: string;
  crossProjectEnabled?: boolean;
  crossProjectApprovals?: CrossProjectApprovalRow[];
};

async function nabyPost(body: Record<string, unknown>): Promise<NabyReply> {
  try {
    const res = await fetch('/api/naby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as Omit<NabyReply, 'ok'> & { ok?: boolean } | null;
    if (!json) return { ok: false, error: `request failed (${res.status})` };
    return { ...json, ok: !!json.ok && res.ok };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export const CrossProjectToggle = memo(function CrossProjectToggle({ isOpen }: { isOpen: boolean }) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [approvals, setApprovals] = useState<CrossProjectApprovalRow[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    void nabyPost({ action: 'crossProject.get' }).then((res) => {
      if (!alive || !res.ok) return;
      if (typeof res.crossProjectEnabled === 'boolean') setEnabled(res.crossProjectEnabled);
      if (Array.isArray(res.crossProjectApprovals)) setApprovals(res.crossProjectApprovals);
    });
    return () => {
      alive = false;
    };
  }, [isOpen]);

  const onToggle = useCallback(async () => {
    const next = !enabled;
    setEnabled(next);
    setBusy(true);
    const res = await nabyPost({ action: 'crossProject.set', enabled: next });
    setBusy(false);
    if (!res.ok) {
      setEnabled(!next);
      toast(t('agentManager.crossProject.failed', { defaultValue: 'Could not save: {{error}}', error: res.error ?? '' }), 'error');
      return;
    }
    if (typeof res.crossProjectEnabled === 'boolean') setEnabled(res.crossProjectEnabled);
  }, [enabled, t]);

  const onRemove = useCallback(
    async (row: CrossProjectApprovalRow) => {
      const key = `${row.from}\u0000${row.to}`;
      setRemoving(key);
      const res = await nabyPost({ action: 'crossProject.removeApproval', from: row.from, to: row.to });
      setRemoving(null);
      if (!res.ok) {
        toast(t('agentManager.crossProject.failed', { defaultValue: 'Could not save: {{error}}', error: res.error ?? '' }), 'error');
        return;
      }
      setApprovals(
        Array.isArray(res.crossProjectApprovals)
          ? res.crossProjectApprovals
          : (list) => list.filter((r) => !(r.from === row.from && r.to === row.to)),
      );
    },
    [t],
  );

  const label = t('agentManager.crossProject.toggle', { defaultValue: 'Look into other projects' });
  return (
    <div className="flex flex-col gap-2">
      <label className="flex cursor-pointer items-start gap-2" data-testid="cross-project-toggle">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={enabled}
          disabled={busy}
          onChange={() => void onToggle()}
          aria-label={label}
        />
        <span className="min-w-0">
          <span className="block text-xs font-semibold text-foreground">{label}</span>
          <span className="block text-[0.714rem] text-muted-foreground">
            {t('agentManager.crossProject.hint', {
              defaultValue:
                'naby knows which projects share this one’s sidebar group. Before it reads another project or asks its tabs — in the group or not — it asks you first. It only reads — it never changes another project.',
            })}
          </span>
        </span>
      </label>
      <CrossProjectApprovalList approvals={approvals} removing={removing} onRemove={(row) => void onRemove(row)} />
    </div>
  );
});

/** R18a: the permanent pairs. Presentational, so it renders without a fetch. */
export const CrossProjectApprovalList = memo(function CrossProjectApprovalList({
  approvals,
  removing,
  onRemove,
}: {
  approvals: CrossProjectApprovalRow[];
  /** The key (from, NUL, to) of the row being removed, if any. */
  removing: string | null;
  onRemove: (row: CrossProjectApprovalRow) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="ml-5" data-testid="cross-project-approvals">
      <div className="text-[0.714rem] font-semibold text-muted-foreground">
        {t('agentManager.crossProject.approvalsTitle', { defaultValue: 'Always allowed' })}
      </div>
      {approvals.length === 0 ? (
        <div className="text-[0.714rem] text-muted-foreground" data-testid="cross-project-approvals-empty">
          {t('agentManager.crossProject.approvalsEmpty', { defaultValue: 'No project is always allowed yet.' })}
        </div>
      ) : (
        <ul className="mt-1 flex flex-col gap-1">
          {approvals.map((row) => {
            const key = `${row.from}\u0000${row.to}`;
            const missing = !row.fromListed || !row.toListed;
            const missingNote = missing
              ? ` — ${t('agentManager.crossProject.approvalMissing', { defaultValue: 'Not in the sidebar any more' })}`
              : '';
            return (
              <li
                key={key}
                className={`flex items-center gap-2 text-xs ${missing ? 'opacity-50' : ''}`}
                data-testid="cross-project-approval-row"
                data-missing={missing ? 'true' : 'false'}
              >
                <span className="min-w-0 flex-1 truncate">
                  <span title={`${row.from}${!row.fromListed ? missingNote : ''}`}>‹{row.fromName}›</span>
                  {' → '}
                  <span title={`${row.to}${!row.toListed ? missingNote : ''}`}>‹{row.toName}›</span>
                </span>
                <button
                  type="button"
                  className="rounded px-1.5 py-0.5 text-[0.714rem] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                  disabled={removing === key}
                  onClick={() => onRemove(row)}
                  aria-label={t('agentManager.crossProject.approvalRemoveLabel', {
                    defaultValue: 'Remove always-allow ‹{{from}}› → ‹{{to}}›',
                    from: row.fromName,
                    to: row.toName,
                  })}
                  data-testid="cross-project-approval-remove"
                >
                  {t('agentManager.crossProject.approvalRemove', { defaultValue: 'Remove' })}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});
