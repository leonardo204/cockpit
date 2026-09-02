'use client';

/**
 * GitPanel — the right-side git dock: what changed, where the branch is, and the
 * history as a graph.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT SHOWS. NABY DOES.
 *
 * This panel has no buttons that change the repository, and that is a decision
 * rather than an unfinished edge. naby's user is not someone who knows git's
 * command set — they are someone who asks naby for things in a sentence. For
 * them a row of git buttons is the wrong shape twice over: it offers the shallow
 * half of git (the operations with no judgement in them) while everything that
 * needs judgement — a conflict, a branch that should not have been pushed —
 * still ends in "do this in a terminal", the one instruction this user cannot
 * follow. And it splits the work in two, some of it clicked and some of it
 * asked, with nothing to say which is which.
 *
 * So every action here is a SENTENCE PUT INTO THE CHAT BOX, ready to send or to
 * edit first. The panel's job is to make the repository legible enough that the
 * sentence is a good one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT KEEPS IT TRUE
 *
 * Being a viewer raises the bar on freshness rather than lowering it: a button
 * that is stale gets corrected the moment it is pressed, and a NUMBER that is
 * stale is just believed. Three signals feed it, and each exists because the
 * others are blind to something:
 *
 *   `fs-change`        the working tree moved — an edit, a file created.
 *   `git-change`       index or HEAD moved. `git add` and `git commit` change
 *                      nothing in the working tree, so nothing else sees them.
 *   `git-refs-change`  branches, tags, remotes moved. Measured: `git fetch`,
 *                      `git push`, `git branch` and `git tag` write NEITHER
 *                      index nor HEAD, so before this signal existed they were
 *                      invisible here and the ahead/behind counters silently
 *                      rotted (see `lib/fsWatchScope.ts`).
 *
 * All three arrive whether the change came from naby, from a terminal, or from
 * another program entirely.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWebSocket } from '@cockpit/shared-ui';
import { isGitChange, isGitRefsChange } from './fileBrowserOps';
import type { GitChange, GitLogResponse, GitOverview, GraphRow } from './gitPanelTypes';

// ─────────────────────────────────────────────────────────
// Geometry and colour
// ─────────────────────────────────────────────────────────

/** One commit row. Fixed, because the graph is drawn in a single SVG behind the
 *  list and the two only line up if every row is the same height. */
const ROW_H = 30;
/** Horizontal distance between lanes. */
const LANE_W = 14;
const NODE_R = 3.5;
/** Past this the gutter would eat the panel. Deeper lanes still get their
 *  commits listed; the graph just stops widening. */
const MAX_DRAWN_LANES = 8;

/**
 * Branch colours.
 *
 * Fixed hex rather than theme tokens: these have to stay distinguishable FROM
 * EACH OTHER on both a light and a dark ground, which is a stronger constraint
 * than matching the surrounding palette, and a token that flips with the theme
 * would give two lanes the same colour in one of them. Picked at a mid lightness
 * so none of them disappears into either background.
 */
const LANE_COLOURS = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ec4899',
  '#8b5cf6',
  '#06b6d4',
  '#ef4444',
  '#84cc16',
];

const colourOf = (i: number) => LANE_COLOURS[i % LANE_COLOURS.length]!;
const laneX = (lane: number) => Math.min(lane, MAX_DRAWN_LANES - 1) * LANE_W + LANE_W / 2;

// ─────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────

/**
 * How long ago, in the reader's own language.
 *
 * Computed HERE and not on the server: a relative date rendered server-side is
 * already wrong by the time it is drawn, and stays wrong for as long as the
 * panel is open.
 */
