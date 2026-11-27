import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MemoryStore,
  type EngineEvent,
  type EngineRunInput,
  type ToolSchema,
} from '../../../../../../../dist/naby-runtime.mjs';
import { ASIDE_USAGE_BLOCK, ASIDE_USAGE_HEADING, asideUsageNote, hasAsideTools, withAsideUsage } from './asideUsage';
import { runNestedTurn } from './delegation';

/**
 * THE ASIDE TOOLS: EXEC FIRST, REPL ONLY FOR THE DOM (2026-11-27).
 *
 * Field report: work given to @aside through naby came out worse than the same
 * work given to the Aside browser directly. The participant made 1,747 `repl`
 * calls (the model driving pages with Playwright code) and 23 `exec` calls (the
 * Aside agent itself). Aside's own guide says exec is the default.
 */

describe('the block', () => {
  it('is there exactly when the toolset holds an Aside tool', () => {
    expect(hasAsideTools(['Read', 'aside__repl'])).toBe(true);
    expect(hasAsideTools(['mcp__aside__exec'])).toBe(true);
    expect(hasAsideTools(['Read', 'atlassian__search', 'asideNote'])).toBe(false);
    expect(asideUsageNote(['aside__exec', 'aside__repl'])).toBe(ASIDE_USAGE_BLOCK);
    expect(asideUsageNote(['Bash'])).toBeUndefined();
  });

  it('says exec by default, repl only for the DOM or a screenshot, and that exec needs a full brief', () => {
    expect(ASIDE_USAGE_BLOCK.startsWith(ASIDE_USAGE_HEADING)).toBe(true);
    expect(ASIDE_USAGE_BLOCK).toContain('Use it by default for browser work');
    expect(ASIDE_USAGE_BLOCK).toMatch(/repl.*only when you must inspect the DOM or a screenshot/);
    expect(ASIDE_USAGE_BLOCK).toContain('exec does not see this conversation');
    expect(ASIDE_USAGE_BLOCK).toContain("the user's own request in their words");
    expect(ASIDE_USAGE_BLOCK).toContain('session_id');
  });

  it('is appended once, and only when present', () => {
    const once = withAsideUsage('You are a reviewer.', true)!;
    expect(once).toBe(`You are a reviewer.\n\n${ASIDE_USAGE_BLOCK}`);
    expect(withAsideUsage(once, true)).toBe(once);
    expect(withAsideUsage('You are a reviewer.', false)).toBe('You are a reviewer.');
    expect(withAsideUsage(undefined, true)).toBe(ASIDE_USAGE_BLOCK);
    expect(withAsideUsage(undefined, false)).toBeUndefined();
  });
});

describe('a nested run (naby_delegate, the review loop)', () => {
  const run = async (tools: string[]) => {
    const seen: EngineRunInput[] = [];
    const engine = {
      async *run(input: EngineRunInput): AsyncIterable<EngineEvent> {
        seen.push(input);
        yield { kind: 'text', role: 'assistant', text: 'done' } as EngineEvent;
        yield { kind: 'result', ok: true } as EngineEvent;
      },
    };
    const schemas = tools.map((name) => ({ name, description: name, inputSchema: { type: 'object' } }) as unknown as ToolSchema);
    await runNestedTurn(
      {
        store: new MemoryStore(),
        engine,
        model: { providerId: 'mock' },
        gate: async () => ({ decision: 'allow' as const }),
        toolSchemas: schemas,
        executors: Object.fromEntries(tools.map((n) => [n, async () => ({ content: '' })])),
        signal: new AbortController().signal,
      } as never,
      { spec: { name: 'researcher', systemPrompt: 'You research.' }, task: 'check the page' },
    );
    return seen[0]?.system;
  };

  it('is told how to use the Aside tools when it is given them', async () => {
    expect(await run(['aside__exec', 'aside__repl'])).toBe(`You research.\n\n${ASIDE_USAGE_BLOCK}`);
  });

  it('is not told anything about them otherwise', async () => {
    expect(await run(['fetch_url'])).toBe('You research.');
  });
});

describe('the turn wires it (source facts)', () => {
  const src = readFileSync(join(__dirname, '../engines/naby.ts'), 'utf8');

  it("naby's own system prompt carries it when the turn's toolset holds the Aside tools", () => {
    expect(src).toContain('asideUsageNote(toolSchemas.map((t) => t.name)),');
  });

  it("a participant's speech carries it when that speech is offered them", () => {
    const start = src.indexOf('composeParticipantSystem(');
    const block = src.slice(start, src.indexOf(".join('\\n\\n');", start));
    expect(block).toContain('asideUsageNote(pSchemas.map((t) => t.name))');
  });

  it('a native subagent carries it when the Aside server is connected', () => {
    expect(src).toMatch(/e\.name === ASIDE_SERVER_NAME && isMcpEntryActive\(e\)/);
    expect(src).toContain('withAsideUsage(withRules, subagentAside)');
  });
});
