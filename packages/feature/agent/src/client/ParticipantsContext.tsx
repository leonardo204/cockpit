'use client';

/**
 * ONE READ OF THE PARTICIPANTS, SHARED BY THE CHAT (multi-agent-chat §8.5, MAC-M3).
 *
 * The header roster, the speaker cards, the routing chips and the `@` palette all
 * ask the same three questions — who is registered, who is in THIS session, and
 * is "show routing" on — so `Chat` asks them once (`useParticipantsState`) and
 * hands the answers down through this context. A `MessageBubble` outside any
 * provider (the mobile viewer, a test) reads the default: no participants, routing
 * hidden, which is exactly the zero-participant behaviour of R2.1.
 *
 * REFRESH. The roster changes in four ways and each one triggers a re-read: the
 * session changes; the user adds or removes someone here; naby's proposal is
 * resolved (`naby:approval_resolved`, which also arrives when it was answered on
 * Telegram); or Settings edits the registry (`naby:participants_changed`).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_PARTICIPANT_CHAT_SETTINGS,
  chatSettingsFrom,
  participantInfosFrom,
  type HubInfo,
  type ParticipantChatSettings,
  type ParticipantInfo,
} from './participants';

/** Window event: something outside the chat (Settings) changed the registry. */
export const PARTICIPANTS_CHANGED_EVENT = 'naby:participants_changed';

/** Tell every mounted chat to re-read its participants. */
export function announceParticipantsChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(PARTICIPANTS_CHANGED_EVENT));
}

type ActionReply = { ok: true } | { ok: false; error: string };

export interface ParticipantsContextValue {
  /** Is there anything participant-shaped to draw? False = today's chat, unchanged. */
  enabled: boolean;
  sessionId: string | null;
  hub: HubInfo | null;
  registered: ParticipantInfo[];
  inSession: ParticipantInfo[];
  settings: ParticipantChatSettings;
  lookup: (id: string, name?: string) => ParticipantInfo | undefined;
  add: (agentId: string) => Promise<ActionReply>;
  remove: (agentId: string) => Promise<ActionReply>;
  setShowRouting: (on: boolean) => void;
  refresh: () => void;
}

const noop = () => {};
const noSession = async (): Promise<ActionReply> => ({ ok: false, error: 'no session' });

export const EMPTY_PARTICIPANTS: ParticipantsContextValue = {
  enabled: false,
  sessionId: null,
  hub: null,
  registered: [],
  inSession: [],
  settings: DEFAULT_PARTICIPANT_CHAT_SETTINGS,
  lookup: () => undefined,
  add: noSession,
  remove: noSession,
  setShowRouting: noop,
  refresh: noop,
};

const ParticipantsContext = createContext<ParticipantsContextValue>(EMPTY_PARTICIPANTS);

export const ParticipantsProvider = ParticipantsContext.Provider;

export function useParticipants(): ParticipantsContextValue {
  return useContext(ParticipantsContext);
}

type NabyReply = {
  ok?: boolean;
  error?: string;
  participants?: unknown;
  naby?: { id?: unknown; name?: unknown };
  participantSettings?: unknown;
};

