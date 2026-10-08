import i18n from '@cockpit/shared-i18n';

/**
 * What a muted harness pill SAYS, in the user's language (Phase 3, P3-M9).
 *
 * The engine emits harness events from the Next server, which has no locale —
 * the same constraint that makes `growthReport.change` a structured code rather
 * than prose. Most harness pills are already language-neutral bookkeeping
 * ("compaction", "step 2/4 — continuing") and are shown verbatim, exactly as
 * before. The ones that address the USER, though, cannot be: "this agent is not
 * a butterfly yet, so the turn ran unrouted" is a sentence, and a sentence has a
 * language.
 *
 * So those are emitted as CODES and translated here, on the client, where i18n
 * lives. Everything unknown falls through unchanged, which keeps this additive:
 * a pill this table has never heard of renders precisely as it did before.
 */

/** The routing gate's pill. TWO codes, one for each era of the gate:
 *
 *   `not-butterfly:<agentName>`        — pre-M12: the address was REFUSED and the
 *                                        turn ran unrouted. No longer emitted;
 *                                        still rendered, because it sits in
 *                                        transcripts users can still scroll back to.
 *   `stage-limited:<stage>:<agentName>` — P3-M12a: the address was HONOURED and the
 *                                        agent's actions were narrowed to its stage. */
const ROUTING_GATE = 'routing-gate';
const NOT_BUTTERFLY = 'not-butterfly:';
const STAGE_LIMITED = 'stage-limited:';

/** The AI-SDK engine's rolling compaction (session-context-management §2.3).
 *
 *  TWO codes, because the two outcomes are not the same news and must not read as
 *  if they were: `folded:<n>` means the older turns are still there in compressed
 *  form, `truncated:<n>` means they are gone and no summary could be written. The
 *  second is the one a user needs to know about, so it says so. */
const COMPACTION = 'context-compaction';
const FOLDED = 'folded:';
const TRUNCATED = 'truncated:';

/** The org harness's session-start notices (org-harness-sync §4.5, §3.6).
 *
 *   `copy-notice:<skill>:<unmodified|edited|unknown>` — a same-name copy the user
 *                         installed hides the org version of <skill>;
 *   `unauthorized`      — Skill Hub rejected the key, so the org harness is off. */
const ORG_HARNESS = 'org-harness';
const COPY_NOTICE = 'copy-notice:';
/** M3 (org-harness-sync §3.6, §4.4, §4.6):
 *
 *   `atlassian-required:<status>` — the prompt was blocked: no Atlassian sign-in;
 *   `atlassian-grace:<days>`      — not signed in; new sessions block in <days>;
 *   `atlassian-migrate`           — the API-token connection still runs; log in once;
 *   `atlassian-relogin`           — the sign-in expired; log in again. */
const ATLASSIAN_REQUIRED = 'atlassian-required';
const ATLASSIAN_GRACE = 'atlassian-grace:';
const ATLASSIAN_MIGRATE = 'atlassian-migrate';
const ATLASSIAN_RELOGIN = 'atlassian-relogin';

/** Render one harness pill. Returns the label and the detail as the transcript
 *  should show them; `detail` undefined means the pill is label-only.
 *
 *  Pure with respect to the reducer that calls it: it reads the i18n singleton
 *  (as every other non-component client module does) and touches nothing else. */
