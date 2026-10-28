/**
 * CONVERSATION PARTICIPANTS ON THE CLIENT (multi-agent-chat §8.5, MAC-M3).
 *
 * The pure half of the participant UI: what a participant looks like on screen,
 * which routing rows are drawn, which bubbles get the "relayed by naby" chip,
 * how the header roster collapses, and how the `@` palette orders its agent rows.
 * Kept free of React so every rule here is testable without a DOM — the React
 * components (ParticipantRoster, RoutingChip, MessageBubble's speaker card, the
 * palette) only read the answers.
 *
 * WHERE THE DATA COMES FROM. The registry is `participant.list`, a session's
 * roster `session.participants.list`, the view preference `participants.get`
 * (all `/api/naby`, MAC-M1). A LIVE bubble already carries the speaker's display
 * fields (`system/speaker`); a RELOADED one carries only id + handle, so the
 * bubble resolves the rest against the registry here (`resolveSpeaker`).
 */

import type { ChatMessage, ChatRouting, ChatSpeaker } from './types';

export type ParticipantAvatar = { kind: 'emoji'; value: string } | { kind: 'image'; dataUrl: string };

/** One participant as the chat UI draws it. */
export interface ParticipantInfo {
  id: string;
  /** The `@` handle. */
  name: string;
  displayName: string;
  description: string;
  avatar: ParticipantAvatar;
  /** Hex identifying colour. */
  color: string;
  /** `participant.list` only: sessions that hold it actively. */
  activeSessions?: number;
  /** Where an imported participant came from (MAC-M4) — the card's origin badge. */
  origin?: { format: string; importedAt: number; sourceHash: string; sourceName?: string };
}

/** naby as the roster reports it (`session.participants.list` → `naby`). */
export interface HubInfo {
  id: string;
  name: string;
}

/** The view settings the chat needs from `participants.get`. */
export interface ParticipantChatSettings {
  showRouting: boolean;
  maxPerSession: number;
}

export const DEFAULT_PARTICIPANT_CHAT_SETTINGS: ParticipantChatSettings = {
  showRouting: false,
  maxPerSession: 5,
};

/** The fallback look of a participant whose profile is missing or unreadable. */
export const FALLBACK_AVATAR: ParticipantAvatar = { kind: 'emoji', value: '🤖' };
export const FALLBACK_COLOR = '#8B8FA3';

/** The handles that name naby in a routing row (a hub hand-off on reload). */
const HUB_NAMES = new Set(['naby', '나비']);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function avatarOf(raw: unknown): ParticipantAvatar | undefined {
  if (!isObj(raw)) return undefined;
  if (raw.kind === 'emoji' && typeof raw.value === 'string' && raw.value.trim()) {
    return { kind: 'emoji', value: raw.value };
  }
  if (raw.kind === 'image' && typeof raw.dataUrl === 'string' && raw.dataUrl.startsWith('data:image/')) {
    return { kind: 'image', dataUrl: raw.dataUrl };
  }
  return undefined;
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * Read one row of `participant.list` / `session.participants.list` (an Agent row
 * plus its profile) into what the UI draws, or `null` when it is not a usable
 * row. Defensive: it crosses a wire.
 */
export function participantInfoFrom(row: unknown): ParticipantInfo | null {
  if (!isObj(row)) return null;
  if (typeof row.id !== 'string' || !row.id || typeof row.name !== 'string' || !row.name) return null;
  const profile = isObj(row.profile) ? row.profile : {};
  const displayName =
    typeof profile.displayName === 'string' && profile.displayName.trim() ? profile.displayName.trim() : row.name;
  const color = typeof profile.color === 'string' && HEX.test(profile.color.trim()) ? profile.color.trim() : FALLBACK_COLOR;
  return {
    id: row.id,
    name: row.name,
    displayName,
    description: typeof row.description === 'string' ? row.description : '',
    avatar: avatarOf(profile.avatar) ?? FALLBACK_AVATAR,
    color,
    ...(typeof row.activeSessions === 'number' ? { activeSessions: row.activeSessions } : {}),
    ...(originOf(profile.origin) ? { origin: originOf(profile.origin)! } : {}),
  };
}

function originOf(raw: unknown): ParticipantInfo['origin'] | undefined {
  if (!isObj(raw)) return undefined;
  if (typeof raw.format !== 'string' || typeof raw.importedAt !== 'number' || typeof raw.sourceHash !== 'string') return undefined;
  return {
    format: raw.format,
    importedAt: raw.importedAt,
    sourceHash: raw.sourceHash,
    ...(typeof raw.sourceName === 'string' ? { sourceName: raw.sourceName } : {}),
  };
}

/** Read a list, dropping unusable rows. */
export function participantInfosFrom(rows: unknown): ParticipantInfo[] {
  if (!Array.isArray(rows)) return [];
  const out: ParticipantInfo[] = [];
  for (const r of rows) {
    const p = participantInfoFrom(r);
    if (p) out.push(p);
  }
  return out;
}

/** `participants.get` → the chat's view settings, defaults for anything missing. */
export function chatSettingsFrom(raw: unknown): ParticipantChatSettings {
  const d = DEFAULT_PARTICIPANT_CHAT_SETTINGS;
  if (!isObj(raw)) return d;
  const int = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : fb);
  return {
    showRouting: raw.showRouting === true,
    maxPerSession: int(raw.maxPerSession, d.maxPerSession),
  };
}

