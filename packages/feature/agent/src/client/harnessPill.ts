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

/** The routing gate's refusal (spec §3). `detail` is `not-butterfly:<agentName>` —
 *  the code and the agent it is about, since the sentence names the agent. */
const ROUTING_GATE = 'routing-gate';
const NOT_BUTTERFLY = 'not-butterfly:';

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

  return detail ? { label, detail } : { label };
}