function useRelativeTime() {
  const { i18n } = useTranslation();
  return useCallback(
    (iso: string): string => {
      const then = new Date(iso).getTime();
      if (!Number.isFinite(then)) return '';
      const secs = Math.round((then - Date.now()) / 1000);
      const rtf = new Intl.RelativeTimeFormat(i18n.language, { numeric: 'auto' });
      const steps: [number, Intl.RelativeTimeFormatUnit][] = [
        [60, 'second'],
        [3600, 'minute'],
        [86400, 'hour'],
        [604800, 'day'],
        [2629800, 'week'],
        [31557600, 'month'],
      ];
      let unit: Intl.RelativeTimeFormatUnit = 'year';
      let divisor = 31557600;
      for (let i = 0; i < steps.length; i++) {
        const [limit, name] = steps[i]!;
        if (Math.abs(secs) < limit) {
          unit = name;
          divisor = i === 0 ? 1 : steps[i - 1]![0];
          break;
        }
      }
      return rtf.format(Math.round(secs / divisor), unit);
    },
    [i18n.language],
  );
}

const ICON = 'w-3.5 h-3.5';

function Icon({ d, className = ICON }: { d: string; className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={d} />
    </svg>
  );
}

const PATH = {
  refresh:
    'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
  close: 'M6 18L18 6M6 6l12 12',
  down: 'M19 14l-7 7m0 0l-7-7m7 7V3',
  up: 'M5 10l7-7m0 0l7 7m-7-7v18',
  chevronDown: 'M19 9l-7 7-7-7',
  chevronRight: 'M9 5l7 7-7 7',
  chat: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.9 9.9 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
};

/**
 * The one control this panel has: it writes a sentence into the chat box.
 *
 * IT DOES NOT SEND. The text lands at the caret in the active composer, focused,
 * so the user reads it, edits it if they meant something slightly different, and
 * presses Enter themselves. A button that silently sent a message on their
 * behalf would be a button that changes the repository after all — just with an
 * extra step and less warning.
 */
function AskNaby({ text, label, onAsk }: { text: string; label?: string; onAsk?: (t: string) => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      disabled={!onAsk}
      // THE HOST DELIVERS IT, not this button. Reaching the chat input can mean
      // switching to the tab that owns it first, and only the tab host knows
      // which tab that is — a button that inserted directly could only ever
      // reach a conversation that was already in front, which from a diff tab is
      // never the case.
      onClick={() => onAsk?.(text)}
      title={t('git.askTooltip', {
        defaultValue: 'Put this in the message box — you send it',
      })}
      className="group flex items-center gap-1 w-full px-1.5 py-1 rounded text-left border border-dashed border-border text-muted-foreground hover:border-brand hover:text-brand hover:bg-brand/5"
    >
      <Icon d={PATH.chat} className="w-3 h-3 shrink-0" />
      <span className="truncate text-[0.688rem]">{label ?? text}</span>
    </button>
  );
}

/** A section that can be folded away. The panel is 288px wide by default and all
 *  of them open at once would mean none is readable. */
function Section({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-border">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex items-center gap-1 w-full px-2 py-1.5 text-left text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      >
        <Icon d={open ? PATH.chevronDown : PATH.chevronRight} className="w-3 h-3 shrink-0" />
        <span className="text-[0.688rem] font-semibold uppercase tracking-wide truncate">
          {title}
        </span>
        {count !== undefined && count > 0 && (
          <span className="ml-1 px-1 rounded bg-accent text-[0.625rem] text-foreground shrink-0">
            {count}
          </span>
        )}
      </button>
      {open && children}
    </div>
  );
}

/** The letter beside a path. One character, because the panel is narrow and the
 *  colour carries the rest. */
function ChangeBadge({ kind }: { kind: GitChange['kind'] }) {
  const map: Record<GitChange['kind'], [string, string]> = {
    added: ['A', 'text-emerald-600 dark:text-emerald-400'],
    modified: ['M', 'text-amber-600 dark:text-amber-400'],
    deleted: ['D', 'text-red-600 dark:text-red-400'],
    renamed: ['R', 'text-sky-600 dark:text-sky-400'],
    copied: ['C', 'text-sky-600 dark:text-sky-400'],
    untracked: ['U', 'text-muted-foreground'],
    typechange: ['T', 'text-amber-600 dark:text-amber-400'],
  };
  const [letter, cls] = map[kind];
  return (
    <span className={`w-3 shrink-0 text-center font-mono text-[0.688rem] ${cls}`}>{letter}</span>
  );
}

