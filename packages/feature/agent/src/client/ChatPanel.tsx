'use client';

import { useCallback } from 'react';
import { Chat } from './Chat';
import type { ChatEngine, ToolCallInfo } from './types';

// Migrated from src/components/project/ChatPanel.tsx.

// ============================================
// ChatPanel - Simplified Chat panel without header and sidebar
// ============================================

interface ChatPanelProps {
  tabId: string;
  cwd?: string;
  sessionId?: string;
  engine?: ChatEngine;
  planMode?: boolean;
  onPlanModeChange?: (tabId: string, planMode: boolean) => void;
  isActive?: boolean;
  // Forwarded to Chat: forced history refresh on explicit session jump (see ChatProps.refreshSignal)
  refreshSignal?: { sessionId: string; nonce: number } | null;
  onStateChange: (tabId: string, updates: { isLoading?: boolean; sessionId?: string; title?: string }) => void;
  onOpenNote?: () => void;
  onCreateScheduledTask?: (params: {
    cwd: string;
    tabId: string;
    sessionId: string;
    engine?: string;
    model?: string;
    message: string;
    type: 'once' | 'interval' | 'cron';
    delayMinutes?: number;
    intervalMinutes?: number;
    activeFrom?: string;
    activeTo?: string;
    cron?: string;
  }) => void;
  onOpenSession?: (sessionId: string, title?: string) => void;
  // Host-handled: open the app Settings modal (AI provider surface). Bridged up
  // to the parent window by TabManager, since the modal lives there, not in the
  // per-project iframe this panel renders in.
  onOpenSettings?: () => void;
}

export function ChatPanel({ tabId, cwd, sessionId, engine, planMode, onPlanModeChange, isActive, refreshSignal, onStateChange, onOpenNote, onCreateScheduledTask, onOpenSession, onOpenSettings }: ChatPanelProps) {
  const handleLoadingChange = useCallback((isLoading: boolean) => {
    onStateChange(tabId, { isLoading });
  }, [tabId, onStateChange]);

  const handleSessionIdChange = useCallback((newSessionId: string) => {
    onStateChange(tabId, { sessionId: newSessionId });
  }, [tabId, onStateChange]);

  const handleTitleChange = useCallback((title: string) => {
    onStateChange(tabId, { title });
  }, [tabId, onStateChange]);

  const handlePlanModeChange = useCallback((p: boolean) => {
    onPlanModeChange?.(tabId, p);
  }, [tabId, onPlanModeChange]);

  return (
    <Chat
      tabId={tabId}
      initialCwd={cwd}
      initialSessionId={sessionId}
      engine={engine}
      planMode={planMode}
      onPlanModeChange={handlePlanModeChange}
      hideHeader
      hideSidebar
      isActive={isActive}
      refreshSignal={refreshSignal}
      onLoadingChange={handleLoadingChange}
      onSessionIdChange={handleSessionIdChange}
      onTitleChange={handleTitleChange}
      onOpenNote={onOpenNote}
      onCreateScheduledTask={onCreateScheduledTask}
      onOpenSession={onOpenSession}
      onOpenSettings={onOpenSettings}
    />
  );
}
