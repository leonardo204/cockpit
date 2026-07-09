/**
 * Single source of truth for "can this tool touch the project tree?".
 *
 * Used by BOTH sides of the snapshot feature:
 *  - server hook (snapshot/hook.ts): skip the status check for read-only tools
 *  - client (MessageBubble): whether to show the file-changes entry icon
 *
 * Deny-list semantics on purpose: unknown tools (MCP tools, Task subagents,
 * future additions) are assumed mutating — a snapshot for a tool that
 * changed nothing is a cheap no-op, but a missing entry for a tool that DID
 * change files hides real data.
 */

/** Tools that can never touch the project tree. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'WebSearch',
  'WebFetch',
  'NotebookRead',
  'TodoRead',
  'AskUserQuestion',
  'ExitPlanMode',
  'TodoWrite', // writes outside the project tree
  'Skill', // loads skill content only
]);

/** True when the tool may have modified files (unknown names included). */
export const isMutatingToolName = (name: string): boolean => !READ_ONLY_TOOLS.has(name);
