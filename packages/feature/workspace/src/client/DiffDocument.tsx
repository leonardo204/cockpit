'use client';

/**
 * DiffDocument — one diff, held open in a tab beside the conversation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A TAB AND NOT PART OF THE PANEL
 *
 * The git panel is 288px wide by default. A diff read at that width is a column
 * of fragments — every line wraps twice and the `+`/`−` gutter costs a tenth of
 * the space. So a diff opens where the conversation is, at full width.
 *
 * It is deliberately NOT A MODAL either — but not for the reason an earlier
 * version of this comment gave. A tab REPLACES the conversation on screen rather
 * than sitting beside it, so the diff and the message box are never visible at
 * once and "ask about it while looking at it" was never true.
 *
 * What a tab buys instead is that the diff STAYS. A modal is dismissed the
 * moment you go to type, and with it the thing you were about to describe; a tab
 * is still there when you come back, and switching costs one click. That is also
 * why "Ask naby about this" hands the text to the tab host rather than inserting
 * it here: reaching the chat input means making a conversation active first.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UNIFIED, NOT SIDE BY SIDE
 *
 * Two columns need roughly 160 characters before each side stops wrapping, which
 * this tab has only on a wide screen and never next to an open panel. A unified
 * diff reads correctly at any width, and the line numbers on the left carry the
 * information the second column would have.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWebSocket } from '@cockpit/shared-ui';
import { isGitRefsChange } from './fileBrowserOps';
import type { DiffFile, DiffHunk, DiffResponse } from './gitPanelTypes';

// ─────────────────────────────────────────────────────────
// Small pieces
// ─────────────────────────────────────────────────────────

/**
 * How many lines git hid between two hunks.
 *
 * git trims context to three lines either side, so the gap is everything the
 * reader was not shown. Saying so is what keeps a diff from reading as the whole
 * file — a viewer that silently butts two hunks together is claiming line 12 is
 * followed by line 58.
 */
function gapBefore(previous: DiffHunk | undefined, next: DiffHunk): number {
  if (!previous) return Math.max(0, next.oldStart - 1);
  const lastOld = previous.lines.reduce((n, l) => l.oldNum ?? n, previous.oldStart - 1);
  return Math.max(0, next.oldStart - lastOld - 1);
}

const NUM_W = 'w-10';

function LineRow({
  kind,
  oldNum,
  newNum,
  text,
}: {
  kind: 'context' | 'add' | 'del';
  oldNum?: number;
  newNum?: number;
  text: string;
}) {
  const tint =
    kind === 'add'
      ? 'bg-emerald-500/10'
      : kind === 'del'
        ? 'bg-red-500/10'
        : '';
  const mark = kind === 'add' ? '+' : kind === 'del' ? '−' : ' ';
  const markCls =
    kind === 'add'
      ? 'text-emerald-600 dark:text-emerald-400'
      : kind === 'del'
        ? 'text-red-600 dark:text-red-400'
        : 'text-transparent';

  return (
    <div className={`flex font-mono text-xs leading-5 ${tint}`}>
      {/* LINE NUMBERS ARE NOT SELECTABLE. Copying a diff out of a viewer that
          puts them in the selection gives you code with a number welded to the
          front of every line, which is the commonest small annoyance in every
          web diff there is. */}
      <span className={`${NUM_W} shrink-0 select-none text-right pr-2 text-muted-foreground/60`}>
        {oldNum ?? ''}
      </span>
      <span className={`${NUM_W} shrink-0 select-none text-right pr-2 text-muted-foreground/60`}>
        {newNum ?? ''}
      </span>
      <span className={`w-4 shrink-0 select-none text-center ${markCls}`}>{mark}</span>
      {/* `whitespace-pre` keeps indentation, and `break-all` is deliberately NOT
          used: a wrapped line would break mid-token and read as a different
          line. The row scrolls horizontally with its container instead. */}
      <span className="whitespace-pre text-foreground">{text || ' '}</span>
    </div>
  );
}

