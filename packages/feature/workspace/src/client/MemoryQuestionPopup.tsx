'use client';

/**
 * MemoryQuestionPopup — naby asking about two memories that disagree
 * (memory-auto-apply §5, R26/R27).
 *
 * WHAT IT IS NOT. It is not in the transcript (a question about memory is not
 * part of the conversation), not a modal (it never blocks input), never takes
 * focus, and never pauses a turn. It is a small panel in the bottom-right of the
 * app window, above the project iframes and below the onboarding / what's-new
 * overlays (z-40 vs their z-50/z-[60]) — mounted at the workspace level, so it
 * sits outside the three-panel swipe layout entirely and cannot spill into a
 * neighbouring panel.
 *
 * WHEN IT RAISES ITSELF is decided by `shouldAutoShowMemoryQuestion`
 * (memoryQuestionPopup.ts) — once a day, five minutes after launch, never while a
 * turn runs or the user types, never over a temporary or fast-growth session.
 * Unanswered for 20 s, it folds into a dot on the Settings entry point; the dot
 * re-opens it. Two unanswered folds, or "나중에", snooze the question for a week.
 * Answering one question brings up the next (R26) — the user is already answering.
 *
 * The answers go to `/api/memory` and never touch the trust ledger (R28).
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast, useWebSocket } from '@cockpit/shared-ui';
import type { GlobalSession } from '@cockpit/feature-agent';
import { MemoryChoiceCard } from './MemoryChoiceCard';
import {
  autoShowableQuestions,
  isUserTyping,
  POPUP_AUTO_COLLAPSE_MS,
  shouldAutoShowMemoryQuestion,
} from './memoryQuestionRules';

type Side = { id?: string; key: string; value: string; learnedAt: number };
type QuestionView = {
  id: string;
  kind: 'conflict' | 'overwrite';
  a: Side;
  b: Side;
  createdAt: number;
  shownCount: number;
  snoozedUntil?: number;
};

type ListResponse = {
  questions?: QuestionView[];
  lastAutoShownAt?: number;
  suppressed?: boolean;
};

/** How often the queue is re-read, and how often the show rule is re-checked. */
const REFRESH_MS = 60_000;
const CHECK_MS = 15_000;

/** When this module loaded = when the app window started (R27: 5 minutes). */
const APP_STARTED_AT = Date.now();

