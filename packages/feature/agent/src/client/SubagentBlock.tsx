'use client';

import { memo, useState } from 'react';
import { ChevronDown, ChevronRight, CheckCircle2, Loader, CircleAlert, CircleSlash } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ToolCallModal } from './ToolCallModal';
import type { SubagentGroup } from './subagentGroups';

/**
 * ONE DELEGATED RUN, AS ONE ROW.
 *
 * The transcript's flat vocabulary — a muted toggle line, slim rows underneath —
 * applied to a subagent: who it was, whether it is still going, how much work it
 * did, and (expanded) exactly which calls it made. No card, no border box: a
 * delegated run is still machinery, and machinery does not get to look like
 * something the assistant said.
 *
 * `memo`'d and fed only what it renders. `group` comes from a `useMemo` in the
 * bubble, so its identity changes only when the run actually changes — every
 * other message in the list re-renders without touching this one.
 */

const STATUS_KEY = {
  running: 'chat.subagentRunning',
  completed: 'chat.subagentCompleted',
  failed: 'chat.subagentFailed',
  stopped: 'chat.subagentStopped',
} as const;

const STATUS_FALLBACK = {
  running: 'running',
  completed: 'done',
  failed: 'failed',
  stopped: 'stopped',
} as const;

function StatusIcon({ status }: { status: SubagentGroup['status'] }) {
  if (status === 'running') return <Loader className="w-3 h-3 animate-spin opacity-70" />;
  if (status === 'completed') return <CheckCircle2 className="w-3 h-3 opacity-60" />;
  if (status === 'failed') return <CircleAlert className="w-3 h-3 opacity-70" />;
  if (status === 'stopped') return <CircleSlash className="w-3 h-3 opacity-60" />;
  return null;
}

interface SubagentBlockProps {
  group: SubagentGroup;
  cwd?: string;
  sessionId?: string | null;
}

export const SubagentBlock = memo(function SubagentBlock({ group, cwd, sessionId }: SubagentBlockProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  // The subagent's own calls plus the call that launched it — the launcher first,
  // because its result IS the run's report and reading it before the working-out
  // is what a reader wants.
  const rows = group.parentCall ? [group.parentCall, ...group.calls] : group.calls;

  const title = group.agentType
    ? t('chat.subagentNamed', {
        type: group.agentType,
        defaultValue: 'Subagent · {{type}}',
      })
    : t('chat.subagent', { defaultValue: 'Subagent' });

  return (
    <div className="mt-0.5" data-testid="subagent-block" data-agent-id={group.id}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        data-testid="subagent-toggle"
        className="flex w-full items-center gap-1.5 rounded px-2 py-0.5 text-[0.786rem] text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3 opacity-60 flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 opacity-60 flex-shrink-0" />
        )}
        <span className="flex-shrink-0">{title}</span>
        {group.status !== 'unknown' && (
          <span className="flex items-center gap-1 flex-shrink-0" data-testid="subagent-status">
            <StatusIcon status={group.status} />
            {t(STATUS_KEY[group.status], { defaultValue: STATUS_FALLBACK[group.status] })}
          </span>
        )}
        {rows.length > 0 && (
          <span className="flex-shrink-0 opacity-70">
            · {t('chat.toolCalls', { count: rows.length })}
          </span>
        )}
        {/* The model's own words for the task. Last and truncated: it is the
            least reliable part of the line (free text) and the most likely to
            be long. */}
        {group.description && (
          <span className="truncate opacity-60 text-left">· {group.description}</span>
        )}
      </button>
      {expanded && group.text && (
        // WHAT THE SUBAGENT SAID, in its own block and behind the same fold as
        // its calls. This text used to be appended to the assistant bubble, so a
        // delegated run's narration read as naby's answer to the user. It is a
        // record of someone else's working, so it is shown as one: quiet,
        // monospaced, and only when asked for.
        <div className="ml-3 border-l border-border/50 pl-2 py-1">
          <pre className="whitespace-pre-wrap break-words font-mono text-[0.688rem] leading-relaxed text-muted-foreground">
            {group.text.trim()}
          </pre>
        </div>
      )}
      {expanded && rows.length > 0 && (
        <div className="ml-3 border-l border-border/50 pl-2">
          {rows.map((toolCall, index) => (
            <ToolCallModal
              key={`${toolCall.id}-${index}`}
              toolCall={toolCall}
              cwd={cwd}
              sessionId={sessionId}
            />
          ))}
        </div>
      )}
    </div>
  );
});