function GapRow({ lines }: { lines: number }) {
  const { t } = useTranslation();
  return (
    <div className="flex font-mono text-[0.688rem] leading-5 bg-muted/40 text-muted-foreground">
      <span className={`${NUM_W} shrink-0 select-none text-right pr-2`}>⋯</span>
      <span className={`${NUM_W} shrink-0 select-none text-right pr-2`}>⋯</span>
      <span className="w-4 shrink-0" />
      <span className="pl-1">
        {t('diff.hidden', { defaultValue: '{{count}} unchanged lines', count: lines })}
      </span>
    </div>
  );
}

function FileBlock({ file }: { file: DiffFile }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-2 w-full px-3 py-2 text-left bg-muted/40 hover:bg-accent/60"
      >
        <span className="truncate text-sm text-foreground font-medium" title={file.path}>
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <span className="ml-auto shrink-0 flex items-center gap-2 text-xs font-mono">
          {file.additions > 0 && (
            <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
          )}
          {file.deletions > 0 && (
            <span className="text-red-600 dark:text-red-400">−{file.deletions}</span>
          )}
        </span>
      </button>

      {open && (
        <div className="overflow-x-auto">
          {file.binary ? (
            // NOT AN ERROR AND NOT AN EMPTY DIFF. Rendering "no changes" for a
            // changed image would be the viewer saying something false.
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {t('diff.binary', { defaultValue: 'Binary file — no text to show.' })}
            </div>
          ) : file.hunks.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {t('diff.noTextChange', {
                defaultValue: 'No text changes (a mode or rename only).',
              })}
            </div>
          ) : (
            <div className="py-1 min-w-fit">
              {file.hunks.map((hunk, i) => {
                const gap = gapBefore(file.hunks[i - 1], hunk);
                return (
                  <div key={hunk.header + i}>
                    {gap > 0 && <GapRow lines={gap} />}
                    {hunk.lines.map((line, j) => (
                      <LineRow key={j} {...line} />
                    ))}
                  </div>
                );
              })}
              {file.truncated && (
                <div className="px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                  {t('diff.truncatedFile', {
                    defaultValue: 'This file’s diff is too long to show in full.',
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// The document
// ─────────────────────────────────────────────────────────

export interface DiffDocumentProps {
  cwd: string;
  /** A file diff. Mutually exclusive with `commit`. */
  path?: string;
  /** For a file diff: the index rather than the working tree. */
  staged?: boolean;
  /** A whole commit's diff. */
  commit?: string;
  /** Put a question in the chat box. Delivered by the tab host, which switches
   *  to a conversation first — a diff tab IS the active tab, so the chat input
   *  it would insert into is never registered while this is on screen. */
  onAsk?: (text: string) => void;
}

export function DiffDocument({ cwd, path, staged, commit, onAsk }: DiffDocumentProps) {
  const { t } = useTranslation();
  const [data, setData] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const url = useMemo(() => {
    const p = new URLSearchParams({ cwd });
    if (commit) p.set('commit', commit);
    else if (path) {
      p.set('path', path);
      if (staged) p.set('staged', '1');
    }
    return `/api/git/diff?${p.toString()}`;
  }, [cwd, path, staged, commit]);

  /** Guards against a slow re-read landing after a faster, newer one — an editor
   *  saving twice in a second is enough to overlap two fetches. */
  const reqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++reqRef.current;
    setLoading(true);
    try {
      const res = await fetch(url);
      const next = res.ok ? ((await res.json()) as DiffResponse) : null;
      if (seq === reqRef.current) setData(next);
    } catch {
      if (seq === reqRef.current) setData(null);
    } finally {
      if (seq === reqRef.current) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * A WORKING-TREE DIFF GOES STALE WHILE YOU READ IT. The file is on disk and
   * anything can write to it — you in an editor, naby carrying out the thing you
   * just asked for, a formatter on save. A viewer that showed the state at the
   * moment you clicked would be quietly describing a file that no longer looks
   * like that, and there is nothing on screen to say so.
   *
   * Both signals count, and for different reasons:
   *   `fs-change`   the file was written — the unstaged diff moved.
   *   `git-change`  the index moved. `git add` takes lines OUT of the unstaged
   *                 diff and puts them in the staged one without touching the
   *                 file at all, so nothing else would notice.
   *
   * `git-refs-change` is not subscribed: a branch or a tag moving does not
   * change what the working tree differs from.
   *
   * A COMMIT DIFF IS NOT WATCHED AT ALL, and that is not an omission. A commit is
   * identified by the hash of its content; `git show <hash>` returns the same
   * bytes forever. Re-reading it on every file save would be work that cannot
   * ever produce a different answer.
   */
  const onWatch = useCallback(
    (message: unknown) => {
      // Everything except the refs channel means this diff may have moved, so
      // the test is a single exclusion rather than a list of inclusions — a
      // fourth signal added later should re-read by default, not be forgotten.
      if (isGitRefsChange(message)) return;
      void load();
    },
    [load],
  );
  useWebSocket({
    url: `/ws/fs-watch?cwd=${encodeURIComponent(cwd)}`,
    onMessage: onWatch,
    enabled: !commit,
  });

  // WHAT THE READER WOULD ASK NABY ABOUT THIS DIFF, prefilled. The panel's own
  // suggestions are about the repository; this one is about the thing on screen,
  // so it names it.
  const askText = commit
    ? t('diff.askCommit', {
        defaultValue: 'Explain what commit {{commit}} changed and why.',
        commit: commit.slice(0, 7),
      })
    : t('diff.askFile', {
        defaultValue: 'Explain the changes in {{path}}.',
        path: path ?? '',
      });

  const title = commit
    ? t('diff.commitTitle', { defaultValue: 'Commit {{commit}}', commit: commit.slice(0, 7) })
    : staged
      ? t('diff.stagedTitle', { defaultValue: '{{path}} — staged', path: path ?? '' })
      : (path ?? '');

  const files = data?.ok ? data.files : [];
  const totals = files.reduce(
    (acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }),
    { add: 0, del: 0 },
  );

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
        <span className="truncate text-sm font-medium text-foreground" title={path ?? commit}>
          {title}
        </span>
        <span className="shrink-0 flex items-center gap-2 text-xs font-mono">
          {totals.add > 0 && (
            <span className="text-emerald-600 dark:text-emerald-400">+{totals.add}</span>
          )}
          {totals.del > 0 && <span className="text-red-600 dark:text-red-400">−{totals.del}</span>}
        </span>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={!onAsk}
            onClick={() => onAsk?.(askText)}
            title={t('git.askTooltip', {
              defaultValue: 'Put this in the message box — you send it',
            })}
            className="px-2 py-1 rounded border border-dashed border-border text-xs text-muted-foreground hover:border-brand hover:text-brand hover:bg-brand/5 disabled:opacity-40"
          >
            {t('diff.ask', { defaultValue: 'Ask naby about this' })}
          </button>
          <button
            type="button"
            onClick={() => void load()}
            className="px-2 py-1 rounded text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {t('git.refresh', { defaultValue: 'Refresh' })}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {loading && !data ? (
          <div className="text-xs text-muted-foreground">
            {t('diff.loading', { defaultValue: 'Reading the diff…' })}
          </div>
        ) : !data || !data.ok ? (
          <div className="text-xs text-muted-foreground">
            {t('diff.failed', { defaultValue: 'This diff could not be read.' })}
          </div>
        ) : files.length === 0 ? (
          // A REAL AND ORDINARY OUTCOME: the file was staged, or reverted, while
          // the tab was open. Saying "no changes" is the answer, not a failure.
          <div className="text-xs text-muted-foreground">
            {t('diff.empty', { defaultValue: 'Nothing changed here.' })}
          </div>
        ) : (
          <>
            {files.map((f) => (
              <FileBlock key={`${f.oldPath ?? ''}→${f.path}`} file={f} />
            ))}
            {data.truncated && (
              <div className="text-xs text-amber-600 dark:text-amber-400">
                {t('diff.truncatedList', {
                  defaultValue: 'Only the first files are shown — this change is very large.',
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
