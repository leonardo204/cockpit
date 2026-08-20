'use client';

/**
 * The right-side file browser (VSCode-style) for the chat workspace.
 *
 * It is a lazy directory tree over the active project's working tree (`cwd`):
 * each folder fetches its children from `/api/list-dir` only when expanded, so
 * opening the panel never walks the whole tree. It does three things:
 *
 *   • DRAG a row onto the chat input  → the cwd-relative PATH is inserted.
 *   • ⌘/Ctrl-CLICK a row              → "@<path>" is inserted at the caret.
 *   • DROP OS files onto a folder     → the files are COPIED into that folder
 *     (Finder/Explorer → project), then that folder refreshes.
 *   • plain click on a folder         → expand/collapse (files: no-op).
 *   • DOUBLE-CLICK a MARKDOWN row     → the in-app viewer (MarkdownPreviewModal).
 *   • DOUBLE-CLICK any other file row → the OS default application for that
 *     extension opens it.
 *   • RIGHT-CLICK a row (or the body) → the Finder-basic operations menu:
 *     preview, open, open with, new file, new folder, rename, duplicate,
 *     delete, copy path, reveal.
 *
 * MARKDOWN IS THE ONE EXTENSION THE APP OPENS ITSELF, and the rule is narrow on
 * purpose. For every other type the user's own tools win the argument, so the
 * hand-off to the OS is still the default and both "Open" and "Open With…"
 * remain on the menu for markdown too — this replaces no escape hatch. Markdown
 * is the exception because the app already renders it better than a hand-off
 * can: the same GFM/math/TOC pipeline the chat uses, plus relative `.md` links
 * that open in place, which turns a folder of documents into something
 * browsable instead of a queue of editor windows. `rowActivation`
 * (markdownPreviewOps.ts) is where the choice is made.
 *
 * REFERENCE SAFETY. Reference paths are relative to the project root and folders
 * carry a trailing "/". A `/` or `.` immediately after the name makes the chat
 * command parser's `^\s*[/@]verb(\s|$)` line matcher fail, so an inserted
 * "@src/…" is never mistaken for an "@verb" subagent command.
 *
 * MUTATION SAFETY. Every write goes through `/api/fs-op`, which resolves the
 * path inside `cwd` and REFUSES rather than overwrites (see that route). Delete
 * prefers the Electron trash bridge (`window.naby.fsOps.trash`) because it is
 * recoverable, and falls back to the route's permanent `rm` only in a plain
 * browser — where the confirmation says so, rather than promising a trash that
 * does not exist. Nothing mutates without a confirmation or an explicit name.
 *
 * LIVE REFRESH. The tree used to update only after its OWN writes, so a file the
 * agent created, a folder made in a terminal, or anything a build produced stayed
 * invisible until someone pressed refresh. `/ws/fs-watch` now reports which
 * directories changed and those are bumped through the same per-directory nonce
 * the mutations use. The watcher ignores `node_modules`, `.git` and build output
 * (see src/lib/fsWatchScope.ts) — without that one `npm install` would emit tens
 * of thousands of events — and it is unavailable on platforms that cannot watch
 * recursively, which is why the manual refresh button is still here.
 *
 * The menu itself is FIXED-positioned (see FileBrowserContextMenu): this panel's
 * root is `overflow-hidden`, so an absolutely positioned menu would be clipped.
 *
 * Mounted once per project (in TabManager), so it takes `cwd` directly and is
 * stable across chat-tab switches; it lives off the always-rendered chat hot
 * path (only present while toggled open).
 */

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { confirm, toast, useWebSocket } from '@cockpit/shared-ui';
import { FILE_REF_MIME, insertFileRef, osFilePath } from '@cockpit/feature-agent';
import { FileBrowserContextMenu, type FileMenuState } from './FileBrowserContextMenu';
import { MarkdownPreviewModal } from './MarkdownPreviewModal';
import {
  absolutePathOf,
  childRel,
  createParentOf,
  escapeHtml,
  failureKey,
  fsChangeDirs,
  isCommittableName,
  renameSelection,
  stripTransTags,
  type MenuTarget,
} from './fileBrowserOps';
import { rowActivation } from './markdownPreviewOps';

