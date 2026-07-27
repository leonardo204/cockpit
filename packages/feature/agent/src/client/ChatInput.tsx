'use client';

import { useState, useEffect, useLayoutEffect, useRef, KeyboardEvent, ClipboardEvent, ChangeEvent, DragEvent, useCallback, useMemo, memo } from 'react';
import type { ImageInfo, ImageMediaType, ChatEngine } from './types';
import { toast } from '@cockpit/shared-ui';
import { useTranslation } from 'react-i18next';
import { ImagePreview } from '@cockpit/shared-ui';
import { ScheduleTaskPopover } from './ScheduleTaskPopover';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { loadSlashCommands } from './effect/agentClient';
import {
  FILE_REF_MIME,
  setActiveFileRefInserter,
  clearActiveFileRefInserter,
  osFilePath,
  quotePath,
} from './fileRefBus';
import {
  fileRows,
  findMentionQuery,
  mentionInsertion,
  paletteRows,
  splitMentionPath,
  type DirEntry,
  type FileRow,
} from './palette';

// Migrated from src/components/project/ChatInput.tsx.

// A hard guard on the ORIGINAL file, only to avoid decoding an absurd blob into
// memory — the effective size is set by the downscale below, not this.
const MAX_IMAGE_SIZE = 25 * 1024 * 1024; // 25MB
// Long-edge cap. Both Claude and OpenAI resize a larger image down to about this
// before the model sees it, so capping here is LOSSLESS to the model while cutting
// the upload from megabytes to tens of KB. We never upscale.
const MAX_IMAGE_EDGE = 1568;
// WebP keeps screenshot text crisp and supports transparency, and compresses
// photos hard; 0.9 leaves no visible degradation.
const IMAGE_ENCODE_QUALITY = 0.9;

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

const stripDataUrlPrefix = (dataUrl: string) => dataUrl.replace(/^data:[^;]+;base64,/, '');

/**
 * Downscale + re-encode an image to shrink the upload WITHOUT model-visible quality
 * loss: cap the long edge at MAX_IMAGE_EDGE (the point both vision APIs downscale to
 * anyway) and re-encode to high-quality WebP. Animated GIFs pass through untouched
 * (a canvas would flatten the animation). If the re-encode is not actually smaller
 * (already-tiny image, no downscale), the original is kept. Throws on decode/encode
 * failure so the caller can fall back to the raw file.
 */
async function prepareImage(
  file: File,
  fallbackType: ImageMediaType,
): Promise<{ data: string; preview: string; media_type: ImageMediaType }> {
  if (file.type === 'image/gif') {
    const dataUrl = await blobToDataUrl(file);
    return { data: stripDataUrlPrefix(dataUrl), preview: dataUrl, media_type: 'image/gif' };
  }
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close?.();
    throw new Error('no 2d context');
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  let blob = await canvasToBlob(canvas, 'image/webp', IMAGE_ENCODE_QUALITY);
  let outType: ImageMediaType = 'image/webp';
  if (!blob) {
    blob = await canvasToBlob(canvas, 'image/jpeg', IMAGE_ENCODE_QUALITY);
    outType = 'image/jpeg';
  }
  if (!blob) throw new Error('encode failed');

  // No downscale AND the re-encode didn't help -> keep the smaller original.
  if (scale === 1 && blob.size >= file.size) {
    const dataUrl = await blobToDataUrl(file);
    return { data: stripDataUrlPrefix(dataUrl), preview: dataUrl, media_type: fallbackType };
  }
  const dataUrl = await blobToDataUrl(blob);
  return { data: stripDataUrlPrefix(dataUrl), preview: dataUrl, media_type: outType };
}

