'use client';

import { useCallback } from 'react';
import { Chat } from './Chat';
import type { ChatEngine, DeepseekModel, ToolCallInfo } from './types';

// Migrated from src/components/project/ChatPanel.tsx.

// ============================================
// ChatPanel - Simplified Chat panel without header and sidebar
// ============================================

interface ChatPanelProps {
  tabId: string;
  cwd?: string;
  sessionId?: string;
  engine?: ChatEngine;
  ollamaModel?: string;
  onOllamaModelChange?: (tabId: string, model: string) => void;
  deepseekModel?: DeepseekModel;
  onDeepseekModelChange?: (tabId: string, model: DeepseekModel) => void;
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
}

export function ChatPanel({ tabId, cwd, sessionId, engine, ollamaModel, onOllamaModelChange, deepseekModel, onDeepseekModelChange, planMode, onPlanModeChange, isActive, refreshSignal, onStateChange, onOpenNote, onCreateScheduledTask, onOpenSession }: ChatPanelProps) {
  const handleLoadingChange = useCallback((isLoading: boolean) => {
    onStateChange(tabId, { isLoading });
  }, [tabId, onStateChange]);

  const handleSessionIdChange = useCallback((newSessionId: string) => {
    onStateChange(tabId, { sessionId: newSessionId });
  }, [tabId, onStateChange]);

  const handleTitleChange = useCallback((title: string) => {
    onStateChange(tabId, { title });
  }, [tabId, onStateChange]);

  const handleOllamaModelChange = useCallback((model: string) => {
    onOllamaModelChange?.(tabId, model);
  }, [tabId, onOllamaModelChange]);

  const handleDeepseekModelChange = useCallback((model: DeepseekModel) => {
    onDeepseekModelChange?.(tabId, model);
  }, [tabId, onDeepseekModelChange]);

  const handlePlanModeChange = useCallback((p: boolean) => {
    onPlanModeChange?.(tabId, p);
  }, [tabId, onPlanModeChange]);

  return (
    <Chat
      tabId={tabId}
      initialCwd={cwd}
      initialSessionId={sessionId}
      engine={engine}
      ollamaModel={ollamaModel}
      onOllamaModelChange={handleOllamaModelChange}
      deepseekModel={deepseekModel}
      onDeepseekModelChange={handleDeepseekModelChange}
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
    />
  );
}
