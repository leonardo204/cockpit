import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MemoryStore,
  USER_INSTRUCTIONS_FULL_EVERY,
  USER_INSTRUCTIONS_HEADING,
  USER_INSTRUCTIONS_KEY,
  delegatedInstructionsBlock,
  userInstructionsBlock,
  userInstructionsReminder,
  withDelegatedInstructions,
  type EngineEvent,
  type EngineRunInput,
} from '../../../../../../../dist/naby-runtime.mjs';
import { runNestedTurn } from './delegation';

/**
 * THE USER'S STANDING INSTRUCTIONS IN A LONG SESSION, AND FOR EVERYONE NABY PUTS
 * TO WORK (2026-11-26).
 *
 * Field report: "공통 시스템 지침을 설정에서 넣어놨는데 세션이 길어지면 간혹 잊어버린다."
 * Two causes. (1) The block sat only at the end of the system prompt — the
 * START of a context that runs to 450k–900k tokens in a long session — while
 * this turn's own context rides next to the newest message. (2) Participants,
 * delegated subagents and the review loop never received the block at all.
 */

const RULES = '항상 한국어로 답한다.\n명령은 실행 전에 보여 준다.';

describe('the reminder next to the newest message', () => {
  it('says nothing without instructions or on the first turn', () => {
    expect(userInstructionsReminder('', 5)).toBeUndefined();
    expect(userInstructionsReminder(RULES, 1)).toBeUndefined();
  });

  it('is a one-line pointer on most turns', () => {
    const r = userInstructionsReminder(RULES, 2)!;
    expect(r).toContain("standing instructions");
    expect(r).not.toContain(RULES);
    expect(r.split('\n')).toHaveLength(1);
  });

  it(`repeats the full text every ${USER_INSTRUCTIONS_FULL_EVERY} user turns`, () => {
    const full = userInstructionsReminder(RULES, USER_INSTRUCTIONS_FULL_EVERY)!;
    expect(full).toContain(RULES);
    expect(full.startsWith(USER_INSTRUCTIONS_HEADING)).toBe(true);
    expect(userInstructionsReminder(RULES, USER_INSTRUCTIONS_FULL_EVERY * 3)).toContain(RULES);
    expect(userInstructionsReminder(RULES, USER_INSTRUCTIONS_FULL_EVERY + 1)).not.toContain(RULES);
  });
});

describe('the block for participants, subagents, reviewers and fixers', () => {
  it('carries the text verbatim and says it applies to the reader too', () => {
    const b = delegatedInstructionsBlock(RULES)!;
    expect(b.startsWith(USER_INSTRUCTIONS_HEADING)).toBe(true);
    expect(b).toContain(RULES);
    expect(b).toContain('that includes you');
    expect(b).toContain('do not lift safety rules');
    expect(delegatedInstructionsBlock('  ')).toBeUndefined();
  });

  it('is appended once — a prompt that already carries the block is left alone', () => {
    const once = withDelegatedInstructions('You are a reviewer.', RULES)!;
    expect(once.startsWith('You are a reviewer.\n\n')).toBe(true);
    expect(withDelegatedInstructions(once, RULES)).toBe(once);
    // naby's own block has the same heading, so a prompt built from it is not doubled either.
    expect(withDelegatedInstructions(userInstructionsBlock(RULES), RULES)).toBe(userInstructionsBlock(RULES));
    expect(withDelegatedInstructions('x', '')).toBe('x');
  });
});

describe('a nested run (naby_delegate, the review loop) receives them', () => {
  const run = async (stored: string | undefined) => {
    const store = new MemoryStore();
    if (stored !== undefined) store.setSetting(USER_INSTRUCTIONS_KEY, stored);
    const seen: EngineRunInput[] = [];
    const engine = {
      async *run(input: EngineRunInput): AsyncIterable<EngineEvent> {
        seen.push(input);
        yield { kind: 'text', role: 'assistant', text: 'done' } as EngineEvent;
        yield { kind: 'result', ok: true } as EngineEvent;
      },
    };
    const res = await runNestedTurn(
      {
        store,
        engine,
        model: { providerId: 'mock' },
        gate: async () => ({ decision: 'allow' as const }),
        toolSchemas: [],
        executors: {},
        signal: new AbortController().signal,
      } as never,
      { spec: { name: 'reviewer', systemPrompt: 'You are a reviewer.' }, task: 'review a.ts' },
    );
    return { res, system: seen[0]?.system };
  };

  it('appends the block after the subagent prompt', async () => {
    const { res, system } = await run(RULES);
    expect(res.ok).toBe(true);
    expect(system!.startsWith('You are a reviewer.')).toBe(true);
    expect(system).toContain(USER_INSTRUCTIONS_HEADING);
    expect(system).toContain(RULES);
  });

  it('leaves the prompt as it was when there are none', async () => {
    const { system } = await run(undefined);
    expect(system).toBe('You are a reviewer.');
  });
});

describe('the turn wires them (source facts)', () => {
  const src = readFileSync(join(__dirname, '../engines/naby.ts'), 'utf8');

  it("the reminder rides in the turn's own context, beside the org hooks' block", () => {
    expect(src).toMatch(/\[orgHookBlock, instructionsReminder\]\.filter\(Boolean\)/);
    // Counted in the user's own messages, this one included.
    expect(src).toMatch(/filter\(\(m\) => isUserAuthored\(m\)\)\.length \+ 1/);
  });

  it("a participant's system prompt carries them, after its own", () => {
    const start = src.indexOf('composeParticipantSystem(');
    const block = src.slice(start, src.indexOf(".join('\\n\\n');", start));
    expect(block).toContain('withDelegatedInstructions(undefined, userInstructionsText)');
  });

  it("every subagent given to the engine (native SDK agents too) carries them", () => {
    expect(src).toMatch(/withDelegatedInstructions\(s\.systemPrompt, subagentInstructions\)/);
    expect(src).toContain('const turnSubagents = gatherSubagents(store, projectCwd, engineId).map(');
  });
});
