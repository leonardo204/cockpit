import * as fs from 'fs';
import * as readline from 'readline';
import { join } from 'path';
import { Effect } from 'effect';
import { getClaudeSessionPath } from '@cockpit/shared-utils';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import {
  AppError,
  NotFoundError,
  ValidationError,
} from '@cockpit/effect-core';
import { generateTitle } from '../sessionTitle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface TranscriptMessage {
  type: string;
  // Harness-injected (non-typed) user messages are marked so they can be routed
  // out of the "user bubble" bucket: `isMeta` (skill body / image annotation /
  // compact summary), `origin.kind` (e.g. 'task-notification'), and
  // `sourceToolUseID` (the tool call a skill body was loaded by).
  isMeta?: boolean;
  isCompactSummary?: boolean;
  origin?: { kind?: string };
  sourceToolUseID?: string;
  message?: {
    role?: string;
    content?: string | Array<{
      type: string;
      text?: string;
      name?: string;
      id?: string;
      input?: Record<string, unknown>;
      tool_use_id?: string;
      content?: string;
      is_error?: boolean;
      source?: {
        type: string;
        media_type: string;
        data: string;
      };
    }>;
    usage?: TokenUsage;
  };
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  toolUseResult?: {
    stdout?: string;
    stderr?: string;
  };
}

interface MessageImage {
  type: 'base64';
  media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  data: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  images?: MessageImage[];
  timestamp?: string;
  // Set on role:'system' rows — a harness event rendered as a muted one-line bar
  // (not a conversation bubble). `task-notification` shows the <summary> line.
  systemEvent?: { kind: 'task-notification' | 'meta'; status?: string; detail?: string };
  toolCalls?: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    result?: string;
    isLoading: boolean;
    // Skill body loaded by this call (folded here instead of shown as a user bubble).
    skillContent?: string;
  }>;
}


// File fingerprint: mtime + size, lightweight check for file changes
function getFileFingerprint(filePath: string): string {
  const stat = fs.statSync(filePath);
  return `${stat.mtimeMs}-${stat.size}`;
}

interface SessionByPathBody {
  cwd?: string;
  sessionId?: string;
  // When set, return the transcript of the subagent spawned by this Agent/Task
  // tool call instead of the main session (new-format `<sessionId>/subagents/` dir).
  toolUseId?: string;
  // Workflow drill-in. When `workflowId` is set, return the workflow run journal
  // (`<sessionId>/workflows/<workflowId>.json`); when `workflowAgentId` is also
  // set, return that workflow subagent's transcript
  // (`<sessionId>/subagents/workflows/<workflowId>/agent-<workflowAgentId>.jsonl`).
  workflowId?: string;
  workflowAgentId?: string;
  limit?: number;
  beforeTurnIndex?: number;
  ifFingerprint?: string;
}

// Subagent meta sidecar (agent-<id>.meta.json next to agent-<id>.jsonl)
interface SubagentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
}

// One agent's progress entry inside a workflow run journal.
interface WorkflowAgentEntry {
  type?: string;
  index?: number;
  label?: string;
  phaseIndex?: number;
  phaseTitle?: string;
  agentId?: string;
  model?: string;
  state?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  lastToolName?: string;
  lastToolSummary?: string;
  promptPreview?: string;
  resultPreview?: string;
}

// Workflow run journal (`workflows/<runId>.json`). Only the fields the
// drill-in UI needs are typed; the raw file also carries `script`, `logs`,
// full `result`, etc. which we deliberately do NOT forward to the client.
interface WorkflowJournal {
  runId?: string;
  workflowName?: string;
  status?: string;
  durationMs?: number;
  agentCount?: number;
  totalTokens?: number;
  totalToolCalls?: number;
  startTime?: number;
  phases?: Array<{ title?: string; detail?: string }>;
  summary?: string;
  workflowProgress?: WorkflowAgentEntry[];
}

