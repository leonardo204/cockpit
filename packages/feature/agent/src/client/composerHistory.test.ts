import { describe, it, expect } from 'vitest';
import {
  buildComposerHistory,
  composerHistoryKey,
  composerHistoryPreview,
  sameComposerHistory,
  COMPOSER_HISTORY_LIMIT,
  EMPTY_COMPOSER_HISTORY,
  type ComposerHistoryState,
} from './composerHistory';

/**
 * `↑` on an empty composer offers back what the user already sent this session.
 *
 * Both halves of the feature are pure and are tested HERE, against the same
 * functions the component calls: the derivation (what the list contains) and the
 * key contract (what each key does to it). The wiring — that ChatInput actually
 * routes its keys through this, and that Escape does not also stop the running
 * turn — is asserted in composerHistoryWiring.test.ts, because this repository
 * has no DOM environment in its vitest setup.
 */

const user = (content: string) => ({ role: 'user', content });
const assistant = (content: string) => ({ role: 'assistant', content });

describe('buildComposerHistory — what the list contains', () => {
  it('takes the user messages only, newest first', () => {
    const history = buildComposerHistory([
      user('first'),
      assistant('sure'),
      user('second'),
      assistant('done'),
      user('third'),
    ]);
    expect(history).toEqual(['third', 'second', 'first']);
  });

  it('ignores system rows as well as the assistant', () => {
    const history = buildComposerHistory([
      { role: 'system', content: 'harness reloaded' },
      user('mine'),
      { role: 'system', content: 'compacted' },
    ]);
    expect(history).toEqual(['mine']);
  });

  it('collapses CONSECUTIVE repeats into one row', () => {
    const history = buildComposerHistory([
      user('continue'),
      user('continue'),
      user('continue'),
      user('now do the other one'),
    ]);
    expect(history).toEqual(['now do the other one', 'continue']);
  });

  it('keeps a repeat that is NOT consecutive — it is a different moment', () => {
    const history = buildComposerHistory([user('continue'), user('fix the test'), user('continue')]);
    expect(history).toEqual(['continue', 'fix the test', 'continue']);
  });

  it('treats messages as consecutive across the assistant turns between them', () => {
    // The transcript always interleaves; "sent twice in a row" means twice in a
    // row BY THE USER, not two adjacent rows in the array.
    const history = buildComposerHistory([user('go'), assistant('…'), user('go')]);
    expect(history).toEqual(['go']);
  });

  it('trims each entry and drops the blank ones (an image-only send)', () => {
    const history = buildComposerHistory([
      user('  padded  '),
      user('   '),
      user('\n\t\n'),
      user(''),
      user('real'),
    ]);
    expect(history).toEqual(['real', 'padded']);
  });

  it(`caps at ${COMPOSER_HISTORY_LIMIT}, keeping the most recent`, () => {
    const messages = Array.from({ length: 120 }, (_, i) => user(`m${i}`));
    const history = buildComposerHistory(messages);
    expect(history).toHaveLength(COMPOSER_HISTORY_LIMIT);
    expect(history[0]).toBe('m119');
    expect(history[COMPOSER_HISTORY_LIMIT - 1]).toBe(`m${120 - COMPOSER_HISTORY_LIMIT}`);
  });

  it('is empty for an empty transcript, a missing one, and one with no user text', () => {
    expect(buildComposerHistory([])).toEqual([]);
    expect(buildComposerHistory(undefined)).toEqual([]);
    expect(buildComposerHistory(null)).toEqual([]);
    expect(buildComposerHistory([assistant('hello')])).toEqual([]);
    // The same frozen array every time, so "no history" cannot churn the memo.
    expect(buildComposerHistory([])).toBe(EMPTY_COMPOSER_HISTORY);
    expect(buildComposerHistory([assistant('hello')])).toBe(EMPTY_COMPOSER_HISTORY);
  });

  it('survives a malformed row instead of throwing into the render', () => {
    const messages = [
      user('kept'),
      { role: 'user', content: undefined as unknown as string },
      null as unknown as { role: string; content: string },
    ];
    expect(buildComposerHistory(messages)).toEqual(['kept']);
  });
});

