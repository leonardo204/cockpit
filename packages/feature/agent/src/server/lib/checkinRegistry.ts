// packages/feature/agent/src/server/lib/checkinRegistry.ts
//
// Phase 3 P3-M5 — the cross-request registry of PENDING check-in prompts.
//
// Exactly the mechanism M2's approvalRegistry uses, for the other question the
// app asks mid-turn: when the agent calls `naby_checkin` the turn suspends on a
// promise and emits a `checkin_request` RunEvent; the resolver lives HERE keyed by
// a per-call checkinId, and a SEPARATE request — `POST /api/naby
// {checkin.resolve}` — settles it so the turn resumes with the user's choice.
//
// WHY A PARALLEL MODULE AND NOT A SHARED GENERIC ONE. The two registries settle
// DIFFERENT things: an approval resolves to a `GateDecision` (allow/deny), a
// check-in resolves to a chosen index plus optional free text. Collapsing them
// would mean a payload union that every caller has to narrow, for the sake of
// deduplicating nine lines of Map access. The duplication here is the cheaper
// side of that trade — and the two can now diverge (a check-in has no "always"
// rule to remember) without either growing a flag for the other's case.
//
// Idempotent + leak-safe, same as approvals: the turn side also settles on
// abort/timeout and calls `unregister`, so a resolver never outlives its turn and
// a late `resolve` for a settled id is a harmless no-op.

import type { CheckinAnswer } from '../../../../../../../dist/naby-runtime.mjs';

type Pending = {
  resolve: (answer: CheckinAnswer) => void;
  createdAt: number;
};

// Pinned to globalThis for the same reason approvals are: the paused turn runs in
// the `/api/chat` module realm while `checkin.resolve` arrives in `/api/naby`, and
// Next.js may bundle those routes as separate module instances — a plain
// module-level Map would give each realm its own copy and no resolve would ever
// find the paused promise.
const g = globalThis as unknown as { __nabyPendingCheckins?: Map<string, Pending> };
const pending: Map<string, Pending> = g.__nabyPendingCheckins ?? (g.__nabyPendingCheckins = new Map());

/** Register a paused turn's resolver under `checkinId`. */
export function registerCheckin(
  checkinId: string,
  resolve: (answer: CheckinAnswer) => void,
  createdAt: number,
): void {
  pending.set(checkinId, { resolve, createdAt });
}

/** Settle a pending check-in with the user's answer. Returns false if the id is
 *  unknown (already settled, timed out, or from a dead turn). */
export function resolveCheckin(checkinId: string, answer: CheckinAnswer): boolean {
  const p = pending.get(checkinId);
  if (!p) return false;
  pending.delete(checkinId);
  p.resolve(answer);
  return true;
}

/** Drop a pending entry WITHOUT resolving (the turn side already settled it). */
export function unregisterCheckin(checkinId: string): void {
  pending.delete(checkinId);
}

/** Whether a check-in is currently awaiting an answer. */
export function hasPendingCheckin(checkinId: string): boolean {
  return pending.has(checkinId);
}
