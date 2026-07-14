'use client';

import { memo } from 'react';
import { CommandBubble } from './CommandBubble';
import { getPlugin } from './pluginRegistry';
import { interruptCommand as interruptCmd } from './TerminalWsManager';
import type { ConsoleItem, Command } from './useConsoleState';
import type { PluginItemBase } from './bubblePlugins';

// One console bubble (terminal command OR plugin bubble), memoized so it only
// re-renders when ITS OWN inputs change. ConsoleView re-renders on every PTY
// output chunk (its state updates); previously the bubble props were built
// inline per item inside the map (fresh closures + a fresh `extra` object every
// render), which defeated CommandBubble's / the plugin's React.memo and
// re-rendered EVERY bubble on every output tick. Here all callbacks arrive
// pre-stabilized (useCallback/refs in ConsoleView) and the per-item closures are
// created inside this memoized row, so an idle bubble stays put while another
// bubble streams. The parent derives `selected` / `maximized` / `initialSleeping`
// as plain booleans so selection/sleep changes only touch the affected rows.
type SubscribePty = (commandId: string, writer: (data: string) => void) => () => void;
type SubscribePtyVoid = (commandId: string, cb: () => void) => () => void;

export interface ConsoleBubbleRowProps {
  item: ConsoleItem;
  selected: boolean;
  maximized: boolean;
  /** Plugin bubbles only: initial sleeping state read at mount. */
  initialSleeping: boolean;
  tabId?: string;
  projectCwd: string;
  expandedHeight: number;
  bubbleContentHeight?: number;
  // Drag — stable handlers from ConsoleView.
  onDragStart: (e: React.DragEvent, itemId: string) => void;
  onDragOver: (e: React.DragEvent, itemId: string) => void;
  onDragEnter: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
  // Command callbacks — stable, id-parameterized.
  onSelectId: (id: string) => void;
  onInterruptId: (id: string) => void;
  onStdin: (id: string, data: string) => void;
  onDeleteCommand: (id: string) => void;
  onRerun: (id: string) => void;
  subscribePtyOutput: SubscribePty;
  subscribePtyReset: SubscribePtyVoid;
  subscribePtyRefresh: SubscribePtyVoid;
  ptySizeRef: React.MutableRefObject<Map<string, { cols: number; rows: number }>>;
  resizePty: (id: string, cols: number, rows: number) => void;
  onToggleMaximizeId: (id: string) => void;
  onTitleMouseDown: () => void;
  // Plugin callbacks — stable.
  onClosePlugin: (id: string) => void;
  addBrowserItem: (url: string, afterId: string) => void;
  onSleep: (id: string) => void;
  onWake: (id: string) => void;
}

export const ConsoleBubbleRow = memo(function ConsoleBubbleRow({
  item,
  selected,
  maximized,
  initialSleeping,
  tabId,
  projectCwd,
  expandedHeight,
  bubbleContentHeight,
  onDragStart,
  onDragOver,
  onDragEnter,
  onDragLeave,
  onDrop,
  onDragEnd,
  onSelectId,
  onInterruptId,
  onStdin,
  onDeleteCommand,
  onRerun,
  subscribePtyOutput,
  subscribePtyReset,
  subscribePtyRefresh,
  ptySizeRef,
  resizePty,
  onToggleMaximizeId,
  onTitleMouseDown,
  onClosePlugin,
  addBrowserItem,
  onSleep,
  onWake,
}: ConsoleBubbleRowProps) {
  const dragProps = {
    draggable: true,
    onDragStart: (e: React.DragEvent) => onDragStart(e, item.data.id),
    onDragOver: (e: React.DragEvent) => onDragOver(e, item.data.id),
    onDragEnter,
    onDragLeave,
    onDrop,
    onDragEnd,
  };

  if (item.type === 'command') {
    const cmd = item.data as Command;
    return (
      <div data-bubble-id={cmd.id} className="group/cmd rounded-lg transition-shadow" {...dragProps}>
        <CommandBubble
          commandId={cmd.id}
          tabId={tabId}
          projectCwd={projectCwd}
          command={cmd.command}
          output={cmd.output}
          exitCode={cmd.exitCode}
          isRunning={cmd.isRunning}
          selected={selected}
          onSelect={() => { onSelectId(cmd.id); }}
          onInterrupt={cmd.isRunning ? () => onInterruptId(cmd.id) : undefined}
          onStdin={cmd.isRunning ? (data: string) => onStdin(cmd.id, data) : undefined}
          onDelete={() => {
            if (cmd.isRunning && cmd.pid) interruptCmd(cmd.pid);
            onDeleteCommand(cmd.id);
          }}
          onRerun={() => onRerun(cmd.id)}
          timestamp={cmd.timestamp}
          usePty={cmd.usePty}
          subscribePtyOutput={cmd.usePty ? subscribePtyOutput : undefined}
          subscribePtyReset={cmd.usePty ? subscribePtyReset : undefined}
          subscribePtyRefresh={cmd.usePty ? subscribePtyRefresh : undefined}
          onPtyResize={(cols, rows) => { ptySizeRef.current.set(cmd.id, { cols, rows }); resizePty(cmd.id, cols, rows); }}
          onToggleMaximize={() => onToggleMaximizeId(cmd.id)}
          maximized={maximized}
          expandedHeight={expandedHeight}
          bubbleContentHeight={bubbleContentHeight}
          onTitleMouseDown={onTitleMouseDown}
        />
      </div>
    );
  }

  // Plugin bubble: find Component from registry
  const plugin = getPlugin(item.type);
  if (!plugin) return null;
  const Comp = plugin.Component;
  const pluginData = item.data as PluginItemBase;
  return (
    <div data-bubble-id={pluginData.id} className="rounded-lg transition-shadow" {...dragProps}>
      <Comp
        item={pluginData}
        selected={selected}
        maximized={maximized}
        expandedHeight={expandedHeight}
        bubbleContentHeight={bubbleContentHeight}
        timestamp={pluginData.timestamp}
        onSelect={() => { onSelectId(pluginData.id); }}
        onClose={() => onClosePlugin(pluginData.id)}
        onToggleMaximize={() => onToggleMaximizeId(pluginData.id)}
        onTitleMouseDown={onTitleMouseDown}
        extra={{
          addBrowserItem,
          initialSleeping,
          onSleep,
          onWake,
          // Forwarded to plugin bubbles (e.g. BrowserBubble) so they can scope
          // their bridge registration to the right project / tab — used by
          // /api/connection/list filtering and per-tab bubble-titles JSON lookup.
          projectCwd,
          tabId,
        }}
      />
    </div>
  );
});
