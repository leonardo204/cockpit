/**
 * NABY'S PARTICIPANT DRAFT ON THE CLIENT (multi-agent-chat §8.12, R8.3, MAC-M5a).
 *
 * The pure half of the draft card: reading a draft off an `approval_request`,
 * the editable part of it as a form, the checks that mirror the server, and the
 * `approval.resolve` body each button sends. Kept free of React so every rule is
 * a unit test away from proof.
 *
 * THE SHARED IDENTITY RULES live here too — the `@` handle rule, the avatar and
 * colour presets — because the Settings editor (feature-workspace
 * `participantForm.ts`) and this card must refuse the same things, and the
 * workspace package depends on this one, never the other way round.
 */

import type { ParticipantAvatar } from './participants';

// ---------------------------------------------------------------------------
// Identity rules shared with the Settings editor
// ---------------------------------------------------------------------------

/** Avatar presets the pickers offer (any emoji can be typed). */
export const AVATAR_PRESETS = ['🌐', '🔍', '🧭', '🛠', '🎨', '📝', '🧪', '📊', '🤖', '💡'] as const;
/** Colour presets (identifying data colours, not theme tokens). */
export const COLOR_PRESETS = ['#6366F1', '#0EA5E9', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#14B8A6', '#EC4899'] as const;

/** A hex colour the runtime profile gate accepts. */
export const PARTICIPANT_HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Mirrors the runtime's `PARTICIPANT_MAX_EMOJI_CHARS`. */
export const PARTICIPANT_MAX_EMOJI_CHARS = 16;

/** Mirrors the server's draft limits (`DRAFT_LIMITS`, lib/participantDraft.ts). */
export const DRAFT_LIMITS = { displayNameChars: 80, descriptionChars: 1000 } as const;

/** The `@` handle's problem, if any — `validateParticipantName`'s local half
 *  (collisions are the server's to find). One leading `@` is forgiven. */
export function participantNameError(raw: string): 'name' | 'nameSpace' | 'nameAt' | 'nameLead' | null {
  const name = raw.trim().replace(/^@/, '');
  if (!name) return 'name';
  if (/\s/.test(name)) return 'nameSpace';
  if (name.includes('@')) return 'nameAt';
  if (/^[/.~]/.test(name)) return 'nameLead';
  return null;
}

// ---------------------------------------------------------------------------
// The draft on the wire
// ---------------------------------------------------------------------------

export const DRAFT_SOURCE = 'participant_draft';
export const DRAFT_CREATE = 'participant.create';
export const DRAFT_UPDATE = 'participant.update';

export type DraftField =
  | 'name'
  | 'displayName'
  | 'description'
  | 'instructions'
  | 'guardrailsPolicy'
  | 'greeting'
  | 'avatar'
  | 'color';

export interface DraftFields {
  name: string;
  displayName: string;
  description: string;
  instructions: string;
  guardrailsPolicy: string;
  greeting: string;
  avatar: ParticipantAvatar;
  color: string;
}

/** An `approval_request` with `source:'participant_draft'`, as the card draws it. */
export interface ParticipantDraftCard {
  action: 'create' | 'update';
  id?: string;
  draft: DraftFields;
  /** update: the participant as it is now. */
  before?: DraftFields;
  /** update: what the draft changes (only these are shown before → after). */
  changed: DraftField[];
  addToSession: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function avatarFrom(raw: unknown): ParticipantAvatar {
  if (isObj(raw)) {
    if (raw.kind === 'emoji' && typeof raw.value === 'string' && raw.value) return { kind: 'emoji', value: raw.value };
    if (raw.kind === 'image' && typeof raw.dataUrl === 'string' && raw.dataUrl.startsWith('data:image/')) {
      return { kind: 'image', dataUrl: raw.dataUrl };
    }
  }
  return { kind: 'emoji', value: '🤖' };
}

function fieldsFrom(raw: Record<string, unknown>): DraftFields {
  return {
    name: str(raw.name),
    displayName: str(raw.displayName),
    description: str(raw.description),
    instructions: str(raw.instructions),
    guardrailsPolicy: str(raw.guardrailsPolicy),
    greeting: str(raw.greeting),
    avatar: avatarFrom(raw.avatar),
    color: PARTICIPANT_HEX.test(str(raw.color)) ? str(raw.color) : COLOR_PRESETS[0],
  };
}

/** Read a draft's fields off the wire (a draft card's payload, a `new`
 *  recommendation's draft, §8.13). Defensive: missing text reads as '', a
 *  missing avatar as 🤖, a bad colour as the first preset. */
export function draftFieldsFrom(raw: unknown): DraftFields {
  return fieldsFrom(isObj(raw) ? raw : {});
}

const ALL_FIELDS: DraftField[] = [
  'name',
  'displayName',
  'description',
  'instructions',
  'guardrailsPolicy',
  'greeting',
  'avatar',
  'color',
];

/** Read a draft off a raw `approval_request` detail, or `null` when it is not one. */
export function draftFromApproval(d: Record<string, unknown>): ParticipantDraftCard | null {
  if (d.source !== DRAFT_SOURCE) return null;
  if (d.tool_name !== DRAFT_CREATE && d.tool_name !== DRAFT_UPDATE) return null;
  const input = isObj(d.input) ? d.input : {};
  if (!isObj(input.draft)) return null;
  const draft = fieldsFrom(input.draft);
  if (!draft.name) return null;
  const action = d.tool_name === DRAFT_CREATE ? 'create' : 'update';
  const before = action === 'update' && isObj(input.before) ? fieldsFrom(input.before) : undefined;
  const changed = Array.isArray(input.changed)
    ? input.changed.filter((f): f is DraftField => ALL_FIELDS.includes(f as DraftField))
    : before
      ? ALL_FIELDS.filter((f) => JSON.stringify(before[f]) !== JSON.stringify(draft[f]))
      : [];
  const id = str(input.draft.id);
  return {
    action,
    ...(id ? { id } : {}),
    draft,
    ...(before ? { before } : {}),
    changed,
    addToSession:
      typeof input.addToSession === 'boolean'
        ? input.addToSession
        : input.draft.addToSession === true || action === 'create',
  };
}

// ---------------------------------------------------------------------------
// The editable part (avatar, display name, handle, description, colour)
// ---------------------------------------------------------------------------

export interface DraftForm {
  name: string;
  displayName: string;
  description: string;
  /** The emoji avatar; '' while an image avatar is kept. */
  avatar: string;
  color: string;
}

export function draftFormFrom(card: ParticipantDraftCard): DraftForm {
  return {
    name: card.draft.name,
    displayName: card.draft.displayName,
    description: card.draft.description,
    avatar: card.draft.avatar.kind === 'emoji' ? card.draft.avatar.value : '',
    color: card.draft.color,
  };
}

/** An i18n code under `participants.draft.err`, per field. */
export type DraftFormError = {
  field: 'name' | 'displayName' | 'description' | 'avatar' | 'color';
  code: 'name' | 'nameSpace' | 'nameAt' | 'nameLead' | 'displayName' | 'displayNameLong' | 'descriptionLong' | 'avatar' | 'avatarLong' | 'color';
  params?: Record<string, number>;
};

/** What the server would refuse in the edited fields (the courtesy copy — the
 *  server validates again before it writes). */
export function validateDraftForm(f: DraftForm, card: ParticipantDraftCard): DraftFormError[] {
  const errs: DraftFormError[] = [];
  const nameErr = participantNameError(f.name);
  if (nameErr) errs.push({ field: 'name', code: nameErr });
  const display = f.displayName.trim();
  if (!display) errs.push({ field: 'displayName', code: 'displayName' });
  else if ([...display].length > DRAFT_LIMITS.displayNameChars) {
    errs.push({ field: 'displayName', code: 'displayNameLong', params: { max: DRAFT_LIMITS.displayNameChars } });
  }
  if ([...f.description.trim()].length > DRAFT_LIMITS.descriptionChars) {
    errs.push({ field: 'description', code: 'descriptionLong', params: { max: DRAFT_LIMITS.descriptionChars } });
  }
  const keepsImage = card.draft.avatar.kind === 'image' && !f.avatar.trim();
  if (!keepsImage) {
    if (!f.avatar.trim()) errs.push({ field: 'avatar', code: 'avatar' });
    else if ([...f.avatar.trim()].length > PARTICIPANT_MAX_EMOJI_CHARS) {
      errs.push({ field: 'avatar', code: 'avatarLong', params: { max: PARTICIPANT_MAX_EMOJI_CHARS } });
    }
  }
  if (!PARTICIPANT_HEX.test(f.color.trim())) errs.push({ field: 'color', code: 'color' });
  return errs;
}

/** Only the fields the user actually changed — the server merges them over the
 *  draft it holds. */
export function draftEdits(card: ParticipantDraftCard, f: DraftForm): Partial<DraftForm> {
  const base = draftFormFrom(card);
  const out: Partial<DraftForm> = {};
  const name = f.name.trim().replace(/^@/, '');
  if (name !== base.name) out.name = name;
  if (f.displayName.trim() !== base.displayName) out.displayName = f.displayName.trim();
  if (f.description.trim() !== base.description) out.description = f.description.trim();
  if (f.avatar.trim() && f.avatar.trim() !== base.avatar) out.avatar = f.avatar.trim();
  if (f.color.trim() !== base.color) out.color = f.color.trim();
  return out;
}

/** Which button: create → "create and add" / "create only"; update → "apply". */
export type DraftChoice = 'create-add' | 'create-only' | 'apply' | 'decline';

/** The `approval.resolve` body a button sends. Never `remember` (R8.2). */
export function draftResolveBody(
  approvalId: string,
  card: ParticipantDraftCard,
  form: DraftForm,
  choice: DraftChoice,
): Record<string, unknown> {
  if (choice === 'decline') return { approvalId, decision: 'deny' };
  const edits = draftEdits(card, form);
  return {
    approvalId,
    decision: 'allow',
    ...(Object.keys(edits).length > 0 ? { edits } : {}),
    addToSession: choice === 'create-add' ? true : choice === 'create-only' ? false : card.addToSession,
  };
}

/** Does this `approval_resolved` change the participant registry (a draft that
 *  was approved and saved)? Settings re-reads on it. */
export function draftResolvedSaved(d: Record<string, unknown>): boolean {
  return (
    d.source === DRAFT_SOURCE &&
    (d.tool_name === DRAFT_CREATE || d.tool_name === DRAFT_UPDATE) &&
    d.decision === 'allow' &&
    typeof d.agentId === 'string' &&
    d.agentId !== ''
  );
}
