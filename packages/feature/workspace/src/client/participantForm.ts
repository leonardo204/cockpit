/**
 * THE PARTICIPANT EDITOR'S FORM (multi-agent-chat R1.1, R5.2, MAC-M3).
 *
 * Pure: the editor's state, how a stored participant fills it, what it refuses
 * before the request leaves, and the `participant.put` body it sends. The checks
 * MIRROR the server's (`validateParticipantName` in feature-agent
 * `server/lib/participants.ts`, `parseParticipantProfile` in the runtime) so a
 * mistake is named next to the field instead of coming back as one toast. The
 * server still decides — this list is a courtesy, not the gate.
 *
 * Fields the editor does not show (an import's `origin` and `extensions`,
 * `params.maxOutputTokens`, a knowledge item's file source) are carried through
 * unchanged, so saving an imported participant never strips what it came with.
 */

import { AVATAR_PRESETS, COLOR_PRESETS, PARTICIPANT_HEX, participantNameError } from '@cockpit/feature-agent';

export type MemoryScope = 'session' | 'project' | 'user' | 'org';
export type PermissionMode = 'default' | 'plan';

/** Mirrors the runtime limits (src/runtime/participants.ts). */
export const PARTICIPANT_LIMITS = {
  examples: 5,
  knowledge: 20,
  inlineBytes: 16 * 1024,
} as const;

export type KnowledgeDraft = {
  id: string;
  title: string;
  inject: 'always' | 'on-demand';
  /** Comma-separated as typed; split on save. */
  keywords: string;
  source: { kind: 'inline'; text: string } | { kind: 'file'; path: string };
};

export type ParticipantForm = {
  id?: string;
  /** The `@` handle. */
  name: string;
  displayName: string;
  description: string;
  /** The emoji avatar. Ignored while `avatarImage` is kept. */
  avatarEmoji: string;
  /** An image avatar the participant already has (from an import) — kept until
   *  the user picks an emoji. */
  avatarImage?: string;
  color: string;
  instructions: string;
  greeting: string;
  examples: { user: string; assistant: string }[];
  knowledge: KnowledgeDraft[];
  policy: string;
  permissionMode: PermissionMode;
  toolRefs: string[];
  mcpServers: string[];
  skills: string[];
  /** '' = the session's model. */
  model: string;
  /** As typed; '' = engine default. */
  temperature: string;
  memoryScope: MemoryScope;
  /** Profile fields the editor does not show, written back as they were. */
  keep: { origin?: unknown; extensions?: unknown; maxOutputTokens?: number };
};

// The avatar / colour presets and the handle rule are SHARED with naby's draft
// card in the chat (multi-agent-chat §8.12), so both refuse the same things.
// They live in feature-agent because this package depends on it, not the reverse.

export { AVATAR_PRESETS, COLOR_PRESETS };

const HEX = PARTICIPANT_HEX;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

let draftSeq = 0;
/** A fresh knowledge id (unique within the form; the runtime only needs that). */
export function newKnowledgeId(): string {
  draftSeq += 1;
  return `k-${Date.now().toString(36)}-${draftSeq}`;
}

export function blankParticipantForm(): ParticipantForm {
  return {
    name: '',
    displayName: '',
    description: '',
    avatarEmoji: '🤖',
    color: COLOR_PRESETS[0],
    instructions: '',
    greeting: '',
    examples: [],
    knowledge: [],
    policy: '',
    permissionMode: 'default',
    toolRefs: [],
    mcpServers: [],
    skills: [],
    model: '',
    temperature: '',
    memoryScope: 'user',
    keep: {},
  };
}

