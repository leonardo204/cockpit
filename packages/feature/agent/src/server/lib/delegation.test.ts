import { describe, it, expect } from 'vitest';
import {
  DELEGATE_TOOL_NAME,
  type Executor,
  type SubagentSpec,
  type ToolSchema,
} from '../../../../../../../dist/naby-runtime.mjs';
import { restrictToolset } from './delegation';

/**
 * `toolRefs` NARROWING — and the spelling mismatch that made it narrow to nothing.
 *
 * A subagent file writes an MCP tool the way Claude Code names it
 * (`mcp__cic__find_docs`); naby names the same tool `cic__find_docs`. Compared
 * literally the two sets do not intersect, and the result is not an error but a
 * subagent with an EMPTY toolset that still runs and still answers — with its own
 * failure. `confluence-researcher`, whose only four tools are cic's, is exactly
 * that case, so these are the tests that keep the built-in bundle honest.
 */

const noop: Executor = async () => ({ content: '' });

function schema(name: string): ToolSchema {
  return { name, description: name, parameters: { type: 'object', properties: {} } };
}

const TURN_TOOLS = ['Read', 'Bash', 'cic__find_docs', 'cic__read_section', 'skill-hub__list'];

function restrict(toolRefs?: string[]) {
  const spec: SubagentSpec = {
    name: 'confluence-researcher',
    systemPrompt: 'research',
    ...(toolRefs ? { toolRefs } : {}),
  };
  const schemas = [...TURN_TOOLS.map(schema), schema(DELEGATE_TOOL_NAME)];
  const executors: Record<string, Executor> = {};
  for (const t of [...TURN_TOOLS, DELEGATE_TOOL_NAME]) executors[t] = noop;
  const out = restrictToolset(spec, schemas, executors);
  return { names: out.toolSchemas.map((t) => t.name), executors: Object.keys(out.executors) };
}

describe('restrictToolset', () => {
  it('inherits the turn tools when the spec names none — minus naby_delegate', () => {
    const { names, executors } = restrict();
    expect(names).toEqual(TURN_TOOLS);
    expect(executors).toEqual(TURN_TOOLS);
  });

  it('strips naby_delegate even when the spec asks for it', () => {
    // The parent's delegate executor carries the parent's depth; re-offering it
    // would let a subagent recurse past the cap.
    const { names, executors } = restrict([DELEGATE_TOOL_NAME, 'Read']);
    expect(names).toEqual(['Read']);
    expect(executors).toEqual(['Read']);
  });

  it("resolves Claude's mcp__<server>__<tool> spelling onto naby's names", () => {
    const { names, executors } = restrict([
      'mcp__cic__find_docs',
      'mcp__cic__read_section',
      'mcp__cic__search_cql',
      'mcp__cic__read_page',
    ]);
    // The two that exist this turn are kept; the two the server did not offer
    // simply are not there. Before the fix this list was EMPTY.
    expect(names).toEqual(['cic__find_docs', 'cic__read_section']);
    expect(executors).toEqual(['cic__find_docs', 'cic__read_section']);
  });

  it('accepts naby\'s own spelling too, so a hand-written spec is not punished', () => {
    expect(restrict(['cic__find_docs']).names).toEqual(['cic__find_docs']);
  });

  it('reads a two-segment mcp__<server> ref as the whole server', () => {
    expect(restrict(['mcp__cic']).names).toEqual(['cic__find_docs', 'cic__read_section']);
  });

  it('keeps plain built-in names exact', () => {
    expect(restrict(['Read']).names).toEqual(['Read']);
    // Only the prefix WITH its separator is recognised, so a tool whose own name
    // merely starts with those letters is never cut.
    expect(restrict(['mcp__cic']).names).not.toContain('skill-hub__list');
  });

  it('never widens: a ref the turn does not have conjures nothing', () => {
    expect(restrict(['mcp__cic__find_docs', 'Write', 'mcp__atlassian__search']).names).toEqual([
      'cic__find_docs',
    ]);
  });

  it('narrows to nothing when every ref is unknown, rather than falling back to all', () => {
    // Silent widening would be far worse than an empty set: a subagent meant for
    // four read-only tools would inherit Bash.
    expect(restrict(['mcp__nope__nothing']).names).toEqual([]);
  });

  it('ignores blank entries in a comma-split list', () => {
    expect(restrict(['', '  ', 'mcp__cic__find_docs']).names).toEqual(['cic__find_docs']);
  });
});
