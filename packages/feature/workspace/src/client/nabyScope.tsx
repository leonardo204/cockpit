'use client';

/**
 * Shared scope identity for the Naby settings panels (Memory / Command /
 * Harness). Scoped rows live under one of a few scopes and the panels used to
 * present them as flat, near-identical text filters ("You" / "This project"),
 * which made it hard to tell at a glance whether a memory/command/harness item
 * was GLOBAL (shared by every project) or bound to THIS project only.
 *
 * This module is the single source of that visual language:
 *   - one icon + colour + label per scope (global / project / session / org),
 *   - `ScopeSelector` — the scope filter row (icon + label buttons),
 *   - `ScopeHeader`   — the banner that spells out the selected scope in full
 *                       ("Global (all projects)" / "This project (<folder>)"),
 *   - `ScopeBadge`    — the per-row pill so every list item shows its scope.
 *
 * ORG (team) SCOPE GATING. The `org` scope is real in the store, the server API
 * and the HP-08 harness logic, but a single-user local build has no organization
 * identity or membership, so its `orgId` is only the constant 'default'. Showing
 * an "Organization/Team" filter there is meaningless and confusing. The
 * `ORG_SCOPE_ENABLED` flag hides org from the UI ONLY — nothing server-side is
 * removed. Flip it to `true` once in-house organization infrastructure (org
 * identity + membership) exists and org becomes addressable.
 */

import { memo } from 'react';
import { useTranslation } from 'react-i18next';

// ---------------------------------------------------------------------------
// Org UI gate. Flip to `true` when in-house organization infrastructure lands;
// the store / server API / HP-08 org logic already support it, this only
// re-exposes org in the settings UI.
// ---------------------------------------------------------------------------
export const ORG_SCOPE_ENABLED = false;

/** The scope ids any panel can present. Superset of MemoryScope + HarnessScope
 *  so this one module serves all three panels. */
export type NabyScopeId = 'user' | 'session' | 'project' | 'org';

interface ScopeStyle {
  icon: string;
  /** pill background+text (list-row badge + selected filter button) */
  pill: string;
  /** left-border accent for the ScopeHeader banner */
  border: string;
  /** accent text colour for the header title */
  text: string;
}

// `user` is the GLOBAL scope (shared by every project); we surface it as such.
const SCOPE_STYLE: Record<NabyScopeId, ScopeStyle> = {
  user: {
    icon: '🌐',
    pill: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
    border: 'border-l-sky-500',
    text: 'text-sky-600 dark:text-sky-400',
  },
  project: {
    icon: '📁',
    pill: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
    border: 'border-l-violet-500',
    text: 'text-violet-600 dark:text-violet-400',
  },
  session: {
    icon: '💬',
    pill: 'bg-slate-500/15 text-slate-600 dark:text-slate-400',
    border: 'border-l-slate-500',
    text: 'text-slate-600 dark:text-slate-400',
  },
  org: {
    icon: '🏢',
    pill: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    border: 'border-l-amber-500',
    text: 'text-amber-600 dark:text-amber-400',
  },
};

/** The `user` scope reads as "Global" everywhere in the UI; other scopes map to
 *  their own name. Centralised so a label never drifts between panels. */
function shortLabelKey(scope: NabyScopeId): string {
  return scope === 'user' ? 'scope.global' : `scope.${scope}`;
}
function fullLabelKey(scope: NabyScopeId): string {
  return scope === 'user' ? 'scope.globalFull' : `scope.${scope}Full`;
}
function descKey(scope: NabyScopeId): string {
  return scope === 'user' ? 'scope.globalDesc' : `scope.${scope}Desc`;
}

/** The folder name of an open project, used to name the `project` scope. Pure
 *  basename of the cwd; empty/undefined cwd yields no name (caller falls back to
 *  the "no project" copy). */
export function projectName(cwd: string | undefined): string {
  if (!cwd) return '';
  const parts = cwd.replace(/[/\\]+$/, '').split(/[/\\]/);
  return parts[parts.length - 1] ?? '';
}

