/**
 * WHEN THE MEMORY-QUESTION POPUP MAY RAISE ITSELF (memory-auto-apply R27) — pure,
 * so the rarity rules are a table a test can read rather than timing buried in a
 * component.
 *
 * Every condition must hold:
 *
 *   * there is an open question that is not snoozed (R27 "나중에" / two
 *     unanswered collapses → 7 days);
 *   * the visible tab is not running a turn, and the user is not typing;
 *   * it has not raised itself today (local calendar day — "once a day");
 *   * the app has been open for five minutes (never on launch);
 *   * the active session is neither temporary (`noLearn`) nor a fast-growth one
 *     — the server answers that as `suppressed`.
 *
 * Telegram never asks: the popup lives in the app window and nowhere else.
 */

/** Never raise itself in the first five minutes after the app starts (R27). */
export const POPUP_START_DELAY_MS = 5 * 60_000;
/** Fold away after this long without an answer (R27). */
export const POPUP_AUTO_COLLAPSE_MS = 20_000;

export type PopupQuestion = { id: string; snoozedUntil?: number };

export type PopupShowInput = {
  now: number;
  appStartedAt: number;
  lastAutoShownAt?: number;
  turnRunning: boolean;
  typing: boolean;
  /** The active session is temporary or fast-growth (server-decided). */
  suppressed: boolean;
  questions: readonly PopupQuestion[];
};

/** Two epoch-ms instants on the same LOCAL calendar day. */
export function sameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

/** The questions the popup may raise on its own right now (snoozed ones wait). */
export function autoShowableQuestions<Q extends PopupQuestion>(questions: readonly Q[], now: number): Q[] {
  return questions.filter((q) => q.snoozedUntil === undefined || q.snoozedUntil <= now);
}

export function shouldAutoShowMemoryQuestion(input: PopupShowInput): boolean {
  if (autoShowableQuestions(input.questions, input.now).length === 0) return false;
  if (input.turnRunning || input.typing || input.suppressed) return false;
  if (input.now - input.appStartedAt < POPUP_START_DELAY_MS) return false;
  if (input.lastAutoShownAt !== undefined && sameLocalDay(input.lastAutoShownAt, input.now)) return false;
  return true;
}

/**
 * Is the user typing? True when the deepest focused element — followed into
 * same-origin iframes, which is where every project's chat lives — is an editable
 * field holding text. A half-written message is exactly when a popup must not
 * appear; an empty, merely-focused composer is not typing.
 */
export function isUserTyping(doc: Document | null | undefined): boolean {
  // Tag names, not `instanceof`: an element inside an iframe is an instance of
  // THAT window's constructors, so the parent's `HTMLTextAreaElement` would never
  // match it.
  let el: Element | null = doc?.activeElement ?? null;
  for (let depth = 0; el && depth < 5; depth += 1) {
    const tag = el.tagName;
    if (tag === 'IFRAME') {
      let inner: Document | null = null;
      try {
        inner = (el as HTMLIFrameElement).contentDocument;
      } catch {
        inner = null; // cross-origin: cannot see inside, so cannot claim typing
      }
      el = inner?.activeElement ?? null;
      continue;
    }
    if (tag === 'TEXTAREA' || tag === 'INPUT') {
      return String((el as HTMLInputElement).value ?? '').trim().length > 0;
    }
    if ((el as HTMLElement).isContentEditable) return (el.textContent ?? '').trim().length > 0;
    return false;
  }
  return false;
}
