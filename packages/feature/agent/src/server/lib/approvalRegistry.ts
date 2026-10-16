// Phase 2 M2 — the cross-request registry of PENDING tool-approval prompts.
//
// When the gate hits an 'ask' rule mid-turn it suspends on a promise and emits an
// `approval_request` RunEvent; the paused turn keeps its promise's resolver HERE,
// keyed by a per-turn approvalId. A SEPARATE request — `POST /api/naby
// {approval.resolve}` — looks the resolver up and settles it, so the turn resumes
// with the user's decision. A module-level Map is the right shape: the paused
// turn and the resolving request are different HTTP requests in the same server
// process (the same pattern globalState's caches use).
//
// Idempotent + leak-safe: the turn side ALSO settles on abort/timeout and calls
// `unregister`, so a resolver never lingers after its turn is gone, and a late
// `resolve` for an already-settled id is a harmless no-op.

import type { GateDecision } from '../../../../../../../dist/naby-runtime.mjs';

/**
 * What an answer may carry besides allow/deny (multi-agent-chat §8.12, R8.3):
 * the fields the user corrected on naby's participant DRAFT card, and whether to
 * add the participant to this conversation. Only a draft reads them; every other
 * asker ignores the second argument. Telegram never sends any (R8.3: the phone
 * answers yes/no and the draft's own `addToSession` stands).
 */
export type ApprovalExtras = {
  edits?: { name?: string; displayName?: string; description?: string; avatar?: string; color?: string };
  addToSession?: boolean;
};

type Pending = {
  resolve: (decision: GateDecision, extras?: ApprovalExtras) => void;
  createdAt: number;
  /** What is being approved, when the asker says (multi-agent-chat MAC-M2).
   *  `participant.add` is a proposal, not a tool call: `approval.resolve` must not
   *  turn its "remember" into a policy rule. */
  toolName?: string;
};

// Pinned to globalThis, NOT a plain module-level Map: the paused turn runs in the
// `/api/chat` module realm while `approval.resolve` arrives in the `/api/naby`
// realm, and Next.js can bundle those routes as separate module instances. A
// plain Map would give each realm its own copy, so a resolve would never find the
// paused promise. This is the same globalThis idiom sessionRunHub uses for exactly
// this writer/reader cross-realm split.
const g = globalThis as unknown as { __nabyPendingApprovals?: Map<string, Pending> };
const pending: Map<string, Pending> = g.__nabyPendingApprovals ?? (g.__nabyPendingApprovals = new Map());

/** Register a paused turn's resolver under `approvalId`. Overwrites a stale entry
 *  for the same id (a re-emit after resume). `createdAt` uses the caller's clock
 *  so this module needs no Date.now of its own. */
export function registerApproval(
  approvalId: string,
  resolve: (decision: GateDecision, extras?: ApprovalExtras) => void,
  createdAt: number,
  meta?: { toolName?: string },
): void {
  pending.set(approvalId, { resolve, createdAt, ...(meta?.toolName ? { toolName: meta.toolName } : {}) });
}

/** The tool name a pending approval was registered with, if the asker gave one. */
export function pendingApprovalToolName(approvalId: string): string | undefined {
  return pending.get(approvalId)?.toolName;
}

/** The approval kind whose "remember" is never a policy rule (multi-agent-chat
 *  §8.2): adding a participant is a one-off decision about THIS conversation. */
export const PARTICIPANT_ADD_TOOL = 'participant.add';

/** naby's participant DRAFT (multi-agent-chat §8.12): creating or editing a
 *  participant. These always ask — no remembered answer, ever (R8.2). */
export const PARTICIPANT_CREATE_TOOL = 'participant.create';
export const PARTICIPANT_UPDATE_TOOL = 'participant.update';
/** The draft tool itself, as a policy pattern a hand-made request could name. */
export const PARTICIPANT_DRAFT_TOOL_NAME = 'naby_participant_draft';

/** Approval kinds whose "remember" never becomes a policy rule. */
const NEVER_REMEMBERED: ReadonlySet<string> = new Set([
  PARTICIPANT_ADD_TOOL,
  PARTICIPANT_CREATE_TOOL,
  PARTICIPANT_UPDATE_TOOL,
  PARTICIPANT_DRAFT_TOOL_NAME,
]);

/** Whether an approval kind is one of naby's participant drafts. */
export function isParticipantDraftApproval(toolName: string | undefined): boolean {
  return toolName === PARTICIPANT_CREATE_TOOL || toolName === PARTICIPANT_UPDATE_TOOL;
}

/**
 * Whether a resolve may persist a "remember" policy rule. False for a
 * participant proposal and for naby's participant drafts — recognised by the
 * registered name OR by the pattern the client sent, so a stale or hand-made
 * request cannot write such a rule either.
 */
export function approvalMayRemember(approvalId: string, toolPattern: string): boolean {
  const registered = pendingApprovalToolName(approvalId);
  if (registered !== undefined && NEVER_REMEMBERED.has(registered)) return false;
  if (NEVER_REMEMBERED.has(toolPattern.trim())) return false;
  return true;
}

/** Settle a pending approval with a decision. Returns false if the id is unknown
 *  (already settled, timed out, or from a dead turn). */
export function resolveApproval(approvalId: string, decision: GateDecision, extras?: ApprovalExtras): boolean {
  const p = pending.get(approvalId);
  if (!p) return false;
  pending.delete(approvalId);
  p.resolve(decision, extras);
  return true;
}

/** Drop a pending entry WITHOUT resolving (the turn side already settled it via
 *  abort/timeout and owns the promise). */
export function unregisterApproval(approvalId: string): void {
  pending.delete(approvalId);
}

/** Whether an approval is currently awaiting a decision. */
export function hasPendingApproval(approvalId: string): boolean {
  return pending.has(approvalId);
}
