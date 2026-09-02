import { describe, it, expect } from 'vitest';
import {
  acceptsChatState,
  closableSessionId,
  documentTabTitle,
  diffTabTitle,
  findDiffTab,
  findDocumentTab,
  isChatTab,
  isDiffTab,
  isMarkdownTab,
  openSessionIds,
  tabKindOf,
  type KindedTab,
} from './tabKinds';
import { applyTitleUpdate } from './titleLock';

/**
 * The rules a second kind of tab brings with it.
 *
 * Every one of these fails SILENTLY when it is wrong — a document tab that
 * deletes a conversation on close, one that vanishes from the tab strip because
 * it was mistaken for a session, one that stacks a duplicate every time a file
 * is opened, one wearing the last question somebody asked. None of them is
 * visible in a build, a type, or a rendered DOM.
 */

const chat = (over: Partial<KindedTab> = {}): KindedTab => ({ sessionId: 's1', ...over });
const doc = (over: Partial<KindedTab> = {}): KindedTab => ({
  kind: 'markdown',
  cwd: '/p',
  rel: 'docs/a.md',
  ...over,
});

describe('tab kind — a chat tab and a document tab are told apart', () => {
  it('treats a tab with no kind as a chat', () => {
    // Every tab that existed before documents could be promoted has no `kind`
    // field, and an undefined that fell through to "document" would render the
    // whole app as an empty viewer.
    expect(tabKindOf({})).toBe('chat');
    expect(tabKindOf({ sessionId: 'abc' })).toBe('chat');
    expect(isChatTab({})).toBe(true);
    expect(isMarkdownTab({})).toBe(false);
  });

  it('treats an explicit markdown tab as a document', () => {
    expect(tabKindOf(doc())).toBe('markdown');
    expect(isMarkdownTab(doc())).toBe(true);
    expect(isChatTab(doc())).toBe(false);
  });

  it('is a total function — an unknown kind is a chat, not a crash', () => {
    // A value from an older or newer build must not produce a tab that renders
    // neither panel and leaves a blank pane behind.
    expect(tabKindOf({ kind: 'terminal' as never })).toBe('chat');
  });
});

describe('tab kind — a document tab is invisible to the session machinery', () => {
  it('contributes no id to the set that gets persisted', () => {
    // The save effect writes this set and the next project open re-seeds tabs
    // from it. A document has no session, so it is naturally excluded — which
    // is the whole of "markdown tabs do not survive a restart", with no
    // persistence work and no exception to the existing rule.
    const tabs = [chat({ sessionId: 'a' }), doc(), chat({ sessionId: 'b' })];
    expect(openSessionIds(tabs)).toEqual(['a', 'b']);
  });

  it('drops chat tabs that have not minted a session yet', () => {
    expect(openSessionIds([chat({ sessionId: undefined }), doc()])).toEqual([]);
  });

  it('queues nothing when it is closed', () => {
    // `pendingClosedRef` is the ONLY channel that removes a session from the
    // persisted union and deletes it. Closing a document must not be able to
    // reach it.
    expect(closableSessionId(doc())).toBeUndefined();
    expect(closableSessionId(chat({ sessionId: 'a' }))).toBe('a');
  });

  it('queues nothing even if a document tab somehow carried a session id', () => {
    // Belt and braces: the rule is "documents do not delete sessions", not
    // "documents happen not to have ids".
    expect(closableSessionId(doc({ sessionId: 'a' }))).toBeUndefined();
  });
});

describe('tab kind — opening the same document twice focuses it', () => {
  const tabs = [
    { id: 't1', sessionId: 'a' },
    { id: 't2', ...doc({ rel: 'docs/a.md' }) },
    { id: 't3', ...doc({ rel: 'docs/b.md' }) },
  ];

  it('finds the tab already holding that file', () => {
    expect(findDocumentTab(tabs, '/p', 'docs/b.md')?.id).toBe('t3');
  });

  it('does not match a different file in the same project', () => {
    expect(findDocumentTab(tabs, '/p', 'docs/c.md')).toBeUndefined();
  });

  it('does not match the same path in a different project', () => {
    // Two projects can each hold a README.md; they are not the same document.
    expect(findDocumentTab(tabs, '/other', 'docs/a.md')).toBeUndefined();
  });

  it('never matches a chat tab', () => {
    const withChat = [{ id: 'c', cwd: '/p', rel: 'docs/a.md' }, ...tabs];
    // A chat tab carrying a stray `rel` is not a document — the kind decides.
    expect(findDocumentTab(withChat, '/p', 'docs/a.md')?.id).toBe('t2');
  });
});

