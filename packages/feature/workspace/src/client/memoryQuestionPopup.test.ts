import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  autoShowableQuestions,
  POPUP_AUTO_COLLAPSE_MS,
  POPUP_START_DELAY_MS,
  sameLocalDay,
  shouldAutoShowMemoryQuestion,
  type PopupShowInput,
} from './memoryQuestionRules';

/**
 * THE QUESTION POPUP IS RARE BY RULE (memory-auto-apply R27).
 *
 * The show conditions are one pure function, so the table below IS the
 * behaviour: once a day, five minutes after launch, never during a turn or while
 * typing, never over a temporary / fast-growth session, and a snoozed question
 * waits its week.
 */

const START = new Date(2026, 10, 9, 9, 0, 0).getTime();
const LATER = START + POPUP_START_DELAY_MS + 1;

const base: PopupShowInput = {
  now: LATER,
  appStartedAt: START,
  turnRunning: false,
  typing: false,
  suppressed: false,
  questions: [{ id: 'q1' }],
};

describe('when the popup may raise itself', () => {
  const table: [string, Partial<PopupShowInput>, boolean][] = [
    ['all conditions hold', {}, true],
    ['no open question', { questions: [] }, false],
    ['a turn is running in the visible tab', { turnRunning: true }, false],
    ['the user is typing', { typing: true }, false],
    ['the active session is temporary or fast-growth', { suppressed: true }, false],
    ['the app started under five minutes ago', { now: START + POPUP_START_DELAY_MS - 1 }, false],
    ['it already raised itself today', { lastAutoShownAt: LATER - 60_000 }, false],
    ['it last raised itself yesterday', { lastAutoShownAt: LATER - 24 * 60 * 60_000 }, true],
    ['the only question is snoozed', { questions: [{ id: 'q1', snoozedUntil: LATER + 1 }] }, false],
    ['the snooze has run out', { questions: [{ id: 'q1', snoozedUntil: LATER - 1 }] }, true],
  ];
  for (const [name, over, want] of table) {
    it(`${want ? 'shows' : 'stays hidden'} when ${name}`, () => {
      expect(shouldAutoShowMemoryQuestion({ ...base, ...over })).toBe(want);
    });
  }

  it('"once a day" is the local calendar day', () => {
    const lateNight = new Date(2026, 10, 9, 23, 59).getTime();
    const nextMorning = new Date(2026, 10, 10, 0, 1).getTime();
    expect(sameLocalDay(lateNight, nextMorning)).toBe(false);
    expect(sameLocalDay(START, lateNight)).toBe(true);
  });

  it('a snoozed question is skipped but the others are not', () => {
    const qs = [{ id: 'a', snoozedUntil: LATER + 5 }, { id: 'b' }];
    expect(autoShowableQuestions(qs, LATER).map((q) => q.id)).toEqual(['b']);
  });

  it('folds away after twenty seconds', () => {
    expect(POPUP_AUTO_COLLAPSE_MS).toBe(20_000);
  });
});

const POPUP = readFileSync(join(__dirname, 'MemoryQuestionPopup.tsx'), 'utf8');
const WORKSPACE = readFileSync(join(__dirname, 'Workspace.tsx'), 'utf8');

describe('the popup is not part of the conversation (R26)', () => {
  it('is a non-modal panel in the corner that never takes focus', () => {
    expect(POPUP).toContain('fixed bottom-4 right-4 z-40');
    expect(POPUP).not.toMatch(/autoFocus|\.focus\(\)|role="dialog"|aria-modal/);
  });

  it('is mounted by the workspace, outside every chat transcript', () => {
    expect(WORKSPACE).toContain('<MemoryQuestionPopup');
    expect(POPUP).not.toMatch(/appendMessage|setMessages|ChatMessage/);
  });

  it('goes through the pure rule and reports its own showing and folding', () => {
    expect(POPUP).toContain('shouldAutoShowMemoryQuestion({');
    expect(POPUP).toContain("action: 'questions.autoShown'");
    expect(POPUP).toContain("action: 'questions.collapsed'");
  });

  it('chains to the next question after an answer, and stops on "later"', () => {
    expect(POPUP).toContain("if (choice === 'later' || rest.length === 0)");
  });
});
