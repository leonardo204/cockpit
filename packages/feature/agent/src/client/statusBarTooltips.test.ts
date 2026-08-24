import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import i18n from '../../../../shared/i18n/src/index';
import en from '../../../../shared/i18n/locales/en.json';
import ko from '../../../../shared/i18n/locales/ko.json';
import { cacheBreakdown } from './cacheBreakdown';

/**
 * EVERY FIGURE IN THE STATUS BAR EXPLAINS ITSELF ON HOVER.
 *
 * The row reads `5시간 21% · 7일 4% | 컨텍스트 28% | 턴 입력: 275,350 | 출력: 23,902 |
 * 캐시 적중: 75% | $2.9613`, and three of those figures — turn input, output and the
 * dollar amount — had no explanation at all. The plan chip, the gauge and the cache
 * stat had one; the rest were numbers you either already understood or did not.
 *
 * THESE ARE SOURCE AND DICTIONARY ASSERTIONS, not rendering ones, for the reason
 * this suite gives elsewhere: jsdom has no layout and no pointer, so a tooltip
 * cannot be hovered in a test. What is actually at risk is the wiring (a `title`
 * quietly dropped from a span) and the strings (a key added to en.json and
 * forgotten in ko.json, which reaches a Korean user as a raw key path).
 *
 * THE TOOLTIPS STAY NATIVE `title` ATTRIBUTES. Every hint already in this row is
 * one — both rate-limit spans, the gauge, the plan chip — and mixing the app's
 * `Tooltip` component into the same row would put a portal-rendered popover beside
 * four native ones, in a three-panel layout that clips.
 */

const BAR = join(__dirname, 'TokenUsageBar.tsx');
const src = readFileSync(BAR, 'utf8');

/** The `chat` section of a dictionary, read the way statusBarLabels.test.ts reads
 *  it — the JSON's inferred literal type is not worth carrying into an assertion. */
const chat = (dict: unknown): Record<string, string> =>
  (dict as { chat: Record<string, string> }).chat;

/** Every stat that had NO tooltip at all, by the testid its span now carries and
 *  the key its hint must be written in. */
const STATS: ReadonlyArray<{ testid: string; key: string }> = [
  { testid: 'turn-input-stat', key: 'chat.turnInputHint' },
  { testid: 'output-stat', key: 'chat.outputHint' },
  { testid: 'turn-cost-stat', key: 'chat.turnCostHint' },
];

describe('status bar tooltips — the figures that had none', () => {
  it.each(STATS)('$testid carries a native title through $key', ({ testid, key }) => {
    const span = new RegExp(`data-testid="${testid}"[\\s\\S]{0,600}?>`).exec(src)?.[0];
    expect(span, `${testid} markup not found — did the row change?`).toBeDefined();
    expect(span).toContain('title=');
    expect(span).toContain(`t('${key}'`);
  });

  it('leaves the visible row alone — this is hover text only', () => {
    // The figures themselves are untouched: the same sums, formatted the same way.
    // A tooltip is not a reason to move anything, and this row's height is what the
    // font-size guard measures against.
    expect(src).toContain("t('chat.turnInput')}: <strong");
    expect(src).toContain("t('chat.output')}: <strong");
    expect(src).toContain('{tokenUsage.totalCostUsd.toFixed(4)}');
  });

  it('explains the gauge before repeating it', () => {
    // The gauge DID have a title, but it was `293,384 / 200,000 · claude-opus-5` —
    // the number again, in a second notation. The sentence comes first now and the
    // raw pair follows it, so the tooltip answers "what is this" before "how big".
    expect(src).toContain("t('chat.contextWindowHint'");
    expect(src).toContain("t('chat.contextApproxHint'");
    expect(src).toContain('title={gaugeTitle()}');
  });
});

