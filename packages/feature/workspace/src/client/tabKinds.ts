/**
 * tabKinds.ts — what KIND of thing a tab holds, as pure functions.
 *
 * Until the markdown viewer was promotable, a tab was a chat by construction:
 * TabManager mapped over the tab list and rendered `<ChatPanel>` unconditionally,
 * and every optional field on `TabInfo` past `title` (sessionId, engine,
 * planMode, isLoading) was a chat concept. Adding a second kind of tab is
 * therefore not a rendering change — it is a discrimination that the tab host,
 * the persistence effect, the close path, the title machinery and the
 * right-click menu each have to agree on.
 *
 * They agree HERE, and nowhere else. Same reasoning as markdownPreviewOps.ts and
 * tabOrder.ts beside it: this repo has no component-render harness, so a rule
 * expressed only inside JSX is untested by construction. Each rule below is one
 * whose failure mode is silent — a document tab that quietly deletes a chat
 * session on close, or one whose name is overwritten by a conversation it has
 * nothing to do with — so each is stated once, here, and pinned by
 * tabKinds.test.ts.
 */

/**
 * `chat` is a running conversation; `markdown` is a document held open beside
 * one.
 *
 * ABSENT MEANS CHAT. Every tab that existed before this feature has no `kind`
 * field, and the default has to be the kind they all are — an undefined that
 * fell through to "document" would render the whole app as an empty viewer.
 */
export type TabKind = 'chat' | 'markdown' | 'diff';

/** The parts of a tab this module reads. Deliberately structural rather than
 *  importing TabInfo: these rules are about the shape, and typing them this way
 *  is what lets the tests state them on plain objects. */
export interface KindedTab {
  kind?: TabKind;
  /** The project working tree. A document tab cannot resolve its images or its
   *  relative links without one, which is why it is opened with the project's. */
  cwd?: string;
  /** The document, project-relative. Only a markdown tab has one. */
  rel?: string;
  sessionId?: string;
  /** What a diff tab is showing. Absent on every other kind.
   *
   *  A `path` diff is the working tree (or the index, when `staged`); a `commit`
   *  diff is one commit's whole change. They are separate fields rather than one
   *  string because they are not the same question, and a viewer that guessed
   *  which it had been given would show the wrong one silently. */
  diffPath?: string;
  diffStaged?: boolean;
  diffCommit?: string;
}

export function tabKindOf(tab: KindedTab): TabKind {
  if (tab.kind === 'markdown') return 'markdown';
  if (tab.kind === 'diff') return 'diff';
  return 'chat';
}

export function isMarkdownTab(tab: KindedTab): boolean {
  return tabKindOf(tab) === 'markdown';
}

export function isDiffTab(tab: KindedTab): boolean {
  return tabKindOf(tab) === 'diff';
}

export function isChatTab(tab: KindedTab): boolean {
  return tabKindOf(tab) === 'chat';
}

/**
 * The label a document tab wears: its FILE NAME, not its path.
 *
 * A tab strip is narrow and `specs/phase-3-persona-agent.md` truncates to
 * `specs/phase-3-p…`, which is the half that says nothing — every document in a
 * folder shares it. The full path is still one hover away (the tab's tooltip)
 * and is printed in the viewer's own header.
 */
export function documentTabTitle(rel: string): string {
  const parts = rel.split(/[/\\]/).filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : rel;
}

/**
 * The already-open tab for this exact document, if there is one.
 *
 * Opening the same file twice must FOCUS rather than stack, which is what
 * `handleSelectSession` already does for a session — a second identical tab is
 * never what someone reaching for a document meant, and closing the wrong one of
 * a pair is a small, avoidable annoyance.
 *
 * The cwd is part of the identity: two projects can each hold a `README.md`, and
 * they are not the same document.
 */
export function findDocumentTab<T extends KindedTab>(
  tabs: readonly T[],
  cwd: string,
  rel: string,
): T | undefined {
  return tabs.find((tab) => isMarkdownTab(tab) && tab.cwd === cwd && tab.rel === rel);
}

/** What a diff tab is looking at, as one comparable value. */
export interface DiffTarget {
  cwd: string;
  /** A working-tree or index diff of one file. */
  path?: string;
  staged?: boolean;
  /** One commit's whole change. */
  commit?: string;
}

/**
 * The already-open tab for this exact diff, if there is one.
 *
 * Same focus-don't-stack rule as `findDocumentTab`, with one addition that
 * matters: STAGED AND UNSTAGED ARE DIFFERENT TABS for the same file. They are
 * genuinely different diffs — what a commit would take, and what it would leave
 * behind — and treating them as one identity would silently swap the reader onto
 * the other one.
 */
export function findDiffTab<T extends KindedTab>(
  tabs: readonly T[],
  target: DiffTarget,
): T | undefined {
  return tabs.find(
    (tab) =>
      isDiffTab(tab) &&
      tab.cwd === target.cwd &&
      tab.diffCommit === target.commit &&
      tab.diffPath === target.path &&
      !!tab.diffStaged === !!target.staged,
  );
}

/**
 * The label a diff tab wears.
 *
 * A file diff wears the FILE NAME, like a document tab, for the same reason: the
 * folder part truncates to the half that says nothing. A commit diff wears the
 * short hash, which is the only part of a commit that is both short and unique —
 * a subject line truncates to "Fix the thing that…" for every third commit.
 */
export function diffTabTitle(target: DiffTarget): string {
  if (target.commit) return target.commit.slice(0, 7);
  const rel = target.path ?? '';
  const parts = rel.split(/[/\\]/).filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : rel;
}

/**
 * The sessions this tab list has open — the set the project-state save writes.
 *
 * A document tab contributes NOTHING, and that is what makes markdown tabs
 * disappear on restart without any persistence work: the saved set is what the
 * next open re-seeds tabs from, so a tab with no session id is naturally
 * excluded. That absence matches the existing rule (opening a project starts a
 * new session and never rebuilds the old layout), so it needs no exception.
 */
export function openSessionIds(tabs: readonly KindedTab[]): string[] {
  return tabs
    .filter(isChatTab)
    .map((tab) => tab.sessionId)
    .filter((id): id is string => !!id);
}

/**
 * What closing this tab must queue into `pendingClosedRef` — the ONE channel by
 * which a session is removed from the persisted union (and, downstream,
 * deleted).
 *
 * `undefined` for a document tab, which is the whole safety argument for
 * markdown tabs — and, unchanged, for diff tabs: closing one cannot remove a
 * session, because it names none. Every rule in this file is written as a
 * question about `isChatTab` rather than about "not chat", which is why adding
 * a third kind needed no edit to any of them.
 * Expressed as a function rather than as an `if (tab.sessionId)` in the close
 * path so it can be asserted directly — nothing in a build can see that a close
 * deleted something it should not have.
 */
export function closableSessionId(tab: KindedTab): string | undefined {
  return isChatTab(tab) ? tab.sessionId : undefined;
}

/**
 * Whether the chat's state channel (`updateTabState`: isLoading, sessionId, and
 * the title derived from the conversation) applies to this tab.
 *
 * FALSE FOR A DOCUMENT TAB. Chat tabs re-derive their title from the
 * conversation as it grows — that is why `titleLocked` had to be invented — and
 * a document's title is its file name, which no conversation has any business
 * renaming. Nothing routes a document tab into `onStateChange` today (it renders
 * no ChatPanel at all), so this is a guard rather than a fix; it is here because
 * the day something does, the symptom would be a document tab silently wearing
 * the last question somebody asked.
 */
export function acceptsChatState(tab: KindedTab): boolean {
  return isChatTab(tab);
}
