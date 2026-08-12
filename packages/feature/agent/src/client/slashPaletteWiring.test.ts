import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE WIRING BEHIND shared/slashTokens.ts.
 *
 * `slashTokens.test.ts` proves the rule to the last path/URL/date case, and
 * every one of those tests would still pass if nobody called it. What is
 * asserted here is the connection — and specifically the two ways the
 * mid-sentence bug could come back:
 *
 *   1. the composer re-deriving the anchor inline (which is how it drifted from
 *      `@` in the first place: a whole-line regex living in a `useMemo`, where no
 *      test could see it);
 *   2. a picked command row replacing the LINE again instead of its own span,
 *      which would delete the sentence around a mid-sentence pick.
 *
 * Source assertions rather than rendered ones, for the reason recorded in
 * composerHistoryWiring.test.ts: this suite has no DOM environment, so there is
 * nothing to mount.
 */

/** The `packages/` root — this file sits at packages/feature/agent/src/client. */
const ROOT = join(__dirname, '../../../..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const chatInput = read('feature/agent/src/client/ChatInput.tsx');
const nabyEngine = read('feature/agent/src/server/engines/naby.ts');

/** The body of `handleSelectCommand`, where the replaced span is decided. */
const handleSelectCommand = (() => {
  const start = chatInput.indexOf('const handleSelectCommand = useCallback(');
  expect(start, 'handleSelectCommand not found — did the composer get rewritten?').toBeGreaterThan(-1);
  const end = chatInput.indexOf('const handleKeyDown', start);
  expect(end, 'end of handleSelectCommand not found').toBeGreaterThan(start);
  return chatInput.slice(start, end);
})();

describe('ChatInput — the palette asks the shared rule where a `/` opens', () => {
  it('imports the shared anchor rather than re-deriving one inline', () => {
    expect(chatInput).toMatch(/from '\.\.\/shared\/slashTokens'/);
    expect(chatInput).toMatch(/findSlashQuery\(input, caret\)/);
  });

  it('keeps no line-anchored slash regex of its own', () => {
    // The old rule, in the shape it had: a `^`-anchored match on the caret's
    // line. Anything like it here means the two markers have drifted again.
    expect(chatInput).not.toMatch(/\/\^\\s\*\(\\\/\)/);
    expect(chatInput).not.toMatch(/const activeLine = useMemo/);
  });

  it('asks the SAME question for `@`, so the two markers cannot drift', () => {
    expect(chatInput).toMatch(/findMentionQuery\(input, caret\)/);
  });
});

describe('ChatInput — a picked row replaces its own span, never the line', () => {
  it('splices between the query span, for a mention and a command alike', () => {
    expect(handleSelectCommand).toMatch(/const span = isMention \? mentionQuery! : commandQuery/);
    expect(handleSelectCommand).toMatch(/const from = span\.start/);
    expect(handleSelectCommand).toMatch(/const to = span\.end/);
  });

  it('never reaches for the line bounds the old version replaced', () => {
    expect(handleSelectCommand).not.toMatch(/activeLine/);
  });

  it('inserts through the shared helper, so the trailing space is one decision', () => {
    expect(handleSelectCommand).toMatch(/slashInsertion\(command\.name\.slice\(1\)\)/);
  });
});

describe('naby engine — a named row is read from what the USER typed', () => {
  it('derives the named rows from the RAW prompt, not the expanded one', () => {
    // `ctx.prompt` has already been through resolveCommandPrompt, so a command
    // template that happens to contain `/foo` would name a row the user never
    // asked for. `ctx.params.prompt` is what was typed.
    expect(nabyEngine).toMatch(/namedHarnessRows\(/);
    expect(nabyEngine).toMatch(/ctx\.params\.prompt/);
    expect(nabyEngine).not.toMatch(/namedHarnessRows\(ctx\.prompt/);
  });

  it('hands them to the runtime as the turn\'s explicitly named rows', () => {
    expect(nabyEngine).toMatch(/explicitNames/);
  });
});