interface Entry {
  name: string;
  isDir: boolean;
}

type ListResponse =
  | { ok: true; entries: Entry[] }
  | { ok: false; reason: string };

type CopyResponse =
  | { ok: true; copied: string[]; skipped: string[]; failed: string[] }
  | { ok: false; reason: string };

// `read` is deliberately absent: it is the only action that returns a body, so
// it is issued by MarkdownPreviewModal with its own response type rather than
// forced through the `{ok, rel}` shape every mutating op shares.
type FsOpAction = 'mkdir' | 'mkfile' | 'rename' | 'duplicate' | 'delete' | 'open' | 'reveal' | 'openWith';

type FsOpResponse =
  | { ok: true; rel: string }
  | { ok: false; reason: string };

/** Per-directory refresh signal: bumping a folder's nonce makes its TreeChildren
 *  re-fetch (used after a copy lands new files in it, or after any mutation),
 *  without collapsing the rest of the expanded tree. */
const RefreshContext = createContext<{ nonceOf: (rel: string) => number; bump: (rel: string) => void }>({
  nonceOf: () => 0,
  bump: () => {},
});

/** What a row needs from the panel to take part in the operations menu.
 *
 *  `openMenu` is referentially stable (it only calls a setState), so opening or
 *  closing the menu does not re-render the tree. `renamingRel` and `creating`
 *  do change the value — deliberately: they are what make one row become an
 *  input, and they only move on an explicit user action. */
const FileOpsContext = createContext<{
  openMenu: (e: React.MouseEvent, target: MenuTarget) => void;
  /** Hand a file to the OS default app. */
  openFile: (target: MenuTarget) => void;
  /** Open a markdown file in the in-app viewer. */
  previewFile: (target: MenuTarget) => void;
  /** The row currently being renamed, if any; its label becomes an input. */
  renamingRel: string | null;
  commitRename: (target: MenuTarget, next: string) => void;
  cancelRename: () => void;
  /** The directory currently sprouting a new entry, and which kind. */
  creating: { parentRel: string; isDir: boolean } | null;
  commitCreate: (name: string) => void;
  cancelCreate: () => void;
}>({
  openMenu: () => {},
  openFile: () => {},
  previewFile: () => {},
  renamingRel: null,
  commitRename: () => {},
  cancelRename: () => {},
  creating: null,
  commitCreate: () => {},
  cancelCreate: () => {},
});

/** The reference text for an entry: cwd-relative, folders trailing-slashed so it
 *  can never be parsed as an @verb subagent command. */
function refFor(rel: string, isDir: boolean): string {
  return isDir ? `${rel}/` : rel;
}

async function fetchDir(cwd: string, rel: string): Promise<Entry[] | null> {
  try {
    const params = new URLSearchParams({ cwd, rel });
    const res = await fetch(`/api/list-dir?${params.toString()}`);
    if (!res.ok) return null;
    const data = (await res.json()) as ListResponse;
    return data.ok ? data.entries : null;
  } catch {
    return null;
  }
}

/** Copy OS-dropped files into `destRel` under the project. Returns the number
 *  copied, or null on a hard failure. */
async function copyInto(cwd: string, destRel: string, files: FileList): Promise<CopyResponse | null> {
  const sources: string[] = [];
  for (const f of Array.from(files)) {
    const p = osFilePath(f);
    if (p) sources.push(p);
  }
  if (sources.length === 0) return null;
  try {
    const res = await fetch('/api/copy-into', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, destRel, sources }),
    });
    if (!res.ok) return null;
    return (await res.json()) as CopyResponse;
  } catch {
    return null;
  }
}

/** One mutating operation on the project tree. A transport failure is reported
 *  as `{ok:false, reason:'failed'}` so callers have one shape to branch on. */
async function fsOp(
  cwd: string,
  action: FsOpAction,
  rel: string,
  name?: string,
): Promise<FsOpResponse> {
  try {
    const res = await fetch('/api/fs-op', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, action, rel, name }),
    });
    if (!res.ok) return { ok: false, reason: 'failed' };
    return (await res.json()) as FsOpResponse;
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

type BridgeResult = { ok: true; value: void } | { ok: false; error: { code: string; message: string } };

