'use client';

import { useState, useEffect, useLayoutEffect, useRef, KeyboardEvent, ClipboardEvent, ChangeEvent, DragEvent, useCallback, useMemo, memo } from 'react';
import type { ImageInfo, ImageMediaType, ChatEngine } from './types';
import { toast } from '@cockpit/shared-ui';
import { useTranslation } from 'react-i18next';
import { ImagePreview } from '@cockpit/shared-ui';
import { ScheduleTaskPopover } from './ScheduleTaskPopover';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { loadSlashCommands } from './effect/agentClient';

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
  // 'builtin' = in-process bilingual command; 'user'/'project' = Naby-owned
  // command from the /api/harness CRUD surface, badged distinctly (Phase 1.6
  // HP-02). The old `.claude/commands/*.md` sources were retired.
  source: 'builtin' | 'user' | 'project';
  argumentHint?: string;
}

interface ChatInputProps {
  onSend: (message: string, images?: ImageInfo[]) => void;
  disabled?: boolean;
  cwd?: string;
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

export const ChatInput = memo(function ChatInput({ onSend, disabled, cwd, engine: _engine, onShowUserMessages, onOpenNote, onCreateScheduledTask }: ChatInputProps) {
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

  // Auto-adjust textarea height
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Reset height to get the correct scrollHeight
    textarea.style.height = 'auto';
    // Set new height: min 38px (single line), max 200px (approx 8-10 lines)
    const minHeight = 38;
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

  // The command being typed on the active line: a `/` or `@` marker followed by
  // a partial verb with nothing after it yet (a trailing space starts the body
  // and dismisses the menu). Marker-agnostic — `@qa` matches the same `/qa` entry.
  const commandQuery = useMemo(() => {
    // Verb char class kept in sync with the server (slashCommands' COMMAND_LINE_RE).
    const m = activeLine.text.match(/^\s*([/@])([a-zA-Z0-9-]*)$/);
    return m ? { marker: m[1], verb: m[2].toLowerCase() } : null;
  }, [activeLine.text]);

  // Command filtering: useMemo derived computation, eliminates setState churn per keystroke.
  // Client-side commands that perform a UI action instead of expanding to a prompt.
  // `/plan` toggles plan mode (consumed in Chat.wrappedHandleSend) — only on claude engines.
  const localCommands = useMemo<CommandInfo[]>(() => {
    const isClaude = !_engine || _engine === 'claude';
    if (!isClaude) return [];
    return [{
      name: '/plan',
      description: 'Enable plan mode (read-only). /plan <task> to plan a task; /plan off to disable.',
      source: 'builtin',
      argumentHint: '[task|off]',
    }];
  }, [_engine]);

  const filteredCommands = useMemo(() => {
    if (!commandQuery) return [];
    const { verb } = commandQuery;
    const match = (cmd: CommandInfo) => cmd.name.slice(1).toLowerCase().startsWith(verb);
    return [...localCommands.filter(match), ...commands.filter(match)];
  }, [commandQuery, localCommands, commands]);

  const showCommands = !commandsDismissed && !!commandQuery && filteredCommands.length > 0;

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

  const handleSelectCommand = useCallback((command: CommandInfo) => {
    // Preserve the marker the user typed (`/` main session, `@` subagent); only
    // replace the command token on the active line, leaving other lines intact.
    const marker = commandQuery?.marker ?? '/';
    const insert = `${marker}${command.name.slice(1)} `;
    const before = input.slice(0, activeLine.start);
    const after = input.slice(activeLine.end);
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
  }, [input, activeLine, commandQuery]);

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
  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = e.dataTransfer?.files;
      if (files) for (const f of Array.from(files)) addImageFile(f);
    },
    [addImageFile],
  );
  const onDragOver = useCallback((e: DragEvent) => {
    if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) {
      e.preventDefault();
      setDragOver(true);
    }
  }, []);
  const onDragLeave = useCallback((e: DragEvent) => {
    if (e.currentTarget === e.target) setDragOver(false);
  }, []);

  const handleRemoveImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  const getSourceLabel = (source: CommandInfo['source']) => {
    switch (source) {
      case 'builtin':
        return t('common.builtin');
      case 'user':
      case 'project':
        return t('commandManager.badgeOwned');
    }
  };

  const getSourceColor = (source: CommandInfo['source']) => {
    switch (source) {
      case 'builtin':
        return 'bg-brand/15 text-brand dark:bg-brand/25 dark:text-teal-11';
      case 'user':
      case 'project':
        return 'bg-emerald-500/15 text-emerald-600 dark:bg-emerald-500/25 dark:text-emerald-400';
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
          {t('chat.dropImage', { defaultValue: 'Drop image to attach' })}
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
            const isFirstCommand = index === 0;
            return (
              <div key={cmd.name}>
                {isFirstCommand && (
                  <div className="px-4 py-1 text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/40">
                    Commands
                  </div>
                )}
                <div
                  onClick={() => handleSelectCommand(cmd)}
                  className={`px-4 py-2 cursor-pointer ${
                    index === selectedIndex
                      ? 'bg-brand/10'
                      : 'hover:bg-accent'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm font-medium text-foreground">
                      {(commandQuery?.marker ?? '/') + cmd.name.slice(1)}
                    </span>
                    <span className="flex-1 text-sm text-muted-foreground truncate">
                      {t(`commands.${cmd.name.slice(1)}`, { defaultValue: cmd.description })}
                    </span>
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded ${getSourceColor(cmd.source)}`}
                    >
                      {getSourceLabel(cmd.source)}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex gap-2 items-end p-4">
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
          rows={1}
          className="flex-1 resize-none px-4 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-ring bg-card text-foreground placeholder-slate-9"
        />
      </div>

    </div>
  );
});