async function nabyAction(body: Record<string, unknown>): Promise<NabyReply | null> {
  try {
    const res = await fetch('/api/naby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as NabyReply | null;
    if (!json) return null;
    if (!res.ok && json.ok !== false) return { ok: false, error: `request failed (${res.status})` };
    return json;
  } catch {
    return null;
  }
}

function hubFrom(raw: NabyReply['naby']): HubInfo | null {
  if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string') return null;
  return { id: raw.id, name: raw.name };
}

/**
 * The chat's participant state. `sessionId` null = a chat that has not sent its
 * first message yet: the registry is still read (the palette and the `+` menu
 * show it) but nothing can be added until the session exists.
 */
export function useParticipantsState(sessionId: string | null): ParticipantsContextValue {
  const [registered, setRegistered] = useState<ParticipantInfo[]>([]);
  const [inSession, setInSession] = useState<ParticipantInfo[]>([]);
  const [hub, setHub] = useState<HubInfo | null>(null);
  const [settings, setSettings] = useState<ParticipantChatSettings>(DEFAULT_PARTICIPANT_CHAT_SETTINGS);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  const readRegistry = useCallback(async () => {
    const [list, conf] = await Promise.all([
      nabyAction({ action: 'participant.list' }),
      nabyAction({ action: 'participants.get' }),
    ]);
    if (list?.ok) setRegistered(participantInfosFrom(list.participants));
    if (conf?.ok) setSettings(chatSettingsFrom(conf.participantSettings));
  }, []);

  const readSession = useCallback(async () => {
    const sid = sessionRef.current;
    if (!sid) {
      setInSession([]);
      return;
    }
    const res = await nabyAction({ action: 'session.participants.list', sessionId: sid });
    // A reply for a session we have since left is dropped.
    if (sessionRef.current !== sid) return;
    if (res?.ok) {
      setInSession(participantInfosFrom(res.participants));
      const h = hubFrom(res.naby);
      if (h) setHub(h);
    }
  }, []);

  const refresh = useCallback(() => {
    void readRegistry();
    void readSession();
  }, [readRegistry, readSession]);

  useEffect(() => {
    void readRegistry();
  }, [readRegistry]);

  useEffect(() => {
    void readSession();
  }, [sessionId, readSession]);

  useEffect(() => {
    const onChange = () => refresh();
    window.addEventListener('naby:approval_resolved', onChange);
    window.addEventListener(PARTICIPANTS_CHANGED_EVENT, onChange);
    return () => {
      window.removeEventListener('naby:approval_resolved', onChange);
      window.removeEventListener(PARTICIPANTS_CHANGED_EVENT, onChange);
    };
  }, [refresh]);

  const applyRoster = useCallback((res: NabyReply | null): ActionReply => {
    if (!res) return { ok: false, error: 'request failed' };
    if (!res.ok) return { ok: false, error: res.error ?? 'request failed' };
    setInSession(participantInfosFrom(res.participants));
    const h = hubFrom(res.naby);
    if (h) setHub(h);
    return { ok: true };
  }, []);

  const add = useCallback(
    async (agentId: string): Promise<ActionReply> => {
      const sid = sessionRef.current;
      if (!sid) return { ok: false, error: 'no session' };
      const reply = applyRoster(await nabyAction({ action: 'session.participants.add', sessionId: sid, agentId }));
      // The registry's per-participant session counts moved too.
      if (reply.ok) void readRegistry();
      return reply;
    },
    [applyRoster, readRegistry],
  );

  const remove = useCallback(
    async (agentId: string): Promise<ActionReply> => {
      const sid = sessionRef.current;
      if (!sid) return { ok: false, error: 'no session' };
      const reply = applyRoster(
        await nabyAction({ action: 'session.participants.remove', sessionId: sid, agentId }),
      );
      if (reply.ok) void readRegistry();
      return reply;
    },
    [applyRoster, readRegistry],
  );

  const setShowRouting = useCallback((on: boolean) => {
    // Optimistic: it is a view preference, and the server answers with what it
    // stored — which replaces the guess.
    setSettings((s) => ({ ...s, showRouting: on }));
    void nabyAction({ action: 'participants.set', showRouting: on }).then((res) => {
      if (res?.ok) setSettings(chatSettingsFrom(res.participantSettings));
    });
  }, []);

  const lookup = useCallback(
    (id: string, name?: string) =>
      registered.find((p) => p.id === id) ??
      inSession.find((p) => p.id === id) ??
      (name ? registered.find((p) => p.name === name) : undefined),
    [registered, inSession],
  );

  return useMemo(
    () => ({
      enabled: registered.length > 0 || inSession.length > 0,
      sessionId,
      hub,
      registered,
      inSession,
      settings,
      lookup,
      add,
      remove,
      setShowRouting,
      refresh,
    }),
    [sessionId, hub, registered, inSession, settings, lookup, add, remove, setShowRouting, refresh],
  );
}