interface CommandInfo {
  name: string;
  description: string;
  // Which scope the harness row came from, badged distinctly (Phase 1.6).
  // 'file' is the palette's own row type for an `@path` mention, which has no
  // scope at all. The cockpit builtins and the `.claude/commands/*.md` sources
  // were both retired.
  source: 'user' | 'org' | 'project' | 'file';
  // Which owned-harness kind this row is (undefined for an agent or file row). The "/" menu
  // unifies command/skill/subagent into one palette, so the row shows a small
  // kind glyph to keep them distinguishable.
  kind?: 'command' | 'skill' | 'subagent';
  argumentHint?: string;
  // naby AGENT rows (P3-M5). Offered for `@` ONLY and listed FIRST: `/` calls
  // tools, `@` calls agents. `addressable` is the trust gate — an unverified
  // agent is shown greyed rather than hidden, so the user can see it exists and
  // that it is still growing.
  agent?: {
    stage: 'egg' | 'larva' | 'pupa' | 'butterfly';
    percent: number;
    addressable: boolean;
  };
}

interface ChatInputProps {
  onSend: (message: string, images?: ImageInfo[]) => void;
  disabled?: boolean;
  cwd?: string;
  /** Only the active tab's input registers as the file-reference insertion
   *  target, so a modifier-click in the file browser never lands in a hidden
   *  tab's textarea. Defaults true for standalone use. */
  isActive?: boolean;
  engine?: ChatEngine;
  onShowUserMessages?: () => void;
  onOpenNote?: () => void;
  onCreateScheduledTask?: (params: {
    message: string;
    type: 'once' | 'interval' | 'cron';
    delayMinutes?: number;
    intervalMinutes?: number;
    activeFrom?: string;
    activeTo?: string;
    cron?: string;
  }) => void;
}

/** A row the palette can show: a harness command, a naby agent, or a file/folder
 *  in the open project. `file` is present only on the last kind. */
type PaletteEntry = CommandInfo & { file?: FileRow['file'] };

/** The growth stages as the user sees them. Egg → larva → pupa → butterfly; only
 *  a butterfly can be addressed. */
const GROWTH_GLYPH: Record<'egg' | 'larva' | 'pupa' | 'butterfly', string> = {
  egg: '🥚',
  larva: '🐛',
  pupa: '🛡',
  butterfly: '🦋',
};

