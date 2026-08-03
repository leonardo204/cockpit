'use client';

/**
 * The TEMPORARY-SESSION set (Phase 3 P3-M10, memory-hygiene §3).
 *
 * A session marked `noLearn` teaches naby nothing: no `naby_remember`, no
 * learning instruction, no growth observation, no check-in, and the reflection
 * sweep skips it entirely (see engines/naby.ts and lib/reflection.ts — this hook
 * only carries the flag to and from the UI).
 *
 * WHY THE WHOLE SET IN ONE REQUEST, rather than a per-tab read. The tab bar has
 * to badge every affected tab, and tabs appear in batches — restoring pinned
 * sessions on project open creates several at once. One list request answers all
 * of them; N per-tab requests would fire N times on that one event and still
 * leave a tab unbadged if its request lost a race.
 *
 * IT IS THE SERVER'S ANSWER THAT COUNTS. The toggle updates local state
 * OPTIMISTICALLY (the menu must respond to the click) and then re-reads, so a
 * write that failed puts the badge back where the database says it is rather
 * than leaving the UI claiming a privacy property that was never stored.
 *
 * Plain `fetch`, matching the sibling naby panels (NabyMemoryReview,
 * NabyProviderSetup) rather than the Effect query helpers: these are one-shot
 * settings reads on a local server, and consistency with the code next to it is
 * worth more here than a second pattern.
 */

import { useCallback, useEffect, useState } from 'react';

async function nabyPost(
  body: Record<string, unknown>,
): Promise<{ ok: boolean; noLearnSessions?: string[]; noLearn?: boolean }> {
  try {
    const res = await fetch('/api/naby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false };
    const json = (await res.json().catch(() => null)) as {
      noLearnSessions?: string[];
      noLearn?: boolean;
    } | null;
    return { ok: true, ...(json ?? {}) };
  } catch {
    // A failed read leaves the previous answer in place. The alternative —
    // clearing the set — would silently un-badge every temporary session on one
    // dropped request, which is exactly the wrong direction to fail in.
    return { ok: false };
  }
}

export function useNoLearnSessions() {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());

  const refresh = useCallback(async () => {
    const res = await nabyPost({ action: 'session.noLearn.list' });
    if (res.ok && Array.isArray(res.noLearnSessions)) setIds(new Set(res.noLearnSessions));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Whether nothing is learned from this session. A tab with no session id yet
   *  is never temporary — there is no row to have marked. */
  const isNoLearn = useCallback(
    (sessionId: string | undefined): boolean => (sessionId ? ids.has(sessionId) : false),
    [ids],
  );

  const setNoLearn = useCallback(
    async (sessionId: string, noLearn: boolean) => {
      // Optimistic first — the context menu closes on click and the badge has to
      // be right by the time the tab is visible again.
      setIds((prev) => {
        const next = new Set(prev);
        if (noLearn) next.add(sessionId);
        else next.delete(sessionId);
        return next;
      });
      await nabyPost({ action: 'session.noLearn.set', sessionId, noLearn });
      // Reconciled against the server, which is what makes a failed write show.
      await refresh();
    },
    [refresh],
  );

  return { isNoLearn, setNoLearn, refresh };
}
