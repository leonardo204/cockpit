/**
 * askNabyWiring.test.ts — "Ask naby about this" has to reach a chat input that
 * is not on screen.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BUG THIS PINS, WHICH SHIPPED
 *
 * `ChatInput` registers itself as the insertion target only while ITS tab is
 * active (`if (!isActive) return` in its effect). A diff tab IS the active tab
 * whenever its button can be clicked — so there was never a registered input to
 * insert into, and the button reported "open a conversation first" to a user who
 * had one open behind it.
 *
 * "Every tab keeps its ChatInput mounted" was true and irrelevant: mounted is not
 * registered. The fix is that the TAB HOST delivers the text — it makes a chat
 * tab active, then hands over — and the components only say what to ask.
 *
 * None of this is visible to a mounted test: jsdom renders one tab at a time
 * happily and the failure is a toast, not an error. So the wiring is asserted as
 * source, the way this directory's other wiring guards are.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(join(__dirname, name), 'utf8');
const HOST = read('TabManager.tsx');
const PANEL = read('GitPanel.tsx');
const DIFF = read('DiffDocument.tsx');
const CHAT_INPUT = readFileSync(
  join(__dirname, '..', '..', '..', 'agent', 'src', 'client', 'ChatInput.tsx'),
  'utf8',
);
const BUS = readFileSync(
  join(__dirname, '..', '..', '..', 'agent', 'src', 'client', 'fileRefBus.ts'),
  'utf8',
);

describe('the constraint that made this necessary', () => {
  it('a chat input registers only while its own tab is active', () => {
    // The premise. If this ever stops being true the host could insert directly
    // — but until then, inserting from a tab of its own cannot work.
    expect(CHAT_INPUT).toContain('if (!isActive) return;');
    expect(CHAT_INPUT).toContain('setActiveFileRefInserter(insertAtCaret)');
  });
});

describe('the components ask, they do not deliver', () => {
  it('the git panel routes every suggestion through the host', () => {
    expect(PANEL).toContain('onAsk?: (text: string) => void;');
    expect(PANEL).toContain('onClick={() => onAsk?.(text)}');
    // The direct call is what was wrong; it must not come back.
    expect(PANEL).not.toContain('insertFileRef(');
  });

  it('the diff tab routes its button through the host', () => {
    expect(DIFF).toContain('onClick={() => onAsk?.(askText)}');
    expect(DIFF).not.toContain('insertFileRef(');
  });

  it('a suggestion with nowhere to go is disabled rather than silently dead', () => {
    expect(PANEL).toContain('disabled={!onAsk}');
    expect(DIFF).toContain('disabled={!onAsk}');
  });
});

describe('the host makes a conversation active first', () => {
  it('switches to a chat tab before handing the text over', () => {
    const fn = /const handleAskNaby = useCallback\(([\s\S]*?)\n  \);/.exec(HOST)?.[1];
    expect(fn, 'handleAskNaby is gone').toBeDefined();
    expect(fn).toContain('switchTab(target.id)');
    expect(fn).toContain('insertFileRefWhenReady(body)');
  });

  it('does not switch when a conversation is already in front', () => {
    // Switching away from the tab you are already on would be a jump for nothing.
    const fn = /const handleAskNaby = useCallback\(([\s\S]*?)\n  \);/.exec(HOST)?.[1] ?? '';
    expect(fn).toContain('isChatTab(active)');
    expect(fn).toContain('insertFileRef(body)');
  });

  it('prefers the conversation you came from, not the oldest tab', () => {
    expect(HOST).toContain('lastChatTabIdRef');
    expect(HOST).toContain('if (active && isChatTab(active)) lastChatTabIdRef.current = active.id;');
  });

  it('still reports the one case that really has no conversation', () => {
    const fn = /const handleAskNaby = useCallback\(([\s\S]*?)\n  \);/.exec(HOST)?.[1] ?? '';
    expect(fn).toContain("t('git.askNoChat'");
  });
});

describe('the waiting insert', () => {
  it('holds a request until an input registers, then hands it over', () => {
    // The switch has not rendered when the request is made, so the request waits
    // for the registration rather than the caller polling for it.
    expect(BUS).toContain('export function insertFileRefWhenReady');
    expect(BUS).toMatch(/setActiveFileRefInserter[\s\S]{0,400}pending/);
  });

  it('expires a request that missed its moment', () => {
    // Without the cap, a request whose switch never happened would splice itself
    // into whatever conversation was opened next, minutes later.
    expect(BUS).toContain('PENDING_TTL_MS');
    expect(BUS).toMatch(/Date\.now\(\) - pending\.at <= PENDING_TTL_MS/);
  });
});
