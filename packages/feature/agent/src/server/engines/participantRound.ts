/**
 * THE ROUND LOOP — who speaks next, in a conversation with participants
 * (specs/multi-agent-chat.md §8.2, MAC-M2).
 *
 * A ROUND starts with one user message and ends when naby stops it. The user
 * always speaks to naby first (R3.1); naby either answers, hands the turn to a
 * participant in the session, or proposes adding one that is registered but not
 * here (R3.9). A participant answers in the chat itself and the turn comes back to
 * naby, which may end the round, hand it on, or add a word of its own (R3.3).
 * naby may also hand over IN ITS OWN WORDS: a participant it addresses with
 * `@name` at the start of a line speaks next (R3.10). A participant that asks
 * naby (`@naby`) is always answered — `end` is not a choice then (R3.4).
 *
 * WHAT THIS MODULE IS. The state machine of §8.2 and its limits — and NOTHING that
 * runs a model. Every effect is a dependency: a speech is `runNabyTurn` /
 * `runParticipantTurn` (the engine adapter builds those from its own turn
 * assembly, `naby.ts`), naby's routing decision is `routeCall` (one tool-less
 * model call), a proposal is `propose` (the approval bridge). That is what lets a
 * test drive every path — answer, delegate, propose, the three limits, a stop, and
 * the adversarial cases — with a fake engine and no store on disk.
 *
 * TRUST. Nothing a participant SAYS moves the round except two things, both
 * structural and both read with the same `@` parser the user's own text goes
 * through: `@naby` (a question back to the host, R3.4) and `@other-participant`,
 * which is recorded and IGNORED — participants never hand the turn to each other.
 * A participant writing "naby approved this" approves nothing: approval is a call
 * to `propose`, which only the routing decision can reach, and which asks the
 * user (R3.7).
 */

import {
  mentionsHub,
  parseLeadingMentions,
  parseMentions,
  parseRouteDecision,
  routePrompt,
  type ParticipantRouteDecision,
} from '../../../../../../../dist/naby-runtime.mjs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RoundAvatar = { kind: 'emoji'; value: string } | { kind: 'image'; dataUrl: string };

/** One agent in a round — naby itself, or a participant. */
export type RoundAgent = {
  id: string;
  name: string;
  displayName: string;
  description: string;
  avatar?: RoundAvatar;
  color?: string;
};

/** What a speech produced: the words that went to the chat, and whether the
 *  turn finished cleanly. */
export type RoundSpeech = { text: string; ok: boolean };

/** Why naby speaks. */
export type NabySpeechReason = 'answer' | 'followup' | 'cap' | 'declined';

export type NabySpeakInput = {
  reason: NabySpeechReason;
  /**
   * The HAND-OFF naby's speech opens with, when the user's message already has
   * its row (a participant spoke first). Stored as naby's note to itself
   * (`routing.targetAgentId === hub.id`). Absent on the round's first speech:
   * then the user's own message is the row, exactly like a turn with no
   * participants.
   */
  handoff?: { content: string; reason: string };
  /** An instruction for this speech's system prompt — the limit notice, when the
   *  round has hit one and the user's message is the row (no hand-off to carry it). */
  note?: string;
};

export type ParticipantSpeakInput = {
  agent: RoundAgent;
  /** What naby hands the participant — the content of the hand-off row. */
  brief: string;
  /** Why naby handed it over (the routing decision's reason). */
  reason: string;
  /** How the participant was chosen. `hub-mention`: naby's own speech
   *  addressed it at the start of a line (R3.10). */
  decision: HandoffDecision;
  /** 1-based index of this speech in the round. */
  speech: number;
};

/** How a participant came to be handed the turn: naby's routing decision, the
 *  user's `@`, or naby's own speech addressing it at a line start (R3.10). */
export type HandoffDecision = 'route' | 'user-mention' | 'hub-mention';