interface FsOpsBridge {
  reveal(target: { cwd: string; rel: string }): Promise<BridgeResult>;
  open(target: { cwd: string; rel: string }): Promise<BridgeResult>;
  trash(target: { cwd: string; rel: string }): Promise<BridgeResult>;
}

/** The Electron file bridge, or null where it is not visible (a plain browser,
 *  and Windows builds where the subframe bridge does not surface). Feature-
 *  detected the same way DevModePanel/UpdatePanel detect theirs — the panel
 *  must work in both hosts. It decides whether delete can be a recoverable
 *  trash, and which transport Open / Reveal use; the menu offers them either
 *  way, because `/api/fs-op` covers both when the bridge is dark. */
function fsBridge(): FsOpsBridge | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { naby?: { fsOps?: FsOpsBridge } };
  return w.naby?.fsOps ?? null;
}

/** Does this drag carry OS files (so a folder can accept a copy)? */
function hasOsFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

/**
 * The inline text input a row becomes while it is being named.
 *
 * ONE SETTLEMENT ONLY. Enter commits and then blurs, so without the `settled`
 * latch the blur handler would commit a second time — for a rename that is a
 * second request against a path that no longer exists, i.e. a spurious error
 * toast on a successful rename.
 */
function InlineNameInput({
  defaultValue,
  placeholder,
  selectBasename,
  depth,
  icon,
  onCommit,
  onCancel,
}: {
  defaultValue: string;
  placeholder?: string;
  /** Preselect the name without its extension (rename); false selects all. */
  selectBasename: boolean;
  depth: number;
  icon: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const settled = useRef(false);

  // Focus and select ONCE, on mount. Doing this from a ref callback instead
  // would re-run on every re-render of the tree and yank the caret back to the
  // start while the user is still typing.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const { start, end } = selectBasename
      ? renameSelection(defaultValue)
      : { start: 0, end: defaultValue.length };
    el.setSelectionRange(start, end);
    // `defaultValue`/`selectBasename` are fixed for the life of this input —
    // the row is unmounted when the edit ends.
  }, [defaultValue, selectBasename]);

  const commit = (value: string) => {
    if (settled.current) return;
    settled.current = true;
    onCommit(value);
  };
  const cancel = () => {
    if (settled.current) return;
    settled.current = true;
    onCancel();
  };

  return (
    <div
      style={{ paddingLeft: 8 + depth * 12 }}
      className="flex items-center gap-1 py-0.5 pr-2 text-xs"
    >
      <span className="w-3 flex-shrink-0" />
      <span className="flex-shrink-0">{icon}</span>
      <input
        ref={inputRef}
        data-testid="file-name-input"
        defaultValue={defaultValue}
        placeholder={placeholder}
        onClick={(e) => e.stopPropagation()}
        // Commit on blur as well as Enter: clicking away is what most people
        // do, and losing the typed name there would be rude. An empty value is
        // a cancel, not a request to create a nameless file.
        onBlur={(e) => (e.target.value.trim() ? commit(e.target.value.trim()) : cancel())}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commit(e.currentTarget.value.trim());
          if (e.key === 'Escape') cancel();
        }}
        className="flex-1 min-w-0 px-1 py-0 text-xs bg-background border border-brand rounded outline-none"
      />
    </div>
  );
}