// Locate the subagent transcript spawned by a given tool_use id.
// Subagents live in `<sessionDir>/<sessionId>/subagents/agent-<id>.jsonl`
// with a meta sidecar carrying the spawning toolUseId.
function findSubagentTranscript(
  sessionPath: string,
  toolUseId: string
): { transcriptPath: string; meta: SubagentMeta } | null {
  const subagentsDir = join(sessionPath.replace(/\.jsonl$/, ''), 'subagents');
  if (!fs.existsSync(subagentsDir)) return null;
  for (const file of fs.readdirSync(subagentsDir)) {
    if (!file.endsWith('.meta.json')) continue;
    try {
      const meta = JSON.parse(
        fs.readFileSync(join(subagentsDir, file), 'utf-8')
      ) as SubagentMeta;
      if (meta.toolUseId !== toolUseId) continue;
      const transcriptPath = join(subagentsDir, file.replace(/\.meta\.json$/, '.jsonl'));
      if (fs.existsSync(transcriptPath)) return { transcriptPath, meta };
    } catch {
      // Skip unreadable meta files
    }
  }
  return null;
}

// Path of a workflow run journal: `<sessionDir>/workflows/<runId>.json`.
function workflowJournalPath(sessionPath: string, workflowId: string): string {
  return join(sessionPath.replace(/\.jsonl$/, ''), 'workflows', `${workflowId}.json`);
}

// Path of a single workflow subagent transcript:
// `<sessionDir>/subagents/workflows/<runId>/agent-<agentId>.jsonl`.
function workflowAgentTranscriptPath(
  sessionPath: string,
  workflowId: string,
  agentId: string
): string {
  return join(
    sessionPath.replace(/\.jsonl$/, ''),
    'subagents',
    'workflows',
    workflowId,
    `agent-${agentId}.jsonl`
  );
}

