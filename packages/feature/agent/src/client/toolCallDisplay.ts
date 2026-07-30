import type { ToolCallInfo } from './types';

/**
 * TOOL CALLS ARE MACHINERY, NOT SPEECH.
 *
 * The transcript used to render a tool call in the same visual language as an
 * answer — a bordered `bg-secondary` card inside a `bg-accent rounded-2xl`
 * bubble — so a turn that read four files looked like the assistant had said
 * five things, and the one thing it actually said was the hardest to find. The
 * rendering now demotes calls to slim muted rows; this module holds the pure
 * decisions that rendering needs, so they can be tested without a DOM.
 */

/**
 * At or above this many calls in one run, the rows hide behind a collapsed
 * "N tool calls" line. Below it they render bare.
 *
 * The old threshold was ZERO — every group, including a group of one, got a
 * header reading "1 tool call". That header carried no information the row
 * underneath did not already carry, and it was the single loudest element in
 * the transcript. Four is where a run stops being glanceable and starts being a
 * wall.
 */
export const TOOL_CALL_HEADER_THRESHOLD = 4;

/** True when a run of `count` calls should sit behind a collapsed header. */
export function shouldGroupUnderHeader(count: number): boolean {
  return count >= TOOL_CALL_HEADER_THRESHOLD;
}

/**
 * The calls that belong in the generic row list. `ExitPlanMode` is excluded
 * because its plan is surfaced as its own card — as a row it reads as a failed
 * tool (plan mode auto-denies the call).
 */
export function filterDisplayToolCalls(
  toolCalls: ToolCallInfo[] | undefined
): ToolCallInfo[] {
  return (toolCalls ?? []).filter((tc) => tc.name !== 'ExitPlanMode');
}

const TOOL_ICONS: Record<string, string> = {
  Read: '📄',
  Write: '✏️',
  Edit: '📝',
  Bash: '💻',
  Glob: '🔍',
  Grep: '🔎',
  WebFetch: '🌐',
  WebSearch: '🔍',
  Workflow: '🧩',
  Skill: '🛠️',
};

export function toolIconFor(name: string): string {
  return TOOL_ICONS[name] || '🔧';
}

/**
 * How the one-line preview beside a tool name should be treated.
 *
 *  - `path`    a filesystem path: shortened against the cwd, and offered for
 *              copy as its ABSOLUTE self.
 *  - `literal` an exact string the user may want verbatim (a command, a glob, a
 *              search query): shown as written, still copyable.
 *  - `label`   a human description (an agent's task, a workflow/skill name, or
 *              a generic fallback): shown as written, no copy affordance —
 *              there is nothing addressable to paste anywhere.
 */
export type ToolPreviewKind = 'path' | 'literal' | 'label';

export interface ToolCallPreview {
  text: string;
  kind: ToolPreviewKind;
}

/** Longest generic-fallback preview. Long enough to identify a call, short
 *  enough that it cannot become a paragraph in the transcript. */
const GENERIC_PREVIEW_LIMIT = 120;

function firstStringField(input: Record<string, unknown>): string | null {
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

function condense(text: string, limit = GENERIC_PREVIEW_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * The identifying detail for a tool call — what makes `Read` into
 * `Read src/app.ts`. Returns null when the input has nothing worth showing
 * (e.g. TodoWrite, whose payload is rendered as its own widget).
 */
export function toolCallPreview(
  name: string,
  input: Record<string, unknown> | undefined
): ToolCallPreview | null {
  const i = input ?? {};
  const str = (key: string): string | null =>
    typeof i[key] === 'string' && i[key] !== '' ? (i[key] as string) : null;

  const isAgentTool = name === 'Agent' || name === 'Task';

  if (name === 'Bash') {
    const command = str('command');
    if (command) return { text: condense(command), kind: 'literal' };
  }
  if (isAgentTool) {
    const description = str('description');
    if (description) return { text: condense(description), kind: 'label' };
  }
  if (name === 'Workflow') {
    const detail = str('args') ?? str('resumeFromRunId') ?? '';
    const label = [str('name') ?? '', detail].filter(Boolean).join(' · ');
    if (label) return { text: condense(label), kind: 'label' };
  }
  if (name === 'Skill') {
    const skill = str('skill');
    if (skill) {
      const label = [skill, str('args') ?? ''].filter(Boolean).join(' · ');
      return { text: condense(label), kind: 'label' };
    }
  }
  if (name === 'Glob' || name === 'Grep') {
    const pattern = str('pattern');
    if (pattern) return { text: condense(pattern), kind: 'literal' };
  }
  if (name === 'ToolSearch') {
    const query = str('query');
    if (query) return { text: condense(query), kind: 'literal' };
  }
  if (name === 'TaskCreate') {
    const subject = str('subject');
    if (subject) return { text: condense(subject), kind: 'literal' };
  }
  const path = str('file_path') ?? str('path');
  if (path) return { text: path, kind: 'path' };

  // Nothing recognized. A bare tool name tells the reader nothing, so fall back
  // to the first string the call was given — truncated, and labelled, because a
  // random field is not something to offer as a copyable address.
  const generic = firstStringField(i);
  return generic ? { text: condense(generic), kind: 'label' } : null;
}

/** Shorten an absolute path for display: against the cwd when it is inside it,
 *  otherwise to its last two segments. */
export function relativizePath(fullPath: string, cwd?: string): string {
  if (cwd && fullPath.startsWith(cwd)) {
    const relative = fullPath.slice(cwd.length);
    return relative.startsWith('/') ? relative.slice(1) : relative;
  }
  const parts = fullPath.split('/');
  if (parts.length > 2) return `.../${parts.slice(-2).join('/')}`;
  return fullPath;
}

/**
 * The workflow run id (`wf_xxx`) carried in a Workflow call's launch text. The
 * transcript directory is printed even for a background run, so the id is
 * available as soon as the call returns.
 */
export function parseWorkflowRunId(result?: string): string | null {
  if (!result) return null;
  return result.match(/subagents\/workflows\/(wf_[A-Za-z0-9_-]+)/)?.[1] ?? null;
}
