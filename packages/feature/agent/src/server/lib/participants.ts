// packages/feature/agent/src/server/lib/participants.ts
//
// CONVERSATION PARTICIPANTS — the shell half of MAC-M1 (specs/multi-agent-chat.md
// §8.1, §8.4).
//
// The runtime owns the types and every trust rule (`participants.ts`: the profile
// gate, the mention parser, the routing contract). This module owns what the HTTP
// actions need around them and nothing else:
//
//   * the five `participants.*` settings keys, their defaults and their clamp —
//     the same shape `personaAutonomy` gives the persona's delegation settings;
//   * the participant NAME rule (the `@` handle), shared by create, edit and
//     duplicate so the three can never disagree;
//   * the `-copy` naming for duplicates;
//   * the views the actions answer with (a participant with its active-session
//     count; a session roster row joined with its agent).
//
// Pure apart from the narrow store slices it is handed, so every rule here is a
// unit test away from proof.

import {
  BUILTIN_PERSONA_ID,
  BUILTIN_PERSONA_NAME,
  HUB_MENTION_ALIASES,
  defaultParticipantProfile,
  parseParticipantProfile,
  participantPermissionOf,
  withApprovedTool,
  type Agent,
  type AgentInput,
  type MemoryScope,
  type ParticipantPermission,
  type SessionParticipant,
  type SessionParticipantAddedBy,
  type SessionParticipantStatus,
  type Store,
} from '../../../../../../../dist/naby-runtime.mjs';

// ---------------------------------------------------------------------------
// Settings (§8.4)
// ---------------------------------------------------------------------------

/** naby may propose adding a registered participant that is not in the session
 *  (R3.9, D13). */
export const PARTICIPANTS_PROPOSALS_KEY = 'participants.proposals.enabled';
/** Participants one session may hold (R2.4). naby is not counted. */
export const PARTICIPANTS_MAX_PER_SESSION_KEY = 'participants.maxPerSession';
// `participants.maxSpeechesPerRound` and `participants.maxRoundTrips` are gone
// (0.7.0, §8.15 R11.1): a round is bounded by loop detection and the backstop,
// not by fixed limits. Rows already stored are left alone and never read.
/** Whether the chat draws routing chips (R6.4). A view preference, saved from the
 *  client toggle. */
export const PARTICIPANTS_SHOW_ROUTING_KEY = 'participants.showRouting';
/** naby may recommend a participant for a session from its background read of
 *  the conversation (§8.13, R9.6). Off = the sweep never runs a model call. */
export const PARTICIPANTS_RECOMMENDATIONS_KEY = 'participants.recommendations.enabled';

export const PARTICIPANT_SETTINGS_DEFAULTS = {
  proposalsEnabled: true,
  maxPerSession: 5,
  showRouting: false,
  recommendationsEnabled: true,
} as const;

/** Every integer setting is clamped into this range — on the write AND the read,
 *  so the stored value is always the value the round loop will honour. */
export const PARTICIPANT_SETTING_MIN = 1;
export const PARTICIPANT_SETTING_MAX = 20;

export type ParticipantSettings = {
  proposalsEnabled: boolean;
  maxPerSession: number;
  showRouting: boolean;
  recommendationsEnabled: boolean;
};

export type ParticipantSettingsStore = {
  getSetting(key: string): string | undefined;
};
export type ParticipantSettingsWriteStore = ParticipantSettingsStore & {
  setSetting(key: string, value: string): void;
};

/** Clamp a number into 1..20 (rounded). Non-finite → the fallback. */
export function clampParticipantInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(PARTICIPANT_SETTING_MAX, Math.max(PARTICIPANT_SETTING_MIN, Math.round(value)));
}

function readInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  return clampParticipantInt(Number(raw), fallback);
}

function readBool(raw: string | undefined, fallback: boolean): boolean {
  return raw === 'true' ? true : raw === 'false' ? false : fallback;
}

/** The settings as they stand. Always complete; a garbage or missing row reads as
 *  its default, and a store failure yields all defaults — a settings row must
 *  never be able to break a turn. */