// Trim a raw journal down to the fields the drill-in UI renders. Drops
// `script`, `logs`, and the full `result` blob; keeps bounded previews only.
function trimWorkflowJournal(journal: WorkflowJournal) {
  const agents = (journal.workflowProgress ?? [])
    .filter((e) => e.type === 'workflow_agent')
    .map((e) => ({
      index: e.index,
      label: e.label,
      phaseIndex: e.phaseIndex,
      phaseTitle: e.phaseTitle,
      agentId: e.agentId,
      model: e.model,
      state: e.state,
      tokens: e.tokens,
      toolCalls: e.toolCalls,
      durationMs: e.durationMs,
      lastToolName: e.lastToolName,
      lastToolSummary: e.lastToolSummary,
      promptPreview: e.promptPreview,
      resultPreview: e.resultPreview,
    }));
  return {
    runId: journal.runId,
    workflowName: journal.workflowName,
    status: journal.status,
    durationMs: journal.durationMs,
    agentCount: journal.agentCount,
    totalTokens: journal.totalTokens,
    totalToolCalls: journal.totalToolCalls,
    startTime: journal.startTime,
    phases: journal.phases,
    summary: journal.summary,
    agents,
  };
}

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as SessionByPathBody;
    const { cwd, sessionId, toolUseId, workflowId, workflowAgentId, limit, beforeTurnIndex, ifFingerprint } = body;
    if (!cwd || !sessionId) {
      return yield* Effect.fail(
        new ValidationError({
          field: !cwd ? 'cwd' : 'sessionId',
          reason: 'missing',
        })
      );
    }

    // Resolve the session's transcript file (single-engine: Claude Agent SDK path).
    const resolved = yield* Effect.sync(() => resolveSessionPath(cwd, sessionId));
    if (!resolved) {
      return yield* Effect.fail(
        new NotFoundError({ resource: 'session', id: sessionId })
      );
    }
    const { sessionPath, engine } = resolved;

    // Subagent transcript branch: same parser/fingerprint flow on the agent jsonl
    if (toolUseId) {
      if (!/^[A-Za-z0-9_-]+$/.test(toolUseId)) {
        return yield* Effect.fail(
          new ValidationError({ field: 'toolUseId', reason: 'invalid' })
        );
      }
      const sub = yield* Effect.sync(() => findSubagentTranscript(sessionPath, toolUseId));
      if (!sub) {
        return yield* Effect.fail(
          new NotFoundError({ resource: 'subagent', id: toolUseId })
        );
      }
      const subFingerprint = getFileFingerprint(sub.transcriptPath);
      if (ifFingerprint && ifFingerprint === subFingerprint) {
        return ok({ notModified: true, fingerprint: subFingerprint });
      }
      const subResult = yield* Effect.tryPromise({
        try: () => parseTranscriptFile(sub.transcriptPath),
        catch: (cause) =>
          new AppError({ message: 'parseTranscriptFile failed', cause }),
      });
      return ok({
        messages: subResult.messages,
        subagent: { agentType: sub.meta.agentType, description: sub.meta.description },
        fingerprint: subFingerprint,
      });
    }

    // Workflow drill-in branch: run journal, or a single workflow subagent's
    // transcript when workflowAgentId is also supplied. Both ids are
    // whitelisted to keep the file path inside the session dir.
    if (workflowId) {
      if (!/^wf_[A-Za-z0-9_-]+$/.test(workflowId)) {
        return yield* Effect.fail(
          new ValidationError({ field: 'workflowId', reason: 'invalid' })
        );
      }

      if (workflowAgentId) {
        if (!/^[A-Za-z0-9_-]+$/.test(workflowAgentId)) {
          return yield* Effect.fail(
            new ValidationError({ field: 'workflowAgentId', reason: 'invalid' })
          );
        }
        const agentPath = workflowAgentTranscriptPath(sessionPath, workflowId, workflowAgentId);
        if (!fs.existsSync(agentPath)) {
          return yield* Effect.fail(
            new NotFoundError({ resource: 'workflowAgent', id: workflowAgentId })
          );
        }
        const agentFingerprint = getFileFingerprint(agentPath);
        if (ifFingerprint && ifFingerprint === agentFingerprint) {
          return ok({ notModified: true, fingerprint: agentFingerprint });
        }
        const agentResult = yield* Effect.tryPromise({
          try: () => parseTranscriptFile(agentPath),
          catch: (cause) =>
            new AppError({ message: 'parseTranscriptFile failed', cause }),
        });
        return ok({ messages: agentResult.messages, fingerprint: agentFingerprint });
      }

      const journalPath = workflowJournalPath(sessionPath, workflowId);
      if (!fs.existsSync(journalPath)) {
        return yield* Effect.fail(
          new NotFoundError({ resource: 'workflow', id: workflowId })
        );
      }
      const journalFingerprint = getFileFingerprint(journalPath);
      if (ifFingerprint && ifFingerprint === journalFingerprint) {
        return ok({ notModified: true, fingerprint: journalFingerprint });
      }
      const workflow = yield* Effect.try({
        try: () =>
          trimWorkflowJournal(
            JSON.parse(fs.readFileSync(journalPath, 'utf-8')) as WorkflowJournal
          ),
        catch: (cause) =>
          new AppError({ message: 'readWorkflowJournal failed', cause }),
      });
      return ok({ workflow, fingerprint: journalFingerprint });
    }

    const fingerprint = getFileFingerprint(sessionPath);
    if (ifFingerprint && ifFingerprint === fingerprint) {
      return ok({ notModified: true, fingerprint });
    }

    const parseResult = yield* Effect.tryPromise({
      try: async () => parseTranscriptFile(sessionPath, limit, beforeTurnIndex),
      catch: (cause) =>
        new AppError({ message: 'parseTranscriptFile failed', cause }),
    });

    const { messages, title, usage } = parseResult;
    const totalTurns = 'totalTurns' in parseResult ? parseResult.totalTurns : 0;
    const hasMore = 'hasMore' in parseResult ? parseResult.hasMore : false;
    return ok({
      messages,
      sessionId,
      title,
      usage,
      totalTurns,
      hasMore,
      fingerprint,
      // Authoritative engine for this session. Naby is single-engine, so this is
      // always 'claude'; retained in the response shape for the mobile (/m) client
      // and any legacy readers.
      engine,
    });
  })
);

