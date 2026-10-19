/**
 * PARTICIPANT RECOMMENDATIONS ON THE CLIENT (multi-agent-chat §8.13, MAC-M6).
 *
 * The pure half: what one recommendation looks like on the roster (a dashed chip
 * with an avatar, a name and a "Suggested" badge), how it is read off the wire
 * (`session.participants.list` → `recommendations`, `session.recommendations.*`),
 * and the Settings deep link a `new` one opens (`recommendation:<id>`). No React,
 * so every rule is a unit test away from proof.
 */

import { draftFieldsFrom, type DraftFields } from './participantDraft';
import { participantInfoFrom, type ParticipantAvatar } from './participants';

export type RecommendationKind = 'existing' | 'new';

/** One pending recommendation as the chip and the editor banner draw it. */
export interface RecommendationInfo {
  id: string;
  sessionId: string;
  kind: RecommendationKind;
  /** `existing`: the registered participant to add. */
  agentId?: string;
  /** What the chip shows: the participant's (or the draft's) identity. */
  name: string;
  displayName: string;
  description: string;
  avatar: ParticipantAvatar;
  color: string;
  /** The specialty naby named. */
  specialty: string;
  /** naby's one-line reason (the chip menu, the editor banner). */
  reason: string;
  /** `new`: the draft the editor is filled from. */
  draft?: DraftFields;
}

/** The Settings anchor a `new` recommendation opens the participant editor on. */
export const RECOMMENDATION_ANCHOR_PREFIX = 'recommendation:';

export function recommendationAnchor(id: string): string {
  return `${RECOMMENDATION_ANCHOR_PREFIX}${id}`;
}

/** The recommendation id an anchor names, or null when it is not one. */
export function recommendationIdFromAnchor(anchor: string | undefined | null): string | null {
  if (!anchor || !anchor.startsWith(RECOMMENDATION_ANCHOR_PREFIX)) return null;
  const id = anchor.slice(RECOMMENDATION_ANCHOR_PREFIX.length).trim();
  return id || null;
}

/** The Settings section participants live in (Settings › naby). */
export const RECOMMENDATION_SETTINGS_SECTION = 'agents';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Read one wire row, or null when it is not usable. An `existing` row needs its
 *  participant (`agent`); a `new` row needs a draft with a handle. */
export function recommendationInfoFrom(row: unknown): RecommendationInfo | null {
  if (!isObj(row)) return null;
  const id = str(row.id);
  const sessionId = str(row.sessionId);
  const specialty = str(row.specialty).trim();
  const reason = str(row.reason).trim();
  if (!id || !sessionId || !specialty) return null;
  if (row.kind === 'existing') {
    const agent = participantInfoFrom(row.agent);
    if (!agent) return null;
    return {
      id,
      sessionId,
      kind: 'existing',
      agentId: agent.id,
      name: agent.name,
      displayName: agent.displayName,
      description: agent.description,
      avatar: agent.avatar,
      color: agent.color,
      specialty,
      reason,
    };
  }
  if (row.kind === 'new') {
    if (!isObj(row.draft)) return null;
    const draft = draftFieldsFrom(row.draft);
    if (!draft.name) return null;
    return {
      id,
      sessionId,
      kind: 'new',
      name: draft.name,
      displayName: draft.displayName || draft.name,
      description: draft.description,
      avatar: draft.avatar,
      color: draft.color,
      specialty,
      reason,
      draft,
    };
  }
  return null;
}

/** Read a list, dropping unusable rows. */
export function recommendationInfosFrom(rows: unknown): RecommendationInfo[] {
  if (!Array.isArray(rows)) return [];
  const out: RecommendationInfo[] = [];
  for (const r of rows) {
    const info = recommendationInfoFrom(r);
    if (info) out.push(info);
  }
  return out;
}

type Reply = { ok: true } | { ok: false; error: string };

/**
 * "Add to conversation" on an `existing` recommendation's chip (D16): the
 * ordinary `session.participants.add` (its cap check included), then
 * `session.recommendations.accept`. A `new` one is never accepted from the chip —
 * it is saved in Settings first. An add that fails leaves the recommendation
 * pending, so the user can retry or dismiss it.
 */
export async function acceptExistingRecommendation(
  rec: Pick<RecommendationInfo, 'id' | 'kind' | 'agentId'>,
  deps: {
    add: (agentId: string) => Promise<Reply>;
    accept: (id: string) => Promise<{ ok?: boolean; recommendations?: unknown } | null>;
  },
): Promise<{ reply: Reply; recommendations?: RecommendationInfo[] }> {
  if (rec.kind !== 'existing' || !rec.agentId) {
    return { reply: { ok: false, error: 'only a registered participant can be added from the chip' } };
  }
  const added = await deps.add(rec.agentId);
  if (!added.ok) return { reply: added };
  const res = await deps.accept(rec.id);
  return {
    reply: { ok: true },
    ...(res?.ok ? { recommendations: recommendationInfosFrom(res.recommendations) } : {}),
  };
}

/** Recommendation chips the roster draws before folding the rest into a
 *  "+N suggested" pill — the header row must still fit at ~900 px. */
export const ROSTER_RECOMMENDATIONS_VISIBLE = 1;

/** The pseudo-id the roster uses for "the list of every pending one is open". */
export const RECOMMENDATION_LIST_ID = '__recommendations__';

/** Which recommendations get a chip and which fold into the pill. */
export function recommendationLayout<T>(
  recs: readonly T[],
  max: number = ROSTER_RECOMMENDATIONS_VISIBLE,
): { shown: T[]; more: T[] } {
  return { shown: recs.slice(0, Math.max(0, max)), more: recs.slice(Math.max(0, max)) };
}