/** One row + (for an expanded folder) its lazily-loaded children. */
const TreeNode = memo(function TreeNode({
  cwd,
  parentRel,
  entry,
  depth,
}: {
  cwd: string;
  parentRel: string;
  entry: Entry;
  depth: number;
}) {
  const { t } = useTranslation();
  const { bump } = useContext(RefreshContext);
  const { openMenu, openFile, previewFile, renamingRel, commitRename, cancelRename, creating } =
    useContext(FileOpsContext);
  const [open, setOpen] = useState(false);
  const [dropOver, setDropOver] = useState(false);
  const [copying, setCopying] = useState(false);
  const rel = childRel(parentRel, entry.name);
  const ref = refFor(rel, entry.isDir);
  const renaming = renamingRel === rel;

  // "New file" chosen on a COLLAPSED folder has to open it, or the input would
  // be created into a subtree nobody can see. The folder owns its own `open`
  // state, so it reacts here rather than the panel reaching in.
  useEffect(() => {
    if (entry.isDir && creating?.parentRel === rel) setOpen(true);
  }, [entry.isDir, creating, rel]);

  const onDragStart = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.setData(FILE_REF_MIME, ref);
      e.dataTransfer.setData('text/plain', ref);
      e.dataTransfer.effectAllowed = 'copy';
    },
    [ref],
  );

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        insertFileRef(`@${ref}`);
        return;
      }
      if (entry.isDir) setOpen((v) => !v);
    },
    [entry.isDir, ref],
  );

  /**
   * Double-click a FILE row → the in-app viewer for markdown, the OS default
   * application for everything else (`rowActivation` decides which).
   *
   * It does not fight the single-click handler. A plain click on a file row is
   * already a no-op (only folders toggle), so the two clicks React delivers
   * before this event change nothing. ⌘/Ctrl IS excluded, though: with the
   * modifier held, each click inserts an "@path" reference into the chat, and
   * the user pressing it twice means "insert", not "open the file too".
   *
   * FOLDERS ARE LEFT ALONE. A double-click on a folder is two toggles, which
   * lands back where it started — the existing, expected behaviour.
   */
  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (entry.isDir || e.metaKey || e.ctrlKey) return;
      const target = { rel, parentRel, name: entry.name, isDir: entry.isDir };
      // Primitive deps, not `entry`: the row is memo'd and a fresh object
      // identity from a parent re-render would rebuild this callback for nothing.
      const action = rowActivation(target);
      if (action === 'preview') previewFile(target);
      else if (action === 'os-open') openFile(target);
    },
    [entry.isDir, entry.name, openFile, previewFile, rel, parentRel],
  );

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      // Without this the panel body's handler fires too and the menu would open
      // on the project root instead of the row under the pointer.
      e.stopPropagation();
      openMenu(e, { rel, parentRel, name: entry.name, isDir: entry.isDir });
    },
    [openMenu, rel, parentRel, entry.name, entry.isDir],
  );

  // A folder is a copy target for OS-file drops (Finder → project).
  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!entry.isDir || !hasOsFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropOver(true);
    },
    [entry.isDir],
  );
  const onDragLeave = useCallback(() => setDropOver(false), []);
  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      if (!entry.isDir || !hasOsFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropOver(false);
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      setCopying(true);
      const result = await copyInto(cwd, rel, files);
      setCopying(false);
      if (!result || !result.ok) {
        toast(t('fileBrowser.copyError', { defaultValue: 'Could not copy the files.' }), 'error');
        return;
      }
      toast(
        t('fileBrowser.copyDone', {
          defaultValue: 'Copied {{count}} item(s).',
          count: result.copied.length,
        }),
        'success',
      );
      setOpen(true);
      bump(rel); // refresh this folder so the new files show
    },
    [entry.isDir, cwd, rel, bump, t],
  );

  return (
    <div>
      {renaming ? (
        <InlineNameInput
          defaultValue={entry.name}
          selectBasename={!entry.isDir}
          depth={depth}
          icon={entry.isDir ? '📁' : '📄'}
          onCommit={(value) =>
            commitRename({ rel, parentRel, name: entry.name, isDir: entry.isDir }, value)
          }
          onCancel={cancelRename}
        />
      ) : (
        <div
          draggable
          onDragStart={onDragStart}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={(e) => void onDrop(e)}
          title={ref}
          style={{ paddingLeft: 8 + depth * 12 }}
          className={`flex items-center gap-1 py-0.5 pr-2 text-xs text-foreground/90 cursor-pointer select-none rounded ${
            dropOver ? 'bg-brand/20 ring-1 ring-brand/50' : 'hover:bg-accent/50'
          }`}
        >
          <span className="w-3 flex-shrink-0 text-muted-foreground">
            {entry.isDir ? (open ? '▾' : '▸') : ''}
          </span>
          <span className="flex-shrink-0">{entry.isDir ? '📁' : '📄'}</span>
          <span className="truncate">{entry.name}</span>
          {copying && <span className="ml-1 text-[0.714rem] text-muted-foreground">…</span>}
        </div>
      )}
      {entry.isDir && open && <TreeChildren cwd={cwd} parentRel={rel} depth={depth + 1} />}
    </div>
  );
});

