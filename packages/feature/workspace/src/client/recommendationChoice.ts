/**
 * WHAT THE RECOMMENDATION BANNER'S BUTTONS SEND (multi-agent-chat §8.13 R9.3).
 *
 * Pure apart from the `post` it is handed, so the three request sequences are a
 * unit test away from proof:
 *
 *   save-add   participant.put → session.participants.add → session.recommendations.accept {agentId}
 *   save-only  participant.put → session.recommendations.accept {agentId}
 *   discard    session.recommendations.dismiss
 *
 * The save is the ORDINARY `participant.put` (the editor's own body, its own
 * validation), and the add the ordinary `session.participants.add` (its cap
 * check). A failed add does not undo the save: the participant exists, so the
 * recommendation is still closed and the add error is reported on its own. A
 * failed close (`accept`) is reported as `acceptError` — the participant is
 * saved either way, but the chip would otherwise linger without a word.
 */

export type RecommendationChoice = 'save-add' | 'save-only' | 'discard';

export type ChoiceReply = {
  ok: boolean;
  error?: string;
  participants?: unknown;
  participant?: { id?: unknown };
};

export type ChoicePost = (body: Record<string, unknown>) => Promise<ChoiceReply>;

export type ChoiceOutcome =
  | {
      ok: true;
      choice: RecommendationChoice;
      participants?: unknown;
      agentId?: string;
      addError?: string;
      acceptError?: string;
    }
  | { ok: false; stage: 'dismiss' | 'put'; error: string };

export async function runRecommendationChoice(
  choice: RecommendationChoice,
  recommendation: { id: string; sessionId: string },
  putBody: Record<string, unknown> | null,
  post: ChoicePost,
): Promise<ChoiceOutcome> {
  if (choice === 'discard') {
    const res = await post({ action: 'session.recommendations.dismiss', id: recommendation.id });
    return res.ok ? { ok: true, choice } : { ok: false, stage: 'dismiss', error: res.error ?? 'request failed' };
  }
  if (!putBody) return { ok: false, stage: 'put', error: 'nothing to save' };
  const put = await post(putBody);
  if (!put.ok) return { ok: false, stage: 'put', error: put.error ?? 'request failed' };
  const agentId = typeof put.participant?.id === 'string' ? put.participant.id : undefined;
  let addError: string | undefined;
  if (choice === 'save-add' && agentId) {
    const added = await post({ action: 'session.participants.add', sessionId: recommendation.sessionId, agentId });
    if (!added.ok) addError = added.error ?? 'request failed';
  }
  const accepted = await post({
    action: 'session.recommendations.accept',
    id: recommendation.id,
    ...(agentId ? { agentId } : {}),
  });
  const acceptError = accepted.ok ? undefined : (accepted.error ?? 'request failed');
  return {
    ok: true,
    choice,
    participants: put.participants,
    ...(agentId ? { agentId } : {}),
    ...(addError ? { addError } : {}),
    ...(acceptError ? { acceptError } : {}),
  };
}
