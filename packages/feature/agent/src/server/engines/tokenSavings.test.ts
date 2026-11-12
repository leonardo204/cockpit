import { describe, it, expect } from 'vitest';
import {
  MemoryStore,
  runTurn,
  buildQueryOptions,
  buildAgentPrompt,
  renderPrompt,
  planSdkResume,
  parseSdkResumeState,
  sdkResumeStateFor,
  withoutSubagentRows,
  REPLAYED_TOOL_OUTPUT_MAX_CHARS,
  type EngineEvent,
  type EngineRunInput,
  type RuntimeMessage,
} from '../../../../../../../dist/naby-runtime.mjs';

/**
 * WHY A NABY SESSION SPENT FAR MORE THAN THE SAME WORK IN CLAUDE CODE, and the
 * four fixes for it (v1.48.25):
 *   1. resume the Agent SDK session instead of replaying the transcript as text;
 *   2. leave a subagent's internal rows out of the replay, and clip old outputs;
 *   3. store the typed `/command`, not its expanded body, as the user row;
 *   4. background calls run toolless (and on Sonnet — pinned in reflection).
 */

const CWD = '/tmp/project';
const SID = '0f6c2a1e-1111-4222-8333-944455556666';

function turn(user: string, at: number, answer = 'ok'): RuntimeMessage[] {
  return [
    { role: 'user', content: user, at },
    { role: 'assistant', content: answer },
  ];
}

describe('1. resume — only when the saved handle provably continues this transcript', () => {
  const first: RuntimeMessage[] = [{ role: 'user', content: 'hello', at: 1 }];
  const saved = parseSdkResumeState(sdkResumeStateFor(first, { sdkSessionId: SID, cwd: CWD }));

  it('resumes the next turn of the same conversation', () => {
    const next: RuntimeMessage[] = [...turn('hello', 1), { role: 'user', content: 'and now?', at: 2 }];
    expect(planSdkResume(next, saved, { cwd: CWD })).toBe(SID);
  });

  it('replays when another turn was answered in between (e.g. by another engine)', () => {
    const next: RuntimeMessage[] = [
      ...turn('hello', 1),
      ...turn('on another engine', 2),
      { role: 'user', content: 'and now?', at: 3 },
    ];
    expect(planSdkResume(next, saved, { cwd: CWD })).toBeUndefined();
  });

  it('replays when the answered row is gone or changed', () => {
    const next: RuntimeMessage[] = [...turn('edited', 9), { role: 'user', content: 'and now?', at: 2 }];
    expect(planSdkResume(next, saved, { cwd: CWD })).toBeUndefined();
  });

  it('replays on another project or another Claude account', () => {
    const next: RuntimeMessage[] = [...turn('hello', 1), { role: 'user', content: 'and now?', at: 2 }];
    expect(planSdkResume(next, saved, { cwd: '/tmp/other' })).toBeUndefined();
    expect(planSdkResume(next, saved, { cwd: CWD, accountId: 'acct-2' })).toBeUndefined();
  });

  it('replays when participants are in the room', () => {
    const next: RuntimeMessage[] = [
      ...turn('hello', 1),
      { role: 'user', content: 'brief', at: 2, speaker: { kind: 'naby', name: 'naby', agentId: 'n' } as never },
    ];
    expect(planSdkResume(next, saved, { cwd: CWD })).toBeUndefined();
  });

  it('refuses a malformed or unsafe handle', () => {
    expect(parseSdkResumeState('not json')).toBeUndefined();
    expect(parseSdkResumeState(JSON.stringify({ v: 1, sdkSessionId: '../../etc', cwd: CWD, coveredLen: 1, lastUser: 'x' }))).toBeUndefined();
  });

  it('sends only the new message when resuming, the whole history otherwise', () => {
    const msgs: RuntimeMessage[] = [...turn('hello', 1), { role: 'user', content: 'and now?', at: 2 }];
    expect(buildAgentPrompt(msgs, undefined, true)).toBe('and now?');
    expect(buildAgentPrompt(msgs)).toContain('<conversation_history>');
  });

  it('passes `resume` to the SDK only when asked', () => {
    const base = {
      input: { model: { providerId: 'dev-claude' }, messages: [], toolSchemas: [] } as unknown as EngineRunInput,
      mcpServer: {} as never,
      preToolUse: (async () => ({})) as never,
      abortController: new AbortController(),
      onStderr: () => {},
    };
    expect(buildQueryOptions(base)).not.toHaveProperty('resume');
    expect(buildQueryOptions({ ...base, resume: SID })).toMatchObject({ resume: SID });
  });
});

