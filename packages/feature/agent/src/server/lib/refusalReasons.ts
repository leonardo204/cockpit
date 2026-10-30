/**
 * WHAT THE MODEL IS TOLD WHEN THE SHELL'S GATE REFUSES A TOOL CALL.
 *
 * A refusal is read by the model, which then has to explain it to the user. A
 * reason that only names an internal mechanism ("approval request timed out",
 * "limited to its allowed tools") leaves the model guessing — it retries, works
 * around the block with another tool, or tells the user it does not know what
 * stopped it (2026-10-30 VOC). So every reason here says three things:
 *
 *   1. what happened (the tool did not run, and why),
 *   2. which real control in the app lifts it, in the UI's own words — the
 *      English label with the Korean one in parentheses, because the user may
 *      be reading either,
 *   3. what the model should do now (do not retry, do not work around it, tell
 *      the user).
 *
 * Labels are copied from shared/i18n/locales/{en,ko}.json; change them together.
 * Pure strings, no IO, so they are asserted directly (refusalReasons.test.ts).
 */

/** The ask timed out: an approval card sat unanswered for the whole window. */
export function approvalTimeoutReason(toolName: string, minutes = 10): string {
  return (
    `Nobody approved ${toolName} within ${minutes} minutes, so it did not run. Do not retry it. ` +
    'Tell the user it is waiting on their approval: they can send the request again while watching the chat, ' +
    'turn on Telegram escalation (Settings → Connections → "Enable Telegram escalation" / 설정 → 연결 → "텔레그램 에스컬레이션 사용") ' +
    'so approvals reach their phone, or change the "Ask each time" (매번 확인) rule for this tool in Settings → Permissions (설정 → 권한).'
  );
}

/**
 * The user pressed Deny — on the in-app card, or on the Telegram message. The
 * tool is not named: the resolver does not always know it, and the reason is
 * the result OF that call, so the model already knows which one it was.
 */
export function userDeclinedReason(where: 'app' | 'telegram'): string {
  return (
    `The user declined this tool call ${where === 'telegram' ? 'from Telegram' : 'in the app'}. ` +
    'Do not retry it or work around it; ask what they would prefer instead.'
  );
}

/**
 * A participant's call needed the user's approval, and this turn has nobody to
 * ask: it did not start from the chat window (a Telegram message, a scheduled
 * task, another tab's request) and Telegram escalation is not on for naby.
 *
 * `outside` — the tool is outside the participant's permission level (rather
 * than the participant being set to ask before every tool).
 */
export function participantUnreachableReason(toolName: string, participant: string, outside: boolean): string {
  const why = outside
    ? `${toolName} is outside what @${participant} may do without asking`
    : `@${participant} is set to ask before every tool it uses`;
  const fix = outside
    ? `raise @${participant}'s "What it may do" (할 수 있는 일) level so it includes this tool`
    : `turn off "Ask me every time it uses a tool" (도구를 쓸 때마다 나에게 묻기) for @${participant}`;
  return (
    `${why}, so this call needs the user's approval. This turn was not started from the chat window, ` +
    'so nobody could be asked, and the tool did not run. Do not retry it. ' +
    `Tell the user: they can ${fix} in Settings → Naby → Participants → @${participant} (설정 → 나비 → 참가자), ` +
    'or, for requests sent from Telegram, set naby\'s "Reach me via" (나에게 알리는 방식) to Telegram in Settings → Naby so the approval is asked there, ' +
    'or send the request again from the chat window.'
  );
}

/** A company (org harness) hook refused the call. Mandatory — no switch lifts it. */
export function orgHookDenyReason(script: string, hookReason?: string): string {
  return (
    `Blocked by the company's org harness rule (${script})${hookReason ? `: ${hookReason}` : ''}. ` +
    'This rule is mandatory and cannot be switched off in naby. ' +
    'Do not retry; tell the user which rule blocked it and offer a way that complies.'
  );
}

/** An imported agent reached for a tool outside the fixed list it came with. */
export function agentToolRefsReason(toolName: string, agent: string, allowed: readonly string[]): string {
  // The list is short in practice; capped so a long import cannot flood the reason.
  const shown = allowed.slice(0, 12);
  const list = shown.length > 0 ? `${shown.join(', ')}${allowed.length > shown.length ? ', …' : ''}` : 'none';
  return (
    `@${agent} cannot use ${toolName}: its tools were fixed when it was imported (${list}). ` +
    `Do the work without ${toolName}, or tell the user to ask naby itself, without @${agent}, which can use it.`
  );
}

/** A Block rule in Settings → Permissions covers the participant-draft tool. */
export const PARTICIPANT_DRAFT_BLOCKED_REASON =
  'A rule the user set in Settings → Permissions (설정 → 권한) blocks drafting participants. ' +
  'Do not retry; tell the user, and say they can remove or change that rule.';