/** Fill the form from a `participant.list` row (an Agent with its profile). */
export function formFromParticipant(row: unknown): ParticipantForm {
  const base = blankParticipantForm();
  if (!isObj(row)) return base;
  const p = isObj(row.profile) ? row.profile : {};
  const avatar = isObj(p.avatar) ? p.avatar : {};
  const guard = isObj(p.guardrails) ? p.guardrails : {};
  const params = isObj(p.params) ? p.params : {};
  const scope = row.memoryScope;
  return {
    ...(typeof row.id === 'string' ? { id: row.id } : {}),
    name: str(row.name),
    displayName: str(p.displayName) || str(row.name),
    description: str(row.description),
    avatarEmoji: avatar.kind === 'emoji' && str(avatar.value) ? str(avatar.value) : base.avatarEmoji,
    ...(avatar.kind === 'image' && str(avatar.dataUrl) ? { avatarImage: str(avatar.dataUrl) } : {}),
    color: HEX.test(str(p.color)) ? str(p.color) : base.color,
    instructions: str(row.systemPrompt),
    greeting: str(p.greeting),
    examples: Array.isArray(p.examples)
      ? p.examples.filter(isObj).map((e) => ({ user: str(e.user), assistant: str(e.assistant) }))
      : [],
    knowledge: Array.isArray(p.knowledge)
      ? p.knowledge.filter(isObj).map((k) => {
          const src = isObj(k.source) ? k.source : {};
          return {
            id: str(k.id) || newKnowledgeId(),
            title: str(k.title),
            inject: k.inject === 'on-demand' ? ('on-demand' as const) : ('always' as const),
            keywords: strList(k.keywords).join(', '),
            source:
              src.kind === 'file'
                ? { kind: 'file' as const, path: str(src.path) }
                : { kind: 'inline' as const, text: str(src.text) },
          };
        })
      : [],
    policy: str(guard.policy),
    permissionMode: guard.permissionMode === 'plan' ? 'plan' : 'default',
    toolRefs: strList(row.toolRefs),
    mcpServers: strList(p.mcpServers),
    skills: strList(p.skills),
    model: str(row.model),
    temperature: typeof params.temperature === 'number' ? String(params.temperature) : '',
    memoryScope: scope === 'session' || scope === 'project' || scope === 'org' || scope === 'user' ? scope : 'user',
    keep: {
      ...(p.origin !== undefined ? { origin: p.origin } : {}),
      ...(p.extensions !== undefined ? { extensions: p.extensions } : {}),
      ...(typeof params.maxOutputTokens === 'number' ? { maxOutputTokens: params.maxOutputTokens } : {}),
    },
  };
}

/** The draft side of a participant (§8.12 `DraftFields`) — what a `new`
 *  recommendation carries (§8.13). */
export type DraftFieldsInput = {
  name: string;
  displayName: string;
  description: string;
  instructions: string;
  guardrailsPolicy: string;
  greeting: string;
  avatar: { kind: 'emoji'; value: string } | { kind: 'image'; dataUrl: string };
  color: string;
};

/**
 * Fill the form from a draft — naby's recommendation of a NEW participant
 * (multi-agent-chat §8.13). A new participant, so no `id`; the safe defaults of
 * a draft (R8.1, R9.2): no tools, no MCP servers, no skills, the session's model
 * and `memoryScope: 'session'`. The user widens them here before saving.
 */
export function formFromDraft(draft: DraftFieldsInput): ParticipantForm {
  const base = blankParticipantForm();
  return {
    ...base,
    name: draft.name.trim().replace(/^@/, ''),
    displayName: draft.displayName.trim() || draft.name.trim(),
    description: draft.description,
    avatarEmoji: draft.avatar.kind === 'emoji' && draft.avatar.value.trim() ? draft.avatar.value : base.avatarEmoji,
    ...(draft.avatar.kind === 'image' && draft.avatar.dataUrl ? { avatarImage: draft.avatar.dataUrl } : {}),
    color: HEX.test(draft.color.trim()) ? draft.color.trim() : base.color,
    instructions: draft.instructions,
    greeting: draft.greeting,
    policy: draft.guardrailsPolicy,
    toolRefs: [],
    mcpServers: [],
    skills: [],
    model: '',
    memoryScope: 'session',
  };
}

/** One problem with the form. `code` is an i18n key under `participants.editor.err`. */
export type FormError = {
  field: string;
  code:
    | 'name'
    | 'nameSpace'
    | 'nameAt'
    | 'nameLead'
    | 'displayName'
    | 'instructions'
    | 'avatar'
    | 'color'
    | 'examplesMax'
    | 'exampleEmpty'
    | 'knowledgeMax'
    | 'knowledgeTitle'
    | 'knowledgeSize'
    | 'temperature';
  params?: Record<string, string | number>;
};

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