function resolveSessionPath(
  cwd: string,
  sessionId: string
): {
  sessionPath: string;
  engine: 'claude';
} | null {
  // Naby is single-engine: sessions live under the Claude Agent SDK transcript
  // path. The alt-engine (codex/kimi/ollama/deepseek) and claude2 resolution
  // branches were removed with the engine picker — legacy sessions written by
  // those engines no longer resolve here (accepted single-engine tradeoff).
  const sessionPath = getClaudeSessionPath(cwd, sessionId);
  if (fs.existsSync(sessionPath)) {
    return { sessionPath, engine: 'claude' };
  }
  return null;
}

async function parseTranscriptFile(
  filePath: string,
  limit?: number,
  beforeTurnIndex?: number
): Promise<{ messages: ChatMessage[]; title: string; usage?: TokenUsage; totalTurns: number; hasMore: boolean }> {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const rawMessages: TranscriptMessage[] = [];
  let aiTitle = '';
  let summary = '';
  const userTextMessages: string[] = [];
  let lastUsage: TokenUsage | undefined;

  for await (const line of rl) {
    try {
      const obj = JSON.parse(line) as TranscriptMessage & { summary?: string; aiTitle?: string; isMeta?: boolean };
      if (obj.type === 'user' || obj.type === 'assistant') {
        // Deduplicate: skip user messages with identical content within 1s of the previous one
        // (SDK resume + prompt may write duplicate user entries)
        if (obj.type === 'user' && rawMessages.length > 0) {
          const prev = rawMessages[rawMessages.length - 1];
          if (
            prev.type === 'user' &&
            prev.timestamp && obj.timestamp &&
            Math.abs(new Date(obj.timestamp).getTime() - new Date(prev.timestamp).getTime()) < 1000 &&
            JSON.stringify(prev.message?.content) === JSON.stringify(obj.message?.content)
          ) {
            continue; // skip duplicate
          }
        }
        rawMessages.push(obj);

        // Collect the usage of the last assistant message
        if (obj.type === 'assistant' && obj.message?.usage) {
          lastUsage = obj.message.usage;
        }

        // Collect user text messages for title generation. Exclude harness-injected
        // messages: `isMeta` (skill/image/compact) and `origin.kind` (task-notification,
        // etc.) — only 'human'-origin/unstamped turns are real user input.
        if (
          obj.type === 'user' &&
          !obj.isMeta &&
          !obj.isCompactSummary &&
          (!obj.origin?.kind || obj.origin.kind === 'human') &&
          obj.message?.content
        ) {
          const content = obj.message.content;
          if (typeof content === 'string') {
            userTextMessages.push(content);
          } else if (Array.isArray(content)) {
            const textBlocks = content.filter((b) => b.type === 'text');
            for (const block of textBlocks) {
              if (block.text) userTextMessages.push(block.text);
            }
          }
        }
      }
      // Collect the aiTitle line (cockpit/SDK runtime; stable single value, last wins)
      if (obj.type === 'ai-title' && obj.aiTitle) {
        aiTitle = obj.aiTitle;
      }
      // Collect summary
      if (obj.type === 'summary' && obj.summary) {
        summary = obj.summary;
      }
    } catch {
      // Ignore lines with parse errors
    }
  }

  // Convert message format (full set)
  const allMessages = convertToChatMessages(rawMessages);
  const title = generateTitle(aiTitle, summary, userTextMessages);

  // Count turns: one turn = one user message + the corresponding assistant message
  // Simplified here: each user message starts a new turn
  const turns: ChatMessage[][] = [];
  let currentTurn: ChatMessage[] = [];

  for (const msg of allMessages) {
    if (msg.role === 'user') {
      if (currentTurn.length > 0) {
        turns.push(currentTurn);
      }
      currentTurn = [msg];
    } else {
      currentTurn.push(msg);
    }
  }
  if (currentTurn.length > 0) {
    turns.push(currentTurn);
  }

  const totalTurns = turns.length;

  // If there are no pagination params, return all messages
  if (limit === undefined) {
    return { messages: allMessages, title, usage: lastUsage, totalTurns, hasMore: false };
  }

  // Pagination logic: take `limit` turns going back from beforeTurnIndex
  const endIndex = beforeTurnIndex !== undefined ? beforeTurnIndex : totalTurns;
  const startIndex = Math.max(0, endIndex - limit);
  const hasMore = startIndex > 0;

  // Extract the specified range of turns and flatten into a message array
  const selectedTurns = turns.slice(startIndex, endIndex);
  const messages = selectedTurns.flat();

  return { messages, title, usage: lastUsage, totalTurns, hasMore };
}

