/**
 * pendingMemory.ts — the memory a turn just proposed, offered where it happened.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THERE IS A BUTTON AND NOT A TOOL
 *
 * A memory captured from conversation is written `proposed` and `artifact`-tier,
 * and it stays that way until a PERSON agrees to it. That is not caution for its
 * own sake: `naby_remember` cannot tell an instruction the user gave from a fact
 * naby inferred, and promoting on the model's say-so would let it choose which
 * tier judges its own writes — the failure this codebase already fixed once in
 * the voice layer, where a rewrite could buy a looser band by mixing in a few
 * characters.
 *
 * So the confirm could not be a tool. `confirmMemory` is documented as "the ONLY
 * path external-origin memory becomes confirmed… a threshold can never do it,
 * only a user", and a tool call is the model, however faithfully it reports what
 * the user just said. The click is the user, through the same HTTP action the
 * settings screen uses.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AND WHY THE TURN IS NOT SUSPENDED
 *
 * Tool approvals pause the turn because the answer decides what happens next.
 * Nothing waits on this one — the turn's work is done either way, and blocking
 * it to ask "shall I remember that you like polite answers?" would interrupt the
 * thing the user actually asked for. The offer sits in the transcript and is
 * answered whenever they feel like it.
 *
 * `naby_checkin` was the other candidate and is deliberately NOT reused: it
 * writes to the trust ledger, so a "shall I remember this?" question would be
 * scored as a prediction about the user's preferences and would move the meter.
 */

/** The tool whose result this reads. Named once so the renderer and the tests
 *  cannot disagree about which call carries an offer. */
export const REMEMBER_TOOL = 'naby_remember';

export interface PendingMemory {
  /** The row to confirm. */
  id: string;
  /** Its slug, for a label the reader can recognise. */
  key: string;
}

/**
 * The offer a `naby_remember` result carries, or null when there is nothing to
 * offer.
 *
 * Null for a call that is still running, one that failed, and — the case worth
 * naming — one whose memory is ALREADY `confirmed`. The write gate can confirm
 * on the spot when the claim is corroborated across sessions, and a button that
 * asks for agreement already given is a button that does nothing.
 *
 * Total: this reads a payload that crossed a JSON boundary, and a shape it does
 * not recognise must produce no button rather than throw inside a render.
 */
export function pendingMemoryOf(
  toolName: string,
  resultData: unknown,
): PendingMemory | null {
  if (toolName !== REMEMBER_TOOL) return null;
  // ABSENT IS THE ORDINARY CASE, not an error: a live turn carries only the
  // prose (the stream has no structured half), and every tool that is not this
  // one has nothing to offer. Both simply produce no button.
  if (!resultData || typeof resultData !== 'object') return null;
  const row = resultData as Record<string, unknown>;
  if (row.status !== 'proposed') return null;
  // memory-auto-apply: a write waiting for its REVIEW is not waiting for the
  // user — the review decides, and the button would pre-empt it (R11).
  if (row.review === 'pending' || row.review === 'known') return null;
  const id = typeof row.id === 'string' ? row.id : '';
  const key = typeof row.key === 'string' ? row.key : '';
  if (!id) return null;
  return { id, key: key || id };
}

// ─────────────────────────────────────────────────────────────────────────────
// MEMORY AUTO-APPLY (specs/memory-auto-apply.md §3)
//
// Most writes no longer need the button. A write the evidence rule made eligible
// is reviewed right after the turn and then used — so the call shows what became
// of it ("기억하는 중…" → "기억했어요" / "이미 알고 있어요" / "기억을 바꿨어요"),
// with an undo (R10). The button stays for the writes that are HELD for a person
// (outside content, a fact about the user with no quote, a quote nobody typed —
// R11), with the reason beside it.
// ─────────────────────────────────────────────────────────────────────────────

/** What one `naby_remember` call wrote, read off its structured result. */
export interface MemoryWrite {
  id: string;
  key: string;
  value?: string;
  /** `pending` = waiting for its review; `held` = waiting for a person;
   *  `known` = nothing written, the same claim was already in use. A write from
   *  before memory-auto-apply (no `review` field) reads as `held` when proposed. */
  review: 'pending' | 'held' | 'known';
  /** Why a held write is held (memory-gate `MemoryHoldReason`). */
  holdReason?: string;
}

/** The write a `naby_remember` result describes, or null. Total, like
 *  `pendingMemoryOf`: a shape it does not know produces nothing. */