/** Drop `org` from a scope list while it is UI-gated. Keeps every other scope in
 *  its given order. */
export function visibleScopes<S extends string>(scopes: readonly S[]): S[] {
  return scopes.filter((s) => s !== 'org' || ORG_SCOPE_ENABLED);
}

export function scopeIcon(scope: NabyScopeId): string {
  return SCOPE_STYLE[scope]?.icon ?? '•';
}

// ---------------------------------------------------------------------------
// ScopeBadge — the per-row pill so each list item shows which scope it lives in.
// ---------------------------------------------------------------------------

export const ScopeBadge = memo(function ScopeBadge({
  scope,
  cwd,
}: {
  scope: NabyScopeId;
  cwd?: string;
}) {
  const { t } = useTranslation();
  const style = SCOPE_STYLE[scope] ?? SCOPE_STYLE.user;
  const name = projectName(cwd);
  const label =
    scope === 'project' && name
      ? t('scope.projectFull', { name })
      : t(shortLabelKey(scope));
  return (
    <span
      className={`inline-flex items-center gap-1 shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${style.pill}`}
    >
      <span aria-hidden>{style.icon}</span>
      {label}
    </span>
  );
});

// ---------------------------------------------------------------------------
// ScopeSelector — the scope filter row (icon + short label buttons). Org is
// dropped while UI-gated; a scope with no addressable key (e.g. project with no
// open project) can be rendered disabled.
// ---------------------------------------------------------------------------

export const ScopeSelector = memo(function ScopeSelector({
  scopes,
  value,
  onChange,
  isDisabled,
}: {
  scopes: readonly NabyScopeId[];
  value: NabyScopeId;
  onChange: (scope: NabyScopeId) => void;
  /** Optional per-scope disable (e.g. project unavailable with no cwd). */
  isDisabled?: (scope: NabyScopeId) => boolean;
}) {
  const { t } = useTranslation();
  const shown = visibleScopes(scopes);
  return (
    <div className="flex flex-wrap gap-1.5">
      {shown.map((scope) => {
        const style = SCOPE_STYLE[scope];
        const selected = value === scope;
        const disabled = isDisabled?.(scope) ?? false;
        return (
          <button
            key={scope}
            onClick={() => onChange(scope)}
            disabled={disabled}
            className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors disabled:opacity-40 ${
              selected
                ? `border-brand ${style.pill}`
                : 'border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            <span aria-hidden>{style.icon}</span>
            {t(shortLabelKey(scope))}
          </button>
        );
      })}
    </div>
  );
});

// ---------------------------------------------------------------------------
// ScopeHeader — the banner that spells out the selected scope in full, so the
// user always sees whether they are editing GLOBAL data or THIS-project data.
// ---------------------------------------------------------------------------

export const ScopeHeader = memo(function ScopeHeader({
  scope,
  cwd,
}: {
  scope: NabyScopeId;
  cwd?: string;
}) {
  const { t } = useTranslation();
  const style = SCOPE_STYLE[scope] ?? SCOPE_STYLE.user;
  const name = projectName(cwd);
  const title =
    scope === 'project'
      ? t('scope.projectFull', { name: name || t('scope.noProject') })
      : t(fullLabelKey(scope));
  const desc =
    scope === 'project'
      ? t('scope.projectDesc', { name: name || t('scope.noProject') })
      : t(descKey(scope));
  return (
    <div className={`flex items-start gap-2 rounded-md border-l-2 ${style.border} bg-accent/40 px-2.5 py-1.5`}>
      <span className="text-base leading-none" aria-hidden>
        {style.icon}
      </span>
      <div className="min-w-0">
        <div className={`text-xs font-semibold ${style.text}`}>{title}</div>
        <div className="text-[11px] text-muted-foreground">{desc}</div>
      </div>
    </div>
  );
});