/** Everything the server would refuse, named per field. Empty = ready to save. */
export function validateParticipantForm(f: ParticipantForm): FormError[] {
  const errs: FormError[] = [];
  const nameErr = participantNameError(f.name);
  if (nameErr) errs.push({ field: 'name', code: nameErr });
  if (!f.displayName.trim()) errs.push({ field: 'displayName', code: 'displayName' });
  if (!f.instructions.trim()) errs.push({ field: 'instructions', code: 'instructions' });
  if (!f.avatarImage && !f.avatarEmoji.trim()) errs.push({ field: 'avatar', code: 'avatar' });
  if (!HEX.test(f.color.trim())) errs.push({ field: 'color', code: 'color' });
  if (f.examples.length > PARTICIPANT_LIMITS.examples) {
    errs.push({ field: 'examples', code: 'examplesMax', params: { max: PARTICIPANT_LIMITS.examples } });
  }
  f.examples.forEach((e, i) => {
    if (!e.user.trim() || !e.assistant.trim()) errs.push({ field: `examples.${i}`, code: 'exampleEmpty', params: { n: i + 1 } });
  });
  if (f.knowledge.length > PARTICIPANT_LIMITS.knowledge) {
    errs.push({ field: 'knowledge', code: 'knowledgeMax', params: { max: PARTICIPANT_LIMITS.knowledge } });
  }
  f.knowledge.forEach((k, i) => {
    if (!k.title.trim()) errs.push({ field: `knowledge.${i}`, code: 'knowledgeTitle', params: { n: i + 1 } });
    if (k.source.kind === 'inline' && utf8Bytes(k.source.text) > PARTICIPANT_LIMITS.inlineBytes) {
      errs.push({ field: `knowledge.${i}`, code: 'knowledgeSize', params: { n: i + 1, kb: PARTICIPANT_LIMITS.inlineBytes / 1024 } });
    }
  });
  if (f.temperature.trim()) {
    const t = Number(f.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 2) errs.push({ field: 'temperature', code: 'temperature' });
  }
  return errs;
}

/** The `participant.put` request for a valid form. */
export function participantPutBody(f: ParticipantForm): Record<string, unknown> {
  const temperature = f.temperature.trim() ? Number(f.temperature) : undefined;
  const params = {
    ...(temperature !== undefined ? { temperature } : {}),
    ...(f.keep.maxOutputTokens !== undefined ? { maxOutputTokens: f.keep.maxOutputTokens } : {}),
  };
  const profile = {
    displayName: f.displayName.trim(),
    avatar: f.avatarImage
      ? { kind: 'image', dataUrl: f.avatarImage }
      : { kind: 'emoji', value: f.avatarEmoji.trim() },
    color: f.color.trim(),
    ...(f.greeting.trim() ? { greeting: f.greeting } : {}),
    ...(f.examples.length ? { examples: f.examples.map((e) => ({ user: e.user, assistant: e.assistant })) } : {}),
    knowledge: f.knowledge.map((k) => {
      const keywords = k.keywords
        .split(',')
        .map((w) => w.trim())
        .filter(Boolean);
      return {
        id: k.id,
        title: k.title.trim(),
        inject: k.inject,
        ...(keywords.length ? { keywords } : {}),
        source: k.source,
      };
    }),
    guardrails: {
      ...(f.policy.trim() ? { policy: f.policy } : {}),
      permissionMode: f.permissionMode,
    },
    mcpServers: [...f.mcpServers],
    skills: [...f.skills],
    ...(Object.keys(params).length ? { params } : {}),
    ...(f.keep.origin !== undefined ? { origin: f.keep.origin } : {}),
    ...(f.keep.extensions !== undefined ? { extensions: f.keep.extensions } : {}),
  };
  return {
    action: 'participant.put',
    ...(f.id ? { id: f.id } : {}),
    name: f.name.trim().replace(/^@/, ''),
    description: f.description.trim(),
    instructions: f.instructions.trim(),
    // '' = follow the session's model; the route stores nothing for a blank.
    model: f.model.trim(),
    toolRefs: [...f.toolRefs],
    memoryScope: f.memoryScope,
    profile,
  };
}
