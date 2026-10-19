/**
 * A PARTICIPANT'S PERMISSION TIER ON THE CLIENT (multi-agent-chat §8.14, MAC-M7).
 *
 * The wire shape and the copy only. WHICH tools a level includes is never decided
 * here: the server resolves the effective permission of every row
 * (`participant.list` → `permission`) and the tools of every level (`tools.list`
 * → `levels`) with the runtime's `toolTierOf`, the one judge. This file reads
 * those answers and names them, for the Settings editor, the roster badge and
 * naby's draft card.
 */

export type PermissionLevel = 'none' | 'read' | 'write' | 'elevated' | 'all' | 'custom';
export type PermissionApproval = 'auto' | 'always';
export type ParticipantPermissionValue = {
  level: PermissionLevel;
  approval: PermissionApproval;
  /** Out-of-level tools the user already allowed once (R10.7) — they run
   *  without asking. Absent = none. */
  approvedTools?: string[];
};

/** The five cards, in order. `custom` is the folded advanced option. */
export const PERMISSION_LEVEL_CHOICES = ['none', 'read', 'write', 'elevated', 'all'] as const;
export type PermissionLevelChoice = (typeof PERMISSION_LEVEL_CHOICES)[number];

const LEVELS: readonly PermissionLevel[] = [...PERMISSION_LEVEL_CHOICES, 'custom'];

/** Read a permission off the wire, or `undefined` when it is not one. */
export function permissionValueFrom(raw: unknown): ParticipantPermissionValue | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.level !== 'string' || !LEVELS.includes(r.level as PermissionLevel)) return undefined;
  const approvedTools = Array.isArray(r.approvedTools)
    ? r.approvedTools.filter((n): n is string => typeof n === 'string' && n.length > 0)
    : [];
  return {
    level: r.level as PermissionLevel,
    approval: r.approval === 'always' ? 'always' : 'auto',
    ...(approvedTools.length > 0 ? { approvedTools } : {}),
  };
}

/** Levels the editor warns about (R10.6): they can act outside the project. */
export function permissionIsRisky(level: PermissionLevel): boolean {
  return level === 'elevated' || level === 'all';
}

/** i18n keys (under `participants.permission`) with English defaults. */
export const PERMISSION_LEVEL_COPY: Record<PermissionLevel, { key: string; en: string; descKey: string; descEn: string }> = {
  none: {
    key: 'participants.permission.level.none',
    en: 'No tools',
    descKey: 'participants.permission.desc.none',
    descEn: 'Every tool asks you first.',
  },
  read: {
    key: 'participants.permission.level.read',
    en: 'Read only',
    descKey: 'participants.permission.desc.read',
    descEn: 'Reads and searches files and the web without asking. Other tools ask first.',
  },
  write: {
    key: 'participants.permission.level.write',
    en: 'Read and write',
    descKey: 'participants.permission.desc.write',
    descEn: 'Also edits and creates project files without asking.',
  },
  elevated: {
    key: 'participants.permission.level.elevated',
    en: 'Elevated',
    descKey: 'participants.permission.desc.elevated',
    descEn: 'Also runs commands, starts background jobs and sends messages without asking.',
  },
  all: {
    key: 'participants.permission.level.all',
    en: 'Everything',
    descKey: 'participants.permission.desc.all',
    descEn: 'Uses every tool in the chat without asking, MCP servers you did not pick included.',
  },
  custom: {
    key: 'participants.permission.level.custom',
    en: 'Pick tools',
    descKey: 'participants.permission.desc.custom',
    descEn: 'The tools you list run without asking; other tools ask first.',
  },
};

/** The short label of a permission — "Read only", "Read only · asks every time". */
export function permissionLabel(
  p: ParticipantPermissionValue,
  t: (key: string, opts: { defaultValue: string }) => string,
): string {
  const level = t(PERMISSION_LEVEL_COPY[p.level].key, { defaultValue: PERMISSION_LEVEL_COPY[p.level].en });
  return p.approval === 'always'
    ? `${level} · ${t('participants.permission.alwaysShort', { defaultValue: 'asks every time' })}`
    : level;
}