export function renderHarnessPill(
  subtype: string | undefined,
  detail: string | undefined,
): { label: string; detail?: string } {
  const label = subtype || 'harness event';

  if (label === COMPACTION && (detail?.startsWith(FOLDED) || detail?.startsWith(TRUNCATED))) {
    const truncated = detail.startsWith(TRUNCATED);
    const count = Number(detail.slice((truncated ? TRUNCATED : FOLDED).length)) || 0;
    return {
      label: i18n.t('harnessPill.compaction', {
        defaultValue: 'folded the conversation into a summary',
      }),
      detail: truncated
        ? i18n.t('harnessPill.compactionTruncated', {
            count,
            defaultValue:
              'Older parts of this conversation were dropped to fit the window ({{count}} messages). No summary could be written.',
          })
        : i18n.t('harnessPill.compactionFolded', {
            count,
            defaultValue:
              'Older parts of this conversation were folded into a summary ({{count}} messages).',
          }),
    };
  }

  if (label === ROUTING_GATE && detail?.startsWith(STAGE_LIMITED)) {
    // `stage-limited:<stage>:<agentName>` — split once, so an agent name with a
    // colon in it (nothing forbids one) keeps its colons instead of truncating.
    const rest = detail.slice(STAGE_LIMITED.length);
    const sep = rest.indexOf(':');
    const stage = sep >= 0 ? rest.slice(0, sep) : rest;
    const agentName = sep >= 0 ? rest.slice(sep + 1) : '';
    return {
      label: i18n.t('harnessPill.stageScope', { defaultValue: 'acting within its stage' }),
      detail: i18n.t('harnessPill.stageLimited', {
        agent: agentName,
        stage: i18n.t(`growth.stage.${stage}`, { defaultValue: stage }),
        defaultValue:
          '@{{agent}} answered as itself, at the {{stage}} stage — it can read, draft and propose, and the actions it has not been measured on yet are held back.',
      }),
    };
  }

  if (label === ROUTING_GATE && detail?.startsWith(NOT_BUTTERFLY)) {
    const agentName = detail.slice(NOT_BUTTERFLY.length);
    return {
      label: i18n.t('harnessPill.routingGate', { defaultValue: 'not delegated' }),
      detail: i18n.t('harnessPill.notButterfly', {
        agent: agentName,
        defaultValue:
          '@{{agent}} is not a butterfly yet, so it cannot take delegated work — this ran as a normal turn.',
      }),
    };
  }

  if (label === ORG_HARNESS && detail) {
    const orgLabel = i18n.t('harnessPill.orgHarness', { defaultValue: 'org harness' });
    if (detail === ATLASSIAN_REQUIRED || detail.startsWith(`${ATLASSIAN_REQUIRED}:`)) {
      return {
        label: orgLabel,
        detail: i18n.t('harnessPill.atlassianRequired', {
          defaultValue:
            'This message was not sent: the org harness needs an Atlassian sign-in first. Log in under Settings → Harness → Org harness, then send it again.',
        }),
      };
    }
    if (detail.startsWith(ATLASSIAN_GRACE)) {
      const days = Number(detail.slice(ATLASSIAN_GRACE.length)) || 0;
      return {
        label: orgLabel,
        detail: i18n.t('harnessPill.atlassianGrace', {
          days,
          defaultValue:
            'Atlassian is not connected yet. Log in under Settings → Harness → Org harness — new conversations are blocked in {{days}} day(s).',
        }),
      };
    }
    if (detail === ATLASSIAN_MIGRATE) {
      return {
        label: orgLabel,
        detail: i18n.t('harnessPill.atlassianMigrate', {
          defaultValue:
            'Atlassian now signs in through the browser. Log in once under Settings → Harness → Org harness; the API-token connection keeps working until you do.',
        }),
      };
    }
    if (detail === ATLASSIAN_RELOGIN) {
      return {
        label: orgLabel,
        detail: i18n.t('harnessPill.atlassianRelogin', {
          defaultValue: 'The Atlassian sign-in expired. Log in again under Settings → Harness → Org harness.',
        }),
      };
    }
  }

  if (label === ORG_HARNESS && (detail === 'unauthorized' || detail?.startsWith(COPY_NOTICE))) {
    const orgLabel = i18n.t('harnessPill.orgHarness', { defaultValue: 'org harness' });
    if (detail === 'unauthorized') {
      return {
        label: orgLabel,
        detail: i18n.t('harnessPill.orgUnauthorized', {
          defaultValue:
            'Skill Hub did not accept your key, so the org harness is off. Enter the key again in Settings → Connections.',
        }),
      };
    }
    // `copy-notice:<skill>:<copy>` — skill names carry no colon, so the LAST
    // colon separates the copy kind.
    const rest = detail!.slice(COPY_NOTICE.length);
    const sep = rest.lastIndexOf(':');
    const skill = sep >= 0 ? rest.slice(0, sep) : rest;
    const copy = sep >= 0 ? rest.slice(sep + 1) : 'unknown';
    const copyKind =
      copy === 'unmodified'
        ? i18n.t('orgHarness.copyUnmodified', { defaultValue: 'unmodified copy' })
        : copy === 'edited'
          ? i18n.t('orgHarness.copyEdited', { defaultValue: 'edited copy' })
          : i18n.t('orgHarness.copyUnknown', { defaultValue: 'copy' });
    return {
      label: orgLabel,
      detail: i18n.t('harnessPill.orgCopyNotice', {
        skill,
        copyKind,
        defaultValue:
          'Your own {{skill}} ({{copyKind}}) is used instead of the org version, so it does not get org updates. Choose in Settings → Harness.',
      }),
    };
  }

  return detail ? { label, detail } : { label };
}
