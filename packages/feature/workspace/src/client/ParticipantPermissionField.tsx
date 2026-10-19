'use client';

/**
 * THE PARTICIPANT EDITOR'S PERMISSION FIELD (multi-agent-chat §8.14, R10.6, MAC-M7).
 *
 * Picking tools one chip at a time was a wall for anyone new, so the field leads
 * with five cards — no tools, read only, read and write, elevated, everything —
 * each with one line saying what it allows and a "show included tools" list of
 * what that level resolves to on this machine (`tools.list` → `levels`, judged
 * on the server by the runtime's `toolTierOf`; nothing is classified here). Under
 * the cards: a warning for the two levels that reach outside the project, and
 * the "ask me every time" switch. The old chip editor stays as the folded
 * advanced option "pick tools yourself" — the `custom` level.
 *
 * THE RULE (2026-10-19 user decision): tools inside the chosen level run without
 * asking, tools outside it ask first, and the switch makes every call ask.
 *
 * Pure props; the editor owns the form. `customEditor` is the chip editor itself,
 * so this file does not duplicate it.
 */

import { memo, useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PERMISSION_LEVEL_CHOICES,
  PERMISSION_LEVEL_COPY,
  permissionIsRisky,
  type ParticipantPermissionValue,
  type PermissionLevelChoice,
} from '@cockpit/feature-agent';

const LABEL = 'text-[0.714rem] font-semibold text-muted-foreground';

