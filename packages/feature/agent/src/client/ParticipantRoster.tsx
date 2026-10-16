'use client';

/**
 * THE CONVERSATION'S ROSTER (multi-agent-chat §8.5, R6.2).
 *
 * naby first, always, and never removable (R2.1); then this session's
 * participants in the order they joined, each in its own colour. The one
 * speaking now pulses (`system/speaker` → the chat's acting agent); while
 * someone speaks the others shrink to their avatar, and past four the idle ones
 * fold into "+N". The `+` menu offers the registered participants that are not
 * here yet, with the "n/5" count, and goes inert at the cap. Each participant
 * has its own × to take it out of THIS conversation (the registry is Settings').
 *
 * Split in two so the layout is testable without a DOM: `ParticipantRosterView`
 * is pure props → markup; `ParticipantRoster` reads the chat's participant
 * context and owns the menu's open state.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';
import { Plus, X } from 'lucide-react';
import { ParticipantAvatar, NabyAvatar } from './ParticipantAvatar';
import { addableParticipants, rosterLayout, type ParticipantInfo } from './participants';
import { useParticipants } from './ParticipantsContext';

/** Who is speaking: a participant id, `'naby'`, or nobody. */
export type SpeakingId = string | 'naby' | null;

export interface ParticipantRosterViewProps {
  hubLabel: string;
  inSession: readonly ParticipantInfo[];
  addable: readonly ParticipantInfo[];
  speakingId: SpeakingId;
  maxPerSession: number;
  /** False until the session exists (a chat that has not sent yet). */
  hasSession: boolean;
  menuOpen: boolean;
  busy?: boolean;
  onToggleMenu: () => void;
  onAdd: (agentId: string) => void;
  onRemove: (agentId: string) => void;
}

