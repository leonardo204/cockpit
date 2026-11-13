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
  renderResumePrompt,
  splitSystem,
  splitSystemFor,
  withTurnContext,
  resumeKeyFor,
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

  it('resumes with participants in the room (v1.48.27)', () => {
    const next: RuntimeMessage[] = [
      ...turn('hello', 1),
      { role: 'user', content: 'brief', at: 2, speaker: { name: 'naby', agentId: 'n' } as never },
    ];
    expect(planSdkResume(next, saved, { cwd: CWD })).toBe(SID);
  });

  it('resumes across other speakers\u2019 lines, and sends them with the new message', () => {
    const next: RuntimeMessage[] = [
      ...turn('hello', 1, 'my own answer'),
      { role: 'user', content: 'over to aside', at: 2, speaker: { name: 'naby', agentId: 'n' }, routing: { kind: 'delegate', targetAgentId: 'a' } } as never,
      { role: 'user', content: '[@aside] I opened the six pages', speaker: { name: 'aside', agentId: 'a' } } as never,
      { role: 'user', content: '@aside has answered the user. Add only what is missing.', at: 3, speaker: { name: 'naby', agentId: 'n' }, routing: { kind: 'delegate', targetAgentId: 'n' } } as never,
    ];
    expect(planSdkResume(next, saved, { cwd: CWD })).toBe(SID);
    const prompt = renderResumePrompt(next, saved!.coveredLen);
    expect(prompt).toContain('<conversation_update>');
    expect(prompt).toContain('I opened the six pages');
    expect(prompt).toContain('over to aside');
    // Its own answer is already in the backend session: not sent again.
    expect(prompt).not.toContain('my own answer');
    expect(prompt).not.toContain('hello');
    expect(prompt.endsWith('@aside has answered the user. Add only what is missing.')).toBe(true);
  });

  it('replays when an answer it did not write follows another row', () => {
    const next: RuntimeMessage[] = [
      ...turn('hello', 1),
      { role: 'user', content: 'question for the other engine', at: 2 },
      { role: 'assistant', content: 'answered elsewhere' },
      { role: 'user', content: 'and now?', at: 3 },
    ];
    expect(planSdkResume(next, saved, { cwd: CWD })).toBeUndefined();
  });

  it('keeps one handle per seat', () => {
    expect(resumeKeyFor('s-1')).toBe('engine.resume.s-1');
    expect(resumeKeyFor('s-1', 'a-x/y')).toBe('engine.resume.s-1:a-x_y');
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

describe('5. the system prompt stays the same turn to turn (v1.48.27)', () => {
  it('splits off what was added for this turn', () => {
    expect(splitSystem('BASE', 'BASE\n\nMEMORY')).toEqual({ stable: 'BASE', turn: 'MEMORY' });
    expect(splitSystem('BASE', 'BASE')).toBeUndefined();
    expect(splitSystem(undefined, undefined)).toBeUndefined();
  });

  it('sends the stable part as the system prompt and the rest in the user message', () => {
    const input = {
      model: { providerId: 'dev-claude' },
      messages: [],
      toolSchemas: [],
      system: 'BASE\n\nMEMORY',
      systemParts: { stable: 'BASE', turn: 'MEMORY' },
    } as unknown as EngineRunInput;
    const opts = buildQueryOptions({
      input,
      mcpServer: {} as never,
      preToolUse: (async () => ({})) as never,
      abortController: new AbortController(),
      onStderr: () => {},
    });
    expect(opts).toMatchObject({ systemPrompt: 'BASE' });
    expect(splitSystemFor(input)).toBe(true);
    const prompt = buildAgentPrompt([{ role: 'user', content: 'hi' }], undefined, false, 'MEMORY');
    expect(prompt).toBe(withTurnContext('hi', 'MEMORY'));
    expect(prompt).toContain('<system-reminder>\nMEMORY\n</system-reminder>');
  });

  it('never leaves the SDK without a system prompt', () => {
    const input = { systemParts: { turn: 'MEMORY' } } as unknown as EngineRunInput;
    expect(splitSystemFor(input)).toBe(false);
  });

  it('runTurn hands the engine the split, and the full prompt on `system`', async () => {
    const store = new MemoryStore();
    const session = store.createSession('mock');
    const seen: EngineRunInput[] = [];
    const engine = {
      async *run(input: EngineRunInput): AsyncIterable<EngineEvent> {
        seen.push(input);
        yield { kind: 'result', ok: true };
      },
    };
    await runTurn({
      engine,
      store,
      sessionId: session.id,
      model: { providerId: 'mock' },
      toolSchemas: [],
      executors: {},
      gate: async () => ({ decision: 'allow' as const }),
      userText: 'hi',
      system: 'PERSONA',
      turnContext: 'HOOK OUTPUT',
    });
    expect(seen[0]!.system).toBe('PERSONA\n\nHOOK OUTPUT');
    expect(seen[0]!.systemParts).toEqual({ stable: 'PERSONA', turn: 'HOOK OUTPUT' });
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
