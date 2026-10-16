// packages/feature/agent/src/server/lib/participantDraft.ts
//
// NABY DRAFTS A PARTICIPANT IN THE CONVERSATION (specs/multi-agent-chat.md §8.12,
// MAC-M5a).
//
// "번역가 참가자 만들어 줘" used to end with naby sending the user to Settings.
// Now naby writes the draft itself — through `naby_participant_draft` — and the
// user approves it on a card in the chat. The tool is built per turn by the
// engine adapter (`engines/naby.ts`) and offered ONLY on naby's own turns: never
// to a participant (participantTurn's exclusion list) and never to a subagent
// (the gate refuses it there).
//
// THREE RULES THIS MODULE KEEPS, and why each lives here:
//
//   1. NOTHING IS WRITTEN WITHOUT A PERSON (R8.2). The executor validates the
//      draft and then SUSPENDS on an approval — the same registry, TTL and abort
//      handling as a tool approval. There is no "remember", and the gate never
//      lets a policy rule or the allow-all baseline answer for this tool: the
//      prompt is raised HERE, inside the executor, after the gate has already
//      said allow. So a policy can tighten (deny) but never loosen.
//   2. A DRAFT IS NARROW (R8.1). Only identity and words: handle, display name,
//      description, instructions, guardrail policy, greeting, avatar, colour.
//      Tools, MCP servers, skills, model and memory scope are not in the schema;
//      a new participant gets the safe defaults (`toolRefs: []`, no MCP, no
//      skills, `memoryScope: 'session'`), and an update keeps the stored ones.
//   3. ONE WRITE PATH (R8.4). The approved draft — with the user's corrections
//      merged and validated again — is written by `putParticipant`, the same
//      function `participant.put` uses, and joined to the session by
//      `addParticipantToSession` (the cap check included).

import type {
  Agent,
  Executor,
  GateDecision,
  ParticipantProfile,
  Store,
  ToolOutput,
  ToolSchema,
} from '../../../../../../../dist/naby-runtime.mjs';
import { defaultParticipantProfile, parseParticipantProfile } from '../../../../../../../dist/naby-runtime.mjs';
import {
  PARTICIPANT_CREATE_TOOL,
  PARTICIPANT_DRAFT_TOOL_NAME,
  PARTICIPANT_UPDATE_TOOL,
  registerApproval,
  unregisterApproval,
  type ApprovalExtras,
} from './approvalRegistry';
import { addParticipantToSession, isParticipant, putParticipant, validateParticipantName } from './participants';
import { readParticipantProfile } from './participantTurn';

/** The tool's bare name — also the gate's special-case key. */
export const PARTICIPANT_DRAFT_TOOL = PARTICIPANT_DRAFT_TOOL_NAME;
/** `approval_request.source` for a draft — the client draws the draft card. */
export const PARTICIPANT_DRAFT_SOURCE = 'participant_draft';

/** Size limits a model-written draft is held to on top of the profile gate. The
 *  card's client checks mirror the two the user can edit. */
export const DRAFT_LIMITS = {
  displayNameChars: 80,
  descriptionChars: 1000,
  instructionsBytes: 32 * 1024,
} as const;

/** R8.5 — the line naby's system prompt carries whenever this tool is offered. */
export const PARTICIPANT_DRAFT_RULE = [
  '## Creating or changing participants',
  `- When the user asks you to create a conversation participant, or to change one's instructions or description, call \`${PARTICIPANT_DRAFT_TOOL}\` with a draft and wait for the user's approval on the card. Do not send them to Settings. Do not put tools, permissions, MCP servers, skills or a model they did not ask for into a draft. If the draft is declined, do not try again — ask the user what to change.`,
].join('\n');