export function memoryWriteOf(toolName: string, resultData: unknown): MemoryWrite | null {
  if (toolName !== REMEMBER_TOOL && !toolName.endsWith(`__${REMEMBER_TOOL}`)) return null;
  if (!resultData || typeof resultData !== 'object') return null;
  const row = resultData as Record<string, unknown>;
  const id = typeof row.id === 'string' ? row.id : '';
  if (!id) return null;
  const key = typeof row.key === 'string' && row.key ? row.key : id;
  const value = typeof row.value === 'string' ? row.value : undefined;
  const base = { id, key, ...(value !== undefined ? { value } : {}) };
  if (row.review === 'pending' || row.review === 'known') return { ...base, review: row.review };
  if (row.review === 'held' || row.status === 'proposed') {
    return {
      ...base,
      review: 'held',
      ...(typeof row.holdReason === 'string' ? { holdReason: row.holdReason } : {}),
    };
  }
  return null;
}

/** The server's answer for one memory (`/api/memory` `reviewStatus`). */
export type MemoryReviewState =
  | { state: 'pending' }
  | { state: 'held'; reason?: string; summary?: string }
  | { state: 'applied'; value: string; summary?: string; undone?: boolean }
  | { state: 'known'; value: string }
  | { state: 'changed'; value: string; oldValue: string; summary?: string; oldSummary?: string; undone?: boolean }
  | { state: 'question' }
  | { state: 'gone' };

/** Taller than three lines (runtime MEMORY_SUMMARY_MIN_*; a client bundle
 *  cannot import the runtime). */
export function memoryNeedsSummary(value: string): boolean {
  return value.length > 120 || value.split('\n').length > 3;
}

/** Keep asking the server? While the review is out, or while a long memory still
 *  waits for its summary. Outside content is never summarized. */
export function memoryChipShouldPoll(write: MemoryWrite, latest: MemoryReviewState | undefined): boolean {
  const state = latest?.state ?? (write.review === 'pending' ? 'pending' : '');
  if (state === 'pending') return true;
  if (state !== 'held' && state !== 'applied' && state !== 'changed') return false;
  const text = (latest && 'value' in latest ? latest.value : undefined) ?? write.value ?? '';
  return !(latest as { summary?: string } | undefined)?.summary && write.holdReason !== 'external' && memoryNeedsSummary(text);
}

/** What the chip draws. */
export type MemoryChipView =
  | { kind: 'pending'; canCancel: true }
  | { kind: 'applied'; value: string; canCancel: true }
  | { kind: 'known'; value: string }
  | { kind: 'changed'; value: string; oldValue: string; canCancel: true }
  | { kind: 'held'; reason?: string; summary?: string; canConfirm: true }
  | { kind: 'question' }
  | { kind: 'undone' }
  | { kind: 'none' };

/**
 * Decide what the chip shows from the write and the latest server state. Pure.
 *
 * The server's answer wins once it exists; before the first answer arrives the
 * write's own `review` is drawn, so the chip appears with the call instead of a
 * moment later. `gone` draws nothing — the memory was deleted elsewhere, and a
 * chip about it would describe something that no longer exists.
 */
export function memoryChipView(write: MemoryWrite, status: MemoryReviewState | undefined): MemoryChipView {
  if (!status) {
    if (write.review === 'pending') return { kind: 'pending', canCancel: true };
    if (write.review === 'known') return { kind: 'known', value: write.value ?? write.key };
    return { kind: 'held', ...(write.holdReason ? { reason: write.holdReason } : {}), canConfirm: true };
  }
  switch (status.state) {
    case 'pending':
      return { kind: 'pending', canCancel: true };
    case 'applied':
      return status.undone ? { kind: 'undone' } : { kind: 'applied', value: status.summary || status.value || write.value || write.key, canCancel: true };
    case 'known':
      return { kind: 'known', value: status.value };
    case 'changed':
      return status.undone
        ? { kind: 'undone' }
        : {
            kind: 'changed',
            value: status.summary ?? status.value,
            oldValue: status.oldSummary ?? status.oldValue,
            canCancel: true,
          };
    case 'held': {
      const reason = status.reason ?? write.holdReason;
      return {
        kind: 'held',
        ...(reason ? { reason } : {}),
        ...(status.summary ? { summary: status.summary } : {}),
        canConfirm: true,
      };
    }
    case 'question':
      return { kind: 'question' };
    case 'gone':
    default:
      return { kind: 'none' };
  }
}