/** What a participant bubble draws: the live speaker fields first, the registry
 *  for whatever a reloaded row lacks, and a neutral fallback for a participant
 *  that has since been deleted (an old transcript must still read sensibly). */
export interface ResolvedSpeaker {
  agentId: string;
  name: string;
  displayName: string;
  avatar: ParticipantAvatar;
  color: string;
}

export function resolveSpeaker(
  speaker: ChatSpeaker,
  lookup: (id: string, name: string) => ParticipantInfo | undefined,
): ResolvedSpeaker {
  const known = lookup(speaker.agentId, speaker.name);
  return {
    agentId: speaker.agentId,
    name: speaker.name,
    displayName: speaker.displayName ?? known?.displayName ?? speaker.name,
    avatar: speaker.avatar ?? known?.avatar ?? FALLBACK_AVATAR,
    color: speaker.color ?? known?.color ?? FALLBACK_COLOR,
  };
}

// ---------------------------------------------------------------------------
// Routing rows
// ---------------------------------------------------------------------------

/** What a routing marker means, as the chip draws it. */
export type RoutingChipKind =
  | 'delegate' // naby handed the turn to a participant (its routing decision, or its own line-start @name — R3.10)
  | 'user-mention' // the user's `@` chose the participant; naby's check was skipped
  | 'to-naby' // naby taking the turn back (a stored hub hand-off on reload)
  | 'return' // a participant asked naby (`@naby`)
  | 'propose' // naby proposed adding a participant
  | 'ignored-mention' // a participant addressed another participant: no effect
  | 'cap' // a round limit was reached
  | 'not-in-session' // the user named a registered participant outside the session
  | 'end';

export function routingChipKind(routing: ChatRouting, hub?: HubInfo | null): RoutingChipKind {
  if (routing.decision === 'not-in-session') return 'not-in-session';
  // A limit, a loop stop or the backstop (§8.15 R11.4) — one system line.
  if (routing.decision === 'cap' || routing.decision === 'loop' || routing.decision === 'backstop' || routing.blocked) {
    return 'cap';
  }
  if (routing.decision === 'ignored-mention') return 'ignored-mention';
  if (routing.kind === 'return') return 'return';
  if (routing.kind === 'propose') return 'propose';
  if (routing.kind === 'delegate') {
    const toHub =
      (hub && routing.targetAgentId === hub.id) ||
      (!!routing.targetName && HUB_NAMES.has(routing.targetName.toLowerCase()));
    if (toHub) return 'to-naby';
    if (routing.decision === 'user-mention' || routing.reason === 'user-mention') return 'user-mention';
    return 'delegate';
  }
  return 'end';
}

/**
 * Is this routing row drawn? (R6.4) naby's check-and-delegate steps are HIDDEN
 * by default — the user sees the participant simply answer — and the "show
 * routing" toggle unfolds them. Two kinds are not routing internals but things
 * the user must be told, so they stay visible as system lines whatever the
 * toggle says: a name the user called that is not in the conversation, and a
 * round limit that cut the round short.
 */
export function routingChipVisible(kind: RoutingChipKind, showRouting: boolean): boolean {
  if (kind === 'not-in-session' || kind === 'cap') return true;
  return showRouting;
}

/** A routing marker row (a `system` row that carries `routing`). */
export function isRoutingRow(m: ChatMessage): boolean {
  return m.role === 'system' && !!m.routing;
}

/**
 * The participant bubbles that get the "↪ relayed by naby" chip: a bubble whose
 * speaker is the target of the delegate marker just before it (only routing
 * markers and other system rows may sit between). One pass, so the list renders
 * it for free.
 */
