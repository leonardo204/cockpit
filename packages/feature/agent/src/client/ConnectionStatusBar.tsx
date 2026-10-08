'use client';

/**
 * The thin row under the chat composer: Atlassian and Skill Hub, each a dot and
 * a name (org-harness-sync §3.9). Hover says what the state means (native
 * `title`, like every other hint in the chat's status rows); a click either
 * starts the Atlassian browser sign-in or opens Settings → Harness.
 *
 * Every decision — which items show, which color, which sentence, what a click
 * does — is in `connectionStatusView.ts`. The org harness is mandatory, so the
 * row always shows (user decision, 2026-10-08). The reading comes from the shared,
 * refcounted poller in `connectionStatus.ts`, so ten open tabs make one request.
 */

import { memo, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { StatusDot, toast, type StatusTone } from '@cockpit/shared-ui';
import { publishTopic } from '@cockpit/effect-react';
import { Topics } from '@cockpit/effect-services';
import { useConnectionStatus } from './connectionStatus';
import { startAtlassianLoginFlow } from './atlassianLogin';
import {
  atlassianClick,
  atlassianLines,
  atlassianTone,
  skillHubClick,
  skillHubLines,
  skillHubSettling,
  skillHubTone,
  type ConnectionsStatusView,
  type Line,
} from './connectionStatusView';

type T = (key: string, values?: Record<string, unknown>) => string;

/** Lines → one hover text. A value named `<x>Key` is an i18n key; it is
 *  translated and passed as `<x>`. */
export function renderLines(t: T, lines: Line[]): string {
  return lines
    .map((l) => {
      const values: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(l.values ?? {})) {
        if (k.endsWith('Key') && typeof v === 'string') values[k.slice(0, -3)] = t(v);
        else values[k] = v;
      }
      return t(l.key, values);
    })
    .join('\n');
}

function openHarnessSettings(): void {
  publishTopic(Topics.OpenSettings, { section: 'harness' });
}

/** Skill Hub: Connections at the key when the key is the problem, else Harness. */
function openSkillHubSettings(s: ConnectionsStatusView['skillHub']): void {
  publishTopic(Topics.OpenSettings, skillHubClick(s));
}

const Item = memo(function Item({
  tone,
  pulse,
  label,
  title,
  testId,
  onClick,
}: {
  tone: StatusTone;
  pulse?: boolean;
  label: string;
  title: string;
  testId: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={`${label}: ${title.split('\n')[0] ?? ''}`}
      data-testid={testId}
      data-tone={tone}
      onClick={onClick}
      className="flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-muted hover:text-foreground transition-colors"
    >
      <StatusDot tone={tone} pulse={pulse ?? false} size="md" />
      <span>{label}</span>
    </button>
  );
});

export function ConnectionStatusBar() {
  const { t, i18n } = useTranslation();
  const status = useConnectionStatus();
  const tt = t as unknown as T;

  // A sign-in THIS bar started: report how it ended (the Settings button reports
  // its own). Ref, not state — nothing renders from it.
  const startedHere = useRef(false);
  const pending = status?.atlassian.loginPending === true;
  const wasPending = useRef(pending);
  useEffect(() => {
    if (wasPending.current && !pending && startedHere.current && status) {
      startedHere.current = false;
      if (status.atlassian.status === 'connected') {
        toast(t('orgHarness.atlassian.loginDone', { defaultValue: 'Signed in to Atlassian.' }), 'success');
      } else if (status.atlassian.lastLoginError) {
        toast(
          t('orgHarness.atlassian.loginFailed', {
            error: status.atlassian.lastLoginError,
            defaultValue: 'Atlassian sign-in failed: {{error}}',
          }),
          'error',
        );
      }
    }
    wasPending.current = pending;
  }, [pending, status, t]);

  const onAtlassian = useCallback(() => {
    if (!status || atlassianClick(status.atlassian) === 'settings') {
      openHarnessSettings();
      return;
    }
    startedHere.current = true;
    void startAtlassianLoginFlow().then((r) => {
      if (!r.ok) {
        startedHere.current = false;
        toast(
          t('orgHarness.atlassian.loginFailed', { error: r.error, defaultValue: 'Atlassian sign-in failed: {{error}}' }),
          'error',
        );
      }
    });
  }, [status, t]);

  const onSkillHub = useCallback(() => {
    if (status) openSkillHubSettings(status.skillHub);
  }, [status]);

  // The org harness is mandatory: the row always shows. Only before the very
  // first reading (a local request, milliseconds) is there nothing to draw.
  if (!status) return null;

  const formatTime = (ms: number) => new Date(ms).toLocaleString(i18n.language || undefined);

  return (
    // `relative` + `-mt-3`: the row tucks into the composer's bottom padding
    // (ChatInput's `p-4`), and being positioned is what paints it ABOVE that
    // padded wrapper — without it the wrapper's background covered the row.
    <div
      className="relative flex items-center gap-2 px-4 -mt-3 pb-1.5 text-[0.714rem] leading-none text-muted-foreground select-none"
      data-testid="connection-status-bar"
      role="group"
      aria-label={t('connectionStatus.ariaLabel', { defaultValue: 'Connections' })}
    >
      <Item
        tone={atlassianTone(status.atlassian)}
        pulse={status.atlassian.loginPending}
        label={t('connectionStatus.atlassian', { defaultValue: 'Atlassian' })}
        title={renderLines(tt, atlassianLines(status.atlassian))}
        testId="connection-status-atlassian"
        onClick={onAtlassian}
      />
      <Item
        tone={skillHubTone(status.skillHub)}
        pulse={skillHubSettling(status.skillHub)}
        label={t('connectionStatus.skillHub', { defaultValue: 'Skill Hub' })}
        title={renderLines(tt, skillHubLines(status.skillHub, formatTime))}
        testId="connection-status-skillhub"
        onClick={onSkillHub}
      />
    </div>
  );
}