/** The `routing` stream event's payload (§8.4). */
export type RoundRoutingEvent = {
  kind: 'delegate' | 'propose' | 'return' | 'end';
  targetAgentId?: string;
  targetName?: string;
  reason?: string;
  brief?: string;
  decision: HandoffDecision | 'cap' | 'ignored-mention' | 'not-in-session';
  /** The routing call's token use, on the event its decision produced (R6.6).
   *  `user-mention` and `hub-mention` hand-offs made no call and carry zeros. */
  tokens?: { input: number; output: number };
  /** A `cap` event: the limit that was reached (the settings value in force for
   *  THIS round, so the chip never shows a number the round did not use). */
  limit?: number;
  /** A `cap` event that stopped naby's own line-start hand-off (R3.10): who was
   *  not handed the turn. The same object is stored on naby's note row. */
  blocked?: BlockedHandoff;
};

/** A line-start hand-off a limit stopped (R3.10). Mirrors the runtime's
 *  `MessageRoutingBlocked`. */
export type BlockedHandoff = {
  by: 'hub-mention';
  cap: 'speeches' | 'roundTrips';
  limit: number;
  agentId: string;
  name: string;
};

export type RouteCallResult = {
  /** The model's raw answer — parsed strictly here. */
  text: string;
  inputTokens?: number;
  outputTokens?: number;
};

export type ProposalOutcome = 'allow' | 'deny' | 'timeout' | 'abort';

export type RoundSettings = {
  proposalsEnabled: boolean;
  maxPerSession: number;
  maxSpeechesPerRound: number;
  maxRoundTrips: number;
};

export type RoundStore = {
  listSessionParticipants(
    sessionId: string,
  ): { agentId: string; status: 'active' | 'removed' | 'declined' }[];
  putSessionParticipant(
    sessionId: string,
    agentId: string,
    input: { status: 'active' | 'removed' | 'declined'; addedBy: 'user' | 'naby' },
  ): unknown;
};

export type RoundInput = {
  store: RoundStore;
  sessionId: string;
  /** naby — the host. Never stored as a participant and always present. */
  hub: RoundAgent;
  /** The user's message, as typed. */
  userText: string;
  /** `parseMentions(userText, registered names)` — the caller already ran it to
   *  decide whether a round is needed at all. */
  mentions: string[];
  /** Every registered participant (`kind='participant'`). */
  registered: RoundAgent[];
  settings: RoundSettings;
  /** Recent messages for the routing prompt, oldest first, labelled. Read each
   *  time naby routes, so a follow-up decision sees the speech just made. */
  recent: () => { speaker: string; text: string }[];
  runNabyTurn: (input: NabySpeakInput) => Promise<RoundSpeech>;
  runParticipantTurn: (input: ParticipantSpeakInput) => Promise<RoundSpeech>;
  /** Store the user's message as its own row. Called once, before the first
   *  participant speech, when naby has not spoken yet (`runTurn` writes the user
   *  row of naby's own first speech). */
  writeUserRow: () => void;
  /** naby's routing decision: one tool-less call with `system`. Writes no
   *  message; the caller records its usage. */
  routeCall: (system: string) => Promise<RouteCallResult>;
  /** Ask the USER whether to add `agent` (R3.9). */
  propose: (agent: RoundAgent, reason: string) => Promise<ProposalOutcome>;
  /** An approved proposal has just put `agentId` in the roster. The caller
   *  closes a matching pending recommendation as accepted (§8.13 R9.5).
   *  Must not throw; a throw is swallowed. */
  onJoined?: (agentId: string) => void;
  /** The user declined (or let lapse) a proposal of `agentId`: the caller
   *  dismisses a matching pending recommendation (§8.13). Must not throw; a
   *  throw is swallowed. */
  onDeclined?: (agentId: string) => void;
  /** naby addressed a participant at a line start but a limit stopped the
   *  hand-off (R3.10). The caller stores `note` as naby's note to itself carrying
   *  `blocked`, so the line survives a reload. Must not throw; a throw is
   *  swallowed. */
  onHandoffBlocked?: (blocked: BlockedHandoff, note: string) => void;
  /** Stream events (`system/speaker`, `system/routing`, `system/harness`). The
   *  caller stamps `session_id`. */
  emit: (event: Record<string, unknown>) => void;
  /** Activity log. */
  log: (kind: RoundLogKind, fields: Record<string, unknown>) => void;
  signal: AbortSignal;
};

