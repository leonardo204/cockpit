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
 * ALWAYS DRAWN (MAC-M3b). It used to hide while the conversation had no
 * participants, so a plain naby-only chat showed no roster at all — and users
 * read the empty header as "naby is not here". naby is in every conversation,
 * so the roster now always shows naby's chip and the `+`, even with nobody else.
 *
 * RECOMMENDATIONS (§8.13, MAC-M6) stand just before the `+`: a dashed chip per
 * participant naby suggests for this conversation, with a "Suggested" badge and
 * naby's reason on hover. An `existing` one opens a small menu right there —
 * "Add to conversation" · "Dismiss" (D16, it is already saved). A `new` one is a
 * draft and opens Settings › naby on the participant editor, prefilled.
 *
 * Split in two so the layout is testable without a DOM: `ParticipantRosterView`
 * is pure props → markup; `ParticipantRoster` reads the chat's participant
 * context and owns the menu's open state.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NabyAvatar, toast } from '@cockpit/shared-ui';
import { publishTopic } from '@cockpit/effect-react';
import { Topics } from '@cockpit/effect-services';
import { Plus, X } from 'lucide-react';
import { ParticipantAvatar } from './ParticipantAvatar';
import { addableParticipants, rosterLayout, type ParticipantInfo } from './participants';
import { useParticipants } from './ParticipantsContext';
import {
  RECOMMENDATION_LIST_ID,
  RECOMMENDATION_SETTINGS_SECTION,
  recommendationAnchor,
  recommendationLayout,
  type RecommendationInfo,
} from './recommendations';

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
  /** naby's pending recommendations (§8.13). */
  recommendations?: readonly RecommendationInfo[];
  /** The recommendation whose menu is open. */
  openRecommendationId?: string | null;
  /** A chip was clicked: `existing` toggles its menu, `new` opens Settings. */
  onRecommendationClick?: (id: string) => void;
  onAcceptRecommendation?: (id: string) => void;
  onDismissRecommendation?: (id: string) => void;
}