export function relayedMessageIds(messages: readonly ChatMessage[]): Set<string> {
  const out = new Set<string>();
  // The delegate targets seen since the last non-system row.
  let pending: ChatRouting[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      if (m.routing && m.routing.kind === 'delegate') pending.push(m.routing);
      continue;
    }
    if (m.role === 'assistant' && m.speaker) {
      const sp = m.speaker;
      if (pending.some((r) => (r.targetAgentId ? r.targetAgentId === sp.agentId : r.targetName === sp.name))) {
        out.add(m.id);
      }
    }
    pending = [];
  }
  return out;
}

// ---------------------------------------------------------------------------
// The round in flight
// ---------------------------------------------------------------------------

/** What the "speaking now · next: @b" strip says while a round runs (R6.5). */
export interface RoundProgress {
  /** The speech number of the current speaker within the round, 1-based. */
  speech: number;
  /** The latest hand-off target that has not started speaking yet. */
  next?: { agentId?: string; name: string };
}

/**
 * Derive the round's progress from the live transcript, or `null` when the turn
 * in flight is not a multi-speaker round (no routing marker, no participant
 * bubble since the last user message) — an ordinary turn shows no strip.
 */
export function roundProgress(messages: readonly ChatMessage[]): RoundProgress | null {
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      start = i + 1;
      break;
    }
  }
  const turn = messages.slice(start);
  const isRound = turn.some((m) => isRoutingRow(m) || (m.role === 'assistant' && !!m.speaker));
  if (!isRound) return null;
  const speeches = turn.filter((m) => m.role === 'assistant').length;
  let next: RoundProgress['next'];
  // The last delegate marker AFTER the last assistant bubble that holds speech —
  // a hand-off announced whose target has not taken the turn yet. A live bubble
  // already labelled with that target (the `speaker` event follows the hand-off
  // at once) means it is speaking now, not next.
  const started = new Set<string>();
  for (let i = turn.length - 1; i >= 0; i--) {
    const m = turn[i]!;
    if (m.role === 'assistant') {
      if (m.content.trim() || (m.toolCalls?.length ?? 0) > 0) break;
      if (m.speaker) started.add(m.speaker.agentId);
      continue;
    }
    if (m.routing?.kind === 'delegate' && m.routing.decision !== 'not-in-session') {
      const name = m.routing.targetName ?? m.routing.targetAgentId;
      const id = m.routing.targetAgentId;
      if (name && !(id && started.has(id))) next = { ...(id ? { agentId: id } : {}), name };
      break;
    }
  }
  return { speech: Math.max(1, speeches), ...(next ? { next } : {}) };
}

// ---------------------------------------------------------------------------
// The header roster
// ---------------------------------------------------------------------------

/** How many participants the roster shows before folding idle ones into "+N". */
export const ROSTER_VISIBLE_MAX = 4;

/**
 * Which participants the roster shows in full, and which fold into "+N" (R6.2:
 * "말이 없는 참가자는 접기(4명 초과)"). The speaking participant is never folded;
 * the rest keep their join order.
 */
export function rosterLayout<T extends { id: string }>(
  participants: readonly T[],
  speakingId: string | null | undefined,
  max: number = ROSTER_VISIBLE_MAX,
): { shown: T[]; folded: T[] } {
  if (participants.length <= max) return { shown: [...participants], folded: [] };
  const speaking = participants.find((p) => p.id === speakingId);
  const budget = max - (speaking ? 1 : 0);
  const keep = new Set(
    participants
      .filter((p) => p !== speaking)
      .slice(0, budget)
      .map((p) => p.id),
  );
  if (speaking) keep.add(speaking.id);
  return {
    shown: participants.filter((p) => keep.has(p.id)),
    folded: participants.filter((p) => !keep.has(p.id)),
  };
}

/** The registered participants the `+` menu offers: everyone not already here. */
export function addableParticipants(
  registered: readonly ParticipantInfo[],
  inSession: readonly ParticipantInfo[],
): ParticipantInfo[] {
  const here = new Set(inSession.map((p) => p.id));
  return registered.filter((p) => !here.has(p.id));
}

// ---------------------------------------------------------------------------
// The `@` palette
// ---------------------------------------------------------------------------

/** The palette row fields this reads (`commands.ts` `loadAgentEntries`). */
export type MentionAgentRow = {
  name: string;
  agent?: { participant?: boolean; inSession?: boolean } | undefined;
};