function ChangeRow({
  change,
  onOpen,
}: {
  change: GitChange;
  onOpen?: () => void;
}) {
  const { t } = useTranslation();
  const name = change.path.split('/').pop() || change.path;
  const dir = change.path.slice(0, change.path.length - name.length).replace(/\/$/, '');
  const body = (
    <>
      <ChangeBadge kind={change.kind} />
      <span className="truncate text-xs text-foreground">{name}</span>
      {dir && <span className="truncate text-[0.625rem] text-muted-foreground">{dir}</span>}
    </>
  );
  const cls = 'flex items-center gap-1.5 w-full px-2 py-0.5 text-left';
  const tip = change.oldPath ? `${change.oldPath} → ${change.path}` : change.path;

  // AN UNTRACKED FILE HAS NOTHING TO DIFF AGAINST. git has never seen it, so
  // `git diff` reports nothing for it — offering a click that opens an empty
  // viewer would teach the reader that the viewer is broken.
  if (!onOpen || change.kind === 'untracked') {
    return (
      <div className={cls} title={tip}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`${cls} hover:bg-accent/60`}
      title={`${tip}\n${t('diff.open', { defaultValue: 'Open the diff' })}`}
    >
      {body}
    </button>
  );
}

// ─────────────────────────────────────────────────────────
// The graph
// ─────────────────────────────────────────────────────────

/**
 * The lanes, drawn as ONE SVG behind the whole list rather than one per row.
 *
 * A per-row SVG would have to draw the half of each line that leaves the row and
 * the half that arrives, and any rounding difference between the two shows as a
 * kink at every row boundary. One canvas with absolute coordinates has no seams
 * to misalign, and it is also the cheaper thing to render: a repository of 200
 * commits is one element, not two hundred.
 */
function GraphLanes({ rows, laneCount }: { rows: GraphRow[]; laneCount: number }) {
  const width = Math.min(laneCount, MAX_DRAWN_LANES) * LANE_W;
  const height = rows.length * ROW_H;
  const y = (i: number) => i * ROW_H + ROW_H / 2;

  return (
    <svg
      width={width}
      height={height}
      className="shrink-0"
      aria-hidden="true"
      style={{ minWidth: width }}
    >
      {rows.map((row, i) =>
        row.edges.map((e, j) => {
          const x1 = laneX(e.fromLane);
          const x2 = laneX(e.toLane);
          const y1 = y(i);
          const y2 = y(i + 1);
          // A straight line where the lane does not move, and a curve where it
          // does — drawn with the control points on the VERTICALS so a branch
          // leaves and rejoins the column it belongs to rather than cutting the
          // corner across another lane's node.
          const d =
            x1 === x2
              ? `M${x1} ${y1}L${x2} ${y2}`
              : `M${x1} ${y1}C${x1} ${y1 + ROW_H * 0.5},${x2} ${y2 - ROW_H * 0.5},${x2} ${y2}`;
          return (
            <path
              key={`${i}-${j}`}
              d={d}
              fill="none"
              stroke={colourOf(e.colour)}
              strokeWidth={1.5}
              strokeLinecap="round"
            />
          );
        }),
      )}
      {rows.map((row, i) => (
        <circle
          key={row.commit.hash}
          cx={laneX(row.lane)}
          cy={y(i)}
          r={NODE_R}
          fill={colourOf(row.colour)}
        />
      ))}
    </svg>
  );
}

function RefBadge({ name, kind, current }: { name: string; kind: string; current?: boolean }) {
  const cls =
    kind === 'head'
      ? 'bg-foreground/15 text-foreground font-semibold'
      : kind === 'tag'
        ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
        : kind === 'remote'
          ? 'bg-muted text-muted-foreground'
          : 'bg-brand/15 text-brand';
  return (
    <span
      // THE CHECKED-OUT BRANCH IS RINGED. Without it the graph shows five branch
      // labels and no sign of which one you are standing on — a reader looking
      // for "where am I" would have to go back up to the header for it.
      className={`px-1 rounded text-[0.625rem] leading-4 shrink-0 max-w-[9rem] truncate ${cls} ${
        current ? 'ring-1 ring-brand' : ''
      }`}
      title={name}
    >
      {name}
    </span>
  );
}