const TOOL_DESCRIPTION = [
  'Draft a conversation participant — an agent that can speak in this chat — either a new one (action "create") or a change to an existing one (action "update").',
  'Use it whenever the user asks you to make, set up, rename or change a participant (e.g. "make me a translator participant"). Nothing is saved by this call: the user sees the draft on an approval card, may correct the name, display name, description, avatar and colour, and approves or declines. The call returns once they answer.',
  '`instructions` is the participant\'s system prompt, written to it in the second person. `description` is one sentence saying when the participant should be handed work — you read it later to decide whom to hand a request to.',
  'Tools, MCP servers, skills, the model and memory are NOT part of a draft: a new participant starts with none, and only the user widens them in Settings. Do not promise them.',
  'For "update", pass the participant\'s id or current @handle in `id`, and only the fields that change.',
  'If the result says the draft was declined or timed out, do not call again — ask the user what they want instead.',
].join(' ');

export const PARTICIPANT_DRAFT_SCHEMA: ToolSchema = {
  name: PARTICIPANT_DRAFT_TOOL,
  description: TOOL_DESCRIPTION,
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'update'], description: 'create a new participant, or update an existing one' },
      id: { type: 'string', description: 'update only: the participant\'s id or current @handle' },
      name: { type: 'string', description: 'the @handle (no spaces, no @). Required for create.' },
      displayName: { type: 'string', description: 'the name shown on its speech bubble, e.g. "Translator"' },
      description: { type: 'string', description: 'one sentence: when it should be handed work' },
      instructions: { type: 'string', description: 'its system prompt. Required for create.' },
      guardrailsPolicy: { type: 'string', description: 'optional: what it must never do' },
      greeting: { type: 'string', description: 'optional: its first line when it joins' },
      avatar: { type: 'string', description: 'one emoji, e.g. 🌐' },
      color: { type: 'string', description: 'hex colour like #0ea5e9' },
      addToSession: { type: 'boolean', description: 'add it to this conversation once approved (default true for create)' },
    },
    required: ['action'],
  },
};

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

/** What the model sends (R8.1), type-checked. */
export type DraftToolInput = {
  action: 'create' | 'update';
  id?: string;
  name?: string;
  displayName?: string;
  description?: string;
  instructions?: string;
  guardrailsPolicy?: string;
  greeting?: string;
  avatar?: string;
  color?: string;
  addToSession?: boolean;
};

/** The fields a draft can change — the before/after comparison runs over these. */
export const DRAFT_FIELDS = [
  'name',
  'displayName',
  'description',
  'instructions',
  'guardrailsPolicy',
  'greeting',
  'avatar',
  'color',
] as const;
export type DraftField = (typeof DRAFT_FIELDS)[number];

/** One participant's draftable side, as the card shows it. `''` = absent. */
export type DraftFields = {
  name: string;
  displayName: string;
  description: string;
  instructions: string;
  guardrailsPolicy: string;
  greeting: string;
  avatar: ParticipantProfile['avatar'];
  color: string;
};

/** The draft as it travels on `approval_request.input.draft`. */
export type ParticipantDraft = DraftFields & {
  action: 'create' | 'update';
  /** update: the participant being changed. */
  id?: string;
  addToSession: boolean;
};

/** The approval card's payload (`approval_request.input`). */
export type ParticipantDraftRequest = {
  draft: ParticipantDraft;
  /** update: the participant as it is now. */
  before?: DraftFields;
  /** update: the fields that differ (the card shows only these). */
  changed?: DraftField[];
  addToSession: boolean;
};

const STRING_KEYS = [
  'id',
  'name',
  'displayName',
  'description',
  'instructions',
  'guardrailsPolicy',
  'greeting',
  'avatar',
  'color',
] as const;

/** Type-check the model's input. Unknown keys are ignored — in particular any
 *  attempt to pass `toolRefs`, `mcpServers`, `skills`, `model` or `memoryScope`
 *  has no effect (R8.1). */
export function parseDraftToolInput(raw: unknown): { ok: true; input: DraftToolInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'input must be an object' };
  const r = raw as Record<string, unknown>;
  if (r.action !== 'create' && r.action !== 'update') {
    return { ok: false, error: "action must be 'create' or 'update'" };
  }
  const input: DraftToolInput = { action: r.action };
  for (const k of STRING_KEYS) {
    const v = r[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') return { ok: false, error: `${k} must be a string` };
    input[k] = v;
  }
  if (r.addToSession !== undefined && r.addToSession !== null) {
    if (typeof r.addToSession !== 'boolean') return { ok: false, error: 'addToSession must be a boolean' };
    input.addToSession = r.addToSession;
  }
  return { ok: true, input };
}