describe('the cache tooltip says what was hit, as far as that is knowable', () => {
  it('is built from the tested breakdown rather than assembled in JSX', () => {
    expect(src).toContain('cacheBreakdown(tokenUsage)');
    expect(src).toContain('title={cacheHitTitle()}');
    expect(src).toContain('...cache.lines.map(cacheLineText)');
    // The percentage and the counts are ONE derivation now. The inline arithmetic
    // that used to print the percentage is gone, so the tooltip cannot end up
    // explaining a different number than the one printed beside it.
    expect(src).toContain('{cache.percent}%');
    expect(src).not.toContain('cacheReadInputTokens / (tokenUsage.inputTokens');
    // Show-or-not moved into the helper with it.
    expect(src).toContain('{cache.show && (');
  });

  it('carries the three counts, each through i18next number formatting', () => {
    for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'cacheUncachedTokens']) {
      expect(src).toContain(`t('chat.${key}'`);
      // `{{tokens, number}}`, not `toLocaleString()` glued to a label: grouping then
      // follows the language the sentence is written in, and the line stays one
      // translatable unit instead of two fragments around a number.
      expect(chat(en)[key]).toContain('{{tokens, number}}');
      expect(chat(ko)[key]).toContain('{{tokens, number}}');
    }
  });

  it('formats a count through i18next in both languages rather than concatenating it', () => {
    // The formatter is exercised for real: `{{tokens, number}}` renders the raw
    // digits if the built-in formatter is ever unavailable, and `275350` beside a
    // row of grouped figures is the defect this asserts against. `getFixedT` rather
    // than `changeLanguage` — the i18n instance is a singleton the whole app shares.
    expect(i18n.getFixedT('en')('chat.cacheReadTokens', { tokens: 275350 })).toContain('275,350');
    expect(i18n.getFixedT('ko')('chat.cacheReadTokens', { tokens: 275350 })).toContain('275,350');
    expect(i18n.getFixedT('ko')('chat.cacheReadTokens', { tokens: 275350 })).toContain('캐시에서 읽음');
  });

  it('states the prefix composition as words and never as attribution', () => {
    // The request behind this feature — "tell me what was hit" — has a truthful half
    // and a fabricated one. The counts are measurement; naming WHICH blocks were
    // reused is not knowable from the four numbers the API reports, so the prefix's
    // composition is prose and says outright that the rest is not reported.
    expect(chat(en).cachePrefixNote).toContain('is not reported');
    expect(chat(ko).cachePrefixNote).toContain('알려 주지 않');
    // And the question a reader actually has at 75%: is a low number a problem.
    expect(chat(en).cacheFirstTurnNote).toContain('normal');
    expect(chat(ko).cacheFirstTurnNote).toContain('정상입니다');
  });

  it('produces one line per reported count and none for an absent one', () => {
    // The wiring's contract with the helper, restated at the boundary the tooltip
    // uses: lines in, lines out, nothing invented in between. The absence rules
    // themselves are cacheBreakdown.test.ts's.
    const full = cacheBreakdown({
      inputTokens: 200,
      cacheCreationInputTokens: 50,
      cacheReadInputTokens: 750,
    });
    expect(full.show && full.lines).toHaveLength(3);
    const steady = cacheBreakdown({ inputTokens: 200, cacheReadInputTokens: 750 });
    expect(steady.show && steady.lines).toHaveLength(2);
  });
});

describe('every hint the status bar uses exists in BOTH locales', () => {
  const lookup = (dict: unknown, key: string): unknown =>
    key.split('.').reduce<unknown>((acc, part) => {
      if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[part];
      return undefined;
    }, dict);

  /** The row's tooltip strings, taken from the source rather than from a list.
   *  Matched by SUFFIX because that is what these keys are named for — an
   *  explanation, a note, or a formatted count — and a hand-maintained list is a
   *  list someone eventually adds a key without. */
  const keys = [
    ...new Set(
      src
        .match(/'chat\.[A-Za-z0-9_]*(?:Hint|Note|Tokens|Sources|OtherAccount)'/g)
        ?.map((s) => s.slice(1, -1)) ?? [],
    ),
  ];

  it('finds the keys it is supposed to be checking', () => {
    // A regex that matched nothing would make every assertion below pass vacuously.
    expect(keys.length).toBeGreaterThanOrEqual(12);
    expect(keys).toContain('chat.turnInputHint');
    expect(keys).toContain('chat.outputHint');
    expect(keys).toContain('chat.turnCostHint');
    expect(keys).toContain('chat.cacheHitHint');
    expect(keys).toContain('chat.cacheReadTokens');
    expect(keys).toContain('chat.cachePrefixNote');
    expect(keys).toContain('chat.contextWindowHint');
  });

  it.each(keys)('%s exists in en.json', (key) => {
    expect(typeof lookup(en, key)).toBe('string');
  });

  it.each(keys)('%s exists in ko.json', (key) => {
    expect(typeof lookup(ko, key)).toBe('string');
  });

  it.each(keys)('%s is actually translated, not the English string again', (key) => {
    // The failure this catches is a key copied into ko.json unchanged, which looks
    // translated to every other check here.
    expect(lookup(ko, key)).not.toBe(lookup(en, key));
  });
});
