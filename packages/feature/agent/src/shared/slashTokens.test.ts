import { describe, it, expect } from 'vitest';
import {
  findSlashQuery,
  namedHarnessRows,
  slashInsertion,
  slashTokens,
} from './slashTokens';

// The bug this file exists for: `/plan-review` typed four words into a sentence
// offered no completion and, on send, meant nothing. Only a slash at the very
// start of the box did anything — while `@` had been mid-sentence-capable for
// as long as file mentions have existed.

describe('findSlashQuery — where the palette opens', () => {
  it('opens on a slash that starts the input (the behaviour that already worked)', () => {
    expect(findSlashQuery('/plan', 5)).toEqual({ start: 0, end: 5, verb: 'plan' });
  });

  it('opens on a bare slash, so the full list is one keystroke away', () => {
    expect(findSlashQuery('/', 1)).toEqual({ start: 0, end: 1, verb: '' });
  });

  it('OPENS MID-SENTENCE — the reported bug', () => {
    const input = '이 원천 기술을 조사을 /plan';
    expect(findSlashQuery(input, input.length)).toEqual({
      start: input.indexOf('/'),
      end: input.length,
      verb: 'plan',
    });
  });

  it('opens on a slash at the start of a later line of a multi-line draft', () => {
    const input = 'first line\n/plan';
    expect(findSlashQuery(input, input.length)).toEqual({
      start: 11,
      end: 16,
      verb: 'plan',
    });
  });

  it('lowercases the verb so matching is case-insensitive', () => {
    expect(findSlashQuery('do it with /Plan-Review', 23)?.verb).toBe('plan-review');
  });

  it('filters by what is typed BEFORE the caret, like the `@` mention query', () => {
    expect(findSlashQuery('/plan-review', 5)?.verb).toBe('plan');
  });

  // The one place this deliberately differs from `findMentionQuery`. The version
  // being replaced swapped the whole LINE, so clicking back into a half-typed
  // verb and picking a row rewrote the verb cleanly. Running the span to the end
  // of the token keeps that byte-for-byte, instead of stranding the tail.
  it('spans the whole token when the caret is parked inside a verb already written', () => {
    expect(findSlashQuery('/plan-review', 5)).toEqual({ start: 0, end: 12, verb: 'plan' });
    expect(findSlashQuery('use /plan and go', 7)).toEqual({
      start: 4,
      end: 9,
      verb: 'pl',
    });
  });

  // ── the part that is actually hard ──────────────────────────────────────
  // A `/` inside a word is never the harness. These are the three shapes people
  // type all day, and a palette that flickered open on them would be worse than
  // the bug being fixed.

  it('NEVER opens inside a relative path', () => {
    expect(findSlashQuery('look at src/foo', 15)).toBeNull();
    expect(findSlashQuery('packages/feature/agent', 22)).toBeNull();
  });

  it('NEVER opens inside an absolute path being typed after a directory name', () => {
    expect(findSlashQuery('open ~/naby/src', 15)).toBeNull();
  });

  it('NEVER opens inside a URL', () => {
    expect(findSlashQuery('see https://example.com/docs', 28)).toBeNull();
    expect(findSlashQuery('see https://', 12)).toBeNull();
    expect(findSlashQuery('see https:/', 11)).toBeNull();
  });

  it('NEVER opens inside a date', () => {
    expect(findSlashQuery('due 08/12', 9)).toBeNull();
    expect(findSlashQuery('due 2026/08/12', 14)).toBeNull();
  });

  it('NEVER opens inside a fraction or a unit', () => {
    expect(findSlashQuery('about 1/2 done', 9)).toBeNull();
    expect(findSlashQuery('12km/h', 6)).toBeNull();
  });

  it('closes once the token ends — a space starts the sentence body again', () => {
    expect(findSlashQuery('/plan and then', 14)).toBeNull();
    expect(findSlashQuery('/plan ', 6)).toBeNull();
  });

  it('closes when a second slash turns the token into a path', () => {
    expect(findSlashQuery('/src/foo', 8)).toBeNull();
  });

  it('closes on a character no verb may contain', () => {
    expect(findSlashQuery('/plan.md', 8)).toBeNull();
    expect(findSlashQuery('/plan_review', 12)).toBeNull();
  });

  it('is null when there is no slash at all', () => {
    expect(findSlashQuery('just a sentence', 15)).toBeNull();
  });

  it('does not open from a slash that sits after the caret', () => {
    expect(findSlashQuery('hello /plan', 5)).toBeNull();
  });
});

