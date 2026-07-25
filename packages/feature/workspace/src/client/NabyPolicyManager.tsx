'use client';

/**
 * Phase 2 (M1) — the tool-execution PERMISSIONS panel, rendered in SettingsModal.
 *
 * It manages the persistent policy rules the gate consults before running a tool
 * (`store.putPolicyRule` / `listPolicyRules`, resolved by the runtime's
 * `realPolicy`). A rule says "allow" or "block" a tool (by exact name, a trailing
 * `*` prefix like `mcp__jira__*`, or `*` for all) in a scope; with no rules the
 * app keeps its existing "Allow changes" behaviour, so this is purely additive.
 *
 * M1 exposes allow/deny only; the 'ask' effect (human-in-the-loop approval) lands
 * with the M2 approval bridge. Scopes: this project (a cwd) or all projects (user).
 */

import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';
import type { PolicyRule } from '../../../../../../dist/naby-runtime.mjs';

type Scope = 'user' | 'project';

async function policyAction(body: Record<string, unknown>): Promise<
  { ok: true; rules?: PolicyRule[] } | { ok: false; error: string }
> {
  try {
    const res = await fetch('/api/naby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as
      | { ok: boolean; rules?: PolicyRule[]; error?: string }
      | null;
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? `request failed (${res.status})` };
    return { ok: true, rules: json.rules };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const EFFECT_STYLE: Record<string, string> = {
  allow: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  deny: 'bg-red-500/15 text-red-600 dark:text-red-400',
  ask: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
};

const RuleRow = memo(function RuleRow({
  rule,
  busy,
  onRemove,
}: {
  rule: PolicyRule;
  busy: boolean;
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-border p-2.5">
      <div className="flex items-center gap-2 min-w-0">
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${EFFECT_STYLE[rule.effect] ?? ''}`}>
          {t(`policyManager.effect_${rule.effect}`, { defaultValue: rule.effect })}
        </span>
        <span className="text-xs font-mono text-foreground truncate" title={rule.toolPattern}>
          {rule.toolPattern}
        </span>
      </div>
      <button
        onClick={() => onRemove(rule.id)}
        disabled={busy}
        className="text-xs px-2 py-1 rounded border border-border hover:bg-red-500/10 hover:border-red-500/40 text-red-600 dark:text-red-400 disabled:opacity-50 shrink-0"
      >
        {t('policyManager.remove', { defaultValue: 'Remove' })}
      </button>
    </div>
  );
});

export function NabyPolicyManager({ isOpen, cwd }: { isOpen: boolean; cwd?: string }) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<Scope>('user');
  const [rules, setRules] = useState<PolicyRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pattern, setPattern] = useState('');
  const [effect, setEffect] = useState<'allow' | 'deny' | 'ask'>('ask');

  const scopeKey = scope === 'project' ? cwd : undefined;
  const available = scope !== 'project' || !!cwd;

  const reload = useCallback(async () => {
    if (scope === 'project' && !cwd) {
      setRules([]);
      return;
    }
    setLoading(true);
    const res = await policyAction({ action: 'policy.list', scope, scopeKey });
    if (res.ok) setRules(res.rules ?? []);
    else toast(t('policyManager.error', { defaultValue: 'Could not load rules.' }), 'error');
    setLoading(false);
  }, [scope, scopeKey, cwd, t]);

  useEffect(() => {
    if (isOpen) void reload();
  }, [isOpen, reload]);

  const addRule = useCallback(async () => {
    const p = pattern.trim();
    if (!p) return;
    setBusy(true);
    const res = await policyAction({ action: 'policy.put', scope, scopeKey, toolPattern: p, effect });
    setBusy(false);
    if (res.ok) {
      setRules(res.rules ?? []);
      setPattern('');
      toast(t('policyManager.added', { defaultValue: 'Rule saved.' }), 'success');
    } else {
      toast(t('policyManager.error', { defaultValue: 'Could not save the rule.' }), 'error');
    }
  }, [pattern, effect, scope, scopeKey, t]);

  const removeRule = useCallback(
    async (id: string) => {
      setBusy(true);
      const res = await policyAction({ action: 'policy.remove', id });
      setBusy(false);
      if (res.ok) await reload();
      else toast(t('policyManager.error', { defaultValue: 'Could not remove the rule.' }), 'error');
    },
    [reload, t],
  );

  return (
    <div className="space-y-3">
      <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground leading-relaxed">
        {t('policyManager.description', {
          defaultValue:
            'Rules that decide whether the agent may run a tool. Allow or block a tool by name (use a trailing * to match a group, or * for all). With no rules, the "Allow changes" toggle decides.',
        })}
      </p>

      {/* Scope */}
      <div className="flex gap-1.5">
        {(['user', 'project'] as Scope[]).map((s) => (
          <button
            key={s}
            onClick={() => setScope(s)}
            disabled={s === 'project' && !cwd}
            className={`text-xs px-2 py-1 rounded border transition-colors ${
              scope === s ? 'border-brand bg-brand/10 text-brand' : 'border-border text-muted-foreground hover:text-foreground'
            } disabled:opacity-40`}
          >
            {s === 'user'
              ? t('policyManager.scopeUser', { defaultValue: 'All projects' })
              : t('policyManager.scopeProject', { defaultValue: 'This project' })}
          </button>
        ))}
      </div>

      {!available ? (
        <p className="text-xs text-muted-foreground italic">
          {t('policyManager.projectUnavailable', { defaultValue: 'Open a project to set project rules.' })}
        </p>
      ) : (
        <>
          {/* Add */}
          <div className="flex gap-2 items-end">
            <label className="flex-1 flex flex-col gap-0.5">
              <span className="text-[10px] text-muted-foreground">{t('policyManager.toolLabel', { defaultValue: 'Tool' })}</span>
              <input
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addRule();
                }}
                placeholder={t('policyManager.toolPlaceholder', { defaultValue: 'e.g. Bash, Write, mcp__jira__*' })}
                className="text-xs px-2 py-1 rounded border border-border bg-background text-foreground font-mono"
              />
            </label>
            <select
              value={effect}
              onChange={(e) => setEffect(e.target.value as 'allow' | 'deny' | 'ask')}
              className="text-xs px-2 py-1 rounded border border-border bg-background text-foreground"
            >
              <option value="ask">{t('policyManager.effect_ask', { defaultValue: 'Ask each time' })}</option>
              <option value="deny">{t('policyManager.effect_deny', { defaultValue: 'Block' })}</option>
              <option value="allow">{t('policyManager.effect_allow', { defaultValue: 'Allow' })}</option>
            </select>
            <button
              onClick={() => void addRule()}
              disabled={busy || pattern.trim() === ''}
              className="text-xs px-3 py-1.5 rounded border border-brand bg-brand/10 text-brand hover:bg-brand/20 disabled:opacity-50"
            >
              {t('policyManager.add', { defaultValue: 'Add' })}
            </button>
          </div>

          {/* List */}
          {loading ? (
            <p className="text-xs text-muted-foreground">{t('policyManager.loading', { defaultValue: 'Loading…' })}</p>
          ) : rules.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              {t('policyManager.empty', { defaultValue: 'No rules yet — the "Allow changes" toggle decides.' })}
            </p>
          ) : (
            <div className="space-y-2">
              {rules.map((r) => (
                <RuleRow key={r.id} rule={r} busy={busy} onRemove={(id) => void removeRule(id)} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
