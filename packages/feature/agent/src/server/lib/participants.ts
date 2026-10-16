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
  BUILTIN_PERSONA_NAME,
  HUB_MENTION_ALIASES,
  type Agent,
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
/** Agent speeches per user message, naby included (R3.5a). */
export const PARTICIPANTS_MAX_SPEECHES_KEY = 'participants.maxSpeechesPerRound';
/** naby ↔ one participant hand-offs per user message (R3.5b). */
export const PARTICIPANTS_MAX_ROUND_TRIPS_KEY = 'participants.maxRoundTrips';
/** Whether the chat draws routing chips (R6.4). A view preference, saved from the
 *  client toggle. */
export const PARTICIPANTS_SHOW_ROUTING_KEY = 'participants.showRouting';

export const PARTICIPANT_SETTINGS_DEFAULTS = {
  proposalsEnabled: true,
  maxPerSession: 5,
  maxSpeechesPerRound: 6,
  maxRoundTrips: 3,
  showRouting: false,
} as const;

/** Every integer setting is clamped into this range — on the write AND the read,
 *  so the stored value is always the value the round loop will honour. */
export const PARTICIPANT_SETTING_MIN = 1;
export const PARTICIPANT_SETTING_MAX = 20;

export type ParticipantSettings = {
  proposalsEnabled: boolean;
  maxPerSession: number;
  maxSpeechesPerRound: number;
  maxRoundTrips: number;
  showRouting: boolean;
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
      maxSpeechesPerRound: readInt(store.getSetting(PARTICIPANTS_MAX_SPEECHES_KEY), d.maxSpeechesPerRound),
      maxRoundTrips: readInt(store.getSetting(PARTICIPANTS_MAX_ROUND_TRIPS_KEY), d.maxRoundTrips),
      showRouting: readBool(store.getSetting(PARTICIPANTS_SHOW_ROUTING_KEY), d.showRouting),
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
  const ints: [keyof ParticipantSettings, string, number][] = [
    ['maxPerSession', PARTICIPANTS_MAX_PER_SESSION_KEY, d.maxPerSession],
    ['maxSpeechesPerRound', PARTICIPANTS_MAX_SPEECHES_KEY, d.maxSpeechesPerRound],
    ['maxRoundTrips', PARTICIPANTS_MAX_ROUND_TRIPS_KEY, d.maxRoundTrips],
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
  for (const field of ['proposalsEnabled', 'showRouting'] as const) {
    const v = body[field];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') return { ok: false, error: `${field} must be a boolean` };
    input[field] = v;
  }
  for (const field of ['maxPerSession', 'maxSpeechesPerRound', 'maxRoundTrips'] as const) {
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
    .map((a) => ({ ...a, activeSessions: counts.get(a.id) ?? 0 }));
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
