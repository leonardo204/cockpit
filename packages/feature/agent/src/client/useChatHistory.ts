'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import type { ChatMessage, TokenUsage, ChatEngine } from './types';
import { mergeIncrementalMessages } from './mergeIncrementalMessages';
import { Effect } from 'effect';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { AppError } from '@cockpit/effect-core';

// Shared: POST /api/session-by-path — returns null on failure (matches `!response.ok`).
// Also used by SubagentTranscript to fetch subagent transcripts (via toolUseId).
export const postSessionByPath = (body: Record<string, unknown>) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch('/api/session-by-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) return null;
      return (await response.json()) as Record<string, unknown>;
    },
    catch: (cause) => new AppError({ message: 'session-by-path failed', cause }),
  });

// Migrated from src/components/project/useChatHistory.ts. Self-contained:
// only depends on React and on agent types (now local to this package).
// Server endpoints (/api/session-by-path, /api/session/:id/history) are
// referenced via fetch URLs at runtime — no module-level cross-package
// dependency.

// ============================================
// Constants
// ============================================

const TURNS_PER_PAGE = 10;
// Incremental fetch throttle interval (ms)
const INCREMENTAL_THROTTLE_MS = 5_000;

// ============================================
// First-page cache (stale-while-revalidate)
//
// A /api/session-by-path first-page response can be hundreds of KB with no
// HTTP caching — unnoticeable locally (<10ms), but over a tunnel (ngrok)
// every session open re-downloads it in full. Cache the latest first-page
// response per (cwd, sessionId): on a hit, paint the cached content
// immediately and revalidate in the background with ifFingerprint — if the
// session file is unchanged the server returns just { notModified } (a few
// dozen bytes); otherwise the full payload comes back and refreshes the
// cache. Module-level Map: lives as long as the SPA, no persistence (a page
// reload starts empty).
// ============================================
const FIRST_PAGE_CACHE_MAX = 20;
const firstPageCache = new Map<string, { data: SessionPageData; fingerprint: string }>();

// Shape of a /api/session-by-path response (fields the client consumes).
interface SessionPageData {
  notModified?: boolean;
  fingerprint?: string;
  totalTurns?: number;
  hasMore?: boolean;
  messages?: ChatMessage[];
  sessionId?: string;
  title?: string;
  engine?: ChatEngine;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
}

// ============================================
// Types
// ============================================

interface UseChatHistoryOptions {
  cwd?: string;
  initialSessionId?: string;
  onSessionId: (sid: string) => void;
  onTitleChange?: (title: string) => void;
  onTokenUsage?: (usage: TokenUsage) => void;
  // #10: when the live stream is already rendering this run (viewer joined mid-run), the
  // initial (non-incremental) disk load must NOT overwrite the live bubbles — that double-
  // renders the in-flight turn. The live stream + onComplete reconcile own it.
  liveRunningRef?: React.RefObject<boolean>;
}

interface UseChatHistoryReturn {
  isLoadingHistory: boolean;
  isLoadingMore: boolean;
  hasMoreHistory: boolean;
  loadMoreHistory: () => Promise<void>;
  loadHistory: (sid: string) => Promise<void>;
  loadHistoryByCwdAndSessionId: (
    cwd: string,
    sid: string,
    incremental?: boolean,
    limit?: number,
    beforeTurnIndex?: number,
    // Bypass the incremental throttle — used by explicit user jumps
    // (scheduled-tasks panel / recent / pinned sessions), which must always
    // see the latest disk state even if another incremental fetch just ran.
    force?: boolean
  ) => Promise<void>;
  // The sessionId of the JSONL file whose contents are currently
  // displayed in `messages`. Differs from the live `sessionId` (which
  // drifts every time the SDK emits a `system.init`) — operations that
  // reference rendered message ids (e.g. fork) MUST use this one so the
  // server reads the same file the client is looking at.
  loadedSessionId: string | null;
  // Authoritative engine of the loaded session, echoed by /api/session-by-path
  // (resolved server-side by file location). Used by the mobile chat to send on
  // the session's native engine. null until the first successful load.
  loadedEngine: ChatEngine | null;
}

// ============================================
// Hook
// ============================================