/** The children of one directory, fetched on first render (i.e. on expand) and
 *  whenever this folder's refresh nonce is bumped (after a copy or a mutation). */
const TreeChildren = memo(function TreeChildren({
  cwd,
  parentRel,
  depth,
}: {
  cwd: string;
  parentRel: string;
  depth: number;
}) {
  const { t } = useTranslation();
  const { nonceOf } = useContext(RefreshContext);
  const { creating, commitCreate, cancelCreate } = useContext(FileOpsContext);
  const nonce = nonceOf(parentRel);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    setError(false);
    setEntries(null);
    void fetchDir(cwd, parentRel).then((res) => {
      if (!alive) return;
      if (res) setEntries(res);
      else setError(true);
    });
    return () => {
      alive = false;
    };
  }, [cwd, parentRel, nonce]);

  // The new entry is being named INTO this directory. It renders above the
  // listing and independently of it, so naming a file inside a folder that is
  // still loading (or is empty) works exactly the same.
  const newRow = creating?.parentRel === parentRel && (
    <InlineNameInput
      defaultValue=""
      placeholder={t(creating.isDir ? 'fileBrowser.folderName' : 'fileBrowser.fileName')}
      selectBasename={false}
      depth={depth}
      icon={creating.isDir ? '📁' : '📄'}
      onCommit={commitCreate}
      onCancel={cancelCreate}
    />
  );

  const body = (() => {
    if (error) {
      return (
        <div style={{ paddingLeft: 8 + depth * 12 }} className="py-0.5 text-xs text-red-500">
          {t('fileBrowser.loadError', { defaultValue: 'Could not read this folder.' })}
        </div>
      );
    }
    if (entries === null) {
      return (
        <div style={{ paddingLeft: 8 + depth * 12 }} className="py-0.5 text-xs text-muted-foreground">
          {t('fileBrowser.loading', { defaultValue: 'Loading…' })}
        </div>
      );
    }
    if (entries.length === 0) {
      // "Empty" alongside the input the user is typing into would be a lie.
      return newRow ? null : (
        <div style={{ paddingLeft: 8 + depth * 12 }} className="py-0.5 text-xs text-muted-foreground italic">
          {t('fileBrowser.empty', { defaultValue: 'Empty' })}
        </div>
      );
    }
    return entries.map((entry) => (
      <TreeNode key={entry.name} cwd={cwd} parentRel={parentRel} entry={entry} depth={depth} />
    ));
  })();

  return (
    <>
      {newRow}
      {body}
    </>
  );
});

/** Width bounds for the resizable file browser, in px. The minimum is where a
 *  nested path stops being readable at all. */
export const FILES_MIN_WIDTH = 200;
export const FILES_MAX_WIDTH = 640;
/** The width before it was resizable (Tailwind `w-72`), so an install that has
 *  never dragged the divider looks exactly as it did. */
export const FILES_DEFAULT_WIDTH = 288;

