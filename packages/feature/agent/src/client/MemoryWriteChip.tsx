'use client';

/**
 * MemoryWriteChip — what became of one `naby_remember` call (memory-auto-apply §3).
 *
 *   기억하는 중… · 취소            the write waits for its review (R36)
 *   기억했어요: ‹내용› · 취소       reviewed and in use (R10)
 *   이미 알고 있어요                the same claim was already remembered (R41)
 *   기억을 바꿨어요: ‹A› → ‹B› · 취소  it replaced or refined an older memory (R10, R17a)
 *   기억할까요? + 이유 한 줄        held for the user (R11)
 *   고정했어요: ‹요약› · 취소        anchored on request (memory-tiers R6)
 *   자주 말씀하신 걸 고정했어요 · 취소 anchored from restatements (R6)
 *   고정 기억 ‹요약›과 달라서 … · 새 내용으로 바꾸기  an anchored memory won (R19)
 *
 * The rule for WHAT to draw is pure and lives in pendingMemory.ts
 * (`memoryChipView`); this file only fetches the server's answer and draws it.
 *
 * WHY IT POLLS. The review runs after the turn, fire-and-forget (R37) — there is
 * no event to wait for once the turn's stream has closed. So while the chip says
 * "기억하는 중…" it asks `/api/memory` every few seconds, bounded, and stops the
 * moment the answer settles. A settled chip asks once, on mount, so a reloaded
 * transcript shows the memory as it is now rather than as it was written.
 *
 * Plain `fetch`, matching the confirm it replaces and the sibling memory panels.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';
import { memoryChipShouldPoll, memoryChipView, type MemoryReviewState, type MemoryWrite } from './pendingMemory';

/** How often a pending chip asks, and for how long at most (~3 minutes). */
const POLL_MS = 2_500;
const POLL_MAX = 72;