/**
 * Which of a row's refs to draw.
 *
 * `HEAD -> main` arrives as two refs, and drawing both puts a redundant "HEAD"
 * beside a branch name that already says where HEAD is. So the HEAD badge is
 * dropped WHEN A BRANCH IS THERE TO CARRY IT — and kept when there is not, which
 * is precisely the detached case. That is the one time the reader has no other
 * way to see which commit they are sitting on.
 */
function visibleRefs(refs: { name: string; kind: string }[]) {
  const hasBranch = refs.some((r) => r.kind === 'branch');
  return refs.filter((r) => {
    // `origin/HEAD` is a POINTER AT ANOTHER BADGE ON THE SAME ROW — it is
    // whatever `origin/main` is — so drawing it spends a badge to say the same
    // thing twice, under a name that will change the day the remote's default
    // branch does. Dropped here for the same reason the branch list drops it.
    if (r.kind === 'remote' && r.name.endsWith('/HEAD')) return false;
    return r.kind !== 'head' || !hasBranch;
  });
}

// ─────────────────────────────────────────────────────────
// The panel
// ─────────────────────────────────────────────────────────

export interface GitPanelProps {
  cwd: string;
  onClose: () => void;
  width: number;
  resizing: boolean;
  /** Open a diff beside the conversation. Absent → rows are not clickable, which
   *  is the honest state rather than a click that does nothing. */
  onOpenDiff?: (target: { path?: string; staged?: boolean; commit?: string }) => void;
  /** Put a question in the chat box, switching to a conversation if one is not
   *  already in front. Absent → the suggestion buttons are disabled. */
  onAsk?: (text: string) => void;
}

