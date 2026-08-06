'use client';

/**
 * THE THRESHOLD BANNER (specs/session-context-management.md §2.1).
 *
 * At 85% of the window a single line appears above the input offering the one
 * intervention naby has: continue in a new tab. It is an OFFER, never a block —
 * the conversation keeps working, nothing is truncated behind the user's back on
 * the Agent SDK engine (the SDK compacts itself) and nothing is forced.
 *
 * WHY IT LIVES BESIDE <CheckinPrompt/> AND LOOKS LIKE IT. Both are one-line
 * banners above the input that say "something about this conversation needs your
 * attention"; a second visual language for the same slot would read as a different
 * kind of thing.
 *
 * DISMISSAL IS PER SESSION AND IN MEMORY ONLY. The spec asks for "closing it stops
 * it coming back in that session" — not for a preference that outlives the app. A
 * dismissal keyed by session id in component state is exactly that claim and no
 * more: a new session (which is what the button makes) starts honest again.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { publishTopic } from '@cockpit/effect-react';
import { Topics } from '@cockpit/effect-services';
import {
  contextBannerVisible,
  initialContextBannerState,
  reduceContextBanner,
  type ContextBannerState,
} from './contextBannerReveal';

interface ContextLimitBannerProps {
  /** True once the gauge reaches the critical tier (contextGauge.atThreshold). */
  atThreshold: boolean;
  sessionId?: string;
  cwd?: string;
}

export function ContextLimitBanner({ atThreshold, sessionId, cwd }: ContextLimitBannerProps) {
  const { t } = useTranslation();
  // WHICH session was dismissed, not merely "was dismissed": switching tabs must
  // not carry one conversation's dismissal onto another's. The rule itself lives in
  // contextBannerReveal.ts (contextBannerReveal.test.ts), so this component holds
  // one piece of state and a reducer call.
  const [banner, setBanner] = useState<ContextBannerState>(initialContextBannerState);
  const [state, setState] = useState<'idle' | 'working' | 'failed'>('idle');
  // The request outlives a re-render; a second click while one is in flight would
  // mint two sessions and open the wrong one.
  const inFlight = useRef(false);

  useEffect(() => {
    // A new session gets its own answer to "have I dismissed this?".
    setState('idle');
  }, [sessionId]);

  const continueInNewTab = useCallback(async () => {
    if (!sessionId || inFlight.current) return;
    inFlight.current = true;
    setState('working');
    try {
      const res = await fetch('/api/naby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'session.continueInNewTab',
          sessionId,
          ...(cwd ? { cwd } : {}),
          // THE NAME TRAVELS FROM HERE because the server has no locale — the same
          // reason the fast-growth session's title does.
          title: t('tabBar.continuedTitle', {
            title: new Date().toLocaleDateString(),
            defaultValue: 'Continued — {{title}}',
          }),
        }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; sessionId?: string }
        | null;
      if (!res.ok || !json?.ok || !json.sessionId) {
        setState('failed');
        return;
      }
      // GO THERE. `Topics.OpenProject` is the existing "open this project at this
      // session" message — the same path the fast-growth session's button takes,
      // and the same one the session-list rows publish.
      if (cwd) publishTopic(Topics.OpenProject, { cwd, sessionId: json.sessionId });
      // The offer has been taken; this banner's conversation is the OLD one, and
      // repeating the offer in it would invite a second empty tab.
      setBanner((b) => reduceContextBanner(b, { kind: 'continued', sessionId }));
      setState('idle');
    } catch {
      setState('failed');
    } finally {
      inFlight.current = false;
    }
  }, [sessionId, cwd, t]);

  if (!contextBannerVisible(banner, { atThreshold, sessionId })) return null;
  // Visible implies a session (the rule requires one), but that lives in a pure
  // function the compiler cannot narrow through — so the guard is restated here
  // rather than asserted away with a `!`.
  if (!sessionId) return null;
  const openSessionId = sessionId;

  return (
    <div
      className="mx-4 mb-2 flex items-center gap-2 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-3 py-2"
      data-testid="context-limit-banner"
    >
      <span className="text-sm leading-5">⚠️</span>
      <div className="flex-1 text-[0.786rem] leading-5 text-foreground">
        {state === 'failed'
          ? t('contextBanner.failed', { defaultValue: 'Could not open a new tab' })
          : t('contextBanner.long', {
              defaultValue: 'This conversation has grown long — continue in a new tab',
            })}
      </div>
      <button
        onClick={continueInNewTab}
        disabled={state === 'working'}
        data-testid="context-limit-continue"
        className="rounded border border-border px-2 py-1 text-[0.786rem] text-foreground hover:bg-accent disabled:opacity-50"
      >
        {state === 'working'
          ? t('contextBanner.working', { defaultValue: 'Writing the handoff…' })
          : t('contextBanner.continue', { defaultValue: 'Continue in a new tab' })}
      </button>
      <button
        onClick={() =>
          setBanner((b) => reduceContextBanner(b, { kind: 'dismiss', sessionId: openSessionId }))
        }
        aria-label={t('contextBanner.dismiss', { defaultValue: 'Dismiss' })}
        data-testid="context-limit-dismiss"
        className="text-muted-foreground hover:text-foreground"
      >
        ✕
      </button>
    </div>
  );
}