export const ParticipantRosterView = memo(function ParticipantRosterView({
  hubLabel,
  inSession,
  addable,
  speakingId,
  maxPerSession,
  hasSession,
  menuOpen,
  busy = false,
  onToggleMenu,
  onAdd,
  onRemove,
}: ParticipantRosterViewProps) {
  const { t } = useTranslation();
  const { shown, folded } = rosterLayout(inSession, speakingId === 'naby' ? null : speakingId);
  const someoneSpeaks = speakingId !== null;
  const atCap = inSession.length >= maxPerSession;
  const count = t('participants.countOf', {
    defaultValue: 'Participants {{count}}/{{max}}',
    count: inSession.length,
    max: maxPerSession,
  });
  return (
    <div className="relative flex items-center" data-testid="participant-roster">
      <div className="flex items-center gap-1 rounded-full bg-muted p-0.5" title={count}>
        {/* naby: fixed first, no remove (R2.1). */}
        <span
          className={`flex h-7 items-center gap-1 rounded-full border bg-card pl-0.5 pr-2 text-xs font-bold text-foreground ${
            speakingId === 'naby' ? 'border-brand ring-2 ring-brand/20' : 'border-border'
          }`}
          title={t('participants.nabyFixedTitle', {
            defaultValue: 'naby is in every conversation and cannot be removed',
          })}
          data-roster-id="naby"
        >
          <NabyAvatar size="sm" speaking={speakingId === 'naby'} />
          {hubLabel}
          <span className="text-[0.643rem] font-semibold text-muted-foreground">
            · {t('participants.fixed', { defaultValue: 'pinned' })}
          </span>
        </span>
        {shown.map((p) => {
          const speaking = speakingId === p.id;
          const wide = speaking || !someoneSpeaks;
          return (
            <span
              key={p.id}
              className={`group/rs flex h-7 items-center gap-1 rounded-full border bg-card text-xs font-bold text-foreground transition-all ${
                wide ? 'pl-0.5 pr-1.5' : 'px-0.5 opacity-75'
              }`}
              style={
                speaking
                  ? { borderColor: p.color, boxShadow: `0 0 0 3px color-mix(in srgb, ${p.color} 22%, transparent)` }
                  : undefined
              }
              title={`${p.displayName} · @${p.name}`}
              data-roster-id={p.id}
              data-speaking={speaking ? 'true' : undefined}
            >
              <ParticipantAvatar avatar={p.avatar} color={p.color} size="sm" speaking={speaking} />
              {wide ? <span className="max-w-[7rem] truncate">{p.displayName}</span> : null}
              {wide && hasSession ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onRemove(p.id)}
                  className="hidden h-4 w-4 place-items-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover/rs:grid disabled:opacity-50"
                  title={t('participants.remove', { defaultValue: 'Remove from this conversation' })}
                  aria-label={t('participants.remove', { defaultValue: 'Remove from this conversation' })}
                  data-testid={`roster-remove-${p.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              ) : null}
            </span>
          );
        })}
        {folded.length > 0 ? (
          <span
            className="flex h-7 min-w-7 items-center justify-center rounded-full border border-border bg-card px-1.5 text-xs font-bold text-muted-foreground"
            title={folded.map((p) => p.displayName).join(', ')}
            data-testid="roster-folded"
          >
            +{folded.length}
          </span>
        ) : null}
        <button
          type="button"
          onClick={onToggleMenu}
          className="grid h-7 w-7 place-items-center rounded-full border-[1.5px] border-dashed border-brand/55 bg-card text-brand hover:bg-accent"
          title={t('participants.add', { defaultValue: 'Add a participant' })}
          aria-label={t('participants.add', { defaultValue: 'Add a participant' })}
          aria-expanded={menuOpen}
          data-testid="roster-add"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {menuOpen ? (
        <div
          className="absolute right-0 top-full z-40 mt-1.5 w-80 rounded-xl border border-border bg-card p-2 shadow-float"
          data-testid="roster-menu"
        >
          <div className="flex items-center justify-between px-2 pb-2 pt-1 text-xs font-extrabold text-foreground">
            <span>{t('participants.addMenuTitle', { defaultValue: 'Add from your participants' })}</span>
            <span className="font-semibold text-muted-foreground" data-testid="roster-count">
              {count}
            </span>
          </div>
          {!hasSession ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              {t('participants.needSession', { defaultValue: 'Send a first message, then add participants' })}
            </div>
          ) : atCap ? (
            <div className="px-2 py-1.5 text-xs font-semibold text-warning" data-testid="roster-cap">
              {t('participants.atCap', {
                defaultValue: 'This conversation is at its limit of {{max}} participants',
                max: maxPerSession,
              })}
            </div>
          ) : null}
          {addable.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              {inSession.length > 0
                ? t('participants.allHere', { defaultValue: 'Everyone is already here' })
                : t('participants.noneRegistered', { defaultValue: 'No participants yet' })}
            </div>
          ) : (
            addable.map((p) => (
              <div key={p.id} className="flex items-start gap-2.5 rounded-lg px-2 py-2 hover:bg-muted" data-addable={p.name}>
                <ParticipantAvatar avatar={p.avatar} color={p.color} size="md" className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="text-[0.929rem] font-bold text-foreground">
                    {p.displayName} <span className="text-xs font-medium text-muted-foreground">@{p.name}</span>
                  </div>
                  {p.description ? (
                    <div className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">{p.description}</div>
                  ) : null}
                </div>
                <button
                  type="button"
                  disabled={busy || atCap || !hasSession}
                  onClick={() => onAdd(p.id)}
                  className="h-7 shrink-0 self-center rounded-sm bg-accent px-2.5 text-xs font-extrabold text-brand hover:bg-brand/15 disabled:cursor-not-allowed disabled:opacity-40"
                  data-testid={`roster-add-${p.name}`}
                >
                  {t('participants.addPick', { defaultValue: 'Add' })}
                </button>
              </div>
            ))
          )}
          <div className="mt-1 border-t border-border px-2 pb-1 pt-1.5 text-[0.714rem] text-muted-foreground">
            {t('participants.manageHint', { defaultValue: 'Create or import participants in Settings › naby' })}
          </div>
        </div>
      ) : null}
    </div>
  );
});

/** The roster, wired to the chat's participant context. Renders nothing when
 *  there are no participants at all (R2.1: the chat looks as it always did). */
export function ParticipantRoster({ speakingId }: { speakingId: SpeakingId }) {
  const { t } = useTranslation();
  const ctx = useParticipants();
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close the menu on an outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const { add, remove } = ctx;
  const onAdd = useCallback(
    async (agentId: string) => {
      setBusy(true);
      const res = await add(agentId);
      setBusy(false);
      if (res.ok) setMenuOpen(false);
      else toast(t('participants.addFailed', { defaultValue: 'Could not add the participant: {{error}}', error: res.error }), 'error');
    },
    [add, t],
  );
  const onRemove = useCallback(
    async (agentId: string) => {
      setBusy(true);
      const res = await remove(agentId);
      setBusy(false);
      if (!res.ok) {
        toast(
          t('participants.removeFailed', { defaultValue: 'Could not remove the participant: {{error}}', error: res.error }),
          'error',
        );
      }
    },
    [remove, t],
  );
  const onToggleMenu = useCallback(() => setMenuOpen((o) => !o), []);

  if (!ctx.enabled) return null;
  return (
    <div ref={rootRef}>
      <ParticipantRosterView
        hubLabel={t('chat.personaName', { defaultValue: 'naby' })}
        inSession={ctx.inSession}
        addable={addableParticipants(ctx.registered, ctx.inSession)}
        speakingId={speakingId}
        maxPerSession={ctx.settings.maxPerSession}
        hasSession={!!ctx.sessionId}
        menuOpen={menuOpen}
        busy={busy}
        onToggleMenu={onToggleMenu}
        onAdd={(id) => void onAdd(id)}
        onRemove={(id) => void onRemove(id)}
      />
    </div>
  );
}

/** "Show routing" (R6.4c): unfolds naby's check-and-delegate steps as chips.
 *  Saved as a view preference (`participants.set {showRouting}`). */
export const ShowRoutingToggleView = memo(function ShowRoutingToggleView({
  on,
  onToggle,
}: {
  on: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      className={`flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-bold transition-colors ${
        on ? 'border-brand/50 bg-accent text-brand' : 'border-border bg-card text-muted-foreground hover:text-foreground'
      }`}
      title={t('participants.showRoutingHint', { defaultValue: 'Show how naby decided who answers' })}
      data-testid="show-routing-toggle"
    >
      <span
        className={`relative inline-block h-3.5 w-6 rounded-full transition-colors ${on ? 'bg-brand' : 'bg-border'}`}
        aria-hidden="true"
      >
        <span
          className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-all ${on ? 'left-3' : 'left-0.5'}`}
        />
      </span>
      {t('participants.showRouting', { defaultValue: 'Show routing' })}
    </button>
  );
});

export function ShowRoutingToggle() {
  const ctx = useParticipants();
  const { setShowRouting } = ctx;
  const on = ctx.settings.showRouting;
  const onToggle = useCallback(() => setShowRouting(!on), [setShowRouting, on]);
  if (!ctx.enabled) return null;
  return <ShowRoutingToggleView on={on} onToggle={onToggle} />;
}