const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/** The draftable side of a stored participant. */
export function draftFieldsOf(agent: Agent, profile: ParticipantProfile): DraftFields {
  return {
    name: agent.name,
    displayName: profile.displayName,
    description: agent.description ?? '',
    instructions: agent.systemPrompt,
    guardrailsPolicy: profile.guardrails.policy ?? '',
    greeting: profile.greeting ?? '',
    avatar: profile.avatar,
    color: profile.color,
  };
}

function sameAvatar(a: DraftFields['avatar'], b: DraftFields['avatar']): boolean {
  if (a.kind === 'emoji' && b.kind === 'emoji') return a.value === b.value;
  if (a.kind === 'image' && b.kind === 'image') return a.dataUrl === b.dataUrl;
  return false;
}

/** Which draftable fields differ between two sides. */
export function changedDraftFields(before: DraftFields, after: DraftFields): DraftField[] {
  return DRAFT_FIELDS.filter((f) =>
    f === 'avatar' ? !sameAvatar(before.avatar, after.avatar) : before[f] !== after[f],
  );
}

/** A composed, validated draft and the `participant.put` body that saves it. */
export type ComposedDraft = {
  draft: ParticipantDraft;
  before?: DraftFields;
  changed?: DraftField[];
  /** The target row (update). */
  existing?: Agent;
  putBody: Record<string, unknown>;
};

/** Find the participant an update names — by id, else by its handle. */
function findParticipant(store: Pick<Store, 'getAgent' | 'getAgentByName' | 'listAgents'>, ref: string): Agent | undefined {
  const byId = store.getAgent(ref);
  if (byId) return byId;
  const handle = ref.trim().replace(/^@/, '').toLowerCase();
  if (!handle) return undefined;
  return store.listAgents().find((a) => a.kind === 'participant' && a.name.toLowerCase() === handle);
}

/**
 * Validate a draft against the store as it is NOW and build what would be
 * written. Called twice per draft: before the card is shown (so an invalid draft
 * never reaches the user) and after approval with the user's edits merged (so a
 * corrected name that has meanwhile been taken is refused, not overwritten).
 * Never writes, never throws.
 */
