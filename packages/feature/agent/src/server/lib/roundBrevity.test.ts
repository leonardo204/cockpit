import { describe, it, expect } from 'vitest';
import { HUB_ROUND_RULES, HUB_CONTEXT_RULES } from './participantTurn';
import { followupInstruction, wrapupInstruction } from '../engines/participantRound';

/**
 * naby AFTER A PARTICIPANT (field data 2026-11-16): replies right after @aside
 * ran a median 637 chars, mostly re-telling @aside's own message; and 37 of them
 * opened with "@aside 감사합니다 …", a line the round reads as a HAND-OFF — 34
 * times @aside then ran a whole turn to say "알겠습니다". These pin the wording
 * that addresses both.
 */
const aside = { id: 'a', name: 'aside', displayName: 'aside', description: '' };

describe('naby after a participant', () => {
  it('a thank-you line is named as the hand-off it is', () => {
    expect(HUB_ROUND_RULES).toMatch(/Never start a line with @name only to thank a participant/);
    expect(HUB_ROUND_RULES).toMatch(/that line is a hand-off and makes them run again/);
  });

  it('both rule sets say: do not restate what the user just read', () => {
    for (const rules of [HUB_ROUND_RULES, HUB_CONTEXT_RULES]) {
      expect(rules).toMatch(/Do not restate or summarise it/);
      expect(rules).toMatch(/in a few short lines/);
    }
  });

  it('the follow-up asks for a few lines and no thanks to the participant', () => {
    const t = followupInstruction(aside, false);
    expect(t).toContain('Do not restate or summarise it');
    expect(t).toContain('do not thank or address @aside');
    expect(t).toContain('if nothing is missing, say so in one sentence');
  });

  it('a question from the participant is still answered', () => {
    expect(followupInstruction(aside, true)).toContain('addressed you in its last message. Answer it');
  });

  it('the wrap-up is two or three sentences and thanks nobody', () => {
    const t = wrapupInstruction(aside);
    expect(t).toContain('two or three short sentences');
    expect(t).toContain('do not thank or address any participant');
    // 2026-11-26: a wrap-up may hand remaining work on (it then runs).
    expect(t).toContain('a line starting with @name is a request it will carry out');
  });
});