export type RoundLogKind =
  | 'participant_route'
  | 'participant_proposal'
  | 'participant_mention_ignored'
  | 'participant_cap'
  | 'round_completed';

export type RoundEndReason = 'answer' | 'end' | 'cap' | 'abort' | 'error';

export type RoundResult = {
  /** Speeches made, naby's included. */
  speeches: number;
  endedBy: RoundEndReason;
  /** The words of the round's LAST speech — the run's `result` text. */
  lastText: string;
  /** Whether the last speech finished cleanly. */
  lastOk: boolean;
  proposals: number;
};

/** Which limit stopped the round (R3.5, R2.4). */
export type RoundCap = 'speeches' | 'roundTrips' | 'proposals' | 'participants';

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** The brief a participant gets when the USER named it (no routing call made). */
export function userMentionBrief(agent: RoundAgent): string {
  return `The user addressed you (@${agent.name}) directly. Respond to their latest message.`;
}

/** The brief a participant gets when naby's decision carried none. */
export function defaultBrief(agent: RoundAgent, reason: string): string {
  return `naby handed the user's latest message to you (@${agent.name}): ${reason}. Respond to it.`;
}

/** What naby is told when a limit stops the round (§8.2 "마무리하라"). A
 *  `roundTrips` cap names the participant that hit it when it is known. */
export function capInstruction(cap: RoundCap, limit: number, agentName?: string): string {
  const what =
    cap === 'speeches'
      ? `the speech limit for one message (${limit})`
      : cap === 'roundTrips'
        ? agentName
          ? `the hand-off limit for @${agentName} (${limit})`
          : `the hand-off limit for one participant (${limit})`
        : cap === 'proposals'
          ? 'the one proposal allowed per message'
          : `the participant limit for this conversation (${limit})`;
  return (
    `This round has reached ${what}. Wrap up for the user now, in your own words: ` +
    'answer what is still open and do not hand the conversation to anyone else.'
  );
}

/** naby's stored note when a limit stopped its line-start hand-off (R3.10) —
 *  read by naby on later turns, so it knows the participant never got it. */
export function blockedHandoffNote(blocked: Pick<BlockedHandoff, 'cap' | 'limit' | 'name'>): string {
  const what =
    blocked.cap === 'speeches'
      ? `the speech limit for one message (${blocked.limit})`
      : `the hand-off limit for @${blocked.name} (${blocked.limit})`;
  return `Not handed to @${blocked.name}: ${what} was reached, so @${blocked.name} did not get this message.`;
}

