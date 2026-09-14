/**
 * subagentModelWiring.test.ts — the run says which model served it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ASSERTED AGAINST THE SOURCE
 *
 * naby writes `haiku` on the `explorer` agent and `sonnet` on `implementer`
 * because cheapness is the reason those agents exist. It cannot INSIST: the
 * CLI's subagent-model resolution order has moved between versions, and
 * `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` beats every layer of it
 * (specs/subagent-delegation.md §2 rule 2). The design's answer is not to fight
 * the override but to make it visible — which is worth exactly as much as the
 * label actually reaching the screen.
 *
 * There is no React renderer in this suite, and the reducer tests already own
 * the data path. What is left is WIRING: that the block prints the model beside
 * the agent type, that the raw id survives as a tooltip when the tier word
 * replaces it, and that the id reaches the transcript modal's header through the
 * one row that can open it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { modelTierLabel } from './modelTierLabel';

const DIR = __dirname;

/** The source with comments stripped — this file's neighbours explain the very
 *  identifiers asserted below, and a naive scan would read prose as code. */
const read = (f: string) =>
  readFileSync(join(DIR, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

const BLOCK = read('SubagentBlock.tsx');
const TOOL_CALL = read('ToolCallModal.tsx');
const MODAL = read('SubagentTranscriptModal.tsx');

describe('the block’s title', () => {
  it('appends the model to `Subagent · <type>`', () => {
    expect(BLOCK).toContain("import { modelTierLabel } from './modelTierLabel'");
    expect(BLOCK).toContain('const modelLabel = modelTierLabel(group.model);');
    expect(BLOCK).toMatch(/\{modelLabel && ` · \$\{modelLabel\}`\}/);
  });

  it('keeps the RAW id in the tooltip, since the tier word is a summary', () => {
    // `claude-haiku-4-5-20251001` reads as `haiku`; when the tier is a surprise
    // the exact build is the next question, and it must not have been thrown
    // away to shorten a line.
    expect(BLOCK).toMatch(/title=\{group\.model\}/);
  });

  it('shows it even when the run has no agent type', () => {
    // The label is a SIBLING of the title expression, not part of the
    // `agentType` branch — a run reported with no type still says what ran it.
    const titleBlock = BLOCK.slice(BLOCK.indexOf('const title ='), BLOCK.indexOf('const modelLabel'));
    expect(titleBlock).not.toContain('modelLabel');
  });
});

describe('the transcript modal’s header', () => {
  it('is given the model by the row that opens the run', () => {
    // Only the LAUNCHER opens this run's transcript, so only it carries the id.
    expect(BLOCK).toMatch(
      /subagentModel=\{toolCall\.id === group\.parentCall\?\.id \? group\.model : undefined\}/,
    );
    expect(TOOL_CALL).toContain('subagentModel?: string;');
    expect(TOOL_CALL).toContain('model={subagentModel}');
  });

  it('puts it in the subtitle, between who ran and what it was asked', () => {
    expect(MODAL).toContain('const modelLabel = modelTierLabel(model);');
    expect(MODAL).toContain("[meta?.agentType, modelLabel, description].filter(Boolean).join(' · ')");
    // …with the raw id still reachable, as in the block.
    expect(MODAL).toMatch(/title=\{model \? `\$\{subtitle\}\\n\$\{model\}` : subtitle\}/);
  });
});

describe('what the label actually says', () => {
  it('is the tier for a Claude id and the id itself for anything else', () => {
    // The one line a reader of the block cares about, restated where the wiring
    // is: a cheap agent served by opus must LOOK different.
    expect(modelTierLabel('claude-haiku-4-5-20251001')).toBe('haiku');
    expect(modelTierLabel('claude-opus-5[1m]')).toBe('opus');
    expect(modelTierLabel('some-gateway/alias-9')).toBe('some-gateway/alias-9');
    expect(modelTierLabel(undefined)).toBe('');
  });
});