describe('2. the replay leaves out a subagent’s working and clips old outputs', () => {
  const sub = { agentId: 'a1' };
  const history: RuntimeMessage[] = [
    { role: 'user', content: 'research this', at: 1 },
    { role: 'assistant', content: '', toolCalls: [{ toolCallId: 'task1', toolName: 'Task', input: {} }] },
    { role: 'assistant', content: '', toolCalls: [{ toolCallId: 'r1', toolName: 'Read', input: {}, subagent: sub }] },
    { role: 'tool', toolCallId: 'r1', toolName: 'Read', output: { content: 'SUBAGENT FILE BODY' } },
    { role: 'assistant', content: 'subagent musing', subagentToolCallId: 'task1' },
    { role: 'tool', toolCallId: 'task1', toolName: 'Task', output: { content: 'TASK RESULT' } },
    { role: 'assistant', content: 'final answer' },
    { role: 'user', content: 'next', at: 2 },
  ];

  it('keeps the Task call and its result, drops what happened inside it', () => {
    const kept = withoutSubagentRows(history);
    expect(kept.some((m) => m.role === 'tool' && m.toolCallId === 'r1')).toBe(false);
    expect(kept.some((m) => m.role === 'assistant' && m.content === 'subagent musing')).toBe(false);
    expect(kept.some((m) => m.role === 'tool' && m.toolCallId === 'task1')).toBe(true);
    const prompt = renderPrompt(history);
    expect(prompt).not.toContain('SUBAGENT FILE BODY');
    expect(prompt).toContain('TASK RESULT');
  });

  it('clips a long past tool output', () => {
    const big = 'x'.repeat(REPLAYED_TOOL_OUTPUT_MAX_CHARS * 5);
    const prompt = renderPrompt([
      { role: 'user', content: 'read it', at: 1 },
      { role: 'tool', toolCallId: 't', toolName: 'Read', output: { content: big } },
      { role: 'user', content: 'next', at: 2 },
    ]);
    expect(prompt.length).toBeLessThan(REPLAYED_TOOL_OUTPUT_MAX_CHARS * 2);
    expect(prompt).toContain('omitted from the replay');
  });
});

describe('3. the typed /command is stored, its expansion rides one turn', () => {
  it('stores the typed text and still sends the expansion to the engine', async () => {
    const store = new MemoryStore();
    const session = store.createSession('mock');
    const seen: RuntimeMessage[][] = [];
    const engine = {
      async *run(input: EngineRunInput): AsyncIterable<EngineEvent> {
        seen.push(input.messages);
        yield { kind: 'text', role: 'assistant', text: 'done' };
        yield { kind: 'result', ok: true };
      },
    };
    const common = {
      engine,
      store,
      sessionId: session.id,
      model: { providerId: 'mock' },
      toolSchemas: [],
      executors: {},
      gate: async () => ({ decision: 'allow' as const }),
    };
    const expanded = 'LONG SKILL BODY '.repeat(200) + '\n\nwrite the proposal';
    await runTurn({ ...common, userText: expanded, storedUserText: '/report-writer write the proposal' });
    await runTurn({ ...common, userText: 'shorter please' });

    const stored = store.getMessages(session.id).filter((m) => m.role === 'user');
    expect(stored.map((m) => m.content)).toEqual(['/report-writer write the proposal', 'shorter please']);
    // This turn: the engine got the expansion.
    expect(seen[0]!.at(-1)).toMatchObject({ role: 'user', content: expanded });
    // Next turn: the history carries the typed form only.
    expect(JSON.stringify(seen[1])).not.toContain('LONG SKILL BODY');
  });
});

describe('4. a background call carries no built-in tools', () => {
  it('sets `tools: []` only for a toolless engine', () => {
    const base = {
      input: { model: { providerId: 'dev-claude' }, messages: [], toolSchemas: [] } as unknown as EngineRunInput,
      mcpServer: {} as never,
      preToolUse: (async () => ({})) as never,
      abortController: new AbortController(),
      onStderr: () => {},
    };
    expect(buildQueryOptions(base)).not.toHaveProperty('tools');
    expect(buildQueryOptions({ ...base, toolless: true })).toMatchObject({ tools: [] });
  });
});