export function GitPanel({ cwd, onClose, width, resizing, onOpenDiff, onAsk }: GitPanelProps) {
  const { t } = useTranslation();
  const ago = useRelativeTime();

  const [overview, setOverview] = useState<GitOverview | null>(null);
  const [log, setLog] = useState<GitLogResponse | null>(null);
  const [limit, setLimit] = useState(200);
  const [open, setOpen] = useState({ changes: true, branches: false, graph: true });

  const toggle = (k: keyof typeof open) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  // -- reading ---------------------------------------------------------------

  /** Guards against a slow response landing after a faster, newer one. The panel
   *  is remounted per project, but a refresh in flight across a burst of watcher
   *  signals can still finish out of order. */
  const reqRef = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++reqRef.current;
    try {
      const res = await fetch(`/api/git/overview?cwd=${encodeURIComponent(cwd)}`);
      if (!res.ok) return;
      const data = (await res.json()) as GitOverview;
      if (seq === reqRef.current) setOverview(data);
    } catch {
      // A panel showing the previous answer is more useful than an error banner
      // over it; the next signal will correct it.
    }
  }, [cwd]);

  const logReqRef = useRef(0);
  const refreshLog = useCallback(async () => {
    const seq = ++logReqRef.current;
    try {
      const res = await fetch(`/api/git/log?cwd=${encodeURIComponent(cwd)}&limit=${limit}`);
      if (!res.ok) return;
      const data = (await res.json()) as GitLogResponse;
      if (seq === logReqRef.current) setLog(data);
    } catch {
      /* as above */
    }
  }, [cwd, limit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // THE GRAPH IS ONLY READ WHILE IT IS SHOWING. `git log --all` is the most
  // expensive thing this panel does, and running it for a folded section would
  // pay that on every commit anyone makes.
  useEffect(() => {
    if (open.graph) void refreshLog();
  }, [open.graph, refreshLog]);

  const onWatch = useCallback(
    (data: unknown) => {
      const refs = isGitRefsChange(data);
      // WHAT CHANGED DECIDES WHAT IS RE-READ. `fs-change` moves the working tree
      // (the Changes list); `git-change` moves index or HEAD; `git-refs-change`
      // moves branches and counters. The overview answers all three, so it is
      // always re-read — the graph costs more, so it is re-read only when
      // history itself can have moved.
      void refresh();
      if (open.graph && (refs || isGitChange(data))) void refreshLog();
    },
    [refresh, refreshLog, open.graph],
  );
  useWebSocket({ url: `/ws/fs-watch?cwd=${encodeURIComponent(cwd)}`, onMessage: onWatch });

  // -- what the header shows -------------------------------------------------

  const repo = overview?.ok && overview.repo ? overview : null;
  const ahead = repo?.aheadBehind?.ahead ?? 0;
  const behind = repo?.aheadBehind?.behind ?? 0;
  const branchName = repo?.head.branch;

  const graphRows = log?.ok && log.repo ? log.rows : [];
  const laneCount = log?.ok && log.repo ? log.laneCount : 0;

  const header = (
    <div className="flex items-center justify-between px-3 py-2 border-b border-border">
      <span className="text-xs font-medium text-foreground truncate" title={cwd}>
        {t('git.panelTitle', { defaultValue: 'Git' })}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => {
            void refresh();
            if (open.graph) void refreshLog();
          }}
          title={t('git.refresh', { defaultValue: 'Refresh' })}
          className="p-1 rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Icon d={PATH.refresh} />
        </button>
        <button
          type="button"
          onClick={onClose}
          title={t('common.close', { defaultValue: 'Close' })}
          className="p-1 rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Icon d={PATH.close} />
        </button>
      </div>
    </div>
  );

  const shell = (body: React.ReactNode) => (
    <aside
      className={`shrink-0 flex flex-col bg-card h-full overflow-hidden ${
        resizing ? '' : 'transition-[width] duration-200'
      }`}
      style={{ width }}
    >
      {header}
      {body}
    </aside>
  );

  // A project with no repository is an ordinary project, not a failure — the
  // same stance the file tree takes. The suggestion is the one thing worth
  // offering: starting a repository is exactly the kind of task to hand to naby.
  if (overview && overview.ok && !overview.repo) {
    return shell(
      <div className="p-3 space-y-2">
        <p className="text-xs text-muted-foreground leading-relaxed">
          {t('git.noRepo', { defaultValue: 'This project is not a git repository.' })}
        </p>
        <AskNaby onAsk={onAsk} text={t('git.askInit', { defaultValue: 'Set this project up with git.' })} />
      </div>,
    );
  }
  if (!repo) {
    return shell(
      <div className="p-4 text-xs text-muted-foreground">
        {t('git.loading', { defaultValue: 'Reading the repository…' })}
      </div>,
    );
  }

  const dirty = repo.staged.length + repo.unstaged.length;

  return shell(
    <div className="flex-1 overflow-y-auto">
      {/* Branch and how far it is from its upstream. READ-ONLY, including the
          counters: they are the panel's most perishable numbers, which is
          exactly why they must never be a button that looks actionable while
          showing a figure from a minute ago. */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border">
        <span
          className="truncate text-xs font-medium text-foreground"
          title={repo.upstream ?? t('git.noUpstream', { defaultValue: 'No upstream' })}
        >
          {repo.head.detached
            ? t('git.detached', { defaultValue: 'detached HEAD' })
            : (branchName ?? '—')}
        </span>
        {/* NO UPSTREAM IS SAID, NOT GUESSED. A branch tracking nothing shown as
            "behind origin/main" would be a comparison that never happened. */}
        {!repo.upstream && !repo.head.detached && (
          <span className="px-1 rounded bg-muted text-[0.625rem] text-muted-foreground shrink-0">
            {t('git.noUpstreamShort', { defaultValue: 'no upstream' })}
          </span>
        )}
        {repo.aheadBehind && (ahead > 0 || behind > 0) && (
          <span className="ml-auto flex items-center gap-1.5 shrink-0 text-[0.688rem] text-muted-foreground">
            {behind > 0 && (
              <span
                className="flex items-center gap-0.5"
                title={t('git.behindTip', {
                  defaultValue: '{{count}} commits on the remote you do not have',
                  count: behind,
                })}
              >
                <Icon d={PATH.down} className="w-3 h-3" />
                {behind}
              </span>
            )}
            {ahead > 0 && (
              <span
                className="flex items-center gap-0.5"
                title={t('git.aheadTip', {
                  defaultValue: '{{count}} commits here that the remote does not have',
                  count: ahead,
                })}
              >
                <Icon d={PATH.up} className="w-3 h-3" />
                {ahead}
              </span>
            )}
          </span>
        )}
      </div>

      {/* The suggestions, right under the state that justifies them. Each one
          appears only when it is the sensible next sentence — an empty panel
          offering "commit my changes" would be teaching the user to ask for
          things that cannot happen. */}
      {(dirty > 0 || behind > 0 || ahead > 0) && (
        <div className="px-2 py-1.5 border-b border-border space-y-1">
          <div className="text-[0.625rem] text-muted-foreground">
            {t('git.askLead', { defaultValue: 'Tell naby to do it:' })}
          </div>
          {dirty > 0 && (
            <AskNaby onAsk={onAsk}
              text={t('git.askCommit', { defaultValue: 'Commit the current changes for me.' })}
            />
          )}
          {behind > 0 && (
            <AskNaby onAsk={onAsk}
              text={t('git.askPull', { defaultValue: 'Bring down the new commits from the remote.' })}
            />
          )}
          {ahead > 0 && (
            <AskNaby onAsk={onAsk} text={t('git.askPush', { defaultValue: 'Push my commits to the remote.' })} />
          )}
        </div>
      )}

      {/* Conflicts first — they block everything below them. */}
      {repo.conflicted.length > 0 && (
        <div className="px-2 py-1.5 border-b border-border bg-red-500/10 space-y-1">
          <div className="text-[0.688rem] font-semibold text-red-700 dark:text-red-300">
            {t('git.conflicted', { defaultValue: 'Conflicts' })} ({repo.conflicted.length})
          </div>
          {repo.conflicted.map((c) => (
            <div key={c.path} className="truncate text-xs text-foreground" title={c.path}>
              {c.path}
            </div>
          ))}
          {/* The old copy here said "resolve these in a terminal", which is the
              one instruction this panel's reader cannot act on. */}
          <AskNaby onAsk={onAsk}
            text={t('git.askResolve', {
              defaultValue: 'Walk me through these merge conflicts and resolve them.',
            })}
          />
        </div>
      )}

      {/* What changed */}
      <Section
        title={t('git.changes', { defaultValue: 'Changes' })}
        count={dirty}
        open={open.changes}
        onToggle={() => toggle('changes')}
      >
        <div className="pb-1">
          {dirty === 0 ? (
            <div className="px-2 py-1 text-[0.688rem] text-muted-foreground">
              {t('git.clean', { defaultValue: 'No local changes.' })}
            </div>
          ) : (
            <>
              {/* STAGED AND UNSTAGED STAY APART even with no buttons to act on
                  them. "Staged" is what a commit would record right now and
                  "changes" is what it would leave behind — a reader about to ask
                  naby to commit needs to see which of their edits is which. */}
              {repo.staged.length > 0 && (
                <>
                  <div className="px-2 pt-1 text-[0.625rem] uppercase tracking-wide text-muted-foreground">
                    {t('git.staged', { defaultValue: 'Staged' })}
                  </div>
                  {repo.staged.map((c) => (
                    <ChangeRow
                      key={`s-${c.path}`}
                      change={c}
                      // The INDEX diff — what a commit would take. Different
                      // from the row below with the same filename, which is why
                      // they open as two tabs.
                      onOpen={onOpenDiff && (() => onOpenDiff({ path: c.path, staged: true }))}
                    />
                  ))}
                </>
              )}
              {repo.unstaged.length > 0 && (
                <>
                  {repo.staged.length > 0 && (
                    <div className="px-2 pt-1 text-[0.625rem] uppercase tracking-wide text-muted-foreground">
                      {t('git.notStaged', { defaultValue: 'Not staged' })}
                    </div>
                  )}
                  {repo.unstaged.map((c) => (
                    <ChangeRow
                      key={`u-${c.path}`}
                      change={c}
                      onOpen={onOpenDiff && (() => onOpenDiff({ path: c.path }))}
                    />
                  ))}
                </>
              )}
            </>
          )}
        </div>
      </Section>

      {/* Branches */}
      <Section
        title={t('git.branches', { defaultValue: 'Branches' })}
        count={repo.branches.length}
        open={open.branches}
        onToggle={() => toggle('branches')}
      >
        <div className="pb-1">
          {repo.branches.map((b) => (
            <div
              key={b.name}
              className={`flex items-center gap-1.5 px-2 py-0.5 ${
                b.current ? 'text-brand' : 'text-foreground'
              }`}
              title={
                b.upstream ? `→ ${b.upstream}` : t('git.noUpstream', { defaultValue: 'No upstream' })
              }
            >
              <span className="w-2 shrink-0 text-[0.625rem]">{b.current ? '●' : ''}</span>
              <span className="truncate text-xs">{b.name}</span>
              {b.upstream && (
                <span className="ml-auto shrink-0 text-[0.625rem] text-muted-foreground truncate max-w-[7rem]">
                  {b.upstream}
                </span>
              )}
            </div>
          ))}
          {repo.remoteBranches.length > 0 && (
            <div className="px-2 pt-1 text-[0.625rem] text-muted-foreground">
              {t('git.remoteCount', {
                defaultValue: '{{count}} remote branches',
                count: repo.remoteBranches.length,
              })}
            </div>
          )}
          <div className="px-2 pt-1.5">
            <AskNaby onAsk={onAsk}
              text={t('git.askBranch', {
                defaultValue: 'Make a new branch for what I am working on.',
              })}
            />
          </div>
        </div>
      </Section>

      {/* Graph */}
      <Section
        title={t('git.graph', { defaultValue: 'Commit graph' })}
        open={open.graph}
        onToggle={() => toggle('graph')}
      >
        {graphRows.length === 0 ? (
          <div className="px-2 py-1.5 text-[0.688rem] text-muted-foreground">
            {t('git.noCommits', { defaultValue: 'No commits yet.' })}
          </div>
        ) : (
          <>
            <div className="flex px-2 py-1">
              <GraphLanes rows={graphRows} laneCount={laneCount} />
              <div className="min-w-0 flex-1">
                {graphRows.map((row) => (
                  <button
                    key={row.commit.hash}
                    type="button"
                    disabled={!onOpenDiff}
                    onClick={() => onOpenDiff?.({ commit: row.commit.hash })}
                    style={{ height: ROW_H }}
                    className="flex flex-col justify-center min-w-0 w-full pl-1.5 text-left rounded enabled:hover:bg-accent/60 disabled:cursor-default"
                    title={`${row.commit.shortHash}  ${row.commit.author}\n${row.commit.subject}\n${t('diff.open', { defaultValue: 'Open the diff' })}`}
                  >
                    <div className="flex items-center gap-1 min-w-0">
                      {visibleRefs(row.commit.refs).map((r) => (
                        <RefBadge
                          key={`${r.kind}-${r.name}`}
                          name={r.name}
                          kind={r.kind}
                          current={r.kind === 'branch' && r.name === branchName}
                        />
                      ))}
                      <span className="truncate text-xs text-foreground">{row.commit.subject}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[0.625rem] text-muted-foreground">
                      <span className="font-mono">{row.commit.shortHash}</span>
                      <span className="truncate">{row.commit.author}</span>
                      <span className="ml-auto shrink-0">{ago(row.commit.date)}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
            {log?.ok && log.repo && log.hasMore && (
              <button
                type="button"
                onClick={() => setLimit((l) => l + 200)}
                className="w-full py-1 text-[0.688rem] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {t('git.loadMore', { defaultValue: 'Load more' })}
              </button>
            )}
          </>
        )}
      </Section>
    </div>,
  );
}
