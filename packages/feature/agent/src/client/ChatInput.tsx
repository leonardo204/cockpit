'use client';

import { useState, useEffect, useLayoutEffect, useRef, KeyboardEvent, ClipboardEvent, useCallback, useMemo, memo } from 'react';
import type { ImageInfo, ChatEngine } from './types';
import { toast } from '@cockpit/shared-ui';
import { useTranslation } from 'react-i18next';
import { ImagePreview } from '@cockpit/shared-ui';
import { ScheduleTaskPopover } from './ScheduleTaskPopover';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { loadSlashCommands } from './effect/agentClient';

// Migrated from src/components/project/ChatInput.tsx.

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

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

  const handlePaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const supportedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

    for (const item of Array.from(items)) {
      const mediaType = supportedTypes.find((t) => item.type === t);
      if (mediaType) {
        e.preventDefault();

        const file = item.getAsFile();
        if (!file) continue;

        // Check file size
        if (file.size > MAX_IMAGE_SIZE) {
          alert(t('chat.imageSizeLimit', { size: (file.size / 1024 / 1024).toFixed(2) }));
          continue;
        }

        const reader = new FileReader();
        reader.onload = (event) => {
          const dataUrl = event.target?.result as string;
          if (!dataUrl) return;

          // Extract base64 portion from data URL (compatible with all MIME types)
          const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');

          const newImage: ImageInfo = {
            id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            data: base64Data,
            preview: dataUrl,
            media_type: mediaType,
          };

          setImages((prev) => [...prev, newImage]);
        };
        reader.readAsDataURL(file);
      }
    }
  }, [t]);

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
    <div className="border-t border-border bg-card relative">
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