export function readParticipantSettings(store: ParticipantSettingsStore): ParticipantSettings {
  const d = PARTICIPANT_SETTINGS_DEFAULTS;
  try {
    return {
      proposalsEnabled: readBool(store.getSetting(PARTICIPANTS_PROPOSALS_KEY), d.proposalsEnabled),
      maxPerSession: readInt(store.getSetting(PARTICIPANTS_MAX_PER_SESSION_KEY), d.maxPerSession),
      showRouting: readBool(store.getSetting(PARTICIPANTS_SHOW_ROUTING_KEY), d.showRouting),
      recommendationsEnabled: readBool(
        store.getSetting(PARTICIPANTS_RECOMMENDATIONS_KEY),
        d.recommendationsEnabled,
      ),
    };
  } catch {
    return { ...d };
  }
}

/** Write only the supplied fields (a save from one control never resets another),
 *  integers clamped BEFORE they are stored. Returns the settings as now stored. */
export function writeParticipantSettings(
  store: ParticipantSettingsWriteStore,
  input: Partial<ParticipantSettings>,
): ParticipantSettings {
  const d = PARTICIPANT_SETTINGS_DEFAULTS;
  if (input.proposalsEnabled !== undefined) {
    store.setSetting(PARTICIPANTS_PROPOSALS_KEY, input.proposalsEnabled ? 'true' : 'false');
  }
  if (input.showRouting !== undefined) {
    store.setSetting(PARTICIPANTS_SHOW_ROUTING_KEY, input.showRouting ? 'true' : 'false');
  }
  if (input.recommendationsEnabled !== undefined) {
    store.setSetting(PARTICIPANTS_RECOMMENDATIONS_KEY, input.recommendationsEnabled ? 'true' : 'false');
  }
  const ints: [keyof ParticipantSettings, string, number][] = [
    ['maxPerSession', PARTICIPANTS_MAX_PER_SESSION_KEY, d.maxPerSession],
  ];
  for (const [field, key, fallback] of ints) {
    const v = input[field];
    if (typeof v === 'number') store.setSetting(key, String(clampParticipantInt(v, fallback)));
  }
  return readParticipantSettings(store);
}

/** Validate a `participants.set` body. Returns the partial to write, or an error
 *  sentence. A present field must be usable — a UI bug surfaces as an error, not
 *  as a setting that quietly became something else. */
export function parseParticipantSettingsInput(
  body: Record<string, unknown>,
): { ok: true; input: Partial<ParticipantSettings> } | { ok: false; error: string } {
  const input: Partial<ParticipantSettings> = {};
  for (const field of ['proposalsEnabled', 'showRouting', 'recommendationsEnabled'] as const) {
    const v = body[field];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') return { ok: false, error: `${field} must be a boolean` };
    input[field] = v;
  }
  for (const field of ['maxPerSession'] as const) {
    const v = body[field];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, error: `${field} must be a number` };
    input[field] = v;
  }
  return { ok: true, input };
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * Normalise and check a participant's `@` handle. The `agent.put` rules — present,
 * no whitespace, not held by ANOTHER agent (the persona included) — plus two that
 * keep the handle addressable by `parseMentions`: no `@` inside it, and no
 * leading `/`, `.` or `~` (those read as a file reference and are skipped). One
 * leading `@` is forgiven and stripped.
 *
 * Names are compared IGNORING CASE, because `@Name` and `@name` address the same
 * agent: a participant called `Reviewer` next to a custom `reviewer` would be a
 * second answer to one handle. And the hub's handles are RESERVED in any case —
 * the persona's name (`BUILTIN_PERSONA_NAME` and its current name if renamed) and
 * every `HUB_MENTION_ALIASES` spelling (`naby`, `나비`) — so no participant can be
 * addressed as, or speak as, naby (R3.4).
 */
