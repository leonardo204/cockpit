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

type Pending = {
  resolve: (decision: GateDecision) => void;
  createdAt: number;
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
  resolve: (decision: GateDecision) => void,
  createdAt: number,
): void {
  pending.set(approvalId, { resolve, createdAt });
}

/** Settle a pending approval with a decision. Returns false if the id is unknown
 *  (already settled, timed out, or from a dead turn). */
export function resolveApproval(approvalId: string, decision: GateDecision): boolean {
  const p = pending.get(approvalId);
  if (!p) return false;
  pending.delete(approvalId);
  p.resolve(decision);
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
