import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE USER'S STANDING INSTRUCTIONS (specs/user-instructions.md).
 *
 * Through `runNabyAction` against the throwaway database vitest.setup.ts points
 * NABY_DB_PATH at — never ~/.naby/app.db. The orchestrator is mocked so nothing
 * here can start a model turn.
 */
vi.mock('../engines/orchestrator', () => ({
  dispatchChat: async () => ({ ok: false as const, status: 503, error: 'no engine in tests' }),
}));

import { runNabyAction } from './naby';
import { getStore } from '../engines/naby';
import {
  USER_INSTRUCTIONS_KEY,
  USER_INSTRUCTIONS_MAX_CHARS,
  readUserInstructions,
  userInstructionsBlock,
} from '../../../../../../../dist/naby-runtime.mjs';

describe('instructions.get / instructions.set', () => {
  it('saves trimmed text with normalised line endings and reads it back', async () => {
    const set = await runNabyAction({ action: 'instructions.set', text: '  Answer in Korean.\r\nShow the command first.\n\n' });
    expect(set.ok).toBe(true);
    expect(set.instructions).toBe('Answer in Korean.\nShow the command first.');
    expect(getStore().getSetting(USER_INSTRUCTIONS_KEY)).toBe('Answer in Korean.\nShow the command first.');

    const got = await runNabyAction({ action: 'instructions.get' });
    expect(got.ok).toBe(true);
    expect(got.instructions).toBe('Answer in Korean.\nShow the command first.');
    expect(got.instructionsMaxChars).toBe(USER_INSTRUCTIONS_MAX_CHARS);
  });

  it('refuses text over the cap instead of truncating it, and keeps what was there', async () => {
    await runNabyAction({ action: 'instructions.set', text: 'keep me' });
    const res = await runNabyAction({ action: 'instructions.set', text: 'x'.repeat(USER_INSTRUCTIONS_MAX_CHARS + 1) });
    expect(res.ok).toBe(false);
    expect(readUserInstructions(getStore())).toBe('keep me');
  });

  it('refuses a non-string', async () => {
    const res = await runNabyAction({ action: 'instructions.set', text: 42 as unknown as string });
    expect(res.ok).toBe(false);
  });

  it('an empty save clears them', async () => {
    await runNabyAction({ action: 'instructions.set', text: 'something' });
    const res = await runNabyAction({ action: 'instructions.set', text: '   ' });
    expect(res.ok).toBe(true);
    expect((await runNabyAction({ action: 'instructions.get' })).instructions).toBe('');
  });
});

describe('userInstructionsBlock', () => {
  it('injects nothing when there are no instructions', () => {
    expect(userInstructionsBlock('')).toBeUndefined();
    expect(userInstructionsBlock('   \n')).toBeUndefined();
    expect(userInstructionsBlock(undefined)).toBeUndefined();
  });

  it('carries the text verbatim under a heading that says it cannot lift the gate', () => {
    const block = userInstructionsBlock('Answer in Korean.')!;
    expect(block).toContain("## The user's standing instructions");
    expect(block).toContain('Answer in Korean.');
    expect(block).toMatch(/do not lift safety rules/);
  });
});

describe('the turn reads them', () => {
  // Source assertion: the turn system prompt is assembled inline in a 4k-line
  // adapter with no seam to call it in isolation. What matters is that the text
  // is read per turn (so a save applies on the next message) and that the block
  // is LAST — after the learned style line it must outrank.
  const src = readFileSync(join(__dirname, '../engines/naby.ts'), 'utf8');

  it('is read fresh on each turn', () => {
    expect(src).toMatch(/const userInstructionsText = readUserInstructions\(store\);/);
  });

  it('is the last block of the turn system prompt, after the style line', () => {
    const start = src.indexOf('const turnSystem =');
    const end = src.indexOf(".join('\\n\\n') || undefined;", start);
    const assembly = src.slice(start, end);
    const style = assembly.lastIndexOf('styleLine,');
    const user = assembly.indexOf('userInstructionsBlock(userInstructionsText)');
    expect(style).toBeGreaterThan(-1);
    expect(user).toBeGreaterThan(style);
    expect(assembly.slice(user)).toMatch(/^userInstructionsBlock\(userInstructionsText\) : undefined,\s*\]\s*\.filter\(Boolean\)\s*$/);
  });
});