async function memoryPost(body: Record<string, unknown>): Promise<{ ok: boolean; json: Record<string, unknown> | null }> {
  try {
    const res = await fetch('/api/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: res.ok, json };
  } catch {
    return { ok: false, json: null };
  }
}

export const MemoryWriteChip = memo(function MemoryWriteChip({ write }: { write: MemoryWrite }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<MemoryReviewState | undefined>(undefined);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const polls = useRef(0);

  const view = useMemo(() => memoryChipView(write, status), [write, status]);

  const refresh = useCallback(async (): Promise<MemoryReviewState | undefined> => {
    const { ok, json } = await memoryPost({ action: 'reviewStatus', ids: [write.id] });
    if (!ok || !json) return undefined;
    const statuses = Array.isArray(json.statuses) ? (json.statuses as (MemoryReviewState & { id: string })[]) : [];
    const mine = statuses.find((s) => s.id === write.id);
    if (mine) setStatus(mine);
    return mine;
  }, [write.id]);

  // Ask once on mount, then keep asking only while the review is still out.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const latest = await refresh();
      if (cancelled) return;
      polls.current += 1;
      if (memoryChipShouldPoll(write, latest) && polls.current < POLL_MAX) timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refresh, write.review, write.value, write.holdReason]);

  const cancel = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const { ok } = await memoryPost({ action: 'cancel', id: write.id });
    if (!ok) toast(t('chat.memoryChip.cancelFailed', { defaultValue: 'Could not undo that.' }), 'error');
    await refresh();
    setBusy(false);
  }, [busy, write.id, refresh, t]);

  // memory-tiers R6: the undo of an anchoring — back to long-term, never deleted.
  const unanchor = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const { ok } = await memoryPost({ action: 'unanchorChip', id: write.id });
    if (!ok) toast(t('chat.memoryChip.cancelFailed', { defaultValue: 'Could not undo that.' }), 'error');
    await refresh();
    setBusy(false);
  }, [busy, write.id, refresh, t]);

  // memory-tiers R19: the anchored memory takes the new words.
  const replaceAnchored = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const { ok } = await memoryPost({ action: 'replaceAnchored', id: write.id });
    if (!ok) toast(t('chat.memoryChip.replaceFailed', { defaultValue: 'Could not change the pinned memory.' }), 'error');
    await refresh();
    setBusy(false);
  }, [busy, write.id, refresh, t]);

  const confirm = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const { ok } = await memoryPost({ action: 'confirm', id: write.id });
    // A failed confirm leaves the offer standing: the memory is still waiting.
    if (ok) setConfirmed(true);
    setBusy(false);
  }, [busy, write.id]);

  if (view.kind === 'none') return null;

  const chipClass = 'ml-6 mb-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 px-2 text-[0.786rem] text-muted-foreground';
  const cancelButton = (
    <button
      type="button"
      onClick={() => void cancel()}
      disabled={busy}
      data-testid="memory-chip-cancel"
      className="text-brand hover:text-brand/80 disabled:opacity-50"
    >
      {t('chat.memoryChip.cancel', { defaultValue: 'Undo' })}
    </button>
  );

  if (view.kind === 'held') {
    return (
      <div className={chipClass} data-testid="memory-chip">
        {(view.summary || write.value) && (
          // R47: the short line when there is one. The tool card above holds the
          // full text; the tooltip saves opening it.
          <span className="min-w-0 max-w-full break-words line-clamp-3" title={write.value} data-testid="memory-chip-summary">
            {view.summary ?? write.value}
          </span>
        )}
        <button
          type="button"
          onClick={() => void confirm()}
          disabled={busy || confirmed}
          data-testid="confirm-memory"
          className="px-2 py-0.5 rounded-full border border-brand/50 text-brand hover:bg-brand/10 transition-colors disabled:opacity-60"
          title={t('chat.confirmMemoryHint', {
            defaultValue:
              'Agree to this, and naby will use it from now on — and it will outrank anything naby merely inferred.',
          })}
        >
          {confirmed
            ? t('chat.memoryConfirmed', { defaultValue: 'Remembered' })
            : t('chat.confirmMemory', { defaultValue: 'Remember this' })}
        </button>
        {!confirmed && view.reason && (
          <span data-testid="memory-hold-reason">
            {t(`chat.memoryHold.${view.reason}`, { defaultValue: t('chat.memoryHold.default') })}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className={chipClass} data-testid="memory-chip">
      {view.kind === 'pending' && (
        <>
          <span>{t('chat.memoryChip.pending', { defaultValue: 'Remembering…' })}</span>
          <span aria-hidden>·</span>
          {cancelButton}
        </>
      )}
      {view.kind === 'applied' && (
        <>
          <span className="min-w-0 break-words line-clamp-3">
            {t('chat.memoryChip.applied', { defaultValue: 'Remembered: {{value}}', value: view.value })}
          </span>
          <span aria-hidden>·</span>
          {cancelButton}
        </>
      )}
      {view.kind === 'known' && <span>{t('chat.memoryChip.known', { defaultValue: 'Already knew that' })}</span>}
      {view.kind === 'changed' && (
        <>
          <span className="min-w-0 break-words line-clamp-3">
            {t('chat.memoryChip.changed', {
              defaultValue: 'Changed what I remember: {{old}} → {{new}}',
              old: view.oldValue,
              new: view.value,
            })}
          </span>
          <span aria-hidden>·</span>
          {cancelButton}
        </>
      )}
      {view.kind === 'question' && (
        <span>{t('chat.memoryChip.question', { defaultValue: 'I will ask you about this later' })}</span>
      )}
      {view.kind === 'undone' && <span>{t('chat.memoryChip.undone', { defaultValue: 'Undone' })}</span>}
      {view.kind === 'anchored' && (
        <>
          <span className="min-w-0 break-words line-clamp-3" data-testid="memory-chip-anchored">
            {view.origin === 'auto'
              ? t('chat.memoryChip.anchoredAuto', { defaultValue: 'Pinned what you keep telling me: {{value}}', value: view.value })
              : t('chat.memoryChip.anchoredExplicit', { defaultValue: 'Pinned: {{value}}', value: view.value })}
          </span>
          <span aria-hidden>·</span>
          <button
            type="button"
            onClick={() => void unanchor()}
            disabled={busy}
            data-testid="memory-chip-unanchor"
            className="text-brand hover:text-brand/80 disabled:opacity-50"
          >
            {t('chat.memoryChip.cancel', { defaultValue: 'Undo' })}
          </button>
        </>
      )}
      {view.kind === 'unanchored' && (
        <span>{t('chat.memoryChip.unanchored', { defaultValue: 'Unpinned' })}</span>
      )}
      {view.kind === 'anchored-conflict' && (
        <>
          <span className="min-w-0 break-words line-clamp-3" data-testid="memory-chip-anchored-conflict">
            {t('chat.memoryChip.anchoredConflict', {
              defaultValue: 'That differs from the pinned memory {{anchored}}, so I will follow the pinned one',
              anchored: view.anchoredValue,
            })}
          </span>
          <span aria-hidden>·</span>
          <button
            type="button"
            onClick={() => void replaceAnchored()}
            disabled={busy}
            data-testid="memory-chip-replace-anchored"
            className="text-brand hover:text-brand/80 disabled:opacity-50"
          >
            {t('chat.memoryChip.replaceAnchored', { defaultValue: 'Use the new one instead' })}
          </button>
        </>
      )}
      {view.kind === 'anchored-replaced' && (
        <span className="min-w-0 break-words line-clamp-3">
          {t('chat.memoryChip.anchoredReplaced', { defaultValue: 'Changed the pinned memory: {{value}}', value: view.value })}
        </span>
      )}
    </div>
  );
});
