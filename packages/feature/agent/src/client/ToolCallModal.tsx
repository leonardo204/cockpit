'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { toast } from '@cockpit/shared-ui';
import { SubagentTranscriptModal } from './SubagentTranscriptModal';
import { WorkflowRunModal } from './WorkflowRunModal';
import type { ToolCallInfo } from './types';
import { ToolCallPreviewModal } from './ToolCallPreviewModal';
import {
  parseWorkflowRunId,
  relativizePath,
  toolCallPreview,
  toolIconFor,
} from './toolCallDisplay';

// Migrated from src/components/project/ToolCallModal.tsx.

// ============================================
// ToolCallModal — one tool call, as a slim machinery row
// ============================================
//
// This used to be a card: `border border-border rounded-lg bg-secondary`, i.e.
// the same vocabulary the chat bubbles use, stacked INSIDE a bubble. Two nested
// surfaces per call meant a turn that read four files looked like five separate
// utterances, and the actual answer was the hardest thing on screen to find.
//
// A call is now a row: icon, name, a one-line preview, and the controls, in the
// muted house style (text-xs / text-muted-foreground / hover tint, no border, no
// filled block). It reads as a log line, which is what it is. The detail body is
// still one click away and still starts closed.

interface ToolCallProps {
  toolCall: ToolCallInfo;
  cwd?: string;
  // Enables the subagent transcript entry on Agent/Task tool calls
  sessionId?: string | null;
}

