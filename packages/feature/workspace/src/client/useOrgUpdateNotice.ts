'use client';

// packages/feature/workspace/src/client/useOrgUpdateNotice.ts
//
// The org harness update popup's data (org-harness-sync §3.1): read from the
// `/ws/global-state` push the sidebar already listens to (one shared socket per
// URL — this is another listener, not another connection).
//
// WHY THE PUSH. The server re-sends that snapshot on every store write. The sync
// recording a notice is a settings write, and so is an ack from any window, so
// every open window learns of both within the push debounce: a popup shows in
// each window once, and dismissing it in one window retires it in all of them.
// A restart reads the same settings row, so it never shows twice for a version.
//
// The local `dismissed` set only hides the card at once in THIS window, before
// the next push confirms the ack.

import { useCallback, useState } from 'react';
import { useWebSocket } from '@cockpit/shared-ui';
import {
  announceConnectionsChanged,
  orgUpdateFromPush,
  visibleOrgUpdate,
  type OrgUpdateNoticeView,
} from '@cockpit/feature-agent';

async function ackOrgUpdate(version: string): Promise<void> {
  try {
    await fetch('/api/naby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'orgHarness.ackUpdate', version }),
    });
  } catch {
    /* the popup comes back on the next push; nothing else to do */
  }
}

export function useOrgUpdateNotice({ enabled = true }: { enabled?: boolean } = {}): {
  notice: OrgUpdateNoticeView | null;
  dismiss: (version: string) => void;
} {
  const [notice, setNotice] = useState<OrgUpdateNoticeView | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());

  // ONE identity for the hook's lifetime: `useWebSocket` shares a connection per
  // URL and a changing listener would churn it.
  const onMessage = useCallback((raw: unknown) => {
    try {
      const next = orgUpdateFromPush(raw);
      if (next !== undefined) setNotice(next);
    } catch {
      /* a malformed push is not worth a broken workspace */
    }
  }, []);

  useWebSocket({ url: '/ws/global-state', enabled, onMessage });

  const dismiss = useCallback((version: string) => {
    setDismissed((prev) => new Set(prev).add(version));
    void ackOrgUpdate(version).then(() => announceConnectionsChanged());
  }, []);

  return { notice: visibleOrgUpdate(notice, dismissed), dismiss };
}
