import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE WIRING BEHIND composerHistory.ts.
 *
 * The derivation and the key contract are unit-tested to the last case in
 * composerHistory.test.ts, and every one of those tests would still pass if
 * nobody called them. What is asserted here is the connection, and three things
 * that no unit test of a pure function can see:
 *
 *   1. the history block runs AFTER the slash/mention palette (which owns the
 *      same four keys) and BEFORE the Enter-send, so a chosen row can never
 *      fall through into an unreviewed resend;
 *   2. `Escape` stops propagating — Chat.tsx keeps a window-level keydown
 *      listener that aborts the running turn on Escape, and closing this list
 *      must not also kill the generation the user is watching;
 *   3. nothing clips the popup, which escapes the composer upwards
 *      (`absolute bottom-full`) in a three-panel layout.
 *
 * Source assertions rather than rendered ones, for the reason recorded in
 * chatScrollWiring.test.ts and sidebarPopoverClipping.test.ts: this suite has no
 * DOM environment (see vitest.config.ts), so there is nothing to mount and no
 * layout to measure.
 */

/** The `packages/` root — this file sits at packages/feature/agent/src/client. */
const ROOT = join(__dirname, '../../../..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const AGENT = 'feature/agent/src/client';
const chatInput = read(`${AGENT}/ChatInput.tsx`);
const chat = read(`${AGENT}/Chat.tsx`);
const en = JSON.parse(read('shared/i18n/locales/en.json')) as Record<string, Record<string, string>>;
const ko = JSON.parse(read('shared/i18n/locales/ko.json')) as Record<string, Record<string, string>>;

/** The body of ChatInput's `handleKeyDown`, where the ordering rules live. */
const handleKeyDown = (() => {
  const start = chatInput.indexOf('const handleKeyDown = useCallback(');
  expect(start, 'handleKeyDown not found — did the composer get rewritten?').toBeGreaterThan(-1);
  const end = chatInput.indexOf('}, [showCommands', start);
  expect(end, 'end of handleKeyDown not found').toBeGreaterThan(start);
  return chatInput.slice(start, end);
})();

describe('ChatInput — the history list is wired to the tested logic', () => {
  it('routes its keys through composerHistoryKey rather than re-deciding inline', () => {
    expect(chatInput).toMatch(/from '\.\/composerHistory'/);
    expect(handleKeyDown).toMatch(/composerHistoryKey\(e\.key/);
  });

  it('tells it the palette is open, so the two lists cannot both take a key', () => {
    expect(handleKeyDown).toMatch(/paletteOpen:\s*showCommands && filteredCommands\.length > 0/);
    // …and the list is not even drawn behind the palette.
    expect(chatInput).toMatch(/const showHistory =\s*historyOpen && history\.length > 0 && !showCommands/);
  });

  it('asks about the LIVE text, so a non-empty box keeps ArrowUp for the caret', () => {
    // `input`, not the trimmed draft: trimming would make a box holding only
    // spaces count as empty and steal the caret move.
    expect(handleKeyDown).toMatch(/text:\s*input,/);
  });

  it('only owns keys while the list is actually on screen', () => {
    // `showHistory`, not `historyOpen` — a hidden-but-open list would swallow
    // every keystroke that reached this branch.
    expect(handleKeyDown).toMatch(/open:\s*showHistory,/);
  });
});

describe('ChatInput — order of the key handlers', () => {
  it('the palette block comes first', () => {
    const palette = handleKeyDown.indexOf('if (showCommands && filteredCommands.length > 0)');
    const history = handleKeyDown.indexOf('composerHistoryKey(');
    expect(palette).toBeGreaterThan(-1);
    expect(history).toBeGreaterThan(palette);
  });

  it('THE SEND COMES LAST, so a picked row is never also sent', () => {
    const history = handleKeyDown.indexOf('composerHistoryKey(');
    const send = handleKeyDown.indexOf('handleSend()');
    expect(send).toBeGreaterThan(history);
    // And the history branch returns out of the handler for every key it takes.
    const branch = handleKeyDown.slice(history, send);
    expect(branch).not.toContain('handleSend');
    expect(branch).not.toContain('onSend');
    expect(branch).toMatch(/case 'accept':\s*\n\s*applyHistoryEntry\(/);
  });

  it('choosing a row FILLS the box: no send anywhere in that path', () => {
    const start = chatInput.indexOf('const applyHistoryEntry = useCallback(');
    expect(start).toBeGreaterThan(-1);
    const body = chatInput.slice(start, chatInput.indexOf('[replaceDraft, adjustTextareaHeight]', start));
    expect(body).not.toContain('onSend');
    expect(body).not.toContain('handleSend');
    // Fill + focus + caret at the end (replaceDraft), then re-measure the box so
    // a multi-line message grows it.
    expect(body).toContain('replaceDraft(text)');
    expect(body).toContain('adjustTextareaHeight');
    expect(body).toContain('setHistoryOpen(false)');
  });
});

describe('Escape must not also stop the running turn', () => {
  it('Chat still aborts the turn on a window-level Escape (the premise)', () => {
    // If this ever goes away the rule below is free to relax. Asserting the
    // premise keeps the test from silently guarding nothing.
    expect(chat).toMatch(/window\.addEventListener\('keydown'/);
    expect(chat).toMatch(/e\.key === 'Escape' && isHovered && \(isLoading \|\| liveRunning\)/);
  });

  it('so the history branch stops the event before it can reach that listener', () => {
    const history = handleKeyDown.indexOf('composerHistoryKey(');
    const branch = handleKeyDown.slice(history);
    expect(branch).toContain('e.stopPropagation()');
    expect(branch).toContain('e.nativeEvent.stopImmediatePropagation');
    // Guarded by "this action is ours", never unconditionally — the keys the
    // list does not want must keep bubbling.
    expect(branch).toMatch(/if \(historyAction\.type !== 'none'\) \{[\s\S]*?e\.stopPropagation\(\)/);
  });
});

describe('Chat — the list is derived once and handed over stably', () => {
  it('derives it from the transcript it already holds, with no request', () => {
    expect(chat).toMatch(/from '\.\/composerHistory'/);
    expect(chat).toMatch(/buildComposerHistory\(messages\)/);
    expect(chat).toMatch(/history=\{composerHistory\}/);
  });

  it('pins the previous array when nothing moved, so the memo survives streaming', () => {
    // `messages` gets a new identity per streamed chunk; a fresh array each time
    // would defeat ChatInput's memo for a list that only changes on a send.
    expect(chat).toMatch(/useMemo\(\(\) => \{[\s\S]*?sameComposerHistory\(composerHistoryRef\.current, next\)[\s\S]*?\}, \[messages\]\)/);
    expect(chat).toMatch(/return composerHistoryRef\.current/);
  });
});

describe('the popup is not clipped and speaks the same language as the palette', () => {
  it('escapes the composer upwards without a clipping ancestor', () => {
    // Same escape geometry as the command list. The composer root is
    // `relative`; putting overflow-hidden on it would erase both popups, which
    // is invisible to typecheck and to a DOM-less test alike.
    expect(chatInput).toMatch(/ref=\{historyListRef\}\s*\n\s*className="absolute bottom-full left-0 right-0 mx-4 mb-2/);
    const rootClass = /className=\{`border-t bg-card relative [^`]*`\}/.exec(chatInput)?.[0];
    expect(rootClass, 'composer root className not found — did the markup change?').toBeDefined();
    expect(rootClass).not.toContain('overflow-hidden');
    expect(rootClass).not.toContain('overflow-clip');
  });

  it('reuses the palette container and row metrics', () => {
    const commandList = /ref=\{commandListRef\}\s*\n\s*className="([^"]+)"/.exec(chatInput)?.[1];
    const historyList = /ref=\{historyListRef\}\s*\n\s*className="([^"]+)"/.exec(chatInput)?.[1];
    expect(commandList).toBeDefined();
    expect(historyList).toBe(commandList);
    expect(chatInput).toContain('px-4 py-2 cursor-pointer');
  });

  // THE HIGHLIGHT IS THE ONE THING THIS LIST DOES NOT BORROW, and that is a
  // correction rather than an inconsistency. This test used to require the
  // palette's `bg-brand/10` on the ground that one popup language beats two.
  // It shipped, and the selection could not be seen: the palette's rows carry
  // icons and a second line for a 10% tint to sit against, and these rows are
  // bare sentences. It was reported as the arrow keys not working at all —
  // the user reached for the mouse instead. The active row now also gets the
  // left accent bar, which is asserted in composerHistoryVisibility.test.ts
  // together with the scroll behaviour that depends on its marker.
  it('does not borrow the palette highlight, which was too faint here', () => {
    expect(chatInput).not.toMatch(/index === historyIndex \? 'bg-brand\/10'/);
  });

  it('is pickable by mouse as well as by keyboard', () => {
    expect(chatInput).toMatch(/onClick=\{\(\) => applyHistoryEntry\(entry\)\}/);
  });

  it('shows one line per row through the tested preview', () => {
    expect(chatInput).toMatch(/composerHistoryPreview\(entry\)/);
    expect(chatInput).toMatch(/text-sm text-foreground truncate/);
  });
});

describe('UI copy goes through i18n in both languages', () => {
  it('has the history keys in en and ko', () => {
    for (const key of ['historyGroup', 'historyHint']) {
      expect(en.chatInput?.[key], `en chatInput.${key}`).toBeTruthy();
      expect(ko.chatInput?.[key], `ko chatInput.${key}`).toBeTruthy();
      // Translated, not copied.
      expect(ko.chatInput?.[key]).not.toBe(en.chatInput?.[key]);
    }
  });

  it('the component reads them through t(), with no hardcoded label', () => {
    expect(chatInput).toMatch(/t\('chatInput\.historyGroup'/);
    expect(chatInput).toMatch(/t\('chatInput\.historyHint'/);
  });
});