/** One dashed recommendation chip, and its menu when open. */
const RecommendationChip = memo(function RecommendationChip({
  rec,
  open,
  busy,
  hasSession,
  atCap,
  onClick,
  onAccept,
  onDismiss,
}: {
  rec: RecommendationInfo;
  open: boolean;
  busy: boolean;
  hasSession: boolean;
  atCap: boolean;
  onClick: (id: string) => void;
  onAccept: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const { t } = useTranslation();
  const badge = t('participants.recommend.badge', { defaultValue: 'Suggested' });
  const why = t('participants.recommend.why', { defaultValue: "naby's suggestion · {{reason}}", reason: rec.reason });
  return (
    <span className="relative shrink-0" data-roster-recommendation={rec.id} data-recommendation-kind={rec.kind}>
      <button
        type="button"
        onClick={() => onClick(rec.id)}
        disabled={busy}
        className="flex h-7 items-center gap-1 whitespace-nowrap rounded-full border-[1.5px] border-dashed border-brand/60 bg-card pl-0.5 pr-1 text-xs font-bold text-foreground hover:bg-accent disabled:opacity-50"
        title={`${rec.displayName} · ${rec.specialty}\n${why}`}
        aria-expanded={rec.kind === 'existing' ? open : undefined}
        data-testid={`roster-recommendation-${rec.name}`}
      >
        <span className="opacity-80">
          <ParticipantAvatar avatar={rec.avatar} color={rec.color} size="sm" />
        </span>
        <span className="max-w-[4rem] truncate">{rec.displayName}</span>
        <span className="shrink-0 rounded-full bg-accent px-1.5 py-px text-[0.643rem] font-extrabold text-brand">{badge}</span>
      </button>
      {open && rec.kind === 'existing' ? (
        <div
          className="absolute right-0 top-full z-40 mt-1.5 w-72 rounded-xl border border-border bg-card p-3 shadow-float"
          data-testid="roster-recommendation-menu"
        >
          <div className="flex items-start gap-2.5">
            <ParticipantAvatar avatar={rec.avatar} color={rec.color} size="md" className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="text-[0.929rem] font-bold text-foreground">
                {rec.displayName} <span className="text-xs font-medium text-muted-foreground">@{rec.name}</span>
              </div>
              <div className="mt-0.5 text-[0.714rem] font-semibold text-brand">{rec.specialty}</div>
            </div>
          </div>
          <p className="mt-2 text-xs leading-snug text-muted-foreground" data-testid="roster-recommendation-reason">
            {why}
          </p>
          {atCap ? (
            <p className="mt-1.5 text-xs font-semibold text-warning">
              {t('participants.atCap', { defaultValue: 'This conversation is at its limit of participants' })}
            </p>
          ) : null}
          <div className="mt-2.5 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => onDismiss(rec.id)}
              disabled={busy}
              className="h-7 rounded-sm border border-border px-2.5 text-xs font-bold text-muted-foreground hover:text-foreground disabled:opacity-50"
              data-testid="roster-recommendation-dismiss"
            >
              {t('participants.recommend.dismiss', { defaultValue: 'Dismiss' })}
            </button>
            <button
              type="button"
              onClick={() => onAccept(rec.id)}
              disabled={busy || atCap || !hasSession}
              className="h-7 rounded-sm bg-accent px-2.5 text-xs font-extrabold text-brand hover:bg-brand/15 disabled:cursor-not-allowed disabled:opacity-40"
              data-testid="roster-recommendation-accept"
            >
              {t('participants.recommend.addToChat', { defaultValue: 'Add to conversation' })}
            </button>
          </div>
        </div>
      ) : null}
    </span>
  );
});

/** Every pending recommendation in one menu — opened from the "+N suggested"
 *  pill when more than one chip would not fit (§8.13, review finding 10). */
const RecommendationListMenu = memo(function RecommendationListMenu({
  recs,
  busy,
  hasSession,
  atCap,
  onReview,
  onAccept,
  onDismiss,
}: {
  recs: readonly RecommendationInfo[];
  busy: boolean;
  hasSession: boolean;
  atCap: boolean;
  onReview: (id: string) => void;
  onAccept: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="absolute right-0 top-full z-40 mt-1.5 w-80 rounded-xl border border-border bg-card p-2 shadow-float"
      data-testid="roster-recommendation-list"
    >
      <div className="px-2 pb-1.5 pt-1 text-xs font-extrabold text-foreground">
        {t('participants.recommend.listTitle', { defaultValue: "naby's suggestions" })}
      </div>
      {recs.map((rec) => (
        <div key={rec.id} className="rounded-lg px-2 py-2 hover:bg-muted" data-recommendation-row={rec.id}>
          <div className="flex items-start gap-2.5">
            <ParticipantAvatar avatar={rec.avatar} color={rec.color} size="md" className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[0.929rem] font-bold text-foreground">
                {rec.displayName} <span className="text-xs font-medium text-muted-foreground">@{rec.name}</span>
              </div>
              <div className="text-[0.714rem] font-semibold text-brand">{rec.specialty}</div>
              <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">
                {t('participants.recommend.why', { defaultValue: "naby's suggestion · {{reason}}", reason: rec.reason })}
              </p>
            </div>
          </div>
          <div className="mt-1.5 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => onDismiss(rec.id)}
              disabled={busy}
              className="h-7 rounded-sm border border-border px-2.5 text-xs font-bold text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {t('participants.recommend.dismiss', { defaultValue: 'Dismiss' })}
            </button>
            {rec.kind === 'existing' ? (
              <button
                type="button"
                onClick={() => onAccept(rec.id)}
                disabled={busy || atCap || !hasSession}
                className="h-7 rounded-sm bg-accent px-2.5 text-xs font-extrabold text-brand hover:bg-brand/15 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t('participants.recommend.addToChat', { defaultValue: 'Add to conversation' })}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onReview(rec.id)}
                disabled={busy}
                className="h-7 rounded-sm bg-accent px-2.5 text-xs font-extrabold text-brand hover:bg-brand/15 disabled:opacity-40"
              >
                {t('participants.recommend.review', { defaultValue: 'Review in Settings' })}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
});

const noopId = (_id: string) => {};

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
  recommendations = [],
  openRecommendationId = null,
  onRecommendationClick = noopId,
  onAcceptRecommendation = noopId,
  onDismissRecommendation = noopId,
}: ParticipantRosterViewProps) {
  const { t } = useTranslation();
  const { shown, folded } = rosterLayout(inSession, speakingId === 'naby' ? null : speakingId);
  const someoneSpeaks = speakingId !== null;
  const recLayout = recommendationLayout(recommendations);
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
          className={`flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border bg-card pl-0.5 pr-2 text-xs font-bold text-foreground ${
            speakingId === 'naby' ? 'border-brand ring-2 ring-brand/20' : 'border-border'
          }`}
          title={t('participants.nabyFixedTitle', {
            defaultValue: 'naby is in every conversation and cannot be removed',
          })}
          data-roster-id="naby"
        >
          <NabyAvatar size={24} speaking={speakingId === 'naby'} />
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
        {recLayout.shown.map((rec) => (
          <RecommendationChip
            key={rec.id}
            rec={rec}
            open={openRecommendationId === rec.id}
            busy={busy}
            hasSession={hasSession}
            atCap={atCap}
            onClick={onRecommendationClick}
            onAccept={onAcceptRecommendation}
            onDismiss={onDismissRecommendation}
          />
        ))}
        {recLayout.more.length > 0 ? (
          <span className="relative shrink-0">
            <button
              type="button"
              onClick={() => onRecommendationClick(RECOMMENDATION_LIST_ID)}
              disabled={busy}
              aria-expanded={openRecommendationId === RECOMMENDATION_LIST_ID}
              className="flex h-7 items-center whitespace-nowrap rounded-full border-[1.5px] border-dashed border-brand/60 bg-card px-2 text-[0.714rem] font-extrabold text-brand hover:bg-accent disabled:opacity-50"
              title={recLayout.more.map((r) => r.displayName).join(', ')}
              data-testid="roster-recommendation-more"
            >
              {t('participants.recommend.more', { defaultValue: '+{{count}} suggested', count: recLayout.more.length })}
            </button>
            {openRecommendationId === RECOMMENDATION_LIST_ID ? (
              <RecommendationListMenu
                recs={recommendations}
                busy={busy}
                hasSession={hasSession}
                atCap={atCap}
                onReview={onRecommendationClick}
                onAccept={onAcceptRecommendation}
                onDismiss={onDismissRecommendation}
              />
            ) : null}
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

/** Open Settings › naby on the participant editor, prefilled from a `new`
 *  recommendation (§8.13). The modal belongs to the top window; the chat may be
 *  in a project iframe, so the request goes over the bus like the status bar's. */
export function openRecommendationInSettings(id: string): void {
  publishTopic(Topics.OpenSettings, { section: RECOMMENDATION_SETTINGS_SECTION, focus: recommendationAnchor(id) });
}

/** The roster, wired to the chat's participant context. Always rendered —
 *  naby's chip and the `+` show even when nobody else is registered or here
 *  (MAC-M3b; the zero-participant chat used to hide it, which read as "naby is
 *  missing"). */
export function ParticipantRoster({ speakingId }: { speakingId: SpeakingId }) {
  const { t } = useTranslation();
  const ctx = useParticipants();
  const [menuOpen, setMenuOpen] = useState(false);
  const [openRecId, setOpenRecId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close the menus on an outside click or Escape.
  useEffect(() => {
    if (!menuOpen && !openRecId) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setOpenRecId(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        setOpenRecId(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, openRecId]);

  const { add, remove, recommendations, acceptRecommendation, dismissRecommendation } = ctx;
  const onRecommendationClick = useCallback(
    (id: string) => {
      if (id === RECOMMENDATION_LIST_ID) {
        setMenuOpen(false);
        setOpenRecId((cur) => (cur === id ? null : id));
        return;
      }
      const rec = recommendations.find((r) => r.id === id);
      if (!rec) return;
      setMenuOpen(false);
      if (rec.kind === 'new') {
        // A draft is reviewed in the participant editor (R9.3).
        setOpenRecId(null);
        openRecommendationInSettings(rec.id);
        return;
      }
      setOpenRecId((cur) => (cur === id ? null : id));
    },
    [recommendations],
  );
  const onAcceptRecommendation = useCallback(
    async (id: string) => {
      const rec = recommendations.find((r) => r.id === id);
      if (!rec) return;
      setBusy(true);
      const res = await acceptRecommendation(rec);
      setBusy(false);
      if (res.ok) setOpenRecId(null);
      else toast(t('participants.addFailed', { defaultValue: 'Could not add the participant: {{error}}', error: res.error }), 'error');
    },
    [recommendations, acceptRecommendation, t],
  );
  const onDismissRecommendation = useCallback(
    async (id: string) => {
      setBusy(true);
      const res = await dismissRecommendation(id);
      setBusy(false);
      if (res.ok) setOpenRecId(null);
      else {
        toast(
          t('participants.recommend.dismissFailed', { defaultValue: 'Could not dismiss the suggestion: {{error}}', error: res.error }),
          'error',
        );
      }
    },
    [dismissRecommendation, t],
  );
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
  const onToggleMenu = useCallback(() => {
    setOpenRecId(null);
    setMenuOpen((o) => !o);
  }, []);

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
        recommendations={recommendations}
        openRecommendationId={openRecId}
        onRecommendationClick={onRecommendationClick}
        onAcceptRecommendation={(id) => void onAcceptRecommendation(id)}
        onDismissRecommendation={(id) => void onDismissRecommendation(id)}
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