export const ChatInput = memo(function ChatInput({ onSend, disabled, cwd, isActive = true, engine: _engine, onShowUserMessages, onOpenNote, onCreateScheduledTask }: ChatInputProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  // Caret offset into `input`; drives line-aware command autocomplete.
  const [caret, setCaret] = useState(0);
  const [images, setImages] = useState<ImageInfo[]>([]);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [showScheduler, setShowScheduler] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [commandsDismissed, setCommandsDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const commandListRef = useRef<HTMLDivElement>(null);

  // Latest input/caret in refs so the file-reference inserter (registered once
  // for the active tab) always splices at the current position without a stale
  // closure and without churning its identity every keystroke.
  const inputRef = useRef(input);
  inputRef.current = input;
  const caretRef = useRef(caret);
  caretRef.current = caret;

  // Splice text at the current caret (used by drag-drop and the file browser's
  // ⌘/Ctrl-click). Stable identity so registration below never re-runs.
  const insertAtCaret = useCallback((text: string) => {
    const prev = inputRef.current;
    const pos = Math.min(caretRef.current, prev.length);
    const next = prev.slice(0, pos) + text + prev.slice(pos);
    const newPos = pos + text.length;
    setInput(next);
    setCaret(newPos);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(newPos, newPos);
      }
    });
  }, []);

  // Register as the file-reference target only while this tab is active, so a
  // modifier-click in the file browser inserts into the visible input, never a
  // hidden tab's. Cleanup relinquishes only if still the registrant (tab-switch
  // race guard).
  useEffect(() => {
    if (!isActive) return;
    setActiveFileRefInserter(insertAtCaret);
    return () => clearActiveFileRefInserter(insertAtCaret);
  }, [isActive, insertAtCaret]);

  // Auto-adjust textarea height
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Reset height to get the correct scrollHeight
    textarea.style.height = 'auto';
    // Floor at ~3 lines like a normal LLM composer, so the multi-line placeholder
    // hint is never clipped/scrolled; grow up to ~10 lines, then scroll.
    const minHeight = 76;
    const maxHeight = 200;
    const newHeight = Math.max(minHeight, Math.min(textarea.scrollHeight, maxHeight));
    textarea.style.height = `${newHeight}px`;
  }, []);

  // Adjust height when input changes (useLayoutEffect: runs synchronously before paint to avoid double-paint flicker)
  useLayoutEffect(() => {
    adjustTextareaHeight();
  }, [input, adjustTextareaHeight]);

  // Load command list: in-process builtins merged with Naby-owned enabled
  // commands (Phase 1.6 HP-02). Passing `cwd` includes this project's
  // project-scope owned commands; reloads when the active project changes so a
  // freshly created command shows without reopening the tab.
  useEffect(() => {
    BrowserRuntime.runPromiseExit(loadSlashCommands<CommandInfo>(cwd)).then((exit) => {
      if (exit._tag === 'Success') {
        setCommands(exit.value as CommandInfo[]);
      } else {
        console.error('Failed to load commands:', exit.cause);
      }
    });
  }, [cwd]);

  // The line containing the caret — commands are line-led, so autocomplete keys
  // off the current line, not the whole (possibly multi-line) input.
  const activeLine = useMemo(() => {
    const lineStart = caret === 0 ? 0 : input.lastIndexOf('\n', caret - 1) + 1;
    const nl = input.indexOf('\n', caret);
    const lineEnd = nl === -1 ? input.length : nl;
    return { text: input.slice(lineStart, lineEnd), start: lineStart, end: lineEnd };
  }, [input, caret]);

  // The command being typed on the active line: `/` followed by a partial verb
  // with nothing after it yet (a trailing space starts the body and dismisses the
  // menu). `/` ONLY — `@` belongs to the agent/file palette below, and letting one
  // marker mean both is what produced the `@plan` bug.
  const commandQuery = useMemo(() => {
    // Verb char class kept in sync with the server (slashCommands' COMMAND_LINE_RE).
    const m = activeLine.text.match(/^\s*(\/)([a-zA-Z0-9-]*)$/);
    return m ? { marker: m[1], verb: m[2].toLowerCase() } : null;
  }, [activeLine.text]);

  // The `@…` mention being typed, anywhere in the input (see findMentionQuery for
  // why it may sit mid-sentence and why `foo@bar.com` does not match).
  const mentionQuery = useMemo(() => findMentionQuery(input, caret), [input, caret]);

  // -- the directory listing behind a file mention ---------------------------
  //
  // One level at a time, keyed by the directory part of what has been typed, so
  // walking into a folder is one fetch and typing more letters is none. `/api/
  // list-dir` refuses anything that escapes the project root, which is why this
  // does not have to re-derive that guard.
  const mentionDir = mentionQuery ? splitMentionPath(mentionQuery.text).dir : null;
  const [dirEntries, setDirEntries] = useState<{ dir: string; entries: DirEntry[] } | null>(null);
  useEffect(() => {
    if (!cwd || mentionDir === null) return;
    // Already have this level: typing another letter must not refetch.
    if (dirEntries?.dir === mentionDir) return;
    let live = true;
    const url = `/api/list-dir?cwd=${encodeURIComponent(cwd)}&rel=${encodeURIComponent(mentionDir)}`;
    void fetch(url)
      .then((r) => r.json())
      .then((json: { ok?: boolean; entries?: DirEntry[] }) => {
        if (!live) return;
        // A directory that does not exist yet (mid-typing) yields nothing rather
        // than clearing what is on screen — the menu should not flicker empty
        // between keystrokes.
        if (json?.ok && Array.isArray(json.entries)) {
          setDirEntries({ dir: mentionDir, entries: json.entries });
        }
      })
      .catch(() => {
        /* offline or a bad path: the palette simply has no file rows */
      });
    return () => {
      live = false;
    };
  }, [cwd, mentionDir, dirEntries?.dir]);

  // Command filtering: useMemo derived computation, eliminates setState churn per keystroke.
  //
  // There are no client-side commands. `/plan` used to be one — a row defined
  // inline here that toggled plan mode instead of expanding to a prompt — and it
  // was the last thing in the palette the user could not find, edit or remove in
  // Settings. Plan mode is a checkbox above the input; it did not also need a
  // verb that only existed in this file.
  const filteredCommands = useMemo<PaletteEntry[]>(() => {
    // `@` — the agent layer plus files/folders in the open project.
    if (mentionQuery) {
      const { dir, leaf } = splitMentionPath(mentionQuery.text);
      // An agent name is a single token, so a path (anything with a `/`) can only
      // mean a file. Offering agents there would be noise.
      const agents = dir
        ? []
        : paletteRows(
            commands.filter((c) => c.name.slice(1).toLowerCase().startsWith(leaf.toLowerCase())),
            '@',
          );
      const files = dirEntries?.dir === dir ? fileRows(dirEntries.entries, dir, leaf) : [];
      return [...agents, ...files];
    }
    // `/` — the harness. Never an agent row: picking one would write `@name` into
    // a line the dispatcher reads as a harness verb.
    if (!commandQuery) return [];
    const { verb } = commandQuery;
    const match = (cmd: CommandInfo) => cmd.name.slice(1).toLowerCase().startsWith(verb);
    return paletteRows(commands.filter(match), '/');
  }, [commandQuery, mentionQuery, commands, dirEntries]);

  /** A row the user may actually pick. A non-butterfly agent is listed but not
   *  selectable — the same gate the engine applies, so the palette never offers
   *  something routing would refuse. */
  const isSelectable = useCallback(
    (cmd: PaletteEntry) => !cmd.agent || cmd.agent.addressable,
    [],
  );

  const showCommands =
    !commandsDismissed && !!(commandQuery || mentionQuery) && filteredCommands.length > 0;

  // Reset selected index and dismiss state when input changes
  const prevInputRef = useRef(input);
  useLayoutEffect(() => {
    if (prevInputRef.current !== input) {
      queueMicrotask(() => setSelectedIndex(0));
      if (commandsDismissed) queueMicrotask(() => setCommandsDismissed(false));
      prevInputRef.current = input;
    }
  }, [input, commandsDismissed]);

  // Scroll selected item into view
  useLayoutEffect(() => {
    if (showCommands && commandListRef.current) {
      const selectedItem = commandListRef.current.children[selectedIndex] as HTMLElement;
      if (selectedItem) {
        selectedItem.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedIndex, showCommands]);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    const hasContent = trimmed || images.length > 0;
    if (!hasContent || disabled) return;

    // Slash/at commands (/qa, @new-branch, multi-line) are resolved server-side
    // by resolveCommandPrompt — send the raw text so the displayed message stays
    // readable and a single resolver handles builtins + sequential multi-command.
    onSend(trimmed, images.length > 0 ? images : undefined);
    setInput('');
    setImages([]);
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [input, images, disabled, onSend]);

  const handleSelectCommand = useCallback((command: PaletteEntry) => {
    // An agent that has not reached the butterfly stage cannot be addressed yet.
    // Blocked HERE, the one place both the click and the Enter path go through, so
    // there is no second gate to keep in sync.
    if (command.agent && !command.agent.addressable) return;
    // A FILE MENTION replaces only its own `@…` span. Replacing the line (what a
    // command does) would delete the sentence around it, and mentions are normally
    // written mid-sentence. A folder inserts a trailing `/` and no space so the
    // menu stays open for the next segment.
    const isMention = !!mentionQuery;
    const insert = command.file
      ? mentionInsertion(command as FileRow)
      : isMention
        ? `@${command.name.slice(1)} `
        : `/${command.name.slice(1)} `;
    const from = isMention ? mentionQuery!.start : activeLine.start;
    const to = isMention ? mentionQuery!.end : activeLine.end;
    const before = input.slice(0, from);
    const after = input.slice(to);
    const next = before + insert + after;
    const pos = before.length + insert.length;
    setInput(next);
    setCaret(pos);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(pos, pos);
      }
    });
  }, [input, activeLine, mentionQuery]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Check if IME composition is in progress (e.g., Chinese pinyin input)
    if (e.nativeEvent.isComposing) {
      return;
    }

    // Command list keyboard navigation
    if (showCommands && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % filteredCommands.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSelectCommand(filteredCommands[selectedIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setCommandsDismissed(true);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        handleSelectCommand(filteredCommands[selectedIndex]);
        return;
      }
    }

    // Normal send (excluding IME composition state)
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  }, [showCommands, filteredCommands, selectedIndex, handleSelectCommand, handleSend]);

  // Capture one image File into state. Shared by paste, the file picker, and
  // drag-drop. The image is DOWNSCALED + re-encoded on the client (prepareImage)
  // so a multi-MB photo uploads as tens of KB with no model-visible quality loss.
  // Unsupported types are ignored; a decode failure falls back to the raw file.
  const addImageFile = useCallback(
    async (file: File) => {
      const supportedTypes: ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
      const mediaType = supportedTypes.find((t) => file.type === t);
      if (!mediaType) return;
      if (file.size > MAX_IMAGE_SIZE) {
        alert(t('chat.imageSizeLimit', { size: (file.size / 1024 / 1024).toFixed(2) }));
        return;
      }
      const push = (data: string, preview: string, media_type: ImageMediaType) =>
        setImages((prev) => [
          ...prev,
          { id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`, data, preview, media_type },
        ]);
      try {
        const prepared = await prepareImage(file, mediaType);
        push(prepared.data, prepared.preview, prepared.media_type);
      } catch {
        // Fallback: send the original untouched rather than lose the attachment.
        const dataUrl = await blobToDataUrl(file);
        push(dataUrl.replace(/^data:[^;]+;base64,/, ''), dataUrl, mediaType);
      }
    },
    [t],
  );

  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      let handled = false;
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            addImageFile(file);
            handled = true;
          }
        }
      }
      if (handled) e.preventDefault();
    },
    [addImageFile],
  );

  // File-picker: a hidden <input type="file"> the attach button triggers.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const onPickFiles = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files) for (const f of Array.from(files)) addImageFile(f);
      e.target.value = ''; // allow re-picking the same file
    },
    [addImageFile],
  );

  // Drag-and-drop onto the composer.
  const [dragOver, setDragOver] = useState(false);
  // Which kind of drag is hovering, so the overlay names the right action:
  // 'os' = files from Finder/Explorer (images attach, others → path);
  // 'ref' = a row from the in-app file browser (→ relative path).
  const [dragKind, setDragKind] = useState<'os' | 'ref' | null>(null);
  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      setDragKind(null);
      // Files dragged from the OS (Finder/Explorer): a supported image ATTACHES
      // (multimodal, unchanged); any other file inserts its ABSOLUTE path at the
      // caret so the agent can read it. A drop can mix both.
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        const supportedImage = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
        const paths: string[] = [];
        for (const f of Array.from(files)) {
          if (supportedImage.has(f.type)) {
            addImageFile(f);
            continue;
          }
          const p = osFilePath(f);
          if (p) paths.push(quotePath(p));
        }
        if (paths.length > 0) insertAtCaret(`${paths.join(' ')} `);
        return;
      }
      // A file/folder dragged from the in-app file browser → insert its cwd-
      // relative path at the caret. Trailing space so the next keystroke is not
      // glued to the path.
      const ref = e.dataTransfer?.getData(FILE_REF_MIME) ?? '';
      if (ref) insertAtCaret(ref.endsWith(' ') ? ref : `${ref} `);
    },
    [addImageFile, insertAtCaret],
  );
  const onDragOver = useCallback((e: DragEvent) => {
    const types = Array.from(e.dataTransfer?.types ?? []);
    const isRef = types.includes(FILE_REF_MIME);
    if (types.includes('Files') || isRef) {
      e.preventDefault();
      setDragOver(true);
      setDragKind(isRef ? 'ref' : 'os');
    }
  }, []);
  const onDragLeave = useCallback((e: DragEvent) => {
    if (e.currentTarget === e.target) {
      setDragOver(false);
      setDragKind(null);
    }
  }, []);

  const handleRemoveImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  // Every row in the "/" list now comes from the harness, so there is one badge
  // rather than a builtin/owned distinction that no longer exists. File rows are
  // never badged — they render their path instead.
  const getSourceLabel = (source: CommandInfo['source']) =>
    source === 'file' ? '' : t('commandManager.badgeOwned');

  const getSourceColor = (source: CommandInfo['source']) =>
    source === 'file'
      ? ''
      : 'bg-emerald-500/15 text-emerald-600 dark:bg-emerald-500/25 dark:text-emerald-400';

  // A small glyph so a unified "/" list still tells command / skill / subagent
  // apart at a glance. Commands (the default) get none to stay uncluttered.
  const getKindGlyph = (kind: CommandInfo['kind']) => {
    switch (kind) {
      case 'skill':
        return '🧩';
      case 'subagent':
        return '🤖';
      default:
        return null;
    }
  };

  return (
    <div
      className={`border-t bg-card relative ${dragOver ? 'border-brand ring-1 ring-brand/40' : 'border-border'}`}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-brand/5 text-xs text-brand">
          {dragKind === 'ref'
            ? t('chat.dropPath', { defaultValue: 'Drop to insert file path' })
            : t('chat.dropOsFiles', { defaultValue: 'Drop: images attach · other files insert their path' })}
        </div>
      )}
      <ImagePreview images={images} onRemove={handleRemoveImage} disabled={disabled} />

      {/* Command candidate list */}
      {showCommands && filteredCommands.length > 0 && (
        <div
          ref={commandListRef}
          className="absolute bottom-full left-0 right-0 mx-4 mb-2 max-h-64 overflow-y-auto bg-card border border-border rounded-lg shadow-lg"
        >
          {filteredCommands.map((cmd, index) => {
            // THREE groups: agents (the `@` layer), files/folders, and harness
            // commands. A header is drawn at each boundary so they never read as one
            // list — under `@` the first two appear, under `/` only the third.
            const groupOf = (r: PaletteEntry | undefined) =>
              r === undefined ? '' : r.agent ? 'agents' : r.file ? 'files' : 'commands';
            const prev = index > 0 ? filteredCommands[index - 1] : undefined;
            const group = groupOf(cmd);
            const groupHeader =
              index === 0 || groupOf(prev) !== group
                ? group === 'agents'
                  ? t('chatInput.agentsGroup', { defaultValue: 'Agents' })
                  : group === 'files'
                    ? t('chatInput.filesGroup', { defaultValue: 'Files & folders' })
                    : t('chatInput.commandsGroup', { defaultValue: 'Commands' })
                : null;
            const locked = !!cmd.agent && !cmd.agent.addressable;
            return (
              <div key={cmd.name}>
                {groupHeader && (
                  <div className="px-4 py-1 text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/40">
                    {groupHeader}
                  </div>
                )}
                <div
                  onClick={() => handleSelectCommand(cmd)}
                  title={
                    locked
                      ? t('chatInput.agentLocked', {
                          defaultValue:
                            'Still growing — naby can be addressed directly once it reaches the butterfly stage.',
                        })
                      : undefined
                  }
                  className={`px-4 py-2 ${
                    // A locked agent is shown, not hidden: the user should see it
                    // exists and that it is still growing.
                    locked
                      ? 'opacity-40 cursor-not-allowed'
                      : index === selectedIndex
                        ? 'bg-brand/10 cursor-pointer'
                        : 'hover:bg-accent cursor-pointer'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm font-medium text-foreground">
                      {/* A folder shows its trailing slash, which is also what
                          picking it inserts — so the row reads as what it does. */}
                      {(mentionQuery ? '@' : '/') + cmd.name.slice(1) + (cmd.file?.isDir ? '/' : '')}
                    </span>
                    {getKindGlyph(cmd.kind) && (
                      <span className="text-xs" title={cmd.kind}>
                        {getKindGlyph(cmd.kind)}
                      </span>
                    )}
                    <span className="flex-1 text-sm text-muted-foreground truncate">
                      {/* The description is the one the user wrote when registering
                          the row, so there is nothing to translate — the old
                          `commands.<verb>` lookup existed for the shipped builtins
                          and would now try to localise a user's own verb name. A
                          file row has no description at all. */}
                      {cmd.file ? '' : cmd.description}
                    </span>
                    {cmd.file ? (
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {cmd.file.isDir
                          ? t('chatInput.folder', { defaultValue: 'folder' })
                          : t('chatInput.file', { defaultValue: 'file' })}
                      </span>
                    ) : cmd.agent ? (
                      <span
                        className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground whitespace-nowrap"
                        title={t(`growth.stage.${cmd.agent.stage}`, { defaultValue: cmd.agent.stage })}
                      >
                        {GROWTH_GLYPH[cmd.agent.stage]}{' '}
                        {t(`growth.stage.${cmd.agent.stage}`, { defaultValue: cmd.agent.stage })}{' '}
                        {cmd.agent.percent}%
                      </span>
                    ) : (
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded ${getSourceColor(cmd.source)}`}
                      >
                        {getSourceLabel(cmd.source)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Composer box: textarea on top, action toolbar beneath — so a taller
          (3-line) input keeps the controls anchored to the bottom-left like a
          normal LLM input, instead of the icons floating beside a tall field. */}
      <div className="p-4">
        <div className="flex flex-col rounded-lg border border-border bg-card focus-within:ring-2 focus-within:ring-ring">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={disabled ? t('chat.placeholderDisabled') : t('chat.placeholder')}
            rows={3}
            className="w-full resize-none px-4 pt-3 pb-1 bg-transparent border-0 focus:outline-none text-foreground placeholder-slate-9"
          />

          {/* Action toolbar */}
          <div className="flex items-center gap-1 px-2 pb-2">
            {/* Attach image: opens the file picker (paste and drag-drop also work). */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              className="hidden"
              onChange={onPickFiles}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent active:bg-muted active:scale-95 rounded-lg transition-all disabled:opacity-40"
              title={t('chat.attachImage', { defaultValue: 'Attach image' })}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <rect x="3" y="3" width="18" height="18" rx="2" strokeWidth={2} />
                <circle cx="8.5" cy="8.5" r="1.5" strokeWidth={2} />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 15l-5-5L5 21" />
              </svg>
            </button>

            {/* User messages list button */}
            {onShowUserMessages && (
              <button
                onClick={onShowUserMessages}
                className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent active:bg-muted active:scale-95 rounded-lg transition-all"
                title={t('chat.userMessages')}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
            )}

            {/* Project notes button */}
            {onOpenNote && (
              <button
                onClick={onOpenNote}
                className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent active:bg-muted active:scale-95 rounded-lg transition-all"
                title={t('chat.projectNotes')}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
            )}

            {/* Scheduled task button */}
            {onCreateScheduledTask && (
              <div className="relative">
                <button
                  onClick={() => setShowScheduler(!showScheduler)}
                  className={`p-2 rounded-lg transition-all ${
                    showScheduler
                      ? 'text-brand bg-brand/10'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent active:bg-muted active:scale-95'
                  }`}
                  title={t('chat.scheduledTasks')}
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" strokeWidth={2} />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6l4 2" />
                  </svg>
                </button>
                {showScheduler && (
                  <ScheduleTaskPopover
                    onClose={() => setShowScheduler(false)}
                    onCreate={onCreateScheduledTask}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      </div>

    </div>
  );
});
