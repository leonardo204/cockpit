'use client';

/**
 * Full-screen viewer for a single tool call's input params / result blob.
 *
 * Inlined during the F1-03 chat-first trim, replacing `PreviewModal` from the
 * deleted `@cockpit/feature-explorer`. That component was a 334-line file
 * previewer (DiffView / DiffUnifiedView / CodeViewer / FileImagePreview /
 * markdown TOC) whose "file" and "diff" view modes only make sense inside an
 * IDE. Chat needs exactly one thing from it: render this JSON blob readably,
 * with Cmd+F search. So only the JSON rendering path is kept here.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Portal, useJsonSearch, JsonSearchBar } from '@cockpit/shared-ui';
import i18n from '@cockpit/shared-i18n';
import { useTranslation } from 'react-i18next';

// ============================================
// JSON helpers — inlined from the deleted explorer `toolCallUtils.ts`.
// Only the three functions the tool-call preview actually used.
// ============================================

function isValidJson(content: string): boolean {
  try {
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

function formatAsJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

/** Token colors — hardcoded github-dark hex; the preview renders on a fixed
 *  dark surface, so this keeps the view pixel-identical to the old modal. */
const COLORS = {
  key: '#79c0ff',
  str: '#a5d6ff',
  num: '#79c0ff',
  bool: '#ff7b72',
  punct: '#8b949e',
  fold: '#6e7681',
};

const s = (color: string, text: string | React.ReactNode) =>
  React.createElement('span', { style: { color } }, text);

/** A value renders to more than 3 lines ⇒ it can be collapsed. */
function isMultilineValue(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.replace(/\\n/g, '\n').split('\n').length > 3;
  }
  return false;
}

/** Collapsible `key: value` entry — click the long text itself to fold. */
function CollapsibleEntry({ label, value, indent }: {
  label: string; value: unknown; indent: number;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [downPos, setDownPos] = useState({ x: 0, y: 0 });
  const canFold = isMultilineValue(value);
  const onDown = (e: React.MouseEvent) => { setDownPos({ x: e.clientX, y: e.clientY }); };
  const onClick = (e: React.MouseEvent) => {
    const dx = e.clientX - downPos.x;
    const dy = e.clientY - downPos.y;
    if (dx * dx + dy * dy > 25) return; // drag-select must not toggle
    e.stopPropagation();
    setCollapsed(v => !v);
  };
  const foldProps = { onMouseDown: onDown, onClick, style: { cursor: 'pointer' as const } };

  if (canFold && collapsed && typeof value === 'string') {
    const lines = value.replace(/\\n/g, '\n').split('\n');
    return React.createElement('span', foldProps,
      s(COLORS.key, label),
      s(COLORS.punct, ': '),
      s(COLORS.str, lines[0]),
      s(COLORS.fold, ` ${i18n.t('toolCall.foldedLines', { count: lines.length })}`),
    );
  }

  const content = React.createElement(React.Fragment, null,
    s(COLORS.key, label),
    s(COLORS.punct, ': '),
    formatValue(value, indent),
  );
  return canFold ? React.createElement('span', foldProps, content) : content;
}

function formatValue(value: unknown, indent: number): React.ReactNode {
  const indentStr = '  '.repeat(indent);

  if (value === null) return s(COLORS.bool, 'null');
  if (value === undefined) return s(COLORS.bool, 'undefined');
  if (typeof value === 'string') {
    return s(COLORS.str, value.replace(/\\n/g, '\n').replace(/\n/g, '\n' + indentStr));
  }
  if (typeof value === 'number') return s(COLORS.num, String(value));
  if (typeof value === 'boolean') return s(COLORS.bool, String(value));

  if (Array.isArray(value)) {
    if (value.length === 0) return s(COLORS.punct, '[]');
    return React.createElement(React.Fragment, null,
      s(COLORS.punct, '['), '\n',
      ...value.map((item, i) =>
        React.createElement('span', { key: i },
          indentStr + '  ',
          React.createElement(CollapsibleEntry, { label: `[${i}]`, value: item, indent: indent + 1 }),
          i < value.length - 1 ? React.createElement(React.Fragment, null, s(COLORS.punct, ','), '\n') : '\n',
        ),
      ),
      indentStr, s(COLORS.punct, ']'),
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return s(COLORS.punct, '{}');
    return React.createElement(React.Fragment, null,
      s(COLORS.punct, '{'), '\n',
      ...entries.map(([k, v], i) =>
        React.createElement('span', { key: k },
          indentStr + '  ',
          React.createElement(CollapsibleEntry, { label: k, value: v, indent: indent + 1 }),
          i < entries.length - 1 ? React.createElement(React.Fragment, null, s(COLORS.punct, ','), '\n') : '\n',
        ),
      ),
      indentStr, s(COLORS.punct, '}'),
    );
  }

  return String(value);
}

function formatAsHumanReadable(content: string): React.ReactNode {
  try {
    return formatValue(JSON.parse(content), 0);
  } catch {
    return content;
  }
}

// ============================================
// Modal
// ============================================

type ViewMode = 'readable' | 'json';

interface ToolCallPreviewModalProps {
  title: string;
  content: string;
  onClose: () => void;
}

export function ToolCallPreviewModal({ title, content, onClose }: ToolCallPreviewModalProps) {
  const { t } = useTranslation();
  const isJson = isValidJson(content);
  const [viewMode, setViewMode] = useState<ViewMode>(isJson ? 'readable' : 'json');
  const preRef = useRef<HTMLPreElement>(null);
  const jsonSearch = useJsonSearch(preRef);

  // ESC closes (search bar first); Cmd+F opens search in readable mode.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f' && viewMode === 'readable' && isJson) {
        e.preventDefault();
        jsonSearch.open();
        return;
      }
      if (e.key === 'Escape') {
        if (jsonSearch.isVisible) {
          jsonSearch.close();
          return;
        }
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, viewMode, isJson, jsonSearch]);

  const body = viewMode === 'readable' && isJson ? (
    <>
      <JsonSearchBar search={jsonSearch} />
      <pre ref={preRef} className="text-foreground whitespace-pre-wrap break-words" style={{ fontSize: '0.8125rem' }}>
        {formatAsHumanReadable(content)}
      </pre>
    </>
  ) : (
    <pre className="text-foreground whitespace-pre-wrap break-words" style={{ fontSize: '0.8125rem' }}>
      {isJson ? formatAsJson(content) : content}
    </pre>
  );

  return (
    <Portal>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-0 md:p-4"
        onClick={onClose}
      >
        <div
          className="bg-card shadow-xl w-full max-w-[90%] h-full md:h-[90vh] rounded-none md:rounded-lg flex flex-col transition-all"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <h3 className="text-sm font-medium text-foreground">{title}</h3>
            <div className="flex items-center gap-3">
              {isJson && (
                <div className="flex items-center gap-1 bg-accent rounded p-0.5">
                  <button
                    onClick={() => setViewMode('readable')}
                    className={`px-2 py-1 text-xs rounded transition-colors ${
                      viewMode === 'readable'
                        ? 'bg-card text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {t('common.readable')}
                  </button>
                  <button
                    onClick={() => setViewMode('json')}
                    className={`px-2 py-1 text-xs rounded transition-colors ${
                      viewMode === 'json'
                        ? 'bg-card text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    JSON
                  </button>
                </div>
              )}
              <button
                onClick={onClose}
                className="p-1 text-slate-9 hover:text-foreground hover:bg-accent rounded transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-auto p-4">{body}</div>
        </div>
      </div>
    </Portal>
  );
}
