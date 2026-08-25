'use client';

/**
 * The right-side file browser (VSCode-style) for the chat workspace.
 *
 * It is a lazy directory tree over the active project's working tree (`cwd`):
 * each folder fetches its children from `/api/list-dir` only when expanded, so
 * opening the panel never walks the whole tree. It does three things:
 *
 *   • DRAG a row onto the chat input  → the cwd-relative PATH is inserted.
 *   • DROP OS files onto a folder     → the files are COPIED into that folder
 *     (Finder/Explorer → project), then that folder refreshes.
 *   • plain click on a row            → SELECT it; a folder also expands.
 *   • ⌘/Ctrl-CLICK                    → add/remove one row from the selection.
 *   • SHIFT-CLICK                     → extend the selection from the anchor.
 *     ⌘/Ctrl-click USED TO insert "@<path>" at the chat caret. The gesture went
 *     to selection, where it means one thing to everybody; the reference is
 *     still reachable by dragging the row, and by "copy path" in the menu.
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
 * (markdownPreviewOps.ts) is where the choice is made. The preview opens as a
 * MODAL, which is right for a document you glance at and wrong for one you keep
 * referring to — its header offers to promote it into a tab, and this panel
 * passes that request up to the tab host (`onOpenInTab`) rather than growing a
 * second way to open one.
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
import { gitTintClass, gitTintTitleKey } from './gitStatusTint';
import {
  TREE_DRAG_MIME,
  beginTreeDrag,
  canDropInto,
  draggedRels,
  dropOps,
  endTreeDrag,
} from './treeDrag';
import {
  afterPaste,
  parentOf,
  isCutPending,
  pasteOps,
  pasteTargetOf,
  putOnClipboard,
  type TreeClipboard,
} from './treeClipboard';
import {
  EMPTY_SELECTION,
  applyClick,
  isSelected,
  pruneSelection,
  targetsFor,
  type TreeSelection,
} from './treeSelection';
import type { GitFileState, GitStatusResponse } from './gitStatusTypes';
import { confirm, toast, useWebSocket } from '@cockpit/shared-ui';
import { FILE_REF_MIME, osFilePath } from '@cockpit/feature-agent';
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
type FsOpAction = 'mkdir' | 'mkfile' | 'rename' | 'duplicate' | 'move' | 'copy' | 'delete' | 'open' | 'reveal' | 'openWith';

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

/** WHICH ROWS ARE CHANGED, as one lookup the whole tree shares.
 *
 *  A context rather than a prop threaded down: the tree is recursive and each
 *  level is lazily mounted, so a prop would have to pass through every folder
 *  between the panel and the row that needs it. The value changes only when the
 *  status is re-read, which is exactly when every row should recolour.
 *
 *  The map already has the FOLDERS rolled into it (the server does that fold) —
 *  a row asks about its own path and gets an answer whether it is a file or a
 *  collapsed directory holding a change three levels down. */
const GitStatusContext = createContext<(rel: string) => GitFileState | null>(() => null);

/** SELECTION, and the registry that makes a RANGE possible.
 *
 *  A range is defined over what the user can SEE, in the order they see it —
 *  which this tree does not have anywhere, because each level is fetched and
 *  mounted on its own. So every mounted `TreeChildren` registers its rows under
 *  its parent, and the panel flattens the registry depth-first when a
 *  shift-click asks. It is kept in a REF, not state: nothing re-renders when a
 *  folder registers, and the list is only ever read at click time. */