export function FileBrowserPanel({
  cwd,
  onClose,
  width = FILES_DEFAULT_WIDTH,
  resizing = false,
}: {
  cwd: string;
  onClose: () => void;
  /** Panel width in px. */
  width?: number;
  /** True mid-drag: suppresses the width transition so the panel tracks the
   *  pointer instead of easing toward it a beat late. */
  resizing?: boolean;
}) {
  const { t } = useTranslation();
  // Per-directory refresh nonces (bumped after a copy lands files in a folder,
  // after any fs-op mutation, and when the watcher reports a change made from
  // outside the panel).
  const [nonces, setNonces] = useState<Record<string, number>>({});
  const nonceOf = useCallback((rel: string) => nonces[rel] ?? 0, [nonces]);
  /** Bump several directories in ONE state update. A watcher window that
   *  touched four folders must be four re-fetches, not four renders of the
   *  whole tree. */
  const bumpMany = useCallback((rels: readonly string[]) => {
    if (rels.length === 0) return;
    setNonces((prev) => {
      const next = { ...prev };
      for (const rel of rels) next[rel] = (next[rel] ?? 0) + 1;
      return next;
    });
  }, []);
  const bump = useCallback((rel: string) => bumpMany([rel]), [bumpMany]);

  /**
   * CHANGES MADE FROM OUTSIDE THIS PANEL — the agent writing a file, a build,
   * a `mkdir` in a terminal — arrive here.
   *
   * IT ADDS NO SECOND REFRESH PATH. A watcher event is turned into the same
   * `bump(dir)` the panel's own mutations use, so a folder re-fetches only if
   * it is expanded (a collapsed one is unmounted and re-reads on expand
   * anyway), and the rest of the tree is left alone.
   *
   * The connection is keyed by `cwd`, and @cockpit/shared-ui pools by URL: a
   * project switch (this panel is mounted per project) drops the old socket,
   * which is what closes the old watcher on the server. Closing the panel
   * unmounts this hook and stops watching entirely.
   *
   * IT IS AN ADDITION, NOT A REPLACEMENT. The manual refresh button stays: a
   * platform where recursive watching is unavailable answers
   * `fs-watch-unavailable` and sends nothing further, and no watcher catches
   * every event on every filesystem.
   */
  const onWatchMessage = useCallback(
    (data: unknown) => bumpMany(fsChangeDirs(data)),
    [bumpMany],
  );
  useWebSocket({
    url: `/ws/fs-watch?cwd=${encodeURIComponent(cwd)}`,
    onMessage: onWatchMessage,
  });

  // -- the operations menu -------------------------------------------------

  const [menu, setMenu] = useState<FileMenuState | null>(null);
  /** The markdown file the in-app viewer is showing, if any. */
  const [previewRel, setPreviewRel] = useState<string | null>(null);
  const [renamingRel, setRenamingRel] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ parentRel: string; isDir: boolean } | null>(null);

  const openMenu = useCallback((e: React.MouseEvent, target: MenuTarget) => {
    // Opening the menu cancels an inline edit in progress — two focused inputs
    // and a menu on top of them is nobody's idea of a file browser.
    setRenamingRel(null);
    setCreating(null);
    setMenu({ ...target, x: e.clientX, y: e.clientY });
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  /** Report a refused or failed operation. `exists` gets its own sentence
   *  because it is the failure a user causes by accident. */
  const reportFailure = useCallback(
    (action: 'create' | 'rename' | 'duplicate' | 'delete', reason: string | undefined) => {
      toast(t(failureKey(action, reason)), 'error');
    },
    [t],
  );

  const commitCreate = useCallback(
    (name: string) => {
      const pending = creating;
      setCreating(null);
      if (!pending || !isCommittableName('', name)) return;
      void fsOp(cwd, pending.isDir ? 'mkdir' : 'mkfile', pending.parentRel, name).then((res) => {
        if (!res.ok) {
          reportFailure('create', res.reason);
          return;
        }
        bump(pending.parentRel);
      });
    },
    [creating, cwd, bump, reportFailure],
  );

  const commitRename = useCallback(
    (target: MenuTarget, next: string) => {
      setRenamingRel(null);
      // An unchanged name is not an error and not a request; say nothing.
      if (!isCommittableName(target.name, next)) return;
      void fsOp(cwd, 'rename', target.rel, next).then((res) => {
        if (!res.ok) {
          reportFailure('rename', res.reason);
          return;
        }
        bump(target.parentRel);
      });
    },
    [cwd, bump, reportFailure],
  );

  const onDuplicate = useCallback(
    (target: MenuTarget) => {
      void fsOp(cwd, 'duplicate', target.rel).then((res) => {
        if (!res.ok) {
          reportFailure('duplicate', res.reason);
          return;
        }
        bump(target.parentRel);
      });
    },
    [cwd, bump, reportFailure],
  );

  const onDelete = useCallback(
    async (target: MenuTarget) => {
      const trash = fsBridge()?.trash;
      // The two messages differ because the OUTCOMES differ: with the Electron
      // bridge this is a recoverable move to the trash, without it the server
      // does a permanent `rm`. Promising a trash we do not have would be a lie
      // told at the exact moment the user is deciding.
      const message = stripTransTags(
        t(trash ? 'fileBrowser.confirmDeleteMessage' : 'fileBrowser.confirmDeletePermanent', {
          name: escapeHtml(target.name),
        }),
      );
      const agreed = await confirm(message, {
        title: t('fileBrowser.confirmDelete'),
        danger: true,
      });
      if (!agreed) return;

      if (trash) {
        const res = await trash({ cwd, rel: target.rel });
        if (!res.ok) {
          reportFailure('delete', 'failed');
          return;
        }
      } else {
        const res = await fsOp(cwd, 'delete', target.rel);
        if (!res.ok) {
          reportFailure('delete', res.reason);
          return;
        }
      }
      bump(target.parentRel);
    },
    [cwd, bump, reportFailure, t],
  );

  const onCopyPath = useCallback(
    (target: MenuTarget, absolute: boolean) => {
      const text = absolute ? absolutePathOf(cwd, target.rel) : target.rel;
      void navigator.clipboard.writeText(text).then(
        () => toast(t('fileBrowser.pathCopied'), 'success'),
        () => toast(t('fileBrowser.pathCopyError'), 'error'),
      );
    },
    [cwd, t],
  );

  /**
   * Hand a file to the OS default application.
   *
   * BRIDGE FIRST, SERVER SECOND. The Electron bridge is preferred where it is
   * visible, but its absence no longer means "do nothing": the shell's server
   * runs on the same machine as the files, so `/api/fs-op` can launch the OS
   * handler itself. That fallback is what puts "Open" on the menu in a plain
   * browser tab — and on Windows builds where the subframe bridge does not
   * surface, which used to lose the item entirely.
   *
   * Folders are excluded here as well as at the call site, because `openPath`
   * on a directory would spring a Finder window on someone who double-clicked
   * to expand it.
   */
  const onOpen = useCallback(
    (target: MenuTarget) => {
      if (target.isDir) return;
      const open = fsBridge()?.open;
      // `shell.openPath` (and the server twin) reports "no handler for this
      // file type" as a failed Result rather than a rejection, so the resolved
      // branch is the one that actually fires for an unknown extension.
      const launched = open
        ? open({ cwd, rel: target.rel }).then((res) => res.ok)
        : fsOp(cwd, 'open', target.rel).then((res) => res.ok);
      void launched.then(
        (ok) => {
          if (!ok) toast(t('fileBrowser.openError'), 'error');
        },
        () => toast(t('fileBrowser.openError'), 'error'),
      );
    },
    [cwd, t],
  );

  /**
   * Spring the OS "Open with…" chooser — the escape hatch for a file whose
   * default association launches the wrong application, which is precisely the
   * case a plain "Open" cannot help with.
   *
   * SERVER ONLY, unlike its two siblings: the Electron bridge has no open-with
   * channel (Electron's `shell` offers none), and the server spawns the same
   * OS chooser either way. The menu offers this only on macOS/Windows clients —
   * Linux has no standard chooser, and the server refuses it there.
   */
  const onOpenWith = useCallback(
    (target: MenuTarget) => {
      if (target.isDir) return;
      void fsOp(cwd, 'openWith', target.rel).then(
        (res) => {
          if (!res.ok) toast(t('fileBrowser.openError'), 'error');
        },
        () => toast(t('fileBrowser.openError'), 'error'),
      );
    },
    [cwd, t],
  );

  /**
   * Open a markdown file in the in-app viewer.
   *
   * NO BRIDGE AND NO OS INVOLVED — this is the one "open" that stays inside the
   * app, so it is just state. Folders are excluded here as well as at both call
   * sites: `rowActivation` never returns 'preview' for one, and the menu item
   * is gated on the same predicate.
   */
  const onPreview = useCallback((target: MenuTarget) => {
    if (target.isDir) return;
    setPreviewRel(target.rel);
  }, []);

  const onReveal = useCallback(
    (target: MenuTarget) => {
      const reveal = fsBridge()?.reveal;
      const shown = reveal
        ? reveal({ cwd, rel: target.rel }).then((res) => res.ok)
        : fsOp(cwd, 'reveal', target.rel).then((res) => res.ok);
      void shown.then(
        (ok) => {
          if (!ok) toast(t('fileBrowser.revealError'), 'error');
        },
        () => toast(t('fileBrowser.revealError'), 'error'),
      );
    },
    [cwd, t],
  );

  const ops = useMemo(
    () => ({
      openMenu,
      openFile: onOpen,
      previewFile: onPreview,
      renamingRel,
      commitRename,
      cancelRename: () => setRenamingRel(null),
      creating,
      commitCreate,
      cancelCreate: () => setCreating(null),
    }),
    [openMenu, onOpen, onPreview, renamingRel, commitRename, creating, commitCreate],
  );

  // Dropping OS files on the panel body (not on a folder row) copies into the
  // project ROOT.
  const [rootOver, setRootOver] = useState(false);
  const onRootDragOver = useCallback((e: React.DragEvent) => {
    if (!hasOsFiles(e)) return;
    e.preventDefault();
    setRootOver(true);
  }, []);
  const onRootDrop = useCallback(
    async (e: React.DragEvent) => {
      if (!hasOsFiles(e)) return;
      e.preventDefault();
      setRootOver(false);
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const result = await copyInto(cwd, '', files);
      if (!result || !result.ok) {
        toast(t('fileBrowser.copyError', { defaultValue: 'Could not copy the files.' }), 'error');
        return;
      }
      toast(
        t('fileBrowser.copyDone', { defaultValue: 'Copied {{count}} item(s).', count: result.copied.length }),
        'success',
      );
      bump('');
    },
    [cwd, bump, t],
  );

  // Right-click on empty space in the tree = the project root: create only.
  const onRootContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      openMenu(e, { rel: '', parentRel: '', name: '', isDir: true });
    },
    [openMenu],
  );

  return (
    <aside
      className={`shrink-0 flex flex-col bg-card h-full overflow-hidden ${
        resizing ? '' : 'transition-[width] duration-200'
      }`}
      style={{ width }}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-medium text-foreground truncate" title={cwd}>
          {t('fileBrowser.panelTitle', { defaultValue: 'Files' })}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => bump('')}
            title={t('fileBrowser.refreshTree', { defaultValue: 'Refresh directory tree' })}
            className="p-1 rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onClose}
            title={t('common.close', { defaultValue: 'Close' })}
            className="p-1 rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
      <div className="px-3 py-1.5 border-b border-border text-[0.714rem] text-muted-foreground leading-tight">
        {t('fileBrowser.hint', {
          defaultValue: 'Drag a row into the message box for its path, or ⌘/Ctrl-click for @path. Drop files here to copy them in.',
        })}
      </div>
      <RefreshContext.Provider value={{ nonceOf, bump }}>
        <FileOpsContext.Provider value={ops}>
          <div
            onDragOver={onRootDragOver}
            onDragLeave={() => setRootOver(false)}
            onDrop={(e) => void onRootDrop(e)}
            onContextMenu={onRootContextMenu}
            className={`flex-1 overflow-y-auto py-1 ${rootOver ? 'bg-brand/5 ring-1 ring-inset ring-brand/40' : ''}`}
          >
            <TreeChildren cwd={cwd} parentRel="" depth={0} />
          </div>
        </FileOpsContext.Provider>
      </RefreshContext.Provider>
      {/* Keyed on the file so a preview opened from a different row starts with
          a clean back history instead of inheriting the last one's. */}
      {previewRel !== null && (
        <MarkdownPreviewModal
          key={previewRel}
          cwd={cwd}
          rel={previewRel}
          onClose={() => setPreviewRel(null)}
        />
      )}
      {menu && (
        <FileBrowserContextMenu
          state={menu}
          onClose={closeMenu}
          onOpen={onOpen}
          onOpenWith={onOpenWith}
          onPreview={onPreview}
          onNewFile={(target) => setCreating({ parentRel: createParentOf(target), isDir: false })}
          onNewFolder={(target) => setCreating({ parentRel: createParentOf(target), isDir: true })}
          onRename={(target) => setRenamingRel(target.rel)}
          onDuplicate={onDuplicate}
          onDelete={(target) => void onDelete(target)}
          onCopyPath={onCopyPath}
          onReveal={onReveal}
        />
      )}
    </aside>
  );
}