describe('sameComposerHistory — identity stability for the memo', () => {
  it('is true for equal contents and false for any difference', () => {
    expect(sameComposerHistory(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameComposerHistory([], [])).toBe(true);
    expect(sameComposerHistory(['a'], ['b'])).toBe(false);
    expect(sameComposerHistory(['a'], ['a', 'b'])).toBe(false);
  });

  it('recomputing over an unchanged transcript compares equal', () => {
    // This is the property Chat.tsx relies on to pin the previous array while
    // the assistant streams: the user half of the transcript has not moved.
    const messages = [user('one'), assistant('…')];
    const a = buildComposerHistory(messages);
    const b = buildComposerHistory([...messages, assistant('… more')]);
    expect(a).not.toBe(b);
    expect(sameComposerHistory(a, b)).toBe(true);
  });
});

describe('composerHistoryPreview — one line per row', () => {
  it('shows a single-line message as it is', () => {
    expect(composerHistoryPreview('fix the login bug')).toBe('fix the login bug');
  });

  it('shows the first line of a multi-line message and marks the rest', () => {
    expect(composerHistoryPreview('do this:\n- a\n- b')).toBe('do this: …');
  });

  it('ellipsises a long first line', () => {
    const preview = composerHistoryPreview('x'.repeat(200));
    expect(preview.endsWith('…')).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(121);
  });

  it('skips leading blank lines rather than previewing nothing', () => {
    expect(composerHistoryPreview('\n\nactual text')).toBe('actual text …');
  });
});

// -- the key contract -------------------------------------------------------

const state = (over: Partial<ComposerHistoryState> = {}): ComposerHistoryState => ({
  open: false,
  index: 0,
  text: '',
  historyLength: 3,
  paletteOpen: false,
  ...over,
});

describe('composerHistoryKey — opening', () => {
  it('ArrowUp on an EMPTY box opens with the most recent message selected', () => {
    expect(composerHistoryKey('ArrowUp', state())).toEqual({ type: 'open', index: 0 });
  });

  it('THE RULE THAT MATTERS: ArrowUp with text in the box is left to the caret', () => {
    // Multi-line editing depends on `↑` moving up a line. A history popup that
    // steals it makes the composer unusable for anything longer than a line.
    expect(composerHistoryKey('ArrowUp', state({ text: 'a' }))).toEqual({ type: 'none' });
    expect(composerHistoryKey('ArrowUp', state({ text: 'line one\nline two' }))).toEqual({ type: 'none' });
    // Whitespace is still text — the caret has somewhere to go.
    expect(composerHistoryKey('ArrowUp', state({ text: ' ' }))).toEqual({ type: 'none' });
  });

  it('does not open on an empty history — a popup with no rows is a dead end', () => {
    expect(composerHistoryKey('ArrowUp', state({ historyLength: 0 }))).toEqual({ type: 'none' });
  });

  it('opens no other way: ArrowDown, Enter, Tab and Escape are not ours while closed', () => {
    for (const key of ['ArrowDown', 'Enter', 'Tab', 'Escape', 'a']) {
      expect(composerHistoryKey(key, state()), key).toEqual({ type: 'none' });
    }
  });

  it('THE PALETTE WINS: no key is taken while the slash/mention list is up', () => {
    expect(composerHistoryKey('ArrowUp', state({ paletteOpen: true }))).toEqual({ type: 'none' });
    expect(composerHistoryKey('ArrowUp', state({ open: true, paletteOpen: true }))).toEqual({ type: 'none' });
    expect(composerHistoryKey('Enter', state({ open: true, paletteOpen: true }))).toEqual({ type: 'none' });
    expect(composerHistoryKey('Escape', state({ open: true, paletteOpen: true }))).toEqual({ type: 'none' });
  });
});

describe('composerHistoryKey — navigating', () => {
  it('ArrowUp walks older, ArrowDown walks newer', () => {
    expect(composerHistoryKey('ArrowUp', state({ open: true, index: 0 }))).toEqual({ type: 'move', index: 1 });
    expect(composerHistoryKey('ArrowUp', state({ open: true, index: 1 }))).toEqual({ type: 'move', index: 2 });
    expect(composerHistoryKey('ArrowDown', state({ open: true, index: 2 }))).toEqual({ type: 'move', index: 1 });
  });

  it('clamps at both ends instead of wrapping', () => {
    expect(composerHistoryKey('ArrowUp', state({ open: true, index: 2 }))).toEqual({ type: 'move', index: 2 });
    expect(composerHistoryKey('ArrowDown', state({ open: true, index: 0 }))).toEqual({ type: 'move', index: 0 });
  });

  it('clamps an index that no longer fits the list', () => {
    expect(composerHistoryKey('Enter', state({ open: true, index: 99 }))).toEqual({ type: 'accept', index: 2 });
    expect(composerHistoryKey('Enter', state({ open: true, index: -4 }))).toEqual({ type: 'accept', index: 0 });
  });

  it('closes rather than indexing into a list that emptied underneath it', () => {
    expect(composerHistoryKey('Enter', state({ open: true, historyLength: 0 }))).toEqual({ type: 'close' });
  });

  it('leaves every other key to the textarea', () => {
    for (const key of ['a', 'Backspace', 'ArrowLeft', 'PageUp']) {
      expect(composerHistoryKey(key, state({ open: true })), key).toEqual({ type: 'none' });
    }
  });
});

describe('composerHistoryKey — choosing', () => {
  it('Enter FILLS — it never sends', () => {
    // The whole point of putting a past message back in the box is to edit it
    // first. There is no action in this module that means "send".
    const action = composerHistoryKey('Enter', state({ open: true, index: 1 }));
    expect(action).toEqual({ type: 'accept', index: 1 });
    expect(action.type).not.toBe('send');
  });

  it('Tab does the same as Enter', () => {
    expect(composerHistoryKey('Tab', state({ open: true, index: 1 }))).toEqual({ type: 'accept', index: 1 });
  });

  it('Escape closes and changes nothing', () => {
    expect(composerHistoryKey('Escape', state({ open: true, index: 2 }))).toEqual({ type: 'close' });
  });
});

describe('composerHistoryKey — the sequence a user actually types', () => {
  it('↑ ↑ Enter fills the second-most-recent message', () => {
    const history = buildComposerHistory([user('one'), assistant('…'), user('two'), user('three')]);
    let open = false;
    let index = 0;
    let filled: string | null = null;
    let sent: string | null = null;

    for (const key of ['ArrowUp', 'ArrowUp', 'Enter']) {
      const action = composerHistoryKey(key, {
        open,
        index,
        text: filled ?? '',
        historyLength: history.length,
        paletteOpen: false,
      });
      if (action.type === 'open') {
        open = true;
        index = action.index;
      } else if (action.type === 'move') {
        index = action.index;
      } else if (action.type === 'accept') {
        filled = history[action.index];
        open = false;
      } else if (action.type === 'none' && key === 'Enter') {
        sent = 'would have sent';
      }
    }

    expect(filled).toBe('two');
    expect(sent).toBeNull();
    expect(open).toBe(false);
  });
});
