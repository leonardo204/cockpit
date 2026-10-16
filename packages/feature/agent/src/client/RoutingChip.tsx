'use client';

/**
 * A ROUTING STEP, DRAWN AS A CHIP (multi-agent-chat §8.5, R6.4).
 *
 * naby's check-and-delegate steps arrive as `system` marker rows carrying
 * `routing` — live from `system/routing`, reloaded from naby's stored hand-off
 * rows (toChatMessages). By default they are HIDDEN: the user sees the
 * participant simply answer, with a small "relayed by naby" mark on its bubble.
 * The "show routing" toggle unfolds them, for debugging and for trust.
 *
 * Two kinds are never hidden, because they are not routing internals but things
 * the user has to be told: a name they called that is not in this conversation
 * (with a one-click add), and a round limit that cut the round short. Those draw
 * as centred system lines instead of chips (`routingChipVisible`).
 */

import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';
import type { ChatRouting } from './types';
import { routingChipKind, routingChipVisible, type RoutingChipKind } from './participants';
import { useParticipants } from './ParticipantsContext';

const GLYPH: Record<RoutingChipKind, string> = {
  delegate: '🦋',
  'user-mention': '👆',
  'to-naby': '🦋',
  return: '↩',
  propose: '🦋',
  'ignored-mention': '⛔',
  cap: '⏸',
  'not-in-session': 'ℹ️',
  end: '🦋',
};

const CHIP_TONE: Partial<Record<RoutingChipKind, string>> = {
  'ignored-mention': 'text-destructive bg-destructive/10 border-destructive/45',
  'user-mention': 'text-success bg-success/10 border-success/45',
};

export const RoutingChip = memo(function RoutingChip({ routing }: { routing: ChatRouting }) {
  const { t } = useTranslation();
  const ctx = useParticipants();
  const [adding, setAdding] = useState(false);
  const kind = routingChipKind(routing, ctx.hub);
  if (!routingChipVisible(kind, ctx.settings.showRouting)) return null;

  const target = routing.targetAgentId ? ctx.lookup(routing.targetAgentId, routing.targetName) : undefined;
  const name = routing.targetName ?? target?.name ?? routing.targetAgentId ?? '';

  // ---- always-visible system lines -------------------------------------
  if (kind === 'not-in-session' || kind === 'cap') {
    const text =
      kind === 'cap'
        ? routing.reason === 'roundTrips'
          ? t('participants.route.capRoundTrips', {
              defaultValue: 'Reached the round-trip limit ({{limit}}); naby wraps up',
              // The event's own number (MAC-M4) — the settings may have changed
              // since this round ran.
              limit: routing.limit ?? ctx.settings.maxRoundTrips,
            })
          : t('participants.route.capSpeeches', {
              defaultValue: 'Reached the speech limit ({{limit}}); naby wraps up',
              limit: routing.limit ?? ctx.settings.maxSpeechesPerRound,
            })
        : t('participants.route.notInSession', {
            defaultValue: '@{{name}} is not in this conversation. Add it as a participant.',
            name,
          });
    const canAdd =
      kind === 'not-in-session' &&
      !!routing.targetAgentId &&
      !!ctx.sessionId &&
      !ctx.inSession.some((p) => p.id === routing.targetAgentId);
    return (
      <div className="my-2 flex justify-center px-2" data-role="system" data-routing-kind={kind}>
        <span className="inline-flex max-w-[85%] items-center gap-1.5 rounded-full bg-warning/10 px-3 py-1 text-[0.786rem] font-semibold text-warning">
          <span aria-hidden="true">{GLYPH[kind]}</span>
          <span className="min-w-0 break-words">{text}</span>
          {canAdd ? (
            <button
              type="button"
              disabled={adding}
              onClick={async () => {
                setAdding(true);
                const res = await ctx.add(routing.targetAgentId!);
                setAdding(false);
                if (!res.ok) {
                  toast(
                    t('participants.addFailed', { defaultValue: 'Could not add the participant: {{error}}', error: res.error }),
                    'error',
                  );
                }
              }}
              className="ml-1 rounded-sm bg-card px-2 py-0.5 text-[0.714rem] font-bold text-brand hover:bg-accent disabled:opacity-50"
            >
              {t('participants.addPick', { defaultValue: 'Add' })}
            </button>
          ) : null}
        </span>
      </div>
    );
  }

  // ---- routing chips (shown with "show routing") ------------------------
  const label = (() => {
    switch (kind) {
      case 'delegate':
        return t('participants.route.delegate', { defaultValue: 'naby → @{{name}}', name });
      case 'user-mention':
        return t('participants.route.userMention', {
          defaultValue: 'You picked @{{name}} · naby’s check skipped',
          name,
        });
      case 'to-naby':
        return t('participants.route.toNaby', { defaultValue: 'naby takes the turn back' });
      case 'return':
        return t('participants.route.return', { defaultValue: 'Asked naby' });
      case 'propose':
        return t('participants.route.propose', { defaultValue: 'naby proposes adding @{{name}}', name });
      case 'ignored-mention':
        return t('participants.route.ignored', {
          defaultValue: '@{{name}} mention ignored · only naby hands the turn on',
          name,
        });
      default:
        return t('participants.route.end', { defaultValue: 'Round ended' });
    }
  })();
  // A reason worth reading: not the machine codes the round uses as reasons.
  const reason =
    routing.reason && !['user-mention', 'asked', 'not-in-session', 'speeches', 'roundTrips'].includes(routing.reason)
      ? routing.reason
      : undefined;
  const tone = CHIP_TONE[kind] ?? 'text-brand bg-accent border-brand/45';
  return (
    <div className="my-1.5 ml-10 flex justify-start pr-4" data-role="system" data-routing-kind={kind}>
      <div
        className={`max-w-[85%] rounded-sm border border-dashed px-2.5 py-1 font-mono text-[0.714rem] font-semibold ${tone}`}
        data-testid="routing-chip"
      >
        <span aria-hidden="true">{GLYPH[kind]}</span> {label}
        {reason ? <span className="ml-1.5 font-medium text-muted-foreground">· {reason}</span> : null}
        {routing.tokens && routing.tokens.input + routing.tokens.output > 0 ? (
          <span className="ml-1.5 font-medium text-muted-foreground" data-testid="routing-tokens">
            ·{' '}
            {t('participants.route.tokens', {
              defaultValue: '{{count}} tok',
              count: routing.tokens.input + routing.tokens.output,
            })}
          </span>
        ) : null}
        {routing.brief ? (
          <details className="mt-0.5 font-sans font-normal text-muted-foreground">
            <summary className="cursor-pointer select-none text-[0.714rem]">
              {t('participants.route.brief', { defaultValue: 'Brief' })}
            </summary>
            <div className="mt-0.5 whitespace-pre-wrap break-words text-[0.786rem] text-foreground">
              {routing.brief}
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
});
