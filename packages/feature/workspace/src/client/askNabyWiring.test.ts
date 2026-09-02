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

/**
 * A diff tab left open must not quietly go stale.
 *
 * The file is on disk and anything can write to it — the user in an editor, naby
 * carrying out what it was just asked, a formatter on save. A viewer showing the
 * state at the moment of the click describes a file that no longer looks like
 * that, and nothing on screen says so. That is the failure mode this pins,
 * because a stale diff looks exactly like a correct one.
 */
describe('the diff tab keeps up with the file', () => {
  it('subscribes to the same watcher the panel uses', () => {
    expect(DIFF).toContain('useWebSocket({');
    expect(DIFF).toContain('url: `/ws/fs-watch?cwd=${encodeURIComponent(cwd)}`');
  });

  it('re-reads on anything but a refs change', () => {
    // Stated as ONE exclusion rather than a list of inclusions, so a signal
    // added later re-reads by default instead of being forgotten.
    expect(DIFF).toContain('if (isGitRefsChange(message)) return;');
    expect(DIFF).toContain('void load();');
  });

  it('re-reads when the INDEX moves, not only when the file is written', () => {
    // `git add` takes lines out of the unstaged diff without touching the file,
    // so listening for file writes alone would leave the tab showing lines that
    // are now staged. The subscription is to the whole socket, which carries
    // `git-change` too — it must not narrow to one message type.
    expect(DIFF).not.toContain("'fs-change'");
  });

  it('does not watch a commit diff, because a commit cannot change', () => {
    // A commit is identified by the hash of its content: `git show <hash>` is
    // the same bytes forever. Re-reading it on every save is work that cannot
    // produce a different answer.
    expect(DIFF).toContain('enabled: !commit');
  });

  it('drops a slow re-read that lands after a newer one', () => {
    // An editor saving twice in a second is enough to overlap two fetches.
    expect(DIFF).toContain('const seq = ++reqRef.current;');
    expect(DIFF).toContain('if (seq === reqRef.current) setData(next);');
  });

  it('does not blank the diff while re-reading it', () => {
    // The loading state is shown only when there is nothing to show yet;
    // otherwise a live refresh would flash the whole tab empty.
    expect(DIFF).toContain('{loading && !data ?');
  });
});