export function useChatHistory(
  messages: ChatMessage[],
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  sessionId: string | null,
  { cwd, initialSessionId, onSessionId, onTitleChange, onTokenUsage, liveRunningRef }: UseChatHistoryOptions
): UseChatHistoryReturn {
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [currentTurnIndex, setCurrentTurnIndex] = useState<number | undefined>(undefined);
  const [totalTurns, setTotalTurns] = useState(0);
  // sessionId of the file whose contents currently populate `messages`.
  // Updated whenever a load successfully returns messages.
  const [loadedSessionId, setLoadedSessionId] = useState<string | null>(null);
  // Engine echoed by /api/session-by-path for the loaded session.
  const [loadedEngine, setLoadedEngine] = useState<ChatEngine | null>(null);

  // Use ref to ensure callbacks use the latest reference
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;
  const onTokenUsageRef = useRef(onTokenUsage);
  onTokenUsageRef.current = onTokenUsage;

  // File fingerprint: used for incremental check if file has changed
  const fingerprintRef = useRef<string | undefined>(undefined);
  // Last incremental fetch time: used for throttling
  const lastIncrementalFetchRef = useRef(0);

  // Load history messages by cwd + sessionId
  const loadHistoryByCwdAndSessionId = useCallback(async (
    cwdPath: string,
    sid: string,
    incremental = false,
    limit?: number,
    beforeTurnIndex?: number,
    force = false
  ) => {
    // Direction 2: incremental time throttle — skip if less than N seconds since last fetch.
    // `force` (explicit user jump) bypasses the throttle but still stamps the clock, so the
    // jump can never be silently swallowed by an unrelated fetch that ran moments earlier.
    if (incremental) {
      const now = Date.now();
      if (!force && now - lastIncrementalFetchRef.current < INCREMENTAL_THROTTLE_MS) {
        return;
      }
      lastIncrementalFetchRef.current = now;
    }

    // Apply one /api/session-by-path payload to local state. Shared by the
    // cache-hit fast path and the network response path.
    const applyPage = (data: SessionPageData, viaIncremental: boolean) => {
        // Save file fingerprint
        if (data.fingerprint) {
          fingerprintRef.current = data.fingerprint;
        }

        // Update pagination state
        if (data.totalTurns !== undefined) {
          setTotalTurns(data.totalTurns);
        }
        if (data.hasMore !== undefined) {
          setHasMoreHistory(data.hasMore);
        }

        if (data.messages && data.messages.length > 0) {
          if (viaIncremental) {
            // Incremental update mode: only update changed messages. The response may
            // be a suffix WINDOW (limit=N turns) of the session — mergeIncrementalMessages
            // aligns it by id so pre-window history is never truncated.
            setMessages((prevMessages) =>
              mergeIncrementalMessages(prevMessages, data.messages as ChatMessage[])
            );
          } else {
            // #10: full (initial) load — but if the live stream is already rendering this
            // run (viewer joined mid-run), don't overwrite its bubbles. loadedSessionId is
            // still set below so liveSessionId resolves; live + onComplete reconcile own it.
            //
            // WHAT IS PROTECTED IS THE BUBBLES, NOT THE FLAG. The live flag now also goes
            // up for a turn that has been RESERVED and has not started (§3.3c) — there is
            // nothing on screen to protect in that window, and skipping the load there
            // would leave a session's whole history blank behind the typing indicator
            // until the turn ended. Checked against the rendered messages instead.
            setMessages((prevMessages) =>
              liveRunningRef?.current &&
              prevMessages.some((m) => typeof m.id === 'string' && m.id.startsWith('live-'))
                ? prevMessages
                : (data.messages as ChatMessage[])
            );
          }
          // Track which file the rendered messages came from. Use the sid
          // we actually requested (data.sessionId echoes the request and
          // may be missing in some shapes).
          setLoadedSessionId(sid);
        }
        if (data.sessionId) {
          onSessionId(data.sessionId);
        }
        if (data.engine) {
          setLoadedEngine(data.engine);
        }
        // Notify parent component of title change
        if (data.title) {
          onTitleChangeRef.current?.(data.title);
        }
        // Set token usage info (from last assistant message in history)
        if (data.usage) {
          onTokenUsageRef.current?.({
            inputTokens: data.usage.input_tokens || 0,
            outputTokens: data.usage.output_tokens || 0,
            cacheCreationInputTokens: data.usage.cache_creation_input_tokens || 0,
            cacheReadInputTokens: data.usage.cache_read_input_tokens || 0,
            totalCostUsd: 0, // No cost info in history records
          });
        }
    };

    // First-page cache: only the plain initial load shape (no incremental, no
    // pagination cursor) is cached — that's the request every "open a session"
    // fires and the one that hurts over high-latency links.
    const cacheKey = `${cwdPath}::${sid}`;
    const cacheable = !incremental && beforeTurnIndex === undefined;
    const cached = cacheable ? firstPageCache.get(cacheKey) : undefined;

    if (!incremental) {
      if (cached) {
        // Stale-while-revalidate: paint cached content immediately, then
        // revalidate below with its fingerprint (no loading spinner).
        applyPage(cached.data, false);
      } else {
        setIsLoadingHistory(true);
      }
    }
    try {
      // Direction 3: carry a fingerprint so the server can short-circuit with
      // { notModified } when the session file is unchanged.
      const requestBody: Record<string, unknown> = { cwd: cwdPath, sessionId: sid, limit, beforeTurnIndex };
      if (incremental && fingerprintRef.current) {
        requestBody.ifFingerprint = fingerprintRef.current;
      } else if (cached) {
        requestBody.ifFingerprint = cached.fingerprint;
      }

      const exit = await BrowserRuntime.runPromiseExit(postSessionByPath(requestBody));
      if (exit._tag === 'Success' && exit.value) {
        const data = exit.value as SessionPageData;

        // Direction 3: file unchanged, skip all processing
        if (data.notModified) {
          return;
        }

        applyPage(data, incremental);

        // Refresh the first-page cache (LRU: re-insert, evict oldest over cap)
        if (cacheable && data.fingerprint && data.messages && data.messages.length > 0) {
          firstPageCache.delete(cacheKey);
          firstPageCache.set(cacheKey, { data, fingerprint: data.fingerprint });
          if (firstPageCache.size > FIRST_PAGE_CACHE_MAX) {
            const oldest = firstPageCache.keys().next().value;
            if (oldest !== undefined) firstPageCache.delete(oldest);
          }
        }
      }
    } catch (error) {
      console.error('Failed to load history by cwd and sessionId:', error);
    } finally {
      if (!incremental) {
        setIsLoadingHistory(false);
      }
    }
  }, [setMessages, onSessionId]);

  // Load more history messages (called when scrolling up)
  const loadMoreHistory = useCallback(async () => {
    if (!cwd || !sessionId || isLoadingMore || !hasMoreHistory) return;

    setIsLoadingMore(true);
    try {
      const beforeIndex = currentTurnIndex !== undefined
        ? currentTurnIndex
        : totalTurns - Math.ceil(messages.filter(m => m.role === 'user').length);

      const exit = await BrowserRuntime.runPromiseExit(
        postSessionByPath({
          cwd,
          sessionId,
          limit: TURNS_PER_PAGE,
          beforeTurnIndex: beforeIndex > 0 ? beforeIndex : undefined,
        })
      );

      if (exit._tag === 'Success' && exit.value) {
        const data = exit.value as {
          messages?: ChatMessage[];
          hasMore?: boolean;
          fingerprint?: string;
        };
        if (data.messages && data.messages.length > 0) {
          // Prepend new messages to existing messages
          setMessages(prev => [...data.messages!, ...prev]);
          // Update current turn index
          const loadedTurns = data.messages.filter((m: ChatMessage) => m.role === 'user').length;
          setCurrentTurnIndex(beforeIndex - loadedTurns);
          // Older turns were pulled from the same file the rest of the
          // view already represents — keep loadedSessionId in sync.
          setLoadedSessionId(sessionId);
        }
        if (data.hasMore !== undefined) {
          setHasMoreHistory(data.hasMore);
        }
        // Save fingerprint
        if (data.fingerprint) {
          fingerprintRef.current = data.fingerprint;
        }
      } else if (exit._tag === 'Failure') {
        console.error('Failed to load more history:', exit.cause);
      }
    } finally {
      setIsLoadingMore(false);
    }
  }, [cwd, sessionId, isLoadingMore, hasMoreHistory, currentTurnIndex, totalTurns, messages, setMessages]);

  // Load history messages (by sessionId)
  const loadHistory = useCallback(async (sid: string) => {
    setIsLoadingHistory(true);
    const historyEff = Effect.tryPromise({
      try: async () => {
        const response = await fetch(`/api/session/${sid}/history`);
        if (!response.ok) return null;
        return (await response.json()) as { messages?: ChatMessage[] };
      },
      catch: (cause) => new AppError({ message: 'load session history failed', cause }),
    });
    const exit = await BrowserRuntime.runPromiseExit(historyEff);
    if (exit._tag === 'Success' && exit.value?.messages && exit.value.messages.length > 0) {
      setMessages(exit.value.messages);
      setLoadedSessionId(sid);
    } else if (exit._tag === 'Failure') {
      console.error('Failed to load history:', exit.cause);
    }
    setIsLoadingHistory(false);
  }, [setMessages]);

  /**
   * THE SESSION'S CONVERSATION, loaded once per session.
   *
   * IT USED TO BE `[]` — read at mount and never again — and that was the empty
   * chat. A tab does not necessarily know its session at mount: the one a
   * project opens on is adopted a moment later, when the saved project state
   * comes back, so `initialSessionId` was `undefined` on the only render this
   * effect ever looked at.
   *
   * The failure then fed itself. `Chat`'s own `sessionId` state is set by the
   * RESPONSE to this load (`onSessionId`), so with no load there was no session
   * id, and the activation fetch beside it skipped for want of one. Nothing
   * broke the loop until the user sent a message — which is why the history
   * appeared only after starting a new conversation.
   *
   * The ref keeps the "once" that the empty array was there for: this reacts to
   * the id ARRIVING, not to every render, and re-fetching is the job of the
   * activation effect and the explicit-jump path, both of which know when the
   * disk may have moved on.
   */
  const loadedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!cwd || !initialSessionId) return;
    if (loadedForRef.current === initialSessionId) return;
    loadedForRef.current = initialSessionId;
    loadHistoryByCwdAndSessionId(cwd, initialSessionId, false, TURNS_PER_PAGE);
  }, [cwd, initialSessionId, loadHistoryByCwdAndSessionId]);

  return {
    isLoadingHistory,
    isLoadingMore,
    hasMoreHistory,
    loadMoreHistory,
    loadHistory,
    loadHistoryByCwdAndSessionId,
    loadedSessionId,
    loadedEngine,
  };
}