export function validateParticipantName(
  raw: unknown,
  store: Pick<Store, 'getAgentByName' | 'listAgents'>,
  selfId?: string,
): { ok: true; name: string } | { ok: false; error: string } {
  const name = typeof raw === 'string' ? raw.trim().replace(/^@/, '') : '';
  if (!name) return { ok: false, error: 'name is required' };
  if (/\s/.test(name)) return { ok: false, error: 'name cannot contain spaces' };
  if (name.includes('@')) return { ok: false, error: "name cannot contain '@'" };
  if (/^[/.~]/.test(name)) return { ok: false, error: "name cannot start with '/', '.' or '~'" };
  const folded = name.toLowerCase();
  const agents = store.listAgents();
  const reserved = new Set(
    [BUILTIN_PERSONA_NAME, ...HUB_MENTION_ALIASES, ...agents.filter((a) => a.kind === 'persona').map((a) => a.name)].map(
      (n) => n.toLowerCase(),
    ),
  );
  if (reserved.has(folded)) return { ok: false, error: `'${name}' is the built-in agent's name` };
  const holder =
    store.getAgentByName(name) ??
    agents.find((a) => a.id !== selfId && a.name.toLowerCase() === folded);
  if (holder && holder.id !== selfId) {
    return {
      ok: false,
      error:
        holder.kind === 'persona'
          ? `'${name}' is the built-in agent's name`
          : `agent name '${name}' is already in use`,
    };
  }
  return { ok: true, name };
}

/** `<name>-copy`, then `<name>-copy-2`, `-copy-3`… — the first one nobody holds.
 *  A source that is itself a copy is not copied as `x-copy-copy`. */