export function ToolCallModal({ toolCall, cwd, sessionId }: ToolCallProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [previewContent, setPreviewContent] = useState<{ title: string; content: string } | null>(null);
  const [showSubagent, setShowSubagent] = useState(false);
  const [showWorkflow, setShowWorkflow] = useState(false);

  const toolIcon = toolIconFor(toolCall.name);
  const isAgentTool = toolCall.name === 'Agent' || toolCall.name === 'Task';
  const isSubagentCall = isAgentTool && !!cwd && !!sessionId;
  const isWorkflow = toolCall.name === 'Workflow';
  const workflowRunId = isWorkflow ? parseWorkflowRunId(toolCall.result) : null;
  // Workflow drill-in needs the run id plus the session coordinates to locate
  // the journal under `<sessionId>/workflows/`.
  const isWorkflowCall = isWorkflow && !!workflowRunId && !!cwd && !!sessionId;

  // The identifying detail beside the name. `path` previews are shortened for
  // display but copied in full; `label` previews (an agent's task, a workflow
  // name, a generic fallback) are not addresses, so no copy affordance.
  const preview = toolCallPreview(toolCall.name, toolCall.input);
  const displayText = preview
    ? preview.kind === 'path'
      ? relativizePath(preview.text, cwd)
      : preview.text
    : null;
  const canCopy = !!preview && preview.kind !== 'label';

  const copyPreview = () => {
    if (!preview) return;
    navigator.clipboard.writeText(preview.text);
    toast(t('common.copiedPath'));
  };

  const openPreview = (type: 'input' | 'result') => {
    const suffix = type === 'input' ? t('toolCall.inputParams') : t('toolCall.resultLabel');
    const content = type === 'input'
      ? JSON.stringify(toolCall.input, null, 2)
      : (typeof toolCall.result === 'string' ? toolCall.result : JSON.stringify(toolCall.result, null, 2));
    setPreviewContent({
      title: `${toolCall.name}${displayText ? ` ${displayText}` : ''} - ${suffix}`,
      content,
    });
  };

  return (
    <div className="group/tool" data-testid="tool-call-row">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-1.5 rounded px-2 py-1 text-left text-xs leading-5 text-muted-foreground hover:bg-muted/30 transition-colors"
        title={t('toolCall.toggleDetails', { defaultValue: 'Show details' })}
      >
        <span className="text-[11px] leading-none flex-shrink-0">{toolIcon}</span>
        <span className="text-foreground flex-shrink-0">{toolCall.name}</span>
        {displayText && (
          <>
            <span
              className="truncate flex-1 min-w-0 font-mono text-[11px]"
              title={preview?.text || ''}
            >
              {displayText}
            </span>
            {canCopy && (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  copyPreview();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.stopPropagation();
                    copyPreview();
                  }
                }}
                className="p-0.5 rounded opacity-50 hover:opacity-100 hover:text-foreground transition-opacity flex-shrink-0 cursor-pointer"
                title={t('common.copyAbsPath')}
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </span>
            )}
          </>
        )}
        {/* Right action area */}
        <span className="ml-auto flex items-center gap-2 flex-shrink-0">
          {isSubagentCall && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); setShowSubagent(true); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); setShowSubagent(true); } }}
              className="text-[11px] text-brand hover:text-teal-10 cursor-pointer"
              title={t('chat.subagentViewTitle')}
            >
              {t('chat.subagent')}
            </span>
          )}
          {isWorkflowCall && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); setShowWorkflow(true); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); setShowWorkflow(true); } }}
              className="text-[11px] text-brand hover:text-teal-10 cursor-pointer"
              title={t('chat.workflowViewTitle')}
            >
              {t('chat.workflowRun')}
            </span>
          )}
          {expanded && !toolCall.isLoading && (
            <>
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); openPreview('input'); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); openPreview('input'); } }}
                className="text-[11px] text-brand hover:text-teal-10 cursor-pointer"
                title={t('toolCall.inputParamsTitle')}
              >
                {t('toolCall.input')}
              </span>
              {toolCall.result && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); openPreview('result'); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); openPreview('result'); } }}
                  className="text-[11px] text-brand hover:text-teal-10 cursor-pointer"
                  title={t('toolCall.resultTitle')}
                >
                  {t('toolCall.result')}
                </span>
              )}
            </>
          )}
          {toolCall.isLoading ? (
            <span className="inline-block w-3 h-3 border-2 border-brand border-t-transparent rounded-full animate-spin" />
          ) : expanded ? (
            <ChevronDown className="w-3 h-3 opacity-60" />
          ) : (
            <ChevronRight className="w-3 h-3 opacity-60" />
          )}
        </span>
      </button>

      {/* Detail, indented under its row and lit like the reasoning block rather
          than like a card — same recipe as the thinking summary body. */}
      {expanded && (
        <div className="ml-6 mb-1 rounded-md border border-border bg-muted/30 px-2 py-1.5 text-[11px] leading-relaxed">
          <div>
            <div className="mb-0.5 text-muted-foreground">{t('toolCall.inputParams')}</div>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-foreground/90">
              {JSON.stringify(toolCall.input, null, 2)}
            </pre>
          </div>

          {toolCall.result && (
            <div className="mt-1.5 border-t border-border/60 pt-1.5">
              <div className="mb-0.5 text-muted-foreground">{t('toolCall.resultLabel')}</div>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-foreground/90">
                {typeof toolCall.result === 'string' ? toolCall.result : JSON.stringify(toolCall.result, null, 2)}
              </pre>
            </div>
          )}

          {/* Skill body loaded by this call — folded here instead of shown as a user bubble */}
          {toolCall.skillContent && (
            <div className="mt-1.5 border-t border-border/60 pt-1.5">
              <div className="mb-0.5 text-muted-foreground">
                {t('toolCall.skillContent', { defaultValue: 'Skill content' })}
              </div>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-foreground/90">
                {toolCall.skillContent}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Preview modal */}
      {previewContent && (
        <ToolCallPreviewModal
          title={previewContent.title}
          content={previewContent.content}
          onClose={() => setPreviewContent(null)}
        />
      )}

      {/* Subagent transcript modal */}
      {showSubagent && cwd && sessionId && (
        <SubagentTranscriptModal
          cwd={cwd}
          sessionId={sessionId}
          toolCall={toolCall}
          onClose={() => setShowSubagent(false)}
        />
      )}

      {/* Workflow run modal */}
      {showWorkflow && cwd && sessionId && workflowRunId && (
        <WorkflowRunModal
          cwd={cwd}
          sessionId={sessionId}
          runId={workflowRunId}
          isRunning={!!toolCall.isLoading}
          onClose={() => setShowWorkflow(false)}
        />
      )}
    </div>
  );
}
