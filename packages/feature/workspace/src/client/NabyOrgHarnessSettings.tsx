'use client';

/**
 * The org harness card (org-harness-sync §4.5, §4.8), rendered first under
 * Settings → Harness.
 *
 * What it shows: the package version and the last check, whether the Skill Hub
 * key was accepted, the on/off switch (the §4.8 kill switch — the env variable
 * wins over it), the org skills and whether each is on, and the same-name copy
 * choices ("use the org version" / "keep my copy") with whether the copy was
 * edited. It holds no secret: `/api/naby` answers with the runtime's
 * `OrgHarnessState`, which carries neither the key nor the metrics token.
 *
 * Every decision about what a state MEANS lives in `orgHarnessView.ts`; this
 * component only renders it and posts the existing `orgHarness.*` actions.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';
import {
  orgActivation,
  orgActivationKey,
  orgChoiceRows,
  orgCopyKindKey,
  orgSkillRows,
  orgStatusKey,
  orgSyncOutcomeKey,
  orgToggleDisabled,
  type OrgHarnessView,
} from './orgHarnessView';

type OrgResult = { ok: true; orgHarness?: OrgHarnessView } | { ok: false; error: string };

async function orgAction(body: Record<string, unknown>): Promise<OrgResult> {
  try {
    const res = await fetch('/api/naby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as
      | { ok: boolean; orgHarness?: OrgHarnessView; error?: string }
      | null;
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? `request failed (${res.status})` };
    return { ok: true, ...(json.orgHarness ? { orgHarness: json.orgHarness } : {}) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function NabyOrgHarnessSettings({ isOpen }: { isOpen: boolean }) {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<OrgHarnessView | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (body: Record<string, unknown>, success?: string) => {
      setBusy(true);
      const res = await orgAction(body);
      setBusy(false);
      if (res.ok) {
        if (res.orgHarness) setView(res.orgHarness);
        if (success) toast(success, 'success');
      } else {
        toast(res.error, 'error');
      }
    },
    [],
  );

  useEffect(() => {
    if (isOpen) void run({ action: 'orgHarness.get' });
  }, [isOpen, run]);

  if (!view) {
    return <p className="text-xs text-muted-foreground">{t('orgHarness.loading', { defaultValue: 'Loading…' })}</p>;
  }

  const activation = orgActivation(view);
  const skills = orgSkillRows(view);
  const choices = orgChoiceRows(view);
  const lastSync = view.lastSync;
  const lastSyncAt = lastSync
    ? new Date(lastSync.at).toLocaleString(i18n.language || undefined)
    : undefined;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground leading-relaxed">
        {t('orgHarness.description', {
          defaultValue:
            "The company's shared harness (altimedia-harness), which follows Skill Hub and updates itself when a new version is published.",
        })}
      </p>

      <div className="text-xs space-y-1">
        <p className="text-foreground">{t(orgStatusKey(view))}</p>
        <p className={activation === 'needsKey' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}>
          {t(orgActivationKey(activation))}
        </p>
        <p className="text-muted-foreground">
          {view.package
            ? t('orgHarness.version', { version: view.package.version, defaultValue: 'Version {{version}}' })
            : t('orgHarness.noPackage', {
                defaultValue: 'Not downloaded yet — it downloads when you are on the company network.',
              })}
        </p>
        {lastSync && lastSyncAt ? (
          <p className="text-muted-foreground">
            {t('orgHarness.lastSync', { at: lastSyncAt, defaultValue: 'Last checked {{at}}' })}
            {' · '}
            {t(orgSyncOutcomeKey(lastSync.outcome))}
          </p>
        ) : null}
      </div>

      <label className="flex items-center gap-2 text-xs text-foreground">
        <input
          type="checkbox"
          checked={view.enabledSetting && !view.envOff}
          disabled={busy || orgToggleDisabled(view)}
          onChange={(e) => void run({ action: 'orgHarness.set', enabled: e.target.checked })}
        />
        {t('orgHarness.toggle', { defaultValue: 'Use the org harness' })}
      </label>
      {view.envOff ? (
        <p className="text-xs text-muted-foreground">
          {t('orgHarness.envOffHint', { defaultValue: 'Turned off by NABY_ORG_HARNESS=0 in the environment.' })}
        </p>
      ) : null}

      {skills.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs font-medium text-foreground">{t('orgHarness.skills', { defaultValue: 'Org skills' })}</p>
          <ul className="text-xs space-y-0.5">
            {skills.map((s) => (
              <li key={s.name} className="flex items-center gap-2">
                <code className="text-foreground">/{s.name}</code>
                <span className={s.enabled ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'}>
                  {s.enabled
                    ? t('orgHarness.skillOn', { defaultValue: 'on' })
                    : t('orgHarness.skillOff', { defaultValue: 'off' })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {choices.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs font-medium text-foreground">
            {t('orgHarness.copiesTitle', { defaultValue: 'Skills you installed with the same name' })}
          </p>
          {choices.map((c) => (
            <div key={c.name} className="rounded border border-border p-2 space-y-1">
              <p className="text-xs text-foreground">
                {c.state === 'pending'
                  ? t('orgHarness.copyPending', {
                      skill: c.name,
                      copyKind: t(orgCopyKindKey(c.copy ?? 'unknown')),
                      defaultValue:
                        'Your {{skill}} ({{copyKind}}) is used instead of the org version and does not get its updates.',
                    })
                  : t('orgHarness.copyKept', {
                      skill: c.name,
                      defaultValue: 'You chose to keep your own {{skill}}.',
                    })}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy || !view.on}
                  onClick={() =>
                    void run(
                      { action: 'orgHarness.useOrgVersion', name: c.name },
                      t('orgHarness.useOrgDone', { skill: c.name, defaultValue: 'Now using the org {{skill}}.' }),
                    )
                  }
                  className="text-xs px-2 py-1 rounded border border-border text-foreground hover:bg-muted disabled:opacity-50"
                >
                  {t('orgHarness.useOrg', { defaultValue: 'Use the org version' })}
                </button>
                {c.state === 'pending' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run({ action: 'orgHarness.keepUserCopy', name: c.name })}
                    className="text-xs px-2 py-1 rounded border border-border text-foreground hover:bg-muted disabled:opacity-50"
                  >
                    {t('orgHarness.keepMine', { defaultValue: 'Keep my copy' })}
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <button
        type="button"
        disabled={busy || !view.configured}
        onClick={() => void run({ action: 'orgHarness.sync' })}
        className="text-xs px-2 py-1 rounded border border-border text-foreground hover:bg-muted disabled:opacity-50"
      >
        {busy
          ? t('orgHarness.checking', { defaultValue: 'Checking…' })
          : t('orgHarness.checkNow', { defaultValue: 'Check for updates' })}
      </button>
    </div>
  );
}