export function composeDraft(
  store: Pick<Store, 'getAgent' | 'getAgentByName' | 'listAgents'>,
  input: DraftToolInput,
): { ok: true; composed: ComposedDraft } | { ok: false; error: string } {
  let existing: Agent | undefined;
  let before: DraftFields | undefined;
  let baseProfile: ParticipantProfile;
  if (input.action === 'update') {
    const ref = input.id?.trim() ?? '';
    if (!ref) return { ok: false, error: 'update needs the id (or @handle) of the participant to change' };
    const found = findParticipant(store, ref);
    if (!found || !isParticipant(found)) {
      const known = store
        .listAgents()
        .filter((a) => a.kind === 'participant')
        .map((a) => `@${a.name}`);
      return {
        ok: false,
        error:
          `'${ref}' is not a conversation participant — only a participant can be updated` +
          (known.length ? ` (participants: ${known.join(', ')})` : ' (there are no participants yet)'),
      };
    }
    existing = found;
    baseProfile = readParticipantProfile(found).profile;
    before = draftFieldsOf(found, baseProfile);
  } else {
    baseProfile = defaultParticipantProfile(input.displayName?.trim() || input.name?.trim() || 'Participant');
  }

  // -- name (the `@` handle) — the participant.put rule, checked against the
  //    store now (case-insensitive, hub names reserved).
  const rawName = input.name ?? before?.name ?? '';
  const named = validateParticipantName(rawName, store, existing?.id);
  if (!named.ok) return { ok: false, error: named.error };

  const pick = (v: string | undefined, fallback: string): string => (v === undefined ? fallback : v.trim());
  const displayName = pick(input.displayName, before?.displayName ?? '') || named.name;
  if ([...displayName].length > DRAFT_LIMITS.displayNameChars) {
    return { ok: false, error: `displayName is longer than ${DRAFT_LIMITS.displayNameChars} characters` };
  }
  const description = pick(input.description, before?.description ?? '');
  if ([...description].length > DRAFT_LIMITS.descriptionChars) {
    return { ok: false, error: `description is longer than ${DRAFT_LIMITS.descriptionChars} characters` };
  }
  const instructions = pick(input.instructions, before?.instructions ?? '');
  if (!instructions) return { ok: false, error: 'instructions are required' };
  if (utf8Bytes(instructions) > DRAFT_LIMITS.instructionsBytes) {
    return { ok: false, error: `instructions are larger than ${DRAFT_LIMITS.instructionsBytes / 1024} KB` };
  }
  const guardrailsPolicy = pick(input.guardrailsPolicy, before?.guardrailsPolicy ?? '');
  const greeting = pick(input.greeting, before?.greeting ?? '');
  let avatar: DraftFields['avatar'] = before?.avatar ?? baseProfile.avatar;
  if (input.avatar !== undefined) {
    const value = input.avatar.trim();
    if (!value) return { ok: false, error: 'avatar must be an emoji' };
    avatar = { kind: 'emoji', value };
  }
  const color = input.color !== undefined ? input.color.trim() : (before?.color ?? baseProfile.color);

  // -- the profile, through the runtime gate (avatar length, hex colour,
  //    greeting / policy size). An update keeps everything a draft cannot name.
  const guardrails: ParticipantProfile['guardrails'] = { ...baseProfile.guardrails };
  if (guardrailsPolicy) guardrails.policy = guardrailsPolicy;
  else delete guardrails.policy;
  const candidate: Record<string, unknown> = {
    ...baseProfile,
    displayName,
    avatar,
    color,
    guardrails,
  };
  if (greeting) candidate.greeting = greeting;
  else delete candidate.greeting;
  if (!existing) {
    // A new participant gets the safe defaults whatever the model asked for.
    candidate.mcpServers = [];
    candidate.skills = [];
  }
  let profile: ParticipantProfile;
  try {
    profile = parseParticipantProfile(candidate);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const fields: DraftFields = {
    name: named.name,
    displayName: profile.displayName,
    description,
    instructions,
    guardrailsPolicy: profile.guardrails.policy ?? '',
    greeting: profile.greeting ?? '',
    avatar: profile.avatar,
    color: profile.color,
  };
  const changed = before ? changedDraftFields(before, fields) : undefined;
  if (changed && changed.length === 0) return { ok: false, error: 'the draft changes nothing' };

  const draft: ParticipantDraft = {
    action: input.action,
    ...(existing ? { id: existing.id } : {}),
    ...fields,
    // A new participant joins by default — it was asked for in THIS conversation.
    addToSession: input.addToSession ?? input.action === 'create',
  };
  const putBody: Record<string, unknown> = existing
    ? {
        id: existing.id,
        name: fields.name,
        description: fields.description,
        instructions: fields.instructions,
        // Kept verbatim: a draft cannot change the model, tools or memory scope.
        ...(existing.model ? { model: existing.model } : {}),
        profile,
      }
    : {
        name: fields.name,
        description: fields.description,
        instructions: fields.instructions,
        toolRefs: [],
        memoryScope: 'session',
        profile,
      };
  return {
    ok: true,
    composed: { draft, ...(before ? { before, changed } : {}), ...(existing ? { existing } : {}), putBody },
  };
}

/** The tool input that reproduces `draft` with the user's `edits` on top. */
export function draftInputWithEdits(draft: ParticipantDraft, edits: ApprovalExtras['edits']): DraftToolInput {
  const e = edits ?? {};
  return {
    action: draft.action,
    ...(draft.id ? { id: draft.id } : {}),
    name: e.name ?? draft.name,
    displayName: e.displayName ?? draft.displayName,
    description: e.description ?? draft.description,
    instructions: draft.instructions,
    guardrailsPolicy: draft.guardrailsPolicy,
    greeting: draft.greeting,
    // An image avatar (an update that keeps it) is not expressible as an emoji;
    // leaving it out keeps the stored one.
    ...(e.avatar !== undefined
      ? { avatar: e.avatar }
      : draft.avatar.kind === 'emoji'
        ? { avatar: draft.avatar.value }
        : {}),
    color: e.color ?? draft.color,
    addToSession: draft.addToSession,
  };
}

// ---------------------------------------------------------------------------
// The words naby gets back (R8.4) — Korean, the language it reports in
// ---------------------------------------------------------------------------

/** 을/를 after a word: 을 after a Hangul syllable with a final consonant. */
export function objectParticle(word: string): '을' | '를' {
  const last = [...word.trim()].pop() ?? '';
  const code = last.codePointAt(0) ?? 0;
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 === 0 ? '를' : '을';
  return '를';
}

const FIELD_LABEL_KO: Record<DraftField, string> = {
  name: '핸들',
  displayName: '표시 이름',
  description: '설명',
  instructions: '지시',
  guardrailsPolicy: '가드레일',
  greeting: '첫 인사',
  avatar: '아바타',
  color: '색',
};

export type DraftOutcome =
  | { kind: 'deny' | 'timeout' | 'abort' }
  | { kind: 'save-failed'; error: string }
  | {
      kind: 'saved';
      action: 'create' | 'update';
      name: string;
      changed?: DraftField[];
      /** Fields the USER corrected on the card. */
      edited: DraftField[];
      session: 'added' | 'already' | 'not-requested' | { capped: number } | { failed: string };
    };

/** The tool result text for an outcome (R8.4). */
export function draftResultText(o: DraftOutcome): string {
  switch (o.kind) {
    case 'deny':
      return '거절됐어요 — 사용자가 이 초안을 승인하지 않았어요. 다시 시도하지 말고 사용자에게 무엇을 바꾸고 싶은지 물어보세요.';
    case 'timeout':
      return '승인을 기다리다 시간이 지나 저장하지 않았어요. 다시 시도하지 말고 사용자에게 물어보세요.';
    case 'abort':
      return '턴이 중단돼 저장하지 않았어요.';
    case 'save-failed':
      return `승인됐지만 저장하지 못했어요: ${o.error}. 다시 시도하지 말고 사용자에게 알려 주세요.`;
    case 'saved': {
      const handle = `@${o.name}`;
      const p = objectParticle(o.name);
      let line: string;
      if (o.action === 'create') {
        if (o.session === 'added' || o.session === 'already') line = `${handle}${p} 만들고 이 대화에 추가했어요.`;
        else if (o.session === 'not-requested') line = `${handle}${p} 만들었어요. 이 대화에는 추가하지 않았어요.`;
        else if ('capped' in o.session) {
          line = `${handle}${p} 만들었지만 이 대화의 참가자 상한(${o.session.capped}명)이라 추가하지 못했어요.`;
        } else line = `${handle}${p} 만들었지만 이 대화에 추가하지 못했어요: ${o.session.failed}.`;
      } else {
        const what = (o.changed ?? []).map((f) => FIELD_LABEL_KO[f]).join(', ');
        line = `${handle}의 ${what || '내용'}${what ? objectParticle(what) : '을'} 고쳤어요.`;
        if (o.session === 'added') line += ' 이 대화에도 추가했어요.';
        else if (typeof o.session === 'object' && 'capped' in o.session) {
          line += ` 이 대화의 참가자 상한(${o.session.capped}명)이라 추가하지는 못했어요.`;
        }
      }
      if (o.edited.length > 0) {
        line += ` 사용자가 ${o.edited.map((f) => FIELD_LABEL_KO[f]).join(', ')}${objectParticle(
          FIELD_LABEL_KO[o.edited[o.edited.length - 1]!],
        )} 고쳐서 승인했어요 — 핸들은 ${handle}예요.`;
      }
      return line;
    }
  }
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export type DraftStore = Pick<
  Store,
  | 'getAgent'
  | 'getAgentByName'
  | 'listAgents'
  | 'putAgent'
  | 'listSessionParticipants'
  | 'putSessionParticipant'
  | 'getSetting'
>;

export type ParticipantDraftToolDeps = {
  store: DraftStore;
  sessionId: string;
  /** The turn's stream (`ctx.emit`). */
  emit: (event: Record<string, unknown>) => void;
  /** The turn's abort signal — a stopped turn declines the draft. */
  signal: AbortSignal;
  /** How long the card waits before the draft is declined (the tool TTL). */
  ttlMs: number;
  now?: () => number;
  /** The activity log (`logActivity`). */
  log?: (kind: 'approval_requested' | 'approval_resolved' | 'participant_draft', payload: Record<string, unknown>) => void;
  /** naby's agent id, for the activity log. */
  hubAgentId?: string;
  /** Telegram (R8.3): asked when naby's escalation says so. Read per call. */
  escalate?: {
    enabled: () => boolean;
    send: (input: { approvalId: string; toolName: string; input: unknown }) => void;
    finish: (input: { approvalId: string; decision: 'allow' | 'deny'; reason?: string }) => void;
  };
};

type Answer =
  | { kind: 'allow'; extras?: ApprovalExtras }
  | { kind: 'deny' | 'timeout' | 'abort'; reason: string };

/** Build `naby_participant_draft` for one turn. */
export function makeParticipantDraftTool(deps: ParticipantDraftToolDeps): { schema: ToolSchema; executor: Executor } {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});

  /** Raise the card and wait — the tool-approval mechanics, verbatim: one
   *  registry entry, a TTL, the turn's abort, Telegram when asked. */
  const ask = (approvalId: string, toolName: string, input: ParticipantDraftRequest): Promise<Answer> =>
    new Promise<Answer>((resolve) => {
      let settled = false;
      const escalates = deps.escalate?.enabled() ?? false;
      const settle = (a: Answer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        deps.signal.removeEventListener('abort', onAbort);
        unregisterApproval(approvalId);
        if (escalates) {
          deps.escalate!.finish({
            approvalId,
            decision: a.kind === 'allow' ? 'allow' : 'deny',
            ...(a.kind !== 'allow' ? { reason: a.reason } : {}),
          });
        }
        resolve(a);
      };
      const onAbort = () => settle({ kind: 'abort', reason: 'turn was stopped before approval' });
      const timer = setTimeout(() => settle({ kind: 'timeout', reason: 'approval request timed out' }), deps.ttlMs);
      if (deps.signal.aborted) return onAbort();
      deps.signal.addEventListener('abort', onAbort);
      registerApproval(
        approvalId,
        (d: GateDecision, extras?: ApprovalExtras) =>
          settle(
            d.behavior === 'allow'
              ? { kind: 'allow', ...(extras ? { extras } : {}) }
              : { kind: 'deny', reason: d.reason },
          ),
        now(),
        { toolName },
      );
      log('approval_requested', {
        sessionId: deps.sessionId,
        ...(deps.hubAgentId ? { agentId: deps.hubAgentId } : {}),
        approvalId,
        toolName,
        input,
        escalatedToTelegram: escalates,
        askedBy: PARTICIPANT_DRAFT_SOURCE,
      });
      deps.emit({
        type: 'approval_request',
        approvalId,
        tool_name: toolName,
        input,
        session_id: deps.sessionId,
        source: PARTICIPANT_DRAFT_SOURCE,
      });
      if (escalates) deps.escalate!.send({ approvalId, toolName, input });
    });

  const executor: Executor = async (raw, ctx): Promise<ToolOutput> => {
    const parsed = parseDraftToolInput(raw);
    const first = parsed.ok ? composeDraft(deps.store, parsed.input) : parsed;
    if (!first.ok) {
      log('participant_draft', {
        sessionId: deps.sessionId,
        action: parsed.ok ? parsed.input.action : 'unknown',
        decision: 'invalid',
        reason: first.error,
      });
      return {
        content: `Draft rejected, nothing was shown to the user: ${first.error}. Fix the draft and call ${PARTICIPANT_DRAFT_TOOL} again.`,
        isError: true,
      };
    }
    const { draft, before, changed } = first.composed;
    const toolName = draft.action === 'create' ? PARTICIPANT_CREATE_TOOL : PARTICIPANT_UPDATE_TOOL;
    const approvalId = `${deps.sessionId}:${toolName}:${ctx.toolCall.toolCallId}`;
    const request: ParticipantDraftRequest = {
      draft,
      ...(before ? { before, changed } : {}),
      addToSession: draft.addToSession,
    };
    const answer = await ask(approvalId, toolName, request);

    const resolved = (decision: 'allow' | 'deny', extra: Record<string, unknown> = {}) => {
      log('approval_resolved', {
        sessionId: deps.sessionId,
        ...(deps.hubAgentId ? { agentId: deps.hubAgentId } : {}),
        approvalId,
        toolName,
        decision,
        outcome: answer.kind,
      });
      // AFTER the write, so a roster that refreshes on this event reads the new
      // participant (the card itself is already gone, optimistically).
      deps.emit({
        type: 'approval_resolved',
        approvalId,
        decision,
        tool_name: toolName,
        source: PARTICIPANT_DRAFT_SOURCE,
        session_id: deps.sessionId,
        ...extra,
      });
    };

    if (answer.kind !== 'allow') {
      log('participant_draft', { sessionId: deps.sessionId, action: draft.action, decision: answer.kind, ...(draft.id ? { agentId: draft.id } : {}) });
      resolved('deny');
      return { content: draftResultText({ kind: answer.kind }), data: { decision: answer.kind } };
    }

    // The user's corrections, merged and validated AGAIN against the store as it
    // is now (R8.3) — a name that was free when the card opened may not be.
    const edits = answer.extras?.edits;
    const addToSession = answer.extras?.addToSession ?? draft.addToSession;
    const second = composeDraft(deps.store, { ...draftInputWithEdits(draft, edits), addToSession });
    const saved = second.ok ? putParticipant(deps.store, second.composed.putBody) : second;
    if (!saved.ok || !second.ok) {
      const error = saved.ok ? 'invalid draft' : saved.error;
      log('participant_draft', {
        sessionId: deps.sessionId,
        action: draft.action,
        decision: 'allow',
        error,
        ...(draft.id ? { agentId: draft.id } : {}),
      });
      resolved('allow', { error });
      return { content: draftResultText({ kind: 'save-failed', error }), isError: true, data: { decision: 'allow', error } };
    }
    const agent = saved.participant;
    let session: Extract<DraftOutcome, { kind: 'saved' }>['session'] = 'not-requested';
    if (addToSession) {
      const added = addParticipantToSession(deps.store, deps.sessionId, agent.id, 'naby');
      session = added.ok
        ? added.already
          ? 'already'
          : 'added'
        : added.cap !== undefined
          ? { capped: added.cap }
          : { failed: added.error };
    }
    const edited = changedDraftFields(draft, second.composed.draft);
    const finalChanged = second.composed.changed;
    log('participant_draft', {
      sessionId: deps.sessionId,
      action: draft.action,
      decision: 'allow',
      agentId: agent.id,
      agentName: agent.name,
      addedToSession: session === 'added' || session === 'already',
      ...(edited.length ? { edited } : {}),
    });
    resolved('allow', { agentId: agent.id, addedToSession: session === 'added' || session === 'already' });
    return {
      content: draftResultText({
        kind: 'saved',
        action: draft.action,
        name: agent.name,
        ...(finalChanged ? { changed: finalChanged } : {}),
        edited,
        session,
      }),
      data: { decision: 'allow', agentId: agent.id, name: agent.name, session },
    };
  };

  return { schema: PARTICIPANT_DRAFT_SCHEMA, executor };
}