/** naby's note to itself when it speaks after a participant. */
export function followupInstruction(after: RoundAgent | undefined, asked: boolean): string {
  if (!after) return "Answer the user's latest message yourself.";
  return asked
    ? `@${after.name} addressed you in its last message. Answer it, and the user if anything is still open.`
    : `@${after.name} has answered the user. Add only what is still missing; do not repeat it.`;
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

type RouteTokens = { input: number; output: number };

type DelegateItem = {
  agent: RoundAgent;
  brief: string;
  reason: string;
  decision: HandoffDecision;
  tokens?: RouteTokens;
};

type State =
  | { at: 'ROUTE'; followup?: { after: RoundAgent; asked: boolean } }
  | { at: 'DELEGATE'; queue: DelegateItem[] }
  | { at: 'PROPOSE'; agent: RoundAgent; reason: string; brief?: string; tokens?: RouteTokens }
  | {
      at: 'NABY';
      reason: NabySpeechReason;
      cap?: { cap: RoundCap; limit: number; agentName?: string };
      after?: RoundAgent;
      asked?: boolean;
    }
  | { at: 'END'; by: RoundEndReason };

/** Hard ceiling on state transitions — a bug in the machine must not loop. Far
 *  above anything the caps allow (20 speeches is the settings maximum). */
const MAX_TRANSITIONS = 200;

/**
 * Run one round. Never throws for a model or parsing failure — a broken routing
 * answer is `answer` (naby speaks), exactly what a session with no participants
 * does. A throw from a speech dependency propagates (the caller's turn error
 * path handles it, as it does for an ordinary turn).
 */
export async function runParticipantRound(input: RoundInput): Promise<RoundResult> {
  const { hub, settings, signal } = input;
  const byLower = new Map<string, RoundAgent>();
  for (const a of input.registered) byLower.set(a.name.toLowerCase(), a);
  const find = (name: string) => byLower.get(name.toLowerCase());

  // The session roster as it stands at the start of the round, kept current as
  // the round adds to it. naby is never in it (always present).
  const active = new Set<string>();
  const declined = new Set<string>();
  try {
    for (const row of input.store.listSessionParticipants(input.sessionId)) {
      if (row.status === 'active') active.add(row.agentId);
      else if (row.status === 'declined') declined.add(row.agentId);
    }
  } catch {
    /* an unreadable roster reads as empty — naby then answers alone */
  }
  const inSession = () => input.registered.filter((a) => active.has(a.id));
  // Nobody is offered for a proposal once the session is FULL (R2.4): a "yes"
  // could not be honoured, and offering one only to refuse it afterwards would
  // spend the routing call and a cap message on a question never asked.
  const outside = () =>
    settings.proposalsEnabled && active.size < settings.maxPerSession
      ? input.registered.filter((a) => !active.has(a.id) && !declined.has(a.id))
      : [];

  let speeches = 0;
  let proposals = 0;
  const roundTrips = new Map<string, number>();
  let userRowWritten = false;
  let lastText = '';
  let lastOk = true;

  // `seq` numbers the round's routing events so a client that replays the
  // stream (a reconnect) can recognise one it already drew.
  let routingSeq = 0;
  const emitRouting = (routing: RoundRoutingEvent) =>
    input.emit({ type: 'system', subtype: 'routing', seq: ++routingSeq, routing });
  const emitSpeaker = (agent: RoundAgent, persona: boolean) =>
    input.emit({
      type: 'system',
      subtype: 'speaker',
      speech: speeches + 1,
      agent: {
        id: agent.id,
        name: agent.name,
        displayName: agent.displayName,
        ...(agent.avatar ? { avatar: agent.avatar } : {}),
        ...(agent.color ? { color: agent.color } : {}),
        persona,
      },
    });

  const capFor = (agent: RoundAgent): { cap: RoundCap; limit: number } | undefined => {
    // naby must keep one speech to wrap up in, so a hand-off that would use the
    // last one is already over the limit.
    if (speeches + 1 >= settings.maxSpeechesPerRound) {
      return { cap: 'speeches', limit: settings.maxSpeechesPerRound };
    }
    if ((roundTrips.get(agent.id) ?? 0) >= settings.maxRoundTrips) {
      return { cap: 'roundTrips', limit: settings.maxRoundTrips };
    }
    return undefined;
  };

  const hitCap = (cap: { cap: RoundCap; limit: number }, agent?: RoundAgent): State => {
    input.log('participant_cap', {
      cap: cap.cap,
      limit: cap.limit,
      speeches,
      ...(agent ? { agentId: agent.id, agentName: agent.name } : {}),
    });
    // The routing chip draws this line (MAC-M3); the M2 harness pill that used
    // to duplicate it is gone (MAC-M4).
    emitRouting({
      kind: 'end',
      decision: 'cap',
      reason: cap.cap,
      limit: cap.limit,
      ...(agent ? { targetAgentId: agent.id, targetName: agent.name } : {}),
    });
    return {
      at: 'NABY',
      reason: 'cap',
      cap: cap.cap === 'roundTrips' && agent ? { ...cap, agentName: agent.name } : cap,
    };
  };

  /** ROUTE / ROUTE_FOLLOWUP: naby's structured decision. */
  /** The last routing call's token use, attached to the event its decision emits. */
  let lastRouteTokens: RouteTokens = { input: 0, output: 0 };
  const route = async (followup?: { after: RoundAgent; asked: boolean }): Promise<ParticipantRouteDecision> => {
    lastRouteTokens = { input: 0, output: 0 };
    const here = inSession();
    const out = proposals < 1 ? outside() : [];
    // Nothing to choose between: no call at all (R2.1, D13).
    if (here.length === 0 && out.length === 0) {
      return followup && !followup.asked
        ? { action: 'end', reason: 'no-participants' }
        : { action: 'answer', reason: 'no-participants' };
    }
    const system = routePrompt({
      userText: input.userText,
      recent: input.recent(),
      inSession: here.map((a) => ({ name: a.name, description: a.description })),
      registeredOutside: out.map((a) => ({ name: a.name, description: a.description })),
      caps: {
        speechesLeft: settings.maxSpeechesPerRound - speeches,
        // PER TARGET: one participant at its limit is not a limit on the others.
        // The headline number is the most any of them has left (0 only when all
        // are spent); the per-name map says which one is spent.
        roundTripsLeft:
          here.length > 0
            ? Math.max(...here.map((a) => settings.maxRoundTrips - (roundTrips.get(a.id) ?? 0)))
            : settings.maxRoundTrips,
        roundTripsLeftFor: Object.fromEntries(
          here.map((a) => [a.name, settings.maxRoundTrips - (roundTrips.get(a.id) ?? 0)]),
        ),
      },
      proposalsEnabled: settings.proposalsEnabled && proposals < 1,
      declined: input.registered.filter((a) => declined.has(a.id)).map((a) => a.name),
      ...(followup ? { followup: { speaker: followup.after.name, asked: followup.asked } } : {}),
    });
    let raw: RouteCallResult;
    try {
      raw = await input.routeCall(system);
    } catch (e) {
      raw = { text: '' };
      input.log('participant_route', {
        decision: 'route',
        error: e instanceof Error ? e.message : String(e),
        ...(followup ? { followup: true } : {}),
      });
    }
    let decision = parseRouteDecision(raw.text, {
      inSession: here.map((a) => a.name),
      outside: out.map((a) => a.name),
    });
    // ROUTE_FOLLOWUP's default is `end` when the participant did not ask naby
    // anything: an unreadable answer there must not buy an extra speech.
    if (followup && decision.reason.startsWith('fallback:')) {
      decision = { action: followup.asked ? 'answer' : 'end', reason: decision.reason };
    }
    // R3.4 (2026-10-28 user decision): a participant that addressed naby is
    // ANSWERED. `end` is not a choice then — naby speaks (or hands it on).
    if (followup?.asked && decision.action === 'end') {
      decision = { action: 'answer', reason: decision.reason };
    }
    lastRouteTokens = { input: raw.inputTokens ?? 0, output: raw.outputTokens ?? 0 };
    input.log('participant_route', {
      decision: 'route',
      action: decision.action,
      ...(decision.target ? { target: decision.target } : {}),
      reason: decision.reason,
      ...(decision.brief ? { brief: decision.brief } : {}),
      ...(followup ? { followup: true, after: followup.after.name, asked: followup.asked } : {}),
      inSession: here.map((a) => a.name),
      offered: out.map((a) => a.name),
      inputTokens: raw.inputTokens ?? 0,
      outputTokens: raw.outputTokens ?? 0,
    });
    return decision;
  };

  /** One participant speech, then what it said that matters to the round. */
  const participantSpeak = async (item: DelegateItem): Promise<{ asked: boolean; ok: boolean }> => {
    if (!userRowWritten) {
      input.writeUserRow();
      userRowWritten = true;
    }
    emitRouting({
      kind: 'delegate',
      targetAgentId: item.agent.id,
      targetName: item.agent.name,
      reason: item.reason,
      brief: item.brief,
      decision: item.decision,
      tokens: item.tokens ?? { input: 0, output: 0 },
    });
    emitSpeaker(item.agent, false);
    speeches += 1;
    roundTrips.set(item.agent.id, (roundTrips.get(item.agent.id) ?? 0) + 1);
    const res = await input.runParticipantTurn({
      agent: item.agent,
      brief: item.brief,
      reason: item.reason,
      decision: item.decision,
      speech: speeches,
    });
    lastText = res.text;
    lastOk = res.ok;
    // R3.4: a participant may address naby; any other participant it names is
    // IGNORED — the text stays, the hand-off does not happen.
    const others = parseMentions(
      res.text,
      input.registered.filter((a) => a.id !== item.agent.id).map((a) => a.name),
    );
    for (const name of others) {
      const other = find(name);
      input.log('participant_mention_ignored', {
        agentId: item.agent.id,
        agentName: item.agent.name,
        ignored: name,
        ...(other ? { ignoredAgentId: other.id } : {}),
      });
      emitRouting({
        kind: 'end',
        decision: 'ignored-mention',
        ...(other ? { targetAgentId: other.id } : {}),
        targetName: name,
        reason: `@${item.agent.name} addressed @${name}; only naby hands the turn on`,
      });
    }
    const asked = mentionsHub(res.text, hub.name);
    if (asked) {
      emitRouting({
        kind: 'return',
        targetAgentId: hub.id,
        targetName: hub.name,
        reason: 'asked',
        decision: 'route',
      });
    }
    return { asked, ok: res.ok };
  };

  /** NABY_SPEAK. */
  const nabySpeak = async (state: Extract<State, { at: 'NABY' }>): Promise<void> => {
    const note = state.cap ? capInstruction(state.cap.cap, state.cap.limit, state.cap.agentName) : undefined;
    let speakInput: NabySpeakInput;
    if (!userRowWritten) {
      speakInput = { reason: state.reason, ...(note ? { note } : {}) };
    } else {
      const content = note ?? followupInstruction(state.after, state.asked === true);
      speakInput = { reason: state.reason, handoff: { content, reason: state.reason } };
    }
    userRowWritten = true;
    emitSpeaker(hub, true);
    speeches += 1;
    const res = await input.runNabyTurn(speakInput);
    lastText = res.text;
    lastOk = res.ok;
  };

  /**
   * R3.10: the participants naby's speech just ADDRESSED — `@name` at the start
   * of a line, in the session, not naby itself, outside code. Each gets the
   * paragraph that opens with its name. Mid-sentence mentions are talk ABOUT a
   * participant and hand nothing over.
   */
  const addressedBy = (text: string): DelegateItem[] => {
    const here = inSession();
    if (here.length === 0 || !text) return [];
    const items: DelegateItem[] = [];
    for (const m of parseLeadingMentions(text, here.map((a) => a.name), { hubNames: [hub.name] })) {
      const agent = here.find((a) => a.name === m.name);
      if (!agent || agent.id === hub.id) continue;
      items.push({ agent, brief: m.brief, reason: 'hub-mention', decision: 'hub-mention' });
    }
    return items;
  };

  let state: State;
  // ---- RECEIVE ------------------------------------------------------------
  const mentioned: DelegateItem[] = [];
  for (const name of input.mentions) {
    const agent = find(name);
    if (!agent) continue;
    if (!active.has(agent.id)) {
      // R3.2: registered but not here — the user is told to add it, and the
      // mention is dropped (it is never a silent addition).
      emitRouting({
        kind: 'delegate',
        targetAgentId: agent.id,
        targetName: agent.name,
        reason: 'not-in-session',
        decision: 'not-in-session',
      });
      continue;
    }
    if (!mentioned.some((m) => m.agent.id === agent.id)) {
      mentioned.push({ agent, brief: userMentionBrief(agent), reason: 'user-mention', decision: 'user-mention' });
    }
  }
  if (mentioned.length > 0) {
    // D2: the user already chose — no routing call, the decision is recorded.
    input.log('participant_route', {
      decision: 'user-mention',
      targets: mentioned.map((m) => m.agent.name),
      inputTokens: 0,
      outputTokens: 0,
    });
    state = { at: 'DELEGATE', queue: mentioned };
  } else {
    state = { at: 'ROUTE' };
  }

  let transitions = 0;
  let lastSpoke: RoundAgent | undefined;
  while (state.at !== 'END') {
    transitions += 1;
    if (transitions > MAX_TRANSITIONS) {
      state = { at: 'END', by: 'error' };
      break;
    }
    if (signal.aborted) {
      state = { at: 'END', by: 'abort' };
      break;
    }
    switch (state.at) {
      case 'ROUTE': {
        const d = await route(state.followup);
        if (signal.aborted) {
          state = { at: 'END', by: 'abort' };
          break;
        }
        if (d.action === 'end') {
          // `end` is only an ending once somebody has spoken; as the first
          // decision of a round it means naby answers.
          state = speeches > 0 ? { at: 'END', by: 'end' } : { at: 'NABY', reason: 'answer' };
        } else if (d.action === 'delegate' && d.target) {
          const agent = find(d.target)!;
          state = {
            at: 'DELEGATE',
            queue: [
              {
                agent,
                brief: d.brief ?? defaultBrief(agent, d.reason),
                reason: d.reason,
                decision: 'route',
                tokens: lastRouteTokens,
              },
            ],
          };
        } else if (d.action === 'propose' && d.target) {
          state = {
            at: 'PROPOSE',
            agent: find(d.target)!,
            reason: d.reason,
            ...(d.brief ? { brief: d.brief } : {}),
            tokens: lastRouteTokens,
          };
        } else {
          state = state.followup
            ? { at: 'NABY', reason: 'followup', after: state.followup.after, asked: state.followup.asked }
            : { at: 'NABY', reason: 'answer' };
        }
        break;
      }

      case 'PROPOSE': {
        const agent: RoundAgent = state.agent;
        const reason: string = state.reason;
        // R3.9: one proposal per message; R2.4: never propose past the cap —
        // checked BEFORE anything is shown, so the user is never asked a question
        // whose "yes" could not be honoured.
        if (proposals >= 1) {
          state = hitCap({ cap: 'proposals', limit: 1 }, agent);
          break;
        }
        if (active.size >= settings.maxPerSession) {
          state = hitCap({ cap: 'participants', limit: settings.maxPerSession }, agent);
          break;
        }
        proposals += 1;
        emitRouting({
          kind: 'propose',
          targetAgentId: agent.id,
          targetName: agent.name,
          reason,
          decision: 'route',
          tokens: state.tokens ?? { input: 0, output: 0 },
        });
        const outcome = await input.propose(agent, reason);
        input.log('participant_proposal', { agentId: agent.id, agentName: agent.name, reason, decision: outcome });
        if (outcome === 'allow') {
          try {
            input.store.putSessionParticipant(input.sessionId, agent.id, { status: 'active', addedBy: 'naby' });
          } catch {
            /* the roster write failing must not lose the user's answer for this round */
          }
          try {
            input.onJoined?.(agent.id);
          } catch {
            /* bookkeeping only — never the round's problem */
          }
          active.add(agent.id);
          state = {
            at: 'DELEGATE',
            queue: [{ agent, brief: state.brief ?? defaultBrief(agent, reason), reason, decision: 'route' }],
          };
        } else {
          try {
            input.store.putSessionParticipant(input.sessionId, agent.id, { status: 'declined', addedBy: 'naby' });
          } catch {
            /* best effort */
          }
          try {
            input.onDeclined?.(agent.id);
          } catch {
            /* bookkeeping only — never the round's problem */
          }
          declined.add(agent.id);
          state = outcome === 'abort' || signal.aborted ? { at: 'END', by: 'abort' } : { at: 'NABY', reason: 'declined' };
        }
        break;
      }

      case 'DELEGATE': {
        let asked = false;
        let spokeInQueue = false;
        let next: State | undefined;
        for (const item of state.queue) {
          if (signal.aborted) {
            next = { at: 'END', by: 'abort' };
            break;
          }
          const cap = capFor(item.agent);
          if (cap) {
            // R3.10: naby addressed a participant the limits no longer allow.
            // Its turn is not opened and naby does not speak again just to say
            // so — the round ends where naby's speech left it. (Once somebody in
            // this queue has spoken, the ordinary wrap-up applies.)
            if (item.decision === 'hub-mention' && !spokeInQueue && (cap.cap === 'speeches' || cap.cap === 'roundTrips')) {
              input.log('participant_cap', {
                cap: cap.cap,
                limit: cap.limit,
                speeches,
                source: 'hub-mention',
                agentId: item.agent.id,
                agentName: item.agent.name,
              });
              // The user is told, as a system line (not a speech): naby called
              // @name, and @name did not get it.
              const blocked: BlockedHandoff = {
                by: 'hub-mention',
                cap: cap.cap,
                limit: cap.limit,
                agentId: item.agent.id,
                name: item.agent.name,
              };
              emitRouting({
                kind: 'end',
                decision: 'cap',
                reason: cap.cap,
                limit: cap.limit,
                targetAgentId: item.agent.id,
                targetName: item.agent.name,
                blocked,
              });
              try {
                input.onHandoffBlocked?.(blocked, blockedHandoffNote(blocked));
              } catch {
                /* bookkeeping only — never the round's problem */
              }
              next = { at: 'END', by: 'cap' };
              break;
            }
            next = hitCap(cap, item.agent);
            break;
          }
          const r = await participantSpeak(item);
          spokeInQueue = true;
          lastSpoke = item.agent;
          if (!r.ok) {
            next = { at: 'END', by: signal.aborted ? 'abort' : 'error' };
            break;
          }
          if (r.asked) asked = true;
        }
        state = next ?? (lastSpoke ? { at: 'ROUTE', followup: { after: lastSpoke, asked } } : { at: 'NABY', reason: 'answer' });
        break;
      }

      case 'NABY': {
        await nabySpeak(state);
        if (signal.aborted || !lastOk || state.reason === 'cap') {
          // A wrap-up at a limit hands nothing on (its instruction says so).
          state = { at: 'END', by: signal.aborted ? 'abort' : !lastOk ? 'error' : 'cap' };
          break;
        }
        // R3.10: naby addressed participants at a line start — they answer next.
        const addressed = addressedBy(lastText);
        if (addressed.length > 0) {
          input.log('participant_route', {
            decision: 'hub-mention',
            targets: addressed.map((m) => m.agent.name),
            inputTokens: 0,
            outputTokens: 0,
          });
          state = { at: 'DELEGATE', queue: addressed };
          break;
        }
        state = { at: 'END', by: 'answer' };
        break;
      }
    }
  }

  const endedBy = (state as Extract<State, { at: 'END' }>).by;
  input.log('round_completed', { speeches, endedBy, proposals });
  return { speeches, endedBy, lastText, lastOk, proposals };
}