/** One level's card. Memo'd: the editor re-renders on every keystroke. */
const LevelCard = memo(function LevelCard({
  level,
  selected,
  tools,
  onPick,
}: {
  level: PermissionLevelChoice;
  selected: boolean;
  /** The catalogue tools this level includes; `undefined` while loading. */
  tools: readonly string[] | undefined;
  onPick: (level: PermissionLevelChoice) => void;
}) {
  const { t } = useTranslation();
  const copy = PERMISSION_LEVEL_COPY[level];
  return (
    <div
      className={`flex min-w-0 flex-col rounded-lg border px-2.5 py-2 ${
        selected ? 'border-brand/60 bg-accent' : 'border-border bg-background hover:bg-muted'
      }`}
      data-testid={`permission-card-${level}`}
    >
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        onClick={() => onPick(level)}
        className="flex flex-col items-start gap-0.5 text-left"
        data-testid={`permission-level-${level}`}
      >
        <span className="flex items-center gap-1.5 text-xs font-bold text-foreground">
          <span
            className={`grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border ${
              selected ? 'border-brand' : 'border-border'
            }`}
            aria-hidden="true"
          >
            {selected ? <span className="h-1.5 w-1.5 rounded-full bg-brand" /> : null}
          </span>
          {t(copy.key, { defaultValue: copy.en })}
        </span>
        <span className="text-[0.714rem] leading-snug text-muted-foreground">
          {t(copy.descKey, { defaultValue: copy.descEn })}
        </span>
      </button>
      {level === 'none' ? null : (
        <details className="mt-1.5 text-[0.714rem]" data-testid={`permission-tools-${level}`}>
          <summary className="cursor-pointer select-none font-semibold text-brand">
            {t('participants.permission.showTools', { defaultValue: 'Show included tools' })}
          </summary>
          {tools === undefined ? null : tools.length === 0 ? (
            <p className="mt-1 text-muted-foreground">{t('participants.permission.noTools', { defaultValue: 'None on this machine' })}</p>
          ) : (
            <ul className="mt-1 flex flex-wrap gap-1">
              {tools.map((n) => (
                <li key={n} className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.643rem] text-foreground">
                  {n}
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
    </div>
  );
});

export const ParticipantPermissionField = memo(function ParticipantPermissionField({
  value,
  levels,
  onChange,
  customEditor,
}: {
  value: ParticipantPermissionValue;
  /** `tools.list` → `levels`; `undefined` until it answers. */
  levels: Readonly<Record<PermissionLevelChoice, readonly string[]>> | undefined;
  onChange: (next: ParticipantPermissionValue) => void;
  /** The chip editor, shown inside the folded "pick tools yourself" option. */
  customEditor: ReactNode;
}) {
  const { t } = useTranslation();
  const pick = useCallback((level: PermissionLevelChoice) => onChange({ ...value, level }), [onChange, value]);
  const toggleAlways = useCallback(
    () => onChange({ ...value, approval: value.approval === 'always' ? 'auto' : 'always' }),
    [onChange, value],
  );
  const useCustom = useCallback(() => onChange({ ...value, level: 'custom' }), [onChange, value]);
  const revoke = useCallback(
    (name: string) => onChange({ ...value, approvedTools: (value.approvedTools ?? []).filter((n) => n !== name) }),
    [onChange, value],
  );
  const approved = value.approvedTools ?? [];
  const always = value.approval === 'always';
  const custom = value.level === 'custom';

  return (
    <div className="space-y-2" data-testid="permission-field" data-level={value.level} data-approval={value.approval}>
      <span className={LABEL}>{t('participants.permission.label', { defaultValue: 'What it may do' })}</span>
      <p className="text-[0.714rem] text-muted-foreground" data-testid="permission-level-hint">
        {t('participants.permission.levelHint', {
          defaultValue:
            'Tools inside the level run without asking; tools outside it ask you first. A tool you allow once is not asked again.',
        })}
      </p>
      <div
        role="radiogroup"
        aria-label={t('participants.permission.label', { defaultValue: 'What it may do' })}
        className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-1.5"
      >
        {PERMISSION_LEVEL_CHOICES.map((level) => (
          <LevelCard key={level} level={level} selected={value.level === level} tools={levels?.[level]} onPick={pick} />
        ))}
      </div>
      {approved.length > 0 ? (
        <div className="space-y-1" data-testid="permission-approved">
          <span className={LABEL}>{t('participants.permission.approvedLabel', { defaultValue: 'Tools you have allowed' })}</span>
          <div className="flex flex-wrap gap-1">
            {approved.map((name) => (
              <span
                key={name}
                className="flex items-center gap-1 rounded-sm bg-accent px-1.5 py-0.5 font-mono text-xs text-brand"
                data-approved-tool={name}
              >
                {name}
                <button
                  type="button"
                  onClick={() => revoke(name)}
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={t('participants.permission.revoke', { defaultValue: 'Ask again for {{name}}', name })}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <p className="text-[0.714rem] text-muted-foreground">
            {t('participants.permission.approvedHint', {
              defaultValue: 'Allowed once from an approval card, so they no longer ask. Remove one with × to be asked again.',
            })}
          </p>
        </div>
      ) : null}
      {permissionIsRisky(value.level) ? (
        <p
          className="rounded-md bg-destructive/10 px-2 py-1.5 text-[0.714rem] font-semibold text-destructive"
          data-testid="permission-warning"
        >
          {value.level === 'all'
            ? t('participants.permission.warnAll', {
                defaultValue: 'It can use every tool in the chat — commands, messages and every MCP server included.',
              })
            : t('participants.permission.warnElevated', {
                defaultValue: 'It can run commands and send messages — things a snapshot cannot undo.',
              })}
        </p>
      ) : null}
      <p className="text-[0.714rem] text-muted-foreground">
        {t('participants.permission.mcpNote', {
          defaultValue:
            'MCP tools from the servers picked under External resources follow the level ("Read only" takes the ones a server marks read-only).',
        })}
      </p>
      <button
        type="button"
        role="switch"
        aria-checked={always}
        onClick={toggleAlways}
        className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-background px-2.5 py-2 text-left hover:bg-muted"
        data-testid="permission-always"
      >
        <span
          className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${always ? 'bg-brand' : 'bg-muted-foreground/40'}`}
          aria-hidden="true"
        >
          <span
            className={`absolute top-0.5 h-3 w-3 rounded-full bg-background shadow-sm transition-[left] ${
              always ? 'left-3.5' : 'left-0.5'
            }`}
          />
        </span>
        <span className="min-w-0">
          <span className="block text-xs font-semibold text-foreground">
            {t('participants.permission.always', { defaultValue: 'Ask me every time it uses a tool' })}
          </span>
          <span className="block text-[0.714rem] text-muted-foreground">
            {t('participants.permission.alwaysHint', {
              defaultValue: 'Every tool call asks before it runs. Where nobody can answer, the call is refused.',
            })}
          </span>
        </span>
      </button>
      <details className="rounded-lg border border-dashed border-border px-2.5 py-1.5" open={custom} data-testid="permission-custom">
        <summary className="cursor-pointer select-none text-xs font-semibold text-foreground">
          {t('participants.permission.customSummary', { defaultValue: 'Pick tools yourself (advanced)' })}
          {custom ? (
            <span className="ml-1.5 rounded-sm bg-accent px-1 py-0.5 text-[0.643rem] text-brand">
              {t('participants.permission.inUse', { defaultValue: 'in use' })}
            </span>
          ) : null}
        </summary>
        <div className="mt-2 space-y-1.5">
          {custom ? null : (
            <button
              type="button"
              onClick={useCustom}
              className="text-xs px-2 py-1 rounded-md border border-border text-foreground hover:bg-accent"
              data-testid="permission-use-custom"
            >
              {t('participants.permission.useCustom', { defaultValue: 'Use only the tools listed below' })}
            </button>
          )}
          {customEditor}
        </div>
      </details>
    </div>
  );
});
