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
const MAPPER = readFileSync(
  join(HERE, '../server/api/session/toChatMessages.ts'),
  'utf8',
);
const chat = (d: unknown) => (d as { chat: Record<string, string> }).chat;

describe('the structured half of a tool result reaches the transcript', () => {
  it('is carried through the mapper, not dropped', () => {
    // `ToolOutput.data` has been written to disk all along and nothing read it
    // back; the transcript kept only the prose the model sees.
    expect(MAPPER).toContain('const toolData = new Map<string, unknown>()');
    expect(MAPPER).toContain('if (m.output?.data !== undefined) toolData.set(m.toolCallId, m.output.data)');
    expect(MAPPER).toContain('resultData: toolData.get(tc.toolCallId)');
  });
});

describe('the offer', () => {
  it('goes through the tested rule rather than sniffing the row inline', () => {
    expect(MODAL).toContain('pendingMemoryOf(toolCall.name, toolCall.resultData)');
  });

  it('is visible without expanding the row', () => {
    // An offer nobody sees is a settings screen with extra steps. It sits
    // OUTSIDE the `expanded &&` block.
    const offer = /\{pending && \([\s\S]*?\n          \)\}/.exec(MODAL)?.[0];
    expect(offer, 'the offer is gone — did the row change?').toBeDefined();
    expect(MODAL.indexOf('{pending && (')).toBeLessThan(
      MODAL.indexOf('{expanded && !toolCall.isLoading && ('),
    );
  });

  it('disappears once it has been taken', () => {
    // Asking again for agreement already given is a button that does nothing.
    expect(MODAL).toContain('const pending = confirmed ? null : pendingMemoryOf(');
  });
});

describe('who is allowed to confirm', () => {
  it('goes through the same HTTP action the settings screen uses', () => {
    // `confirmMemory` is "the ONLY path external-origin memory becomes
    // confirmed… a threshold can never do it, only a user". A tool call is the
    // model, however faithfully it reports what the user just said — so the
    // click is the user, and it takes the user's own route.
    expect(MODAL).toContain("body: JSON.stringify({ action: 'confirm', id: pending.id })");
    expect(MODAL).toContain("fetch('/api/memory'");
  });

  it('does not claim success it did not get', () => {
    // A failed confirm leaves the offer standing, because the memory is still
    // waiting.
    expect(MODAL).toContain('if (res.ok) setConfirmed(true);');
  });

  it('cannot be fired twice while one is in flight', () => {
    expect(MODAL).toContain('if (!pending || confirming) return;');
  });
});

describe('what it says', () => {
  it('is translated in both languages', () => {
    for (const key of ['confirmMemory', 'memoryConfirmed', 'confirmMemoryHint']) {
      expect(chat(en)[key], `en: ${key}`).toBeTruthy();
      expect(chat(ko)[key], `ko: ${key}`).toBeTruthy();
      expect(chat(ko)[key]).not.toBe(chat(en)[key]);
    }
  });

  it('says what agreeing actually buys', () => {
    // The reason to press it is not "save a note" — it is that a thing the user
    // agreed to outranks a thing naby inferred. The hint says so.
    expect(chat(en).confirmMemoryHint).toContain('outrank');
    expect(chat(ko).confirmMemoryHint).toContain('우선');
  });
});