async function memoryPost(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch('/api/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

export type MemoryQuestionPopupProps = {
  /** The visible project — a turn running in it holds the popup back. */
  activeCwd?: string;
  /** The visible tab's session — the server says whether it suppresses (R27). */
  activeSessionId?: string;
  /** Folded into the Settings entry point (true) or not. */
  onDotChange?: (hasDot: boolean) => void;
  /** Bumped by the workspace when the dot is clicked: re-open. */
  reopenSignal?: number;
};

export const MemoryQuestionPopup = memo(function MemoryQuestionPopup({
  activeCwd,
  activeSessionId,
  onDotChange,
  reopenSignal,
}: MemoryQuestionPopupProps) {
  const { t, i18n } = useTranslation();
  const [questions, setQuestions] = useState<QuestionView[]>([]);
  const [mode, setMode] = useState<'hidden' | 'open' | 'dot'>('hidden');
  const [answered, setAnswered] = useState(0);
  const [busy, setBusy] = useState(false);
  const stateRef = useRef<{ lastAutoShownAt?: number; suppressed: boolean }>({ suppressed: false });
  const sessionsRef = useRef<GlobalSession[]>([]);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const touched = useRef(false);

  // Which tabs are running, from the same broadcast the sidebar reads.
  const onGlobalState = useCallback((msg: unknown) => {
    const parsed = msg as { data?: { sessions?: GlobalSession[] } };
    if (parsed?.data?.sessions) sessionsRef.current = parsed.data.sessions;
  }, []);
  useWebSocket({ url: '/ws/global-state', onMessage: onGlobalState });

  const refresh = useCallback(async (): Promise<QuestionView[]> => {
    const json = (await memoryPost({
      action: 'questions.list',
      ...(activeSessionId ? { sessionId: activeSessionId } : {}),
    })) as ListResponse | null;
    if (!json) return [];
    const list = Array.isArray(json.questions) ? json.questions : [];
    stateRef.current = {
      ...(typeof json.lastAutoShownAt === 'number' ? { lastAutoShownAt: json.lastAutoShownAt } : {}),
      suppressed: json.suppressed === true,
    };
    setQuestions(list);
    return list;
  }, [activeSessionId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const clearCollapse = useCallback(() => {
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
    collapseTimer.current = undefined;
  }, []);

  // The show rule, re-checked every few seconds while the popup is hidden.
  useEffect(() => {
    if (mode !== 'hidden') return;
    const check = () => {
      const now = Date.now();
      const turnRunning = sessionsRef.current.some(
        (s) => s.status === 'loading' && (!activeCwd || s.cwd === activeCwd),
      );
      const show = shouldAutoShowMemoryQuestion({
        now,
        appStartedAt: APP_STARTED_AT,
        ...(stateRef.current.lastAutoShownAt !== undefined
          ? { lastAutoShownAt: stateRef.current.lastAutoShownAt }
          : {}),
        turnRunning,
        typing: isUserTyping(typeof document === 'undefined' ? null : document),
        suppressed: stateRef.current.suppressed,
        questions,
      });
      if (!show) return;
      stateRef.current = { ...stateRef.current, lastAutoShownAt: now };
      void memoryPost({ action: 'questions.autoShown' });
      touched.current = false;
      setAnswered(0);
      setMode('open');
      // Unanswered for 20 s: fold into the dot, and count it (two in a row snooze).
      clearCollapse();
      collapseTimer.current = setTimeout(() => {
        if (touched.current) return;
        const first = autoShowableQuestions(questions, Date.now())[0];
        if (first) void memoryPost({ action: 'questions.collapsed', id: first.id });
        setMode('dot');
      }, POPUP_AUTO_COLLAPSE_MS);
    };
    const timer = setInterval(check, CHECK_MS);
    return () => clearInterval(timer);
  }, [mode, questions, activeCwd, clearCollapse]);

  useEffect(() => () => clearCollapse(), [clearCollapse]);

  // The dot lives on the Settings entry point; tell the workspace.
  useEffect(() => {
    onDotChange?.(mode === 'dot' && questions.length > 0);
  }, [mode, questions.length, onDotChange]);

  // A click on the dot re-opens (a manual open is not counted against the day).
  useEffect(() => {
    if (!reopenSignal) return;
    touched.current = true;
    clearCollapse();
    if (questions.length > 0) setMode('open');
  }, [reopenSignal, questions.length, clearCollapse]);

  const touch = useCallback(() => {
    touched.current = true;
    clearCollapse();
  }, [clearCollapse]);

  const current = questions[0];

  const answer = useCallback(
    async (choice: 'a' | 'b' | 'both' | 'later') => {
      if (!current || busy) return;
      touch();
      setBusy(true);
      const json = await memoryPost({ action: 'questions.answer', id: current.id, answer: choice });
      setBusy(false);
      if (!json) {
        toast(t('memoryQuestion.answerFailed', { defaultValue: 'Could not save the answer.' }), 'error');
        return;
      }
      const rest = Array.isArray(json.questions) ? (json.questions as QuestionView[]) : [];
      setQuestions(rest);
      // "Later" ends the run of questions; an answer moves to the next one (R26).
      if (choice === 'later' || rest.length === 0) {
        setMode('hidden');
        setAnswered(0);
      } else {
        setAnswered((n) => n + 1);
      }
    },
    [current, busy, touch, t],
  );

  if (mode !== 'open' || !current) return null;

  const formatDate = (ms: number) =>
    new Date(ms).toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' });
  const total = answered + questions.length;
  const side = (s: Side, label: 'A' | 'B') => (
    <MemoryChoiceCard
      value={s.value}
      meta={
        label === 'B' && current.kind === 'overwrite'
          ? t('memoryQuestion.newCandidate', { defaultValue: 'just now' })
          : t('memoryQuestion.learnedAt', { defaultValue: 'learned {{date}}', date: formatDate(s.learnedAt) })
      }
      pickLabel={t('memoryQuestion.keepThis', { defaultValue: 'Keep this one' })}
      moreLabel={t('memoryQuestion.showMore', { defaultValue: 'Show more' })}
      lessLabel={t('memoryQuestion.showLess', { defaultValue: 'Show less' })}
      disabled={busy}
      onPick={() => void answer(label === 'A' ? 'a' : 'b')}
    />
  );

  return (
    <div
      role="region"
      aria-live="polite"
      aria-label={t('memoryQuestion.regionLabel', { defaultValue: 'A question about what naby remembers' })}
      data-testid="memory-question-popup"
      onMouseEnter={touch}
      onFocusCapture={touch}
      className="fixed bottom-4 right-4 z-40 w-[22rem] max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-background shadow-lg p-3 max-h-[70vh] overflow-y-auto"
    >
      <div className="flex items-start gap-2">
        <p className="flex-1 text-sm text-foreground">
          {current.kind === 'overwrite'
            ? t('memoryQuestion.overwriteTitle', {
                defaultValue: 'Something new disagrees with what I remember. Which is right?',
              })
            : t('memoryQuestion.title', { defaultValue: 'Two memories disagree. Which one is right?' })}
        </p>
        {total > 1 && (
          <span className="text-[0.714rem] text-muted-foreground" data-testid="memory-question-counter">
            {t('memoryQuestion.counter', { defaultValue: '{{index}}/{{total}}', index: answered + 1, total })}
          </span>
        )}
      </div>
      <div className="mt-2 flex flex-col gap-2">
        {side(current.a, 'A')}
        {side(current.b, 'B')}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => void answer('both')}
          className="px-2 py-1 rounded-md border border-border text-xs text-foreground hover:bg-accent disabled:opacity-50"
        >
          {t('memoryQuestion.keepBoth', { defaultValue: 'Keep both' })}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void answer('later')}
          className="px-2 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {t('memoryQuestion.later', { defaultValue: 'Later' })}
        </button>
      </div>
    </div>
  );
});