// Plain text of a user message, whether string- or block-form.
function messageText(msg: TranscriptMessage): string {
  const c = msg.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');
  return '';
}

// The harness-injection kind of a user message, or null if it's a real user turn.
// A real user turn has no `isMeta` and no non-'human' `origin.kind`.
//   - 'skill': a skill body loaded by a tool call (folded into that call, not shown here)
//   - 'task-notification' / 'meta': rendered as a muted system-event bar
function injectionKind(msg: TranscriptMessage): 'skill' | 'task-notification' | 'meta' | null {
  if (msg.isMeta && msg.sourceToolUseID) return 'skill';
  if (msg.origin?.kind === 'task-notification') return 'task-notification';
  if (msg.origin?.kind && msg.origin.kind !== 'human') return 'meta';
  if (msg.isMeta) return 'meta';
  if (msg.isCompactSummary) return 'meta'; // context-compaction continuation notice (no isMeta on some versions)
  return null;
}

// Build a muted system-event row from an injected message (task-notification / meta).
function buildSystemEvent(msg: TranscriptMessage, kind: 'task-notification' | 'meta'): ChatMessage | null {
  const raw = messageText(msg);
  if (kind === 'task-notification') {
    const summary = raw.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim();
    const status = raw.match(/<status>([\s\S]*?)<\/status>/)?.[1]?.trim();
    return {
      id: msg.uuid || `sysevent-${Date.now()}`,
      role: 'system',
      content: summary || raw.trim().slice(0, 200),
      timestamp: msg.timestamp,
      systemEvent: { kind: 'task-notification', detail: raw.trim(), ...(status ? { status } : {}) },
    };
  }
  const text = raw.trim();
  if (!text) return null;
  return {
    id: msg.uuid || `sysevent-${Date.now()}`,
    role: 'system',
    content: text,
    timestamp: msg.timestamp,
    systemEvent: { kind: 'meta' },
  };
}

