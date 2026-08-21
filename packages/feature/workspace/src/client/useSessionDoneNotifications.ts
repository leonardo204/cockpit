'use client';

// packages/feature/workspace/src/client/useSessionDoneNotifications.ts
//
// The wiring for `sessionDoneNotify.ts`: subscribe to the global-state push the
// sidebar already listens to, and report each `unread` EDGE to the desktop.
//
// ONE EDGE IS ONE REPORT, NOT ONE BANNER. The main process keeps at most one
// banner alive and replaces it with a counted successor as further runs finish,
// which is what stopped ten Telegram turns from becoming ten identical banners
// at unlock. So this file's job is to be an accurate and unembellished census of
// endings; the aggregation is somewhere it can outlive a window.
//
// IT OPENS NO NEW CONNECTION. `useWebSocket` shares one socket per URL (the
// sidebar's own comment says so, and its handler identity is kept stable for
// exactly that reason), so this is a third listener on a socket that is already
// there rather than a third socket.
//
// EVERY DECISION IS IN THE PURE MODULE. This file holds the state that cannot be
// pure — the last-seen statuses and the ref indirections — and nothing else.

import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useWebSocket } from '@cockpit/shared-ui';
import {
  newlyDoneSessions,
  notifiableFinishedSessions,
  notifySessionDone,
  rememberStatuses,
  type SessionStatusRow,
} from './sessionDoneNotify';

export interface SessionDoneNotificationsOptions {
  /**
   * The session the user is actually looking at, read at notification time.
   *
   * A GETTER rather than a value: the visible session lives in a ref in
   * `Workspace` (it arrives by postMessage from the project iframe and must not
   * re-render the whole workspace), and a stale closure here would suppress the
   * wrong banner — or fail to suppress the right one.
   */
  getVisibleSessionId: () => string | undefined;
  /** Off in a plain browser, or wherever the caller has no desktop bridge. */
  enabled?: boolean;
}

export function useSessionDoneNotifications({
  getVisibleSessionId,
  enabled = true,
}: SessionDoneNotificationsOptions): void {
  const { i18n } = useTranslation();

  /** Last status seen per session. Absent = never seen, which is deliberately
   *  NOT a transition (see `newlyDoneSessions`). */
  const seenRef = useRef<Map<string, string>>(new Map());

  const visibleRef = useRef(getVisibleSessionId);
  useEffect(() => {
    visibleRef.current = getVisibleSessionId;
  });

  const languageRef = useRef(i18n.language);
  useEffect(() => {
    languageRef.current = i18n.language;
  });

  // ONE identity for the lifetime of the hook: `useWebSocket` shares a
  // connection per URL and a changing listener would churn it.
  const handleMessage = useCallback((raw: unknown) => {
    try {
      const parsed = raw as { type?: string; data?: { sessions?: SessionStatusRow[] } };
      const rows = parsed?.data?.sessions;
      if (!Array.isArray(rows)) return;

      const previous = seenRef.current;
      const finished = newlyDoneSessions(previous, rows);
      // Remembered BEFORE anything is shown, so a throw in the loop below cannot
      // leave the same edge waiting to fire again on the next push.
      seenRef.current = rememberStatuses(previous, rows);

      const visibleSessionId = visibleRef.current();
      const appFocused = typeof document !== 'undefined' && document.hasFocus();
      // The judgement is all in the pure module; what is left here is the call.
      // ONE call per finished run, on purpose — main tallies the calls to decide
      // what its single replaceable banner says (electron/notifications.ts), so
      // collapsing a batch here would make the count say less than the truth.
      const worthTelling = notifiableFinishedSessions({
        finished,
        appFocused,
        ...(visibleSessionId ? { visibleSessionId } : {}),
      });
      for (const row of worthTelling) {
        notifySessionDone(row, languageRef.current);
      }
    } catch {
      // A malformed push is not worth a broken workspace.
    }
  }, []);

  useWebSocket({
    url: '/ws/global-state',
    enabled,
    onMessage: handleMessage,
  });
}