export function uniqueCopyName(base: string, taken: (name: string) => boolean): string {
  const root = base.replace(/-copy(?:-\d+)?$/, '');
  const first = `${root}-copy`;
  if (!taken(first)) return first;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${root}-copy-${n}`;
    if (!taken(candidate)) return candidate;
  }
  return `${root}-copy-${Date.now()}`;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** A participant as the actions return it: the agent row plus, for
 *  `participant.list`, how many sessions hold it actively, and, for
 *  `session.participants.list`, its standing in that session. */
export type ParticipantView = Agent & {
  activeSessions?: number;
  status?: SessionParticipantStatus;
  addedBy?: SessionParticipantAddedBy;
  /** epoch ms of the session row's last status change. */
  statusUpdatedAt?: number;
  /** The EFFECTIVE permission tier (§8.14) — the stored one, or the legacy
   *  reading of a row saved before tiers existed. Read by the editor and the
   *  roster badge so the client never re-derives it. `participant.list` only. */
  permission?: ParticipantPermission;
};

export function isParticipant(agent: Agent | undefined): agent is Agent {
  return agent?.kind === 'participant';
}

/** Every participant with its active-session count. Counts walk the session list
 *  once; a session without a row contributes nothing. */
export function listParticipantsWithCounts(
  store: Pick<Store, 'listAgents' | 'listSessions' | 'listSessionParticipants'>,
): ParticipantView[] {
  const counts = new Map<string, number>();
  for (const s of store.listSessions()) {
    for (const row of store.listSessionParticipants(s.sessionId)) {
      if (row.status === 'active') counts.set(row.agentId, (counts.get(row.agentId) ?? 0) + 1);
    }
  }
  return store
    .listAgents()
    .filter((a) => a.kind === 'participant')
    .map((a) => ({ ...a, activeSessions: counts.get(a.id) ?? 0, permission: participantPermissionOf(a) }));
}

/** The session's ACTIVE participants, joined with their agent rows, in the order
 *  they joined. A row whose agent is gone (or is no longer a participant) is
 *  skipped rather than shown as a ghost. */
export function sessionRoster(
  store: Pick<Store, 'getAgent' | 'listSessionParticipants'>,
  sessionId: string,
): ParticipantView[] {
  const out: ParticipantView[] = [];
  for (const row of store.listSessionParticipants(sessionId)) {
    if (row.status !== 'active') continue;
    const agent = store.getAgent(row.agentId);
    if (!isParticipant(agent)) continue;
    out.push(viewOfRow(agent, row));
  }
  return out;
}

function viewOfRow(agent: Agent, row: SessionParticipant): ParticipantView {
  return { ...agent, status: row.status, addedBy: row.addedBy, statusUpdatedAt: row.updatedAt };
}

// ---------------------------------------------------------------------------
// Writes shared by the HTTP actions and naby's draft tool (MAC-M5a, §8.12)
// ---------------------------------------------------------------------------

/** The `participant.put` body, as the action and the draft tool hand it over. */
export type ParticipantPutInput = {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  instructions?: unknown;
  model?: unknown;
  toolRefs?: unknown;
  memoryScope?: unknown;
  profile?: unknown;
};

export type ParticipantWriteStore = Pick<Store, 'getAgent' | 'getAgentByName' | 'listAgents' | 'putAgent'>;

/**
 * Create or edit a participant — THE one write path (`participant.put` and the
 * approved draft both land here, so a draft can never be saved under rules the
 * editor does not apply). Validates the name, the instructions and the profile
 * (the runtime gate); never throws.
 */
export function putParticipant(
  store: ParticipantWriteStore,
  body: ParticipantPutInput,
): { ok: true; participant: Agent } | { ok: false; error: string } {
  const targetId = typeof body.id === 'string' && body.id ? body.id : '';
  const existing = targetId ? store.getAgent(targetId) : undefined;
  if (targetId) {
    // Only a participant row is editable here: the persona is read-only and a
    // custom agent has its own editor (`agent.put`), and turning one kind into
    // another would silently change what it may do.
    if (targetId === BUILTIN_PERSONA_ID || existing?.kind === 'persona') {
      return { ok: false, error: 'the built-in persona is read-only and cannot be edited' };
    }
    if (!existing) return { ok: false, error: 'no participant with that id' };
    if (!isParticipant(existing)) {
      return { ok: false, error: 'only a conversation participant can be edited here' };
    }
  }
  const named = validateParticipantName(body.name, store, existing?.id);
  if (!named.ok) return { ok: false, error: named.error };
  const instructions = typeof body.instructions === 'string' ? body.instructions.trim() : '';
  if (!instructions) return { ok: false, error: 'instructions are required' };
  const memoryScope: MemoryScope =
    body.memoryScope === 'session' ||
    body.memoryScope === 'project' ||
    body.memoryScope === 'user' ||
    body.memoryScope === 'org'
      ? body.memoryScope
      : // A NEW participant defaults to `session`, not `user`: an imported
        // profile is untrusted, and what it learns should not reach every
        // other conversation unless the user widens it (§8.1). An edit that
        // omits the field keeps the row's scope.
        (existing?.memoryScope ?? 'session');

  // The profile is UNTRUSTED input: it passes the runtime gate or nothing is
  // written. Omitted on an edit = keep the stored one; omitted on a create =
  // the default profile (an emoji and a colour).
  let profile;
  try {
    profile =
      body.profile !== undefined
        ? parseParticipantProfile(body.profile)
        : (existing?.profile ?? defaultParticipantProfile(named.name));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  // The permission tier (§8.14) follows the same "omitted = keep" rule: a
  // profile sent without one (an older client, an import's re-apply) must not
  // quietly turn a "read only" participant back into its legacy reading.
  if (profile.permission === undefined && existing?.profile?.permission !== undefined) {
    profile = { ...profile, permission: existing.profile.permission };
  }
  // The remembered approvals (R10.7) likewise: a permission sent without an
  // `approvedTools` key keeps the stored list; an explicit list (even []) replaces
  // it — that is how the editor's × revokes one.
  const sentPermission = (body.profile as { permission?: { approvedTools?: unknown } } | undefined)?.permission;
  const storedApproved = existing?.profile?.permission?.approvedTools;
  if (
    profile.permission &&
    storedApproved?.length &&
    (sentPermission === undefined || sentPermission === null || sentPermission.approvedTools === undefined)
  ) {
    profile = { ...profile, permission: { ...profile.permission, approvedTools: storedApproved } };
  }

  // toolRefs: a sent list replaces; an edit that does not mention it keeps the
  // row's; a NEW participant without one gets NO tools ([]), never "inherit the
  // session's toolset" — widening an agent's tools has to be a deliberate
  // request (the same rule `agent.put` keeps, and §8.1's import default).
  const toolRefs = Array.isArray(body.toolRefs)
    ? body.toolRefs.filter((r): r is string => typeof r === 'string')
    : (existing?.toolRefs ?? []);

  const input: AgentInput = {
    ...(existing ? { id: existing.id } : {}),
    name: named.name,
    kind: 'participant',
    ...(typeof body.description === 'string' && body.description.trim()
      ? { description: body.description.trim() }
      : {}),
    systemPrompt: instructions,
    ...(typeof body.model === 'string' && body.model.trim() ? { model: body.model.trim() } : {}),
    toolRefs,
    memoryScope,
    // NOT NULL in the table; a participant has no autonomy and nothing reads
    // this (§8.1).
    autonomy: { escalation: 'inline' },
    profile,
  };
  try {
    return { ok: true, participant: store.putAgent(input) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Remember that the user allowed `toolName` for this participant (R10.7, the
 * 2026-10-19 user decision: once allowed, the same tool is not asked again).
 * Called after an out-of-level approval is ALLOWED — in the app or over Telegram,
 * both land on the same approval. A refusal is never remembered, and nothing is
 * recorded while the participant asks every time (`withApprovedTool`). A legacy
 * row gets its effective permission written down with the tool added. Returns the
 * row as stored (the same one when nothing changed); never throws.
 */
export function recordApprovedTool(
  store: Pick<Store, 'getAgent' | 'putAgent'>,
  agentId: string,
  toolName: string,
): Agent | undefined {
  const agent = store.getAgent(agentId);
  if (!isParticipant(agent) || !agent.profile) return agent;
  const current = participantPermissionOf(agent);
  const next = withApprovedTool(current, toolName);
  if (next === current) return agent;
  try {
    const { id, name, kind, description, systemPrompt, model, toolRefs, memoryScope, autonomy } = agent;
    return store.putAgent({
      id,
      name,
      kind,
      ...(description !== undefined ? { description } : {}),
      systemPrompt,
      ...(model !== undefined ? { model } : {}),
      ...(toolRefs !== undefined ? { toolRefs } : {}),
      memoryScope,
      autonomy,
      profile: { ...agent.profile, permission: next },
    });
  } catch (e) {
    console.warn(`[participants] approved tool not recorded for ${agentId}: ${e instanceof Error ? e.message : String(e)}`);
    return agent;
  }
}

/**
 * Put a participant into a session's roster as `active`, with the per-session cap
 * (R2.4) counted here — the cap is a SETTING, so the store does not know it.
 * Already active = a no-op success. A fresh add wins over an earlier `declined`
 * or `removed` (§8.1).
 */
export function addParticipantToSession(
  store: Pick<Store, 'getAgent' | 'listSessionParticipants' | 'putSessionParticipant' | 'getSetting'>,
  sessionId: string,
  agentId: string,
  addedBy: SessionParticipantAddedBy,
): { ok: true; already: boolean } | { ok: false; error: string; cap?: number } {
  const agent = store.getAgent(agentId);
  if (!isParticipant(agent)) {
    return { ok: false, error: 'only a conversation participant can join a session' };
  }
  const rows = store.listSessionParticipants(sessionId);
  if (rows.some((r) => r.agentId === agent.id && r.status === 'active')) return { ok: true, already: true };
  const { maxPerSession } = readParticipantSettings(store);
  const active = rows.filter((r) => r.status === 'active').length;
  if (active >= maxPerSession) {
    return { ok: false, error: `a session can hold at most ${maxPerSession} participants`, cap: maxPerSession };
  }
  store.putSessionParticipant(sessionId, agent.id, { status: 'active', addedBy });
  return { ok: true, already: false };
}
