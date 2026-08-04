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

  return detail ? { label, detail } : { label };
}