describe('slashInsertion — what a picked row writes over its own span', () => {
  it('writes the verb and a trailing space, so the sentence continues', () => {
    expect(slashInsertion('plan-review')).toBe('/plan-review ');
  });
});

describe('slashTokens — what a sent message names', () => {
  it('marks a slash that leads its line as line-led', () => {
    expect(slashTokens('/qa check this')).toEqual([
      { start: 0, end: 3, verb: 'qa', lineLed: true },
    ]);
  });

  it('allows leading whitespace on a line-led verb, exactly like the dispatcher', () => {
    expect(slashTokens('   /qa x')[0]).toMatchObject({ verb: 'qa', lineLed: true });
  });

  it('marks a mid-sentence slash as NOT line-led', () => {
    expect(slashTokens('please use /plan-review here')).toEqual([
      { start: 11, end: 23, verb: 'plan-review', lineLed: false },
    ]);
  });

  it('finds two adjacent tokens (the anchor character must not eat the next one)', () => {
    expect(slashTokens('use /a /b').map((t) => t.verb)).toEqual(['a', 'b']);
  });

  it('finds a line-led verb on a later line of a multi-line message', () => {
    const tokens = slashTokens('some preamble\n/qa the rest');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ verb: 'qa', lineLed: true });
  });

  it('ignores a slash inside a word', () => {
    expect(slashTokens('src/foo https://a.com/b 08/12')).toEqual([]);
  });

  it('ignores a verb that does not start with a letter (the dispatcher rule)', () => {
    expect(slashTokens('due /2026-plan')).toEqual([]);
    expect(slashTokens('use /-plan')).toEqual([]);
  });
});

describe('namedHarnessRows — the rows a turn explicitly asks for', () => {
  it('returns a mid-sentence name — the whole point', () => {
    expect(
      namedHarnessRows('이 원천 기술을 사용해서 자동 편집 툴에 대한 조사을 /plan-review 스킬로 해봐'),
    ).toEqual(['plan-review']);
  });

  it('EXCLUDES a line-led verb: the dispatcher already expanded that one', () => {
    expect(namedHarnessRows('/qa check this')).toEqual([]);
  });

  it('takes the mid-sentence names out of a message that also leads with a command', () => {
    expect(namedHarnessRows('/qa now do it with /plan-review please')).toEqual([
      'plan-review',
    ]);
  });

  it('de-duplicates, keeping the order they were written', () => {
    expect(namedHarnessRows('use /b then /a then /b again')).toEqual(['b', 'a']);
  });

  it('lowercases, so the harness lookup is case-insensitive', () => {
    expect(namedHarnessRows('run /Plan-Review on it')).toEqual(['plan-review']);
  });

  it('names nothing for a message full of paths, URLs and dates', () => {
    expect(
      namedHarnessRows('read src/foo.ts and https://example.com/a and ship it 08/12'),
    ).toEqual([]);
  });

  it('names nothing for an ordinary sentence', () => {
    expect(namedHarnessRows('just talk to me')).toEqual([]);
  });

  it('is stateless across calls (the shared global regex is reset each time)', () => {
    expect(namedHarnessRows('use /a')).toEqual(['a']);
    expect(namedHarnessRows('use /a')).toEqual(['a']);
  });
});