const SelectionContext = createContext<{
  isRowSelected: (rel: string) => boolean;
  isRowCut: (rel: string) => boolean;
  /** The current selection, read at DRAG START so a dragged row can carry the
   *  whole selection when it belongs to one. A getter rather than the value, so
   *  the context does not change identity on every click. */
  selectionOf: () => TreeSelection;
  /** Carry out a drop: move (or, with Alt, copy) these rows into that folder. */
  applyDrop: (rels: readonly string[], destDir: string, copy: boolean) => Promise<void>;
  onRowClick: (rel: string, intent: { toggle: boolean; range: boolean }) => void;
  registerRows: (parentRel: string, rels: readonly string[]) => void;
  unregisterRows: (parentRel: string) => void;
}>({
  isRowSelected: () => false,
  isRowCut: () => false,
  selectionOf: () => EMPTY_SELECTION,
  applyDrop: async () => {},
  onRowClick: () => {},
  registerRows: () => {},
  unregisterRows: () => {},
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
  /** `move`/`copy` only: the destination DIRECTORY. Left out of the body when
   *  absent so every other action's request is byte-identical to what it was. */
  destRel?: string,
): Promise<FsOpResponse> {
  try {
    const res = await fetch('/api/fs-op', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, action, rel, name, ...(destRel === undefined ? {} : { destRel }) }),
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
  /** Begin an OS drag carrying these files. Optional: it is newer than the rest
   *  of the bridge, and a shell built before it simply does not offer drag-out. */
  startDrag?(target: { cwd: string; rels: string[] }): Promise<BridgeResult>;
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
  // WHY THE COLOUR IS READ HERE AND NOT PASSED IN. The tint depends on the whole
  // repository's status, which arrives long after this row first drew and
  // changes on its own schedule; a prop would mean re-rendering every ancestor
  // to recolour one leaf. The context re-renders exactly the rows that read it.
  const { isRowSelected, onRowClick, isRowCut, applyDrop, selectionOf } =
    useContext(SelectionContext);
  const selected = isRowSelected(rel);
  // Dimmed while a cut is pending, the way every file manager shows a move that
  // has not happened yet. It is still a normal row — readable, openable, there —
  // because a cut moves nothing until it is pasted.
  const cut = isRowCut(rel);
  const gitStateOf = useContext(GitStatusContext);
  const gitState = gitStateOf(rel);
  // A colour is not self-describing — `text-brand` on a filename says
  // "something" and gives the reader no way to find out what. The hint rides the
  // `title` the row already has, under the path it already showed.
  const gitTitleKey = gitTintTitleKey(gitState);
  const { t: tGit } = useTranslation();
  const gitTitle = gitTitleKey ? tGit(gitTitleKey) : null;
  const renaming = renamingRel === rel;

  // "New file" chosen on a COLLAPSED folder has to open it, or the input would
  // be created into a subtree nobody can see. The folder owns its own `open`
  // state, so it reacts here rather than the panel reaching in.
  useEffect(() => {
    if (entry.isDir && creating?.parentRel === rel) setOpen(true);
  }, [entry.isDir, creating, rel]);

  const onDragStart = useCallback(
    (e: React.DragEvent) => {
      // ALT SENDS THE FILES OUT OF THE APP, to Finder/Explorer or anything else
      // that takes files — and it has to be decided HERE, because
      // `webContents.startDrag` REPLACES the HTML drag rather than joining it:
      // once the OS owns the gesture, no in-page drop target sees it. One drag
      // cannot serve both, so the user says which at the moment they start.
      //
      // It does not collide with Alt-to-copy on an in-tree drop. That modifier
      // is read when the pointer is RELEASED, and a drag that began with Alt
      // never reaches an in-tree drop at all; to copy inside the tree, press Alt
      // after the drag is moving.
      //
      // Only where the bridge is visible. In a plain browser tab there is no way
      // to hand files to the OS, and the drag stays the in-app one it always was
      // rather than becoming a gesture that silently does nothing.
      const bridge = fsBridge();
      if (e.altKey && bridge?.startDrag) {
        e.preventDefault();
        void bridge.startDrag({ cwd, rels: [...targetsFor(selectionOf(), rel)] });
        return;
      }
      // BOTH PAYLOADS, because one gesture serves two drops. The composer reads
      // `FILE_REF_MIME` to insert a path; a folder in this tree reads
      // `TREE_DRAG_MIME` to move files. A row dragged to the chat still inserts
      // exactly what it always did.
      e.dataTransfer.setData(FILE_REF_MIME, ref);
      e.dataTransfer.setData('text/plain', ref);
      e.dataTransfer.setData(TREE_DRAG_MIME, rel);
      // DRAGGING A SELECTED ROW DRAGS THE WHOLE SELECTION — and one outside it
      // drags only itself, the same rule the context menu follows. Without it,
      // selecting five files and dragging one of them moves one, which reads as
      // the selection having been ignored.
      beginTreeDrag(targetsFor(selectionOf(), rel));
      // `copyMove`, not `copy`: within the tree this MOVES, and the cursor has
      // to say so. The chat's own drop zone reads the payload, not the effect.
      e.dataTransfer.effectAllowed = 'copyMove';
    },
    [ref, rel, cwd, selectionOf],
  );
  const onDragEnd = useCallback(() => endTreeDrag(), []);

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      // ⌘/CTRL-CLICK NOW EXTENDS THE SELECTION, not inserts an @path reference.
      // The gesture was taken because in a file tree it means one thing to
      // everybody, and a tree that disagreed with every file manager would be
      // wrong in a way the panel's hint text could not fix. The reference is not
      // lost: dragging a row into the composer still inserts it, and the
      // right-click menu still copies the path.
      onRowClick(rel, { toggle: e.metaKey || e.ctrlKey, range: e.shiftKey });
      // Selecting and expanding are not alternatives — a plain click on a folder
      // does both, the way every tree does. A modified click does NOT toggle:
      // the user is building a selection, and folders opening under them while
      // they do it is the tree fighting the gesture.
      if (entry.isDir && !e.metaKey && !e.ctrlKey && !e.shiftKey) setOpen((v) => !v);
    },
    [entry.isDir, rel, onRowClick],
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

  /** A tree drag is recognised by its TYPE, which is all `dragover` may read —
   *  browsers block `getData` there so a page cannot snoop on a passing drag.
   *  The rows themselves come from the in-memory slot (treeDrag.ts). */
  const hasTreeDrag = (e: React.DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes(TREE_DRAG_MIME);

  // A folder takes OS-file drops (Finder → project) AND rows dragged from this
  // tree. The two are told apart by type and handled by different code, because
  // one copies files in from outside and the other moves them around inside.
  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!entry.isDir) return;
      if (hasOsFiles(e)) {
        e.preventDefault();
        e.stopPropagation();
        setDropOver(true);
        return;
      }
      // NOT LIGHTING UP IS THE FEEDBACK. A drop that would do nothing — rows
      // dropped back where they live — or one that cannot be done — a folder
      // into its own descendant — leaves the target dark and the cursor showing
      // "no", which is a better answer than an error after the user lets go.
      if (!hasTreeDrag(e) || !canDropInto(draggedRels(), rel)) return;
      e.preventDefault();
      e.stopPropagation();
      // Alt/Option copies, as it does in Finder. Read here as well as at drop so
      // the cursor tells the truth while the pointer is still moving.
      e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
      setDropOver(true);
    },
    [entry.isDir, rel],
  );
  const onDragLeave = useCallback(() => setDropOver(false), []);
  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      if (!entry.isDir) return;
      // ROWS FROM THIS TREE — handled first, and it never falls through to the
      // OS-copy path below: a tree drag carries no `files`, so a mistaken
      // fall-through would silently do nothing at all.
      if (!hasOsFiles(e) && hasTreeDrag(e)) {
        e.preventDefault();
        e.stopPropagation();
        setDropOver(false);
        setOpen(true);
        await applyDrop(draggedRels(), rel, e.altKey);
        return;
      }
      if (!hasOsFiles(e)) return;
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
          onDragEnd={onDragEnd}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={(e) => void onDrop(e)}
          title={gitTitle ? `${ref}\n${gitTitle}` : ref}
          style={{ paddingLeft: 8 + depth * 12 }}
          className={`flex items-center gap-1 py-0.5 pr-2 text-xs ${gitTintClass(
            gitState,
          )} ${cut ? 'opacity-50' : ''} cursor-pointer select-none rounded ${
            dropOver
              ? 'bg-brand/20 ring-1 ring-brand/50'
              : selected
                ? // The selection reads as a BACKGROUND, leaving the git tint on
                  // the text intact: a selected modified file must still look
                  // modified, or selecting a row would hide what it is.
                  'bg-accent'
                : 'hover:bg-accent/50'
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

  // THIS LEVEL'S ROWS, IN DISPLAY ORDER, handed to the panel so a shift-range has
  // a sequence to measure over. Registered on every entries change and withdrawn
  // on unmount — which is exactly what collapsing a folder does, so a collapsed
  // level stops contributing to the range without anyone having to say so.
  const { registerRows, unregisterRows } = useContext(SelectionContext);
  useEffect(() => {
    if (entries === null) return;
    registerRows(parentRel, entries.map((e) => childRel(parentRel, e.name)));
    return () => unregisterRows(parentRel);
  }, [entries, parentRel, registerRows, unregisterRows]);

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
  onOpenInTab,
}: {
  cwd: string;
  onClose: () => void;
  /** Panel width in px. */
  width?: number;
  /** True mid-drag: suppresses the width transition so the panel tracks the
   *  pointer instead of easing toward it a beat late. */
  resizing?: boolean;
  /**
   * Attach the previewed document to the tab strip — passed straight through to
   * the viewer's header control, which supplies the document the reader is
   * actually on rather than the one they double-clicked. The panel does not
   * open tabs itself; the tab host does, and it is the one that has a tab strip.
   */
  onOpenInTab?: (rel: string) => void;
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

  // -- selection -----------------------------------------------------------
  //
  // WHERE THE VISIBLE ORDER COMES FROM. A shift-range is measured over the rows
  // the user can see, in the order they see them, and this tree has that
  // sequence nowhere — every level is fetched and mounted separately, and a
  // collapsed folder's children are not merely hidden, they are unmounted. So
  // each mounted level registers its rows here, and the panel walks the registry
  // depth-first to reconstruct the order.
  //
  // A REF, NOT STATE, deliberately: a folder expanding would otherwise re-render
  // the whole tree to record a fact only a click ever reads.
  const rowsRef = useRef<Map<string, readonly string[]>>(new Map());
  const registerRows = useCallback((parentRel: string, rels: readonly string[]) => {
    rowsRef.current.set(parentRel, rels);
  }, []);
  const unregisterRows = useCallback((parentRel: string) => {
    rowsRef.current.delete(parentRel);
  }, []);

  /** The visible rows, depth-first, exactly as drawn. A folder contributes its
   *  own row and then its children — but only if it is EXPANDED, which is the
   *  same thing as "its level registered itself". */
  const visibleRows = useCallback((): string[] => {
    const out: string[] = [];
    const walk = (parentRel: string, seen: Set<string>) => {
      if (seen.has(parentRel)) return;
      seen.add(parentRel);
      for (const rel of rowsRef.current.get(parentRel) ?? []) {
        out.push(rel);
        if (rowsRef.current.has(rel)) walk(rel, seen);
      }
    };
    walk('', new Set());
    return out;
  }, []);

  const [selection, setSelection] = useState<TreeSelection>(EMPTY_SELECTION);
  const onRowClick = useCallback(
    (rel: string, intent: { toggle: boolean; range: boolean }) => {
      const visible = visibleRows();
      // Pruned FIRST, against the rows that actually exist right now. A folder
      // collapsed since the last click leaves selected paths behind, and a range
      // measured from one of them would run from a row that is not on screen.
      setSelection((prev) => applyClick(pruneSelection(prev, visible), rel, intent, visible));
    },
    [visibleRows],
  );
  // The clipboard's STATE lives here, beside the selection it is filled from —
  // the operations that use it are further down, after the refreshers they need.
  // Declared this early because the tree's cut-dimming reads it, and that reader
  // is part of the same context value the selection publishes.
  const [clipboard, setClipboard] = useState<TreeClipboard | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const clipboardRef = useRef(clipboard);
  clipboardRef.current = clipboard;

  const isRowSelected = useCallback(
    (rel: string) => isSelected(selection, rel),
    [selection],
  );

  // -- which rows are changed ----------------------------------------------
  //
  // ONE REQUEST FOR THE WHOLE TREE, not one per folder. `git status` reports the
  // repository, so asking per directory would run it N times for one answer —
  // and the tree needs the whole map anyway: a collapsed folder is coloured by
  // paths it has not loaded and cannot ask about.
  //
  // WHAT THIS DOES NOT CATCH, stated because the gap is real and the manual
  // refresh button is its answer. The watcher below is the trigger, and
  // `.git` is on its ignore list (`fsWatchScope.ts`) — deliberately, since git
  // rewrites files in there constantly. So an edit recolours immediately, while
  // a `git add` or `commit` made in a terminal does not: nothing in the working
  // tree changed. Watching `.git` to close that gap would mean a refresh storm
  // during every rebase, which is a worse trade than a colour that is briefly
  // stale.
  const [gitChanged, setGitChanged] = useState<Record<string, GitFileState>>({});
  const refreshGitStatus = useCallback(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/git-status?cwd=${encodeURIComponent(cwd)}`);
        if (!res.ok) return;
        const data = (await res.json()) as GitStatusResponse;
        if (cancelled) return;
        // A project with no repository, or an answer this route could not give,
        // clears the colours rather than leaving the last repository's on screen.
        setGitChanged(data.ok && data.repo ? (data.changed ?? {}) : {});
      } catch {
        // The tree is useful without colours. A status that could not be read is
        // not worth an error the reader cannot act on.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd]);
  useEffect(() => refreshGitStatus(), [refreshGitStatus]);

  /** Referentially stable for the tree's sake: this is the context value every
   *  row reads, and a new identity per render would re-render the whole tree on
   *  every keystroke in the panel. */
  const gitStateOf = useCallback(
    (rel: string): GitFileState | null => gitChanged[rel] ?? null,
    [gitChanged],
  );

  // -- the clipboard ---------------------------------------------------------
  //
  // ITS OWN, IN MEMORY, not `navigator.clipboard`. A file manager's clipboard
  // carries a set of paths AND an intent — the same three files mean "leave
  // them" after a copy and "remove them from here" after a cut, and nothing in a
  // text payload says which. Writing paths as text would also clobber whatever
  // the user had copied from their editor, on a keystroke pressed inside a tree.
  // Rules in treeClipboard.ts; this is the wiring.
  const copySelection = useCallback((mode: 'copy' | 'cut') => {
    setClipboard((prev) => putOnClipboard(prev, mode, selectionRef.current.selected));
  }, []);

  /**
   * PASTE — one request per item, so each comes back with its own reason.
   *
   * The folders that change are bumped rather than the whole tree: the source's
   * parent (a cut empties it) and the destination. `bumpMany` makes that one
   * state update, so a ten-file paste is one render, not twenty.
   */
  /** Run a batch of move/copy operations and report what happened. Shared by the
   *  paste and the drop, which are the same operation reached two ways. Returns
   *  how many actually succeeded, which is what decides whether a cut is spent. */
  const runFileOps = useCallback(
    async (ops: readonly { action: 'move' | 'copy'; rel: string; destRel: string }[]) => {
      const touched = new Set<string>(ops.map((o) => o.destRel));
      let moved = 0;
      let firstFailure: string | undefined;
      for (const op of ops) {
        const res = await fsOp(cwd, op.action, op.rel, undefined, op.destRel);
        if (res.ok) {
          moved += 1;
          // The SOURCE folder too: a move empties it, and refreshing only the
          // destination leaves the row still drawn where it no longer is.
          touched.add(parentOf(op.rel));
        } else if (!firstFailure) {
          firstFailure = res.reason;
        }
      }
      bumpMany([...touched]);
      refreshGitStatus();
      // ONE MESSAGE, FOR THE FIRST REFUSAL. Ten toasts for a ten-file paste is a
      // wall the user dismisses without reading; the rows that did move are
      // visible in the tree, so the part worth saying out loud is why one did not.
      if (firstFailure) toast(t(failureKey('paste', firstFailure)), 'error');
      return moved;
    },
    [cwd, bumpMany, refreshGitStatus, t],
  );

  const pasteInto = useCallback(
    async (destDir: string) => {
      const ops = pasteOps(clipboardRef.current, destDir);
      if (ops.length === 0) return;
      const moved = await runFileOps(ops);
      setClipboard((prev) => afterPaste(prev, moved));
    },
    [runFileOps],
  );

  /**
   * A DROP, carried out. Deliberately the same body a paste runs — one request
   * per row, the touched folders bumped together, the first refusal reported —
   * because a drop IS a paste with an ephemeral clipboard, and two executors is
   * how the two gestures start behaving differently.
   */
  const applyDrop = useCallback(
    async (rels: readonly string[], destDir: string, copy: boolean) => {
      const ops = dropOps(rels, destDir, copy);
      if (ops.length === 0) return;
      await runFileOps(ops);
    },
    [runFileOps],
  );

  const isRowCut = useCallback(
    (rel: string) => isCutPending(clipboardRef.current, rel),
    // `clipboard` is the dep, not the ref: the ref keeps the reader current
    // while this identity is what tells the tree to redraw when a cut is made
    // or spent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clipboard],
  );
  const selectionOf = useCallback(() => selectionRef.current, []);
  const selectionValue = useMemo(
    () => ({
      isRowSelected,
      isRowCut,
      selectionOf,
      applyDrop,
      onRowClick,
      registerRows,
      unregisterRows,
    }),
    [isRowSelected, isRowCut, selectionOf, applyDrop, onRowClick, registerRows, unregisterRows],
  );



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
    (data: unknown) => {
      bumpMany(fsChangeDirs(data));
      // A file changing on disk is the commonest reason a row's colour is now
      // wrong, so the same signal that re-reads the folder re-reads the status.
      refreshGitStatus();
    },
    [bumpMany, refreshGitStatus],
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
    (action: 'create' | 'rename' | 'duplicate' | 'delete' | 'paste', reason: string | undefined) => {
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

  /** COPY / CUT FROM THE MENU. `targetsFor` is the rule that stops a right-click
   *  on a row outside the selection acting on the selection — without it,
   *  right-clicking one file while five are selected copies six. */
  const onMenuClipboard = useCallback(
    (target: MenuTarget, mode: 'copy' | 'cut') => {
      setClipboard((prev) =>
        putOnClipboard(prev, mode, targetsFor(selectionRef.current, target.rel)),
      );
    },
    [],
  );

  const onMenuPaste = useCallback(
    (target: MenuTarget) => {
      void pasteInto(target.rel === '' ? '' : pasteTargetOf(target.rel, target.isDir));
    },
    [pasteInto],
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

  // -- keyboard ---------------------------------------------------------------
  //
  // SCOPED TO THE PANEL, not the window. The app has no shortcut registry — every
  // listener is its own `addEventListener` — and a global ⌘C in a chat app would
  // steal the copy the user meant for the message they just selected. So this
  // listens on the panel's own element and only acts while focus is inside it.
  //
  // It also runs INSIDE THE PER-PROJECT IFRAME (Workspace.tsx documents why that
  // matters: iframes do not bubble keydown to the parent), which is where the
  // panel lives, so nothing has to cross the frame boundary.
  //
  // A row being renamed swallows its own keys (`InlineNameInput`), so ⌘C while
  // typing a filename never reaches this.
  const panelRef = useRef<HTMLElement>(null);
  const onPanelKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'c') {
        e.preventDefault();
        copySelection('copy');
      } else if (key === 'x') {
        e.preventDefault();
        copySelection('cut');
      } else if (key === 'v') {
        e.preventDefault();
        // WHERE A KEYBOARD PASTE LANDS. There is no pointer to read, so it goes
        // to the selection's own folder — the place the user is looking. With
        // nothing selected that is the project root, which is the only other
        // honest answer.
        const sel = selectionRef.current.selected;
        const first = sel[0];
        void pasteInto(first === undefined ? '' : parentOf(first));
      }
    },
    [copySelection, pasteInto],
  );

  // Dropping OS files on the panel body (not on a folder row) copies into the
  // project ROOT.
  const [rootOver, setRootOver] = useState(false);
  const onRootDragOver = useCallback((e: React.DragEvent) => {
    if (hasOsFiles(e)) {
      e.preventDefault();
      setRootOver(true);
      return;
    }
    // Rows dragged onto the empty space below the tree land in the project root,
    // which is where a file manager puts them and the only way to move something
    // OUT of a folder without scrolling to find a target row.
    const types = Array.from(e.dataTransfer?.types ?? []);
    if (!types.includes(TREE_DRAG_MIME) || !canDropInto(draggedRels(), '')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
    setRootOver(true);
  }, []);
  const onRootDrop = useCallback(
    async (e: React.DragEvent) => {
      // Rows from this tree, moved into the project root. Checked first and
      // returning: a tree drag carries no `files`, so falling through would do
      // nothing at all.
      if (!hasOsFiles(e) && Array.from(e.dataTransfer?.types ?? []).includes(TREE_DRAG_MIME)) {
        e.preventDefault();
        setRootOver(false);
        await applyDrop(draggedRels(), '', e.altKey);
        return;
      }
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
    [cwd, bump, t, applyDrop],
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
      ref={panelRef}
      // `tabIndex` is what lets the panel HOLD focus at all — without it a click
      // on a row focuses nothing and a keystroke goes to the document. -1 keeps
      // it out of the tab order: this is a place keys are delivered to, not a
      // control to tab into.
      tabIndex={-1}
      onKeyDown={onPanelKeyDown}
      className={`shrink-0 flex flex-col bg-card h-full overflow-hidden outline-none ${
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
            onClick={() => {
              bump('');
              // The manual refresh is the ONLY way to pick up a `git add` or
              // `commit` made in a terminal: nothing in the working tree changed,
              // so the watcher never fired (see the status block above).
              refreshGitStatus();
            }}
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
          defaultValue: 'Click to select, ⌘/Ctrl-click to add, shift-click for a range. Drag a row into the message box for its path; drop files here to copy them in.',
        })}
      </div>
      <RefreshContext.Provider value={{ nonceOf, bump }}>
        <GitStatusContext.Provider value={gitStateOf}>
        <SelectionContext.Provider value={selectionValue}>
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
        </SelectionContext.Provider>
        </GitStatusContext.Provider>
      </RefreshContext.Provider>
      {/* Keyed on the file so a preview opened from a different row starts with
          a clean back history instead of inheriting the last one's. */}
      {previewRel !== null && (
        <MarkdownPreviewModal
          key={previewRel}
          cwd={cwd}
          rel={previewRel}
          onClose={() => setPreviewRel(null)}
          onOpenInTab={onOpenInTab}
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
          onClipboard={onMenuClipboard}
          onPaste={onMenuPaste}
          canPaste={clipboard !== null}
          onDelete={(target) => void onDelete(target)}
          onCopyPath={onCopyPath}
          onReveal={onReveal}
        />
      )}
    </aside>
  );
}
