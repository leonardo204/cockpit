import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import en from '../../../../shared/i18n/locales/en.json';
import ko from '../../../../shared/i18n/locales/ko.json';

/**
 * A MEMORY CAN BE AGREED TO WHERE IT WAS PROPOSED.
 *
 * Until now the only way to make a captured memory count was a settings screen —
 * the user watched naby write "answer politely", was told to go and confirm it
 * somewhere else, and mostly did not. The offer now sits on the call that made
 * it.
 *
 * Source assertions: this is a click path through an HTTP action, and there is
 * no component harness here. The RULE for when an offer exists is pure and
 * covered in pendingMemory.test.ts.
 */

const HERE = __dirname;
const MODAL = readFileSync(join(HERE, 'ToolCallModal.tsx'), 'utf8');
const CHIP = readFileSync(join(HERE, 'MemoryWriteChip.tsx'), 'utf8');
const MAPPER = readFileSync(
  join(HERE, '../server/api/session/toChatMessages.ts'),
  'utf8',
);
const REDUCER = readFileSync(join(HERE, 'applyStreamEvent.ts'), 'utf8');
const chat = (d: unknown) => (d as { chat: Record<string, unknown> }).chat;
const chip = (d: unknown) => (chat(d).memoryChip ?? {}) as Record<string, string>;

describe('the structured half of a tool result reaches the transcript', () => {
  it('is carried through the mapper, not dropped', () => {
    // `ToolOutput.data` has been written to disk all along and nothing read it
    // back; the transcript kept only the prose the model sees.
    expect(MAPPER).toContain('const toolData = new Map<string, unknown>()');
    expect(MAPPER).toContain('if (m.output?.data !== undefined) toolData.set(m.toolCallId, m.output.data)');
    expect(MAPPER).toContain('resultData: toolData.get(tc.toolCallId)');
  });

  it('rides the live stream too, so the chip appears with the call (memory-auto-apply R10)', () => {
    expect(REDUCER).toContain('resultData: data');
  });
});

describe('the chip (memory-auto-apply §3)', () => {
  it('goes through the tested rules rather than sniffing the row inline', () => {
    expect(MODAL).toContain('memoryWriteOf(toolCall.name, toolCall.resultData)');
    expect(CHIP).toContain('memoryChipView(write, status)');
  });

  it('is visible without expanding the row', () => {
    // An offer — or an undo — nobody sees is a settings screen with extra steps.
    // It sits OUTSIDE the `expanded &&` detail block.
    const at = MODAL.indexOf('{memoryWrite && <MemoryWriteChip write={memoryWrite} />}');
    expect(at, 'the chip is gone — did the row change?').toBeGreaterThan(-1);
    expect(at).toBeLessThan(MODAL.indexOf('{expanded && ('));
  });

  it('asks the server what became of the memory, and stops asking once settled', () => {
    expect(CHIP).toContain("action: 'reviewStatus', ids: [write.id]");
    expect(CHIP).toMatch(/stillPending && polls\.current < POLL_MAX/);
  });

  it('undoes through the memory route (R10)', () => {
    expect(CHIP).toContain("action: 'cancel', id: write.id");
    expect(CHIP).toContain('data-testid="memory-chip-cancel"');
  });
});

describe('who is allowed to confirm a HELD memory (R11)', () => {
  it('goes through the same HTTP action the settings screen uses', () => {
    // `confirmMemory` is "the ONLY path external-origin memory becomes
    // confirmed… a threshold can never do it, only a user". A tool call is the
    // model, however faithfully it reports what the user just said — so the
    // click is the user, and it takes the user's own route.
    expect(CHIP).toContain("action: 'confirm', id: write.id");
    expect(CHIP).toContain("fetch('/api/memory'");
    expect(CHIP).toContain('data-testid="confirm-memory"');
  });

  it('does not claim success it did not get', () => {
    // A failed confirm leaves the offer standing, because the memory is still
    // waiting.
    expect(CHIP).toContain('if (ok) setConfirmed(true);');
  });

  it('cannot be fired twice while one is in flight', () => {
    expect(CHIP).toContain('if (busy) return;');
  });

  it('says why it is held, in one line beside the button', () => {
    expect(CHIP).toContain('data-testid="memory-hold-reason"');
    expect(CHIP).toContain('`chat.memoryHold.${view.reason}`');
  });
});

describe('what it says', () => {
  it('is translated in both languages', () => {
    for (const key of ['confirmMemory', 'memoryConfirmed', 'confirmMemoryHint']) {
      expect(chat(en)[key], `en: ${key}`).toBeTruthy();
      expect(chat(ko)[key], `ko: ${key}`).toBeTruthy();
      expect(chat(ko)[key]).not.toBe(chat(en)[key]);
    }
    for (const key of ['pending', 'applied', 'known', 'changed', 'cancel', 'undone', 'question']) {
      expect(chip(en)[key], `en: memoryChip.${key}`).toBeTruthy();
      expect(chip(ko)[key], `ko: memoryChip.${key}`).toBeTruthy();
    }
  });

  it('speaks the chat chips in the words the spec gives (memory-auto-apply R10)', () => {
    expect(chip(ko).pending).toBe('기억하는 중…');
    expect(chip(ko).applied).toBe('기억했어요: {{value}}');
    expect(chip(ko).known).toBe('이미 알고 있어요');
    expect(chip(ko).changed).toBe('기억을 바꿨어요: {{old}} → {{new}}');
    expect(chip(ko).cancel).toBe('취소');
  });

  it('says what agreeing actually buys', () => {
    // The reason to press it is not "save a note" — it is that a thing the user
    // agreed to outranks a thing naby inferred. The hint says so.
    expect(String(chat(en).confirmMemoryHint)).toContain('outrank');
    expect(String(chat(ko).confirmMemoryHint)).toContain('우선');
  });
});