describe('tab kind — a document is labelled by its file name', () => {
  it('uses the last segment, not the path', () => {
    // `specs/phase-3-persona-agent.md` truncates in a tab strip to the half that
    // says nothing, because every document in the folder shares it.
    expect(documentTabTitle('specs/phase-3-persona-agent.md')).toBe('phase-3-persona-agent.md');
  });

  it('handles a file at the project root', () => {
    expect(documentTabTitle('README.md')).toBe('README.md');
  });

  it('handles Windows separators', () => {
    expect(documentTabTitle('docs\\guide\\intro.md')).toBe('intro.md');
  });

  it('never returns an empty label', () => {
    // An empty tab is indistinguishable from a broken one.
    expect(documentTabTitle('')).toBe('');
    expect(documentTabTitle('/')).toBe('/');
  });
});

describe('tab kind — the chat title machinery cannot rename a document', () => {
  it('refuses the chat state channel for a document tab', () => {
    // `updateTabState` carries isLoading, sessionId AND the title derived from
    // the conversation. A chat tab re-derives its own on every turn — that is
    // why titleLock exists — and a document's title is its file name.
    expect(acceptsChatState(doc())).toBe(false);
    expect(acceptsChatState(chat())).toBe(true);
  });

  it('is the guard that keeps a derived title away from a file name', () => {
    // What WOULD happen without the gate, stated so the gate's value is not
    // theoretical: titleLock would happily overwrite an unlocked title.
    const tab = { id: 't', title: 'a.md', ...doc() };
    expect(applyTitleUpdate(tab, { title: 'Why is the build failing?' }).title).toBe(
      'Why is the build failing?',
    );
    // Which is exactly why the update never reaches it.
    expect(acceptsChatState(tab)).toBe(false);
  });
});

/**
 * The THIRD kind, and why it needed almost no new rules.
 *
 * Every rule in tabKinds is written as a question about `isChatTab` rather than
 * as "not a chat", so a new kind inherits the safe answer by construction. That
 * is a property worth pinning: the day someone rewrites one of them as
 * `kind === 'markdown'`, diff tabs start deleting conversations on close and
 * nothing else in the build changes.
 */
describe('a diff tab', () => {
  const diff: KindedTab = { kind: 'diff', cwd: '/p', diffPath: 'a.ts' };
  const staged: KindedTab = { kind: 'diff', cwd: '/p', diffPath: 'a.ts', diffStaged: true };
  const commit: KindedTab = { kind: 'diff', cwd: '/p', diffCommit: 'abc1234' };

  it('is its own kind, and is neither a chat nor a document', () => {
    expect(tabKindOf(diff)).toBe('diff');
    expect(isDiffTab(diff)).toBe(true);
    expect(isChatTab(diff)).toBe(false);
    expect(isMarkdownTab(diff)).toBe(false);
  });

  it('cannot delete a session when it is closed', () => {
    // The safety argument. A diff tab names no session, so the close path has
    // nothing to queue — expressed as a function precisely so it can be asserted.
    expect(closableSessionId(diff)).toBeUndefined();
    expect(closableSessionId(commit)).toBeUndefined();
  });

  it('contributes nothing to the persisted session set', () => {
    expect(openSessionIds([{ sessionId: 's1' }, diff, commit])).toEqual(['s1']);
  });

  it('is never renamed by a conversation', () => {
    expect(acceptsChatState(diff)).toBe(false);
  });

  it('focuses rather than stacking when the same diff is opened twice', () => {
    const tabs = [diff, commit];
    expect(findDiffTab(tabs, { cwd: '/p', path: 'a.ts' })).toBe(diff);
    expect(findDiffTab(tabs, { cwd: '/p', commit: 'abc1234' })).toBe(commit);
  });

  it('treats staged and unstaged as DIFFERENT diffs of the same file', () => {
    // They are genuinely different: what a commit would take, and what it would
    // leave behind. One identity would silently swap the reader onto the other.
    const tabs = [diff, staged];
    expect(findDiffTab(tabs, { cwd: '/p', path: 'a.ts' })).toBe(diff);
    expect(findDiffTab(tabs, { cwd: '/p', path: 'a.ts', staged: true })).toBe(staged);
  });

  it('does not confuse two projects holding the same filename', () => {
    expect(findDiffTab([diff], { cwd: '/other', path: 'a.ts' })).toBeUndefined();
  });

  it('is not found by the document finder, nor documents by the diff finder', () => {
    const doc: KindedTab = { kind: 'markdown', cwd: '/p', rel: 'a.ts' };
    expect(findDocumentTab([diff], '/p', 'a.ts')).toBeUndefined();
    expect(findDiffTab([doc], { cwd: '/p', path: 'a.ts' })).toBeUndefined();
  });

  it('wears the file name, or the short hash for a commit', () => {
    expect(diffTabTitle({ cwd: '/p', path: 'src/deep/thing.ts' })).toBe('thing.ts');
    expect(diffTabTitle({ cwd: '/p', commit: 'abc1234def5678' })).toBe('abc1234');
  });
});
