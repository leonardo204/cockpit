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
 *
 * REFERENCE SAFETY. Reference paths are relative to the project root and folders
 * carry a trailing "/". A `/` or `.` immediately after the name makes the chat
 * command parser's `^\s*[/@]verb(\s|$)` line matcher fail, so an inserted
 * "@src/…" is never mistaken for an "@verb" subagent command.
 *
 * Mounted once per project (in TabManager), so it takes `cwd` directly and is
 * stable across chat-tab switches; it lives off the always-rendered chat hot
 * path (only present while toggled open).
 */

import { createContext, memo, useCallback, useContext, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';
import { FILE_REF_MIME, insertFileRef, osFilePath } from '@cockpit/feature-agent';

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

/** Per-directory refresh signal: bumping a folder's nonce makes its TreeChildren
 *  re-fetch (used after a copy lands new files in it), without collapsing the
 *  rest of the expanded tree. */
const RefreshContext = createContext<{ nonceOf: (rel: string) => number; bump: (rel: string) => void }>({
  nonceOf: () => 0,
  bump: () => {},
});

/** Join a parent relative path with a child name (root parent = ''). */
function childRel(parentRel: string, name: string): string {
  return parentRel ? `${parentRel}/${name}` : name;
}

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

/** Does this drag carry OS files (so a folder can accept a copy)? */
function hasOsFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
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
  const [open, setOpen] = useState(false);
  const [dropOver, setDropOver] = useState(false);
  const [copying, setCopying] = useState(false);
  const rel = childRel(parentRel, entry.name);
  const ref = refFor(rel, entry.isDir);

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
      <div
        draggable
        onDragStart={onDragStart}
        onClick={onClick}
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
        {copying && <span className="ml-1 text-[10px] text-muted-foreground">…</span>}
      </div>
      {entry.isDir && open && <TreeChildren cwd={cwd} parentRel={rel} depth={depth + 1} />}
    </div>
  );
});

/** The children of one directory, fetched on first render (i.e. on expand) and
 *  whenever this folder's refresh nonce is bumped (after a copy). */
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
    return (
      <div style={{ paddingLeft: 8 + depth * 12 }} className="py-0.5 text-xs text-muted-foreground italic">
        {t('fileBrowser.empty', { defaultValue: 'Empty' })}
      </div>
    );
  }
  return (
    <>
      {entries.map((entry) => (
        <TreeNode key={entry.name} cwd={cwd} parentRel={parentRel} entry={entry} depth={depth} />
      ))}
    </>
  );
});

export function FileBrowserPanel({ cwd, onClose }: { cwd: string; onClose: () => void }) {
  const { t } = useTranslation();
  // Per-directory refresh nonces (bumped after a copy lands files in a folder).
  const [nonces, setNonces] = useState<Record<string, number>>({});
  const nonceOf = useCallback((rel: string) => nonces[rel] ?? 0, [nonces]);
  const bump = useCallback((rel: string) => {
    setNonces((prev) => ({ ...prev, [rel]: (prev[rel] ?? 0) + 1 }));
  }, []);

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

  return (
    <aside className="w-72 shrink-0 border-l border-border flex flex-col bg-card h-full">
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
      <div className="px-3 py-1.5 border-b border-border text-[10px] text-muted-foreground leading-tight">
        {t('fileBrowser.hint', {
          defaultValue: 'Drag a row into the message box for its path, or ⌘/Ctrl-click for @path. Drop files here to copy them in.',
        })}
      </div>
      <RefreshContext.Provider value={{ nonceOf, bump }}>
        <div
          onDragOver={onRootDragOver}
          onDragLeave={() => setRootOver(false)}
          onDrop={(e) => void onRootDrop(e)}
          className={`flex-1 overflow-y-auto py-1 ${rootOver ? 'bg-brand/5 ring-1 ring-inset ring-brand/40' : ''}`}
        >
          <TreeChildren cwd={cwd} parentRel="" depth={0} />
        </div>
      </RefreshContext.Provider>
    </aside>
  );
}