export type MentionGroup = 'session' | 'agents' | 'outside';

/** Which group a `@` agent row belongs in, given the session's participant handles. */
export function mentionGroupOf(row: MentionAgentRow, inSessionNames: ReadonlySet<string>): MentionGroup {
  if (!row.agent?.participant) return 'agents';
  return inSessionNames.has(row.name.replace(/^@/, '').toLowerCase()) ? 'session' : 'outside';
}

/**
 * Order the `@` agent rows (R6.3): this conversation's participants first, then
 * naby and custom agents exactly as before, then registered participants that
 * are not in this conversation (drawn greyed, "add as a participant").
 * Stable within each group.
 */
export function orderMentionAgents<T extends MentionAgentRow>(
  rows: readonly T[],
  inSessionNames: ReadonlySet<string>,
): T[] {
  const by: Record<MentionGroup, T[]> = { session: [], agents: [], outside: [] };
  for (const r of rows) by[mentionGroupOf(r, inSessionNames)].push(r);
  return [...by.session, ...by.agents, ...by.outside];
}

/** Lower-cased handle set for `orderMentionAgents`. */
export function handleSet(participants: readonly { name: string }[]): Set<string> {
  return new Set(participants.map((p) => p.name.toLowerCase()));
}

// ---------------------------------------------------------------------------
// naby's proposal to add a participant (R3.9, R6.7)
// ---------------------------------------------------------------------------

/** An `approval_request` with `source:'participant_proposal'`, as the card draws it. */
export interface ParticipantProposal {
  agentId: string;
  name: string;
  displayName: string;
  avatar: ParticipantAvatar;
  color: string;
  description: string;
  reason: string;
}

/**
 * Read a proposal off a raw `approval_request` detail, or `null` when it is not
 * one (any other approval keeps the tool card). The colour is not on the wire;
 * `lookup` fills it from the registry when it can.
 */
export function proposalFromApproval(
  d: Record<string, unknown>,
  lookup?: (id: string, name?: string) => ParticipantInfo | undefined,
): ParticipantProposal | null {
  if (d.source !== 'participant_proposal') return null;
  const input = isObj(d.input) ? d.input : {};
  const agentId = typeof input.agentId === 'string' ? input.agentId : '';
  const name = typeof input.name === 'string' ? input.name : '';
  if (!agentId || !name) return null;
  const known = lookup?.(agentId, name);
  const reason =
    typeof input.reason === 'string' && input.reason.trim()
      ? input.reason
      : typeof d.reason === 'string'
        ? d.reason
        : '';
  return {
    agentId,
    name,
    displayName:
      typeof input.displayName === 'string' && input.displayName.trim() ? input.displayName : (known?.displayName ?? name),
    avatar: avatarOf(input.avatar) ?? known?.avatar ?? FALLBACK_AVATAR,
    color: known?.color ?? FALLBACK_COLOR,
    description:
      typeof input.description === 'string' && input.description.trim() ? input.description : (known?.description ?? ''),
    reason,
  };
}

/** The agent behind a participant's tool call (§8.9: "the card names the speaker"). */
export function approvalSpeakerName(d: Record<string, unknown>): string | undefined {
  const sp = d.speaker;
  if (!isObj(sp)) return undefined;
  if (typeof sp.displayName === 'string' && sp.displayName.trim()) return sp.displayName;
  return typeof sp.name === 'string' && sp.name.trim() ? sp.name : undefined;
}

/**
 * What picking a `@` agent row does (R3.2, R6.3). A registered participant that
 * is not in this conversation is ADDED first and its mention written after; with
 * no session yet there is nothing to add it to, so the mention is just written
 * (the round then says "not in this conversation", with its own add button).
 * Every other row only inserts its mention.
 */
export type MentionPick = { kind: 'insert' } | { kind: 'add-then-insert'; agentId: string };

export function mentionPickPlan(
  row: MentionAgentRow,
  inSessionNames: ReadonlySet<string>,
  registered: readonly { id: string; name: string }[],
  sessionId: string | null,
): MentionPick {
  if (!row.agent?.participant || mentionGroupOf(row, inSessionNames) !== 'outside' || !sessionId) {
    return { kind: 'insert' };
  }
  const handle = row.name.replace(/^@/, '').toLowerCase();
  const p = registered.find((r) => r.name.toLowerCase() === handle);
  return p ? { kind: 'add-then-insert', agentId: p.id } : { kind: 'insert' };
}