function convertToChatMessages(rawMessages: TranscriptMessage[]): ChatMessage[] {
  const chatMessages: ChatMessage[] = [];
  let currentAssistantMessage: ChatMessage | null = null;
  const toolResults = new Map<string, string>();
  // Skill bodies, keyed by the tool call (sourceToolUseID) that loaded them — folded
  // into that tool call instead of being rendered as a user bubble.
  const skillContents = new Map<string, string>();

  // First pass: collect all tool results + skill bodies
  for (const msg of rawMessages) {
    if (msg.type === 'user' && msg.message?.content && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          toolResults.set(block.tool_use_id, block.content || '');
        }
      }
    }
    if (msg.type === 'user' && injectionKind(msg) === 'skill' && msg.sourceToolUseID) {
      const text = messageText(msg);
      if (text) skillContents.set(msg.sourceToolUseID, text);
    }
  }

  // Second pass: build the message list
  for (const msg of rawMessages) {
    // Handle user text messages
    if (msg.type === 'user' && msg.message?.role === 'user' && msg.message?.content) {
      // Route harness-injected messages out of the user-bubble bucket.
      const injected = injectionKind(msg);
      if (injected) {
        // Skill bodies are folded into their originating tool call (collected above).
        // task-notification / meta become a muted system-event row.
        if (injected !== 'skill') {
          const ev = buildSystemEvent(msg, injected);
          if (ev) {
            if (currentAssistantMessage) {
              chatMessages.push(currentAssistantMessage);
              currentAssistantMessage = null;
            }
            chatMessages.push(ev);
          }
        }
        continue;
      }
      const content = msg.message.content;
      if (typeof content === 'string') {
        if (currentAssistantMessage) {
          chatMessages.push(currentAssistantMessage);
          currentAssistantMessage = null;
        }

        const userMessage: ChatMessage = {
          id: msg.uuid || `user-${Date.now()}`,
          role: 'user',
          content: content,
          timestamp: msg.timestamp,
        };
        chatMessages.push(userMessage);
        continue;
      }

      if (!Array.isArray(content)) continue;

      const textBlocks = content.filter((b) => b.type === 'text');
      const imageBlocks = content.filter((b) => b.type === 'image' && b.source);

      if (textBlocks.length > 0 || imageBlocks.length > 0) {
        if (currentAssistantMessage) {
          chatMessages.push(currentAssistantMessage);
          currentAssistantMessage = null;
        }

        const userMessage: ChatMessage = {
          id: msg.uuid || `user-${Date.now()}`,
          role: 'user',
          content: textBlocks.map((b) => b.text || '').join('\n'),
          timestamp: msg.timestamp,
        };

        if (imageBlocks.length > 0) {
          userMessage.images = imageBlocks.map((b) => ({
            type: 'base64' as const,
            media_type: (b.source?.media_type || 'image/png') as MessageImage['media_type'],
            data: b.source?.data || '',
          }));
        }

        chatMessages.push(userMessage);
      }
    }

    // Handle assistant messages
    if (msg.type === 'assistant' && msg.message?.content) {
      const content = msg.message.content;
      if (!Array.isArray(content)) continue;

      const textBlocks = content.filter((b) => b.type === 'text');
      const toolBlocks = content.filter((b) => b.type === 'tool_use');

      if (textBlocks.length > 0) {
        if (currentAssistantMessage) {
          currentAssistantMessage.content += textBlocks.map((b) => b.text || '').join('\n');
        } else {
          currentAssistantMessage = {
            id: msg.uuid || `assistant-${Date.now()}`,
            role: 'assistant',
            content: textBlocks.map((b) => b.text || '').join('\n'),
            timestamp: msg.timestamp,
            toolCalls: [],
          };
        }
      }

      if (toolBlocks.length > 0) {
        if (!currentAssistantMessage) {
          currentAssistantMessage = {
            id: msg.uuid || `assistant-${Date.now()}`,
            role: 'assistant',
            content: '',
            timestamp: msg.timestamp,
            toolCalls: [],
          };
        }

        for (const tool of toolBlocks) {
          if (tool.name && tool.id) {
            currentAssistantMessage.toolCalls!.push({
              id: tool.id,
              name: tool.name,
              input: tool.input || {},
              result: toolResults.get(tool.id),
              isLoading: false,
              ...(skillContents.has(tool.id) ? { skillContent: skillContents.get(tool.id) } : {}),
            });
          }
        }
      }
    }
  }

  if (currentAssistantMessage) {
    chatMessages.push(currentAssistantMessage);
  }

  return chatMessages;
}
